// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Editor-grade terminal line editing helpers for xterm.js:
//! 1. Click anywhere on the active command line to reposition the shell cursor.
//! 2. Press Backspace/Delete (or type replacement text) with a selection on the
//!    active command line to delete the entire selected span in one shot.
//!
//! Strictly disabled when an alternate-screen or mouse-tracking TUI app
//! (`vim`, `htop`, `less`, `tmux`) is running so full-screen apps remain untouched.

import type { IBufferLine, Terminal } from "@xterm/xterm";

interface LogicalLine {
  startRow: number;
  endRow: number;
  /** Ordered character cells across all wrapped rows (1 entry per Unicode glyph). */
  chars: { row: number; col: number; width: number; text: string }[];
  /** Character index where user-editable command text starts (past the shell prompt). */
  promptEndIdx: number;
  /** Character index immediately after the last non-empty glyph (or cursor, whichever is further). */
  contentEndIdx: number;
  /** Current shell cursor expressed as a character index into `chars` (0..=chars.length). */
  cursorIdx: number;
}

const LEFT_ARROW = "\x1b[D";
const RIGHT_ARROW = "\x1b[C";
const BACKSPACE = "\x7f";

/** Returns true only when the shell prompt is active (not vim/htop/tmux/mouse-capture). */
export function isNormalEditableShell(term: Terminal): boolean {
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") return false;
  if (term.modes.mouseTrackingMode !== "none") return false;
  return true;
}

/** Extracts all non-trailing-empty lines from xterm's active scrollback + viewport buffer. */
export function extractTerminalLines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const result: string[] = [];
  let current = "";
  let hasCurrent = false;

  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && hasCurrent) {
      current += text;
    } else {
      if (hasCurrent) result.push(current);
      current = text;
      hasCurrent = true;
    }
  }
  if (hasCurrent) result.push(current);

  while (result.length > 0 && result[result.length - 1].trim().length === 0) {
    result.pop();
  }
  return result;
}

/**
 * Inspects the unwrapped logical line containing the current cursor, indexing
 * every character accurately (counting CJK wide glyphs as 1 readline step).
 */
function inspectActiveLogicalLine(term: Terminal): LogicalLine | null {
  const buffer = term.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;
  const cursorCol = buffer.cursorX;

  let startRow = cursorRow;
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) {
    startRow -= 1;
  }

  let endRow = cursorRow;
  while (endRow + 1 < buffer.length && buffer.getLine(endRow + 1)?.isWrapped) {
    endRow += 1;
  }

  const chars: LogicalLine["chars"] = [];
  let cursorIdx = -1;
  let lastNonBlankIdx = 0;

  for (let row = startRow; row <= endRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const lineLen = line.length;
    for (let col = 0; col < lineLen; col += 1) {
      if (row === cursorRow && col === cursorCol && cursorIdx === -1) {
        cursorIdx = chars.length;
      }
      const cell = line.getCell(col);
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) {
        // Trailing half of a wide (2-cell) character — not an independent readline char.
        continue;
      }
      const raw = cell.getChars();
      const text = raw.length === 0 ? " " : raw;
      chars.push({ row, col, width, text });
      if (raw.trim().length > 0) {
        lastNonBlankIdx = chars.length;
      }
    }
    if (row === cursorRow && cursorCol >= lineLen && cursorIdx === -1) {
      cursorIdx = chars.length;
    }
  }

  if (cursorIdx === -1) {
    cursorIdx = lastNonBlankIdx;
  }

  const contentEndIdx = Math.max(lastNonBlankIdx, cursorIdx);
  const visibleSlice = chars
    .slice(0, contentEndIdx)
    .map((entry) => entry.text)
    .join("");
  const promptEndIdx = Math.min(detectPromptEndIndex(visibleSlice), cursorIdx);

  return {
    startRow,
    endRow,
    chars,
    promptEndIdx,
    contentEndIdx,
    cursorIdx,
  };
}

/**
 * Finds the character index immediately after common POSIX/PowerShell prompts
 * (e.g. `ubuntu@VM:~$ `, `yujie@Mac ~ % `, `root@host:/# `, `~/app ❯ `, `PS C:\> `)
 * so clicks and selections never try to edit or backspace into the prompt itself.
 */
function detectPromptEndIndex(lineText: string): number {
  const match = /^[^\n]{0,120}?[$#%❯>]\s+/.exec(lineText);
  if (!match) return 0;
  return Array.from(match[0]).length;
}

/** Maps a buffer `(row, col)` to the nearest character index in `logical`. */
function cellToCharIndex(logical: LogicalLine, row: number, col: number): number {
  if (row < logical.startRow) return 0;
  if (row > logical.endRow) return logical.contentEndIdx;

  for (let idx = 0; idx < logical.chars.length; idx += 1) {
    const entry = logical.chars[idx];
    if (entry.row > row) return idx;
    if (entry.row === row) {
      if (col <= entry.col) return idx;
      if (col < entry.col + entry.width) {
        // Clicking the right half of a wide glyph positions after it; left half before it.
        return idx;
      }
    }
  }
  return logical.contentEndIdx;
}

/**
 * Computes arrow-key escape sequences to move the shell cursor to the clicked
 * buffer `(row, col)` if the click landed on the active editable command line.
 */
export function buildClickMoveSequence(
  term: Terminal,
  clickRow: number,
  clickCol: number,
): string | null {
  if (!isNormalEditableShell(term)) return null;

  const logical = inspectActiveLogicalLine(term);
  if (!logical) return null;
  if (clickRow < logical.startRow || clickRow > logical.endRow) return null;

  const rawIdx = cellToCharIndex(logical, clickRow, clickCol);
  const clampedIdx = Math.max(logical.promptEndIdx, Math.min(logical.contentEndIdx, rawIdx));
  const delta = clampedIdx - logical.cursorIdx;
  if (delta === 0) return null;

  return delta < 0 ? LEFT_ARROW.repeat(-delta) : RIGHT_ARROW.repeat(delta);
}

/**
 * Computes the cursor-move + Backspace sequence to delete the user's current
 * xterm selection when it sits on the active editable command line.
 * Returns `null` if the selection is in scrollback history or empty.
 */
export function buildSelectionDeleteSequence(term: Terminal): string | null {
  if (!isNormalEditableShell(term) || !term.hasSelection()) return null;

  const pos = term.getSelectionPosition();
  if (!pos) return null;

  const logical = inspectActiveLogicalLine(term);
  if (!logical) return null;

  // Normalize start <= end (xterm.js getSelectionPosition returns 0-based buffer coordinates).
  let start = pos.start;
  let end = pos.end;
  if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
    [start, end] = [end, start];
  }

  // Only act when the selection overlaps the active command line.
  if (end.y < logical.startRow || start.y > logical.endRow) {
    return null;
  }

  const rawStartIdx = cellToCharIndex(logical, start.y, start.x);
  const rawEndIdx = cellToCharIndex(logical, end.y, end.x);

  const clampedStart = Math.max(logical.promptEndIdx, Math.min(logical.contentEndIdx, rawStartIdx));
  const clampedEnd = Math.max(logical.promptEndIdx, Math.min(logical.contentEndIdx, rawEndIdx));

  const count = clampedEnd - clampedStart;
  if (count <= 0) return null;

  const moveDelta = clampedEnd - logical.cursorIdx;
  const moveSeq =
    moveDelta === 0
      ? ""
      : moveDelta < 0
        ? LEFT_ARROW.repeat(-moveDelta)
        : RIGHT_ARROW.repeat(moveDelta);

  return moveSeq + BACKSPACE.repeat(count);
}

/** Converts a pointer event over the xterm container into buffer `(row, col)`. */
export function clientPointToBufferCell(
  term: Terminal,
  container: HTMLElement,
  clientX: number,
  clientY: number,
): { row: number; col: number } | null {
  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || term.cols <= 0 || term.rows <= 0) {
    return null;
  }

  const relX = clientX - rect.left;
  const relY = clientY - rect.top;
  if (relX < 0 || relY < 0 || relX > rect.width || relY > rect.height) {
    return null;
  }

  const cellWidth = rect.width / term.cols;
  const cellHeight = rect.height / term.rows;
  // Rounding X slightly toward the nearest gap makes clicking between characters feel exact.
  const col = Math.max(0, Math.min(term.cols, Math.round(relX / cellWidth)));
  const viewportRow = Math.max(0, Math.min(term.rows - 1, Math.floor(relY / cellHeight)));
  const row = term.buffer.active.viewportY + viewportRow;

  // Guard against empty lines beyond the buffer.
  const line: IBufferLine | undefined = term.buffer.active.getLine(row);
  if (!line) return null;

  return { row, col };
}
