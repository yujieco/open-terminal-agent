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

    /// A mutex guarding the session registry was poisoned.
    #[error("session registry is unavailable")]
    StatePoisoned,

    /// The requested shell binary is not installed.
    #[error("shell `{0}` is not available")]
    ShellUnavailable(String),
}

impl Serialize for ApiError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
