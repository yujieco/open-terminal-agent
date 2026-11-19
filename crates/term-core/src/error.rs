// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Structured errors for every transport and screen operation.

use thiserror::Error;

/// Crate-wide result alias bound to [`CoreError`].
pub type Result<T, E = CoreError> = std::result::Result<T, E>;

/// Everything that can fail while moving bytes between a terminal and the app.
#[derive(Debug, Error)]
pub enum CoreError {
    /// The requested session id is not registered in the caller's table.
    #[error("session `{0}` was not found")]
    SessionNotFound(String),

    /// The session was closed, so writes can no longer be accepted.
    #[error("session `{0}` is already closed")]
    SessionClosed(String),

    /// The PTY pair could not be created or the shell could not be spawned.
    #[error("failed to spawn pty: {0}")]
    PtySpawn(String),

    /// Reading from or writing to the PTY master failed.
    #[error("pty io failure: {0}")]
    PtyIo(String),

    /// The SSH handshake, authentication or channel setup failed.
    #[error("ssh failure: {0}")]
    Ssh(String),

    /// The SSH server rejected the supplied credentials.
    #[error("ssh authentication rejected for `{username}`")]
    SshAuth {
        /// User that was rejected.
        username: String,
    },

    /// An SFTP operation failed.
    #[error("sftp failure: {0}")]
    Sftp(String),

    /// Opening, configuring or reading a serial port failed.
    #[error("serial failure: {0}")]
    Serial(String),

    /// The requested serial port is not present on this machine.
    #[error("serial port `{0}` is not available")]
    SerialPortMissing(String),

    /// A column or row count of zero reaches a terminal that requires >= 1.
    #[error("invalid terminal geometry: {cols}x{rows}")]
    InvalidGeometry {
        /// Requested column count.
        cols: u16,
        /// Requested row count.
        rows: u16,
    },

    /// The PTY writer handle could not be locked.
    #[error("transport writer is unavailable")]
    WriterUnavailable,

    /// The output stream was closed by the producer.
    #[error("transport output stream is closed")]
    OutputClosed,
}
