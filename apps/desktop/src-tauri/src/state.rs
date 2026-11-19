// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Session registry shared by every Tauri command.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use term_core::{PtyTransport, ShadowScreen, TerminalTransport};
use tokio::sync::Mutex as AsyncMutex;

use crate::error::ApiError;

/// One live session: transport, mirrored screen and metadata used by the UI.
pub struct SessionHandle {
    /// Local PTY transport.
    pub transport: Arc<PtyTransport>,
    /// Shadow screen fed by the same batched frames the UI receives.
    pub screen: Arc<AsyncMutex<ShadowScreen>>,
    /// Shell binary that was started.
    pub shell: String,
    /// Column count the UI asked for.
    pub cols: u16,
    /// Row count the UI asked for.
    pub rows: u16,
}

impl SessionHandle {
    /// Stable id used by every command and event.
    pub fn id(&self) -> String {
        self.transport.session_id().as_str().to_owned()
    }
}

/// Thread-safe map of session id to handle.
#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Arc<SessionHandle>>>,
}

impl SessionRegistry {
    /// Registers a freshly spawned session.
    pub fn insert(&self, handle: Arc<SessionHandle>) -> Result<(), ApiError> {
        let mut sessions = self.sessions.lock().map_err(|_| ApiError::StatePoisoned)?;
        sessions.insert(handle.id(), handle);
        Ok(())
    }

    /// Returns the handle for `id`, or `None` when the session is gone.
    pub fn get(&self, id: &str) -> Result<Option<Arc<SessionHandle>>, ApiError> {
        let sessions = self.sessions.lock().map_err(|_| ApiError::StatePoisoned)?;
        Ok(sessions.get(id).cloned())
    }

    /// Returns the handle for `id` or an error the UI can render.
    pub fn require(&self, id: &str) -> Result<Arc<SessionHandle>, ApiError> {
        self.get(id)?
            .ok_or_else(|| ApiError::UnknownSession(id.to_owned()))
    }

    /// Removes and returns the handle for `id`.
    pub fn remove(&self, id: &str) -> Result<Option<Arc<SessionHandle>>, ApiError> {
        let mut sessions = self.sessions.lock().map_err(|_| ApiError::StatePoisoned)?;
        Ok(sessions.remove(id))
    }

    /// All handles, sorted by id so the sidebar order stays stable.
    pub fn list(&self) -> Result<Vec<Arc<SessionHandle>>, ApiError> {
        let sessions = self.sessions.lock().map_err(|_| ApiError::StatePoisoned)?;
        let mut handles: Vec<Arc<SessionHandle>> = sessions.values().cloned().collect();
        handles.sort_by_key(|handle| handle.id());
        Ok(handles)
    }
}
