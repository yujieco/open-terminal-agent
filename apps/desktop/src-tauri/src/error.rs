// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Errors that cross the Tauri IPC boundary. Every variant serializes to a
//! human readable string so the frontend can show it verbatim.

use serde::{Serialize, Serializer};
use term_core::CoreError;

/// Failure surfaced to the WebView.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// Transport or screen failure.
    #[error(transparent)]
    Core(#[from] CoreError),

    /// The frontend referenced a session that no longer exists.
    #[error("unknown session `{0}`")]
    UnknownSession(String),

    /// The frontend referenced an SFTP connection that no longer exists.
    #[error("unknown sftp connection `{0}`")]
    UnknownSftpSession(String),

    /// A mutex guarding the session registry was poisoned.
    #[error("session registry is unavailable")]
    StatePoisoned,

    /// The requested shell binary is not installed.
    #[error("shell `{0}` is not available")]
    ShellUnavailable(String),

    /// SQLite storage failed.
    #[error(transparent)]
    Store(#[from] crate::store::StoreError),

    /// The OS keyring rejected an operation.
    #[error("keyring failure: {0}")]
    Secret(String),

    /// The requested saved session no longer exists.
    #[error("unknown saved session `{0}`")]
    UnknownSavedSession(String),

    /// A saved connection needs a secret that is no longer in the keyring.
    #[error("no keyring entry `{account}`; reopen the connection and enter the password again")]
    SecretMissing {
        /// Keyring account that was expected.
        account: String,
    },

    /// The request was structurally valid but not actionable.
    #[error("invalid request: {0}")]
    InvalidRequest(String),
}

impl Serialize for ApiError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
