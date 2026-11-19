// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Headless shadow screen: a `vt100` parser fed with the same bytes the user
//! sees, so the agent can read clean text, cursor position and scrollback
//! without parsing raw ANSI noise.

use std::num::NonZeroU16;

use serde::{Deserialize, Serialize};
use vt100::Parser;

use crate::error::{CoreError, Result};

/// Rows of scrollback retained per session.
pub const DEFAULT_SCROLLBACK_CAPACITY: usize = 5_000;

/// Default number of scrollback lines included in a snapshot.
pub const SNAPSHOT_SCROLLBACK_LINES: usize = 200;

/// Cursor position inside the visible grid, zero-based.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPosition {
    /// Zero-based row.
    pub row: u16,
    /// Zero-based column.
    pub col: u16,
}

/// Plain-text view of what the terminal shows right now.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSnapshot {
    /// Visible column count.
    pub cols: u16,
    /// Visible row count.
    pub rows: u16,
    /// Cursor position.
    pub cursor: CursorPosition,
    /// Full visible grid as text, lines separated by `\n`.
    pub text: String,
    /// Visible grid split into trimmed lines.
    pub lines: Vec<String>,
    /// Most recent scrollback lines, oldest first.
    pub scrollback: Vec<String>,
    /// Total number of lines currently held in scrollback.
    pub scrollback_len: usize,
}

/// Mirrors one terminal grid and keeps it in sync with the transport stream.
pub struct ShadowScreen {
    parser: Parser,
    cols: u16,
    rows: u16,
    scrollback_capacity: usize,
}

impl ShadowScreen {
    /// Creates a shadow screen with the default scrollback capacity.
    pub fn new(cols: u16, rows: u16) -> Result<Self> {
        Self::with_scrollback(cols, rows, DEFAULT_SCROLLBACK_CAPACITY)
    }

    /// Creates a shadow screen with an explicit scrollback capacity.
    pub fn with_scrollback(cols: u16, rows: u16, scrollback_capacity: usize) -> Result<Self> {
        if cols == 0 || rows == 0 {
            return Err(CoreError::InvalidGeometry { cols, rows });
        }
        Ok(Self {
            parser: Parser::new(dim(rows), dim(cols), scrollback_capacity),
            cols,
            rows,
            scrollback_capacity,
        })
    }

    /// Feeds a chunk of transport bytes into the parser.
    pub fn feed(&mut self, bytes: &[u8]) {
        if !bytes.is_empty() {
            self.parser.process(bytes);
        }
    }

    /// Resizes the mirrored grid, keeping the visible text consistent.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 {
            return Err(CoreError::InvalidGeometry { cols, rows });
        }
        self.parser.set_size(dim(rows), dim(cols));
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    /// Current grid size as `(cols, rows)`.
    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    /// Scrollback capacity this screen was created with.
    pub fn scrollback_capacity(&self) -> usize {
        self.scrollback_capacity
    }

    /// Number of lines currently held in scrollback.
    pub fn scrollback_len(&self) -> usize {
        self.parser.screen().scrollback_len()
    }

    /// Cursor position in the live viewport.
    pub fn cursor(&self) -> CursorPosition {
        let (row, col) = self.parser.screen().cursor_position();
        CursorPosition { row, col }
    }

    /// Visible grid as plain text, stripped of escape sequences.
    pub fn visible_text(&self) -> String {
        self.parser.screen().contents()
    }

    /// Visible grid split into lines with trailing blanks removed.
    pub fn visible_lines(&self) -> Vec<String> {
        visible_lines(&self.visible_text())
    }

    /// Walks the scrollback from oldest to newest and returns the last `limit`
    /// lines. The live viewport is restored before returning.
    pub fn scrollback_lines(&mut self, limit: usize) -> Vec<String> {
        let total = self.scrollback_len();
        let take = total.min(limit);
        if take == 0 {
            return Vec::new();
        }

        let mut lines = Vec::with_capacity(take);
        for offset in (0..take).rev() {
            // `set_scrollback` clamps, so compare against the clamped value to
            // keep the walk honest even if the parser trimmed older lines.
            self.parser.screen_mut().set_scrollback(offset);
            let viewport = self.parser.screen().contents();
            match visible_lines(&viewport).into_iter().next() {
                Some(line) => lines.push(line),
                None => lines.push(String::new()),
            }
        }
        self.parser.screen_mut().set_scrollback(0);
        lines.reverse();
        lines
    }

    /// Builds a serializable snapshot, including the tail of the scrollback.
    pub fn snapshot(&mut self) -> ScreenSnapshot {
        let scrollback = self.scrollback_lines(SNAPSHOT_SCROLLBACK_LINES);
        ScreenSnapshot {
            cols: self.cols,
            rows: self.rows,
            cursor: self.cursor(),
            text: self.visible_text(),
            lines: self.visible_lines(),
            scrollback,
            scrollback_len: self.scrollback_len(),
        }
    }
}

/// Clamps a dimension to the non-zero range `vt100` requires.
fn dim(value: u16) -> NonZeroU16 {
    NonZeroU16::new(value).unwrap_or(NonZeroU16::MIN)
}

fn visible_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| line.trim_end().to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_text_and_cursor() {
        let mut screen = ShadowScreen::new(40, 6).expect("screen");
        screen.feed(b"hello\r\nworld");

        assert_eq!(screen.visible_text().lines().next(), Some("hello"));
        assert_eq!(screen.cursor(), CursorPosition { row: 1, col: 5 });
        assert_eq!(screen.size(), (40, 6));
    }

    #[test]
    fn strips_ansi_sequences_from_visible_text() {
        let mut screen = ShadowScreen::new(20, 3).expect("screen");
        screen.feed(b"\x1b[1;32mok\x1b[0m");

        assert_eq!(screen.visible_text().trim_end(), "ok");
    }

    #[test]
    fn rejects_zero_sized_grids() {
        assert!(matches!(
            ShadowScreen::new(0, 5),
            Err(CoreError::InvalidGeometry { cols: 0, rows: 5 })
        ));
    }

    #[test]
    fn resize_keeps_the_grid_consistent() {
        let mut screen = ShadowScreen::new(80, 24).expect("screen");
        screen.feed(b"a\r\nb\r\nc");
        screen.resize(120, 30).expect("resize");

        assert_eq!(screen.size(), (120, 30));
        assert!(screen.visible_text().contains('a'));
    }

    #[test]
    fn scrollback_lines_are_returned_oldest_first() {
        let mut screen = ShadowScreen::with_scrollback(20, 3, 100).expect("screen");
        for index in 0..12 {
            screen.feed(format!("line-{index}\r\n").as_bytes());
        }

        let tail = screen.scrollback_lines(5);
        assert!(!tail.is_empty(), "scrolled lines should be readable");
        assert!(tail.len() <= 5);
        assert!(
            tail.iter().any(|line| line.starts_with("line-")),
            "scrollback should contain fed content, got {tail:?}"
        );
    }

    #[test]
    fn snapshot_reports_scrollback_length() {
        let mut screen = ShadowScreen::with_scrollback(20, 3, 100).expect("screen");
        for index in 0..12 {
            screen.feed(format!("row-{index}\r\n").as_bytes());
        }
        let snapshot = screen.snapshot();

        assert!(snapshot.scrollback_len > 0);
        assert_eq!(snapshot.cols, 20);
        assert_eq!(snapshot.rows, 3);
    }
}
