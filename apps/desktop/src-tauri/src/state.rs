// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Registries shared by every Tauri command: live terminal sessions and open
//! SFTP connections.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use term_core::{SftpClient, ShadowScreen, SshTunnel, TerminalTransport};
use tokio::sync::Mutex as AsyncMutex;

use crate::error::ApiError;

/// What kind of connection backs a session tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    /// Local shell through a PTY.
    Local,
    /// Remote shell over SSH.
    Ssh,
    /// Serial console.
    Serial,
}

/// One live session: transport, mirrored screen and metadata used by the UI.
pub struct SessionHandle {
    /// Transport, type-erased so every session kind behaves the same.
    pub transport: Arc<dyn TerminalTransport>,
    /// Shadow screen fed by the same batched frames the UI receives.
    pub screen: Arc<AsyncMutex<ShadowScreen>>,
    /// Session kind, used by the sidebar and the status bar.
    pub kind: SessionKind,
    /// Short label, e.g. `zsh`, `root@host` or `/dev/cu.usbserial`.
    pub label: String,
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
    /// Registers a freshly created session.
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

/// Thread-safe map of SFTP connection id to client.
#[derive(Default)]
pub struct SftpRegistry {
    clients: Mutex<HashMap<String, Arc<SftpClient>>>,
}

impl SftpRegistry {
    /// Registers a freshly connected SFTP client and returns its id.
    pub fn insert(&self, client: Arc<SftpClient>) -> Result<String, ApiError> {
        let id = term_core::generate_session_id("sftp").into_string();
        let mut clients = self.clients.lock().map_err(|_| ApiError::StatePoisoned)?;
        clients.insert(id.clone(), client);
        Ok(id)
    }

    /// Returns the client for `id` or an error the UI can render.
    pub fn require(&self, id: &str) -> Result<Arc<SftpClient>, ApiError> {
        let clients = self.clients.lock().map_err(|_| ApiError::StatePoisoned)?;
        clients
            .get(id)
            .cloned()
            .ok_or_else(|| ApiError::UnknownSftpSession(id.to_owned()))
    }

    /// Removes and returns the client for `id`.
    pub fn remove(&self, id: &str) -> Result<Option<Arc<SftpClient>>, ApiError> {
        let mut clients = self.clients.lock().map_err(|_| ApiError::StatePoisoned)?;
        Ok(clients.remove(id))
    }
}

/// Thread-safe map of saved tunnel id to its running [`SshTunnel`].
#[derive(Clone, Default)]
pub struct TunnelRegistry {
    tunnels: Arc<Mutex<HashMap<String, Arc<SshTunnel>>>>,
}

impl TunnelRegistry {
    /// Registers a live tunnel under its saved rule id, returning any previous one.
    pub fn insert(
        &self,
        id: String,
        tunnel: Arc<SshTunnel>,
    ) -> Result<Option<Arc<SshTunnel>>, ApiError> {
        let mut tunnels = self.tunnels.lock().map_err(|_| ApiError::StatePoisoned)?;
        Ok(tunnels.insert(id, tunnel))
    }

    /// Returns the running tunnel for `id`, if active.
    pub fn get(&self, id: &str) -> Result<Option<Arc<SshTunnel>>, ApiError> {
        let tunnels = self.tunnels.lock().map_err(|_| ApiError::StatePoisoned)?;
        Ok(tunnels.get(id).cloned())
    }

    /// Removes and returns the running tunnel for `id`.
    pub fn remove(&self, id: &str) -> Result<Option<Arc<SshTunnel>>, ApiError> {
        let mut tunnels = self.tunnels.lock().map_err(|_| ApiError::StatePoisoned)?;
        Ok(tunnels.remove(id))
    }
}
