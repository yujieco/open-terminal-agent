// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Transport and screen primitives for Open Terminal Agent.
//!
//! `term-core` owns everything that touches bytes and terminal state, with no
//! knowledge of Tauri or React: the `TerminalTransport` trait, the 16ms output
//! batcher, the `vt100` shadow screen and the local PTY implementation. SSH,
//! SFTP and serial transports attach to the same trait in later milestones.

pub mod error;
pub mod pty;
pub mod screen;
pub mod transport;

pub use error::{CoreError, Result};
pub use pty::{PtyConfig, PtyTransport, SharedPtyTransport, default_shell};
pub use screen::{
    CursorPosition, DEFAULT_SCROLLBACK_CAPACITY, SNAPSHOT_SCROLLBACK_LINES, ScreenSnapshot,
    ShadowScreen,
};
pub use transport::{
    CHUNK_CHANNEL_CAPACITY, OUTPUT_CHANNEL_CAPACITY, STREAM_BATCH_INTERVAL, STREAM_BATCH_MAX_BYTES,
    SessionId, StreamBatcher, TerminalOutput, TerminalTransport, TransportEvent,
    generate_session_id,
};
