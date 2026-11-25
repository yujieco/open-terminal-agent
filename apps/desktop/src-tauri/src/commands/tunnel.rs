// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! SSH port-forwarding (tunnel) commands: Local (`-L`), Remote (`-R`), and
//! Dynamic SOCKS5 (`-D`) rules backed by saved SSH profiles.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use term_core::{SshTunnel, TunnelKind, TunnelSpec, TunnelStatsSnapshot};

use crate::error::ApiError;
use crate::secrets::SecretStore;
use crate::state::TunnelRegistry;
use crate::store::{NewSavedTunnel, SavedTunnel, Store};

/// Arguments for [`save_tunnel`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTunnelRequest {
    /// Existing rule id when editing, or `None` when creating.
    #[serde(default)]
    pub id: Option<String>,
    /// Friendly rule name, e.g. "Prod MySQL".
    pub name: String,
    /// Linked saved SSH session id.
    pub session_id: String,
    /// Direction: `local`, `remote`, or `dynamic`.
    pub kind: TunnelKind,
    /// Listen host (defaults to `127.0.0.1`).
    #[serde(default = "default_bind_host")]
    pub bind_host: String,
    /// Listen port.
    pub bind_port: u16,
    /// Destination host (`local`/`remote`; ignored for `dynamic`).
    #[serde(default)]
    pub target_host: String,
    /// Destination port (`local`/`remote`; ignored for `dynamic`).
    #[serde(default)]
    pub target_port: u16,
}

fn default_bind_host() -> String {
    String::from("127.0.0.1")
}

/// Saved tunnel rule enriched with live runtime status and traffic stats.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelView {
    /// Stable rule id.
    pub id: String,
    /// Friendly rule name.
    pub name: String,
    /// Linked saved SSH session id.
    pub session_id: String,
    /// Display name of the linked SSH profile (or fallback if removed).
    pub session_name: String,
    /// `user@host:port` summary of the linked SSH server.
    pub ssh_target: String,
    /// Forwarding kind: `local`, `remote`, or `dynamic`.
    pub kind: TunnelKind,
    /// Configured bind host.
    pub bind_host: String,
    /// Configured bind port.
    pub bind_port: u16,
    /// Actual bound port while running (or configured `bind_port` when stopped).
    pub active_port: u16,
    /// Configured destination host.
    pub target_host: String,
    /// Configured destination port.
    pub target_port: u16,
    /// True when the tunnel is currently listening / forwarding.
    pub running: bool,
    /// Live connection & traffic counters (zeros when stopped).
    pub stats: TunnelStatsSnapshot,
}

fn build_tunnel_view(
    saved: SavedTunnel,
    store: &Store,
    registry: &TunnelRegistry,
) -> Result<TunnelView, ApiError> {
    let kind = TunnelKind::parse(&saved.kind).unwrap_or(TunnelKind::Local);
    let (session_name, ssh_target) = match store.get(&saved.session_id)? {
        Some(profile) => {
            let host = profile
                .payload
                .get("host")
                .and_then(Value::as_str)
                .unwrap_or("?");
            let user = profile
                .payload
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("?");
            let port = profile
                .payload
                .get("port")
                .and_then(Value::as_u64)
                .unwrap_or(22);
            (profile.name, format!("{user}@{host}:{port}"))
        }
        None => (String::from("—"), String::new()),
    };

    let live = registry.get(&saved.id)?;
    let (running, active_port, stats) = match live {
        Some(tunnel) => (true, tunnel.bound_port(), tunnel.stats()),
        None => (false, saved.bind_port, TunnelStatsSnapshot::default()),
    };

    Ok(TunnelView {
        id: saved.id,
        name: saved.name,
        session_id: saved.session_id,
        session_name,
        ssh_target,
        kind,
        bind_host: saved.bind_host,
        bind_port: saved.bind_port,
        active_port,
        target_host: saved.target_host,
        target_port: saved.target_port,
        running,
        stats,
    })
}

/// Lists all saved SSH tunnels with their live status and traffic stats.
#[tauri::command]
pub fn list_tunnels(
    store: State<'_, Store>,
    registry: State<'_, TunnelRegistry>,
) -> Result<Vec<TunnelView>, ApiError> {
    let saved = store.list_tunnels()?;
    let mut views = Vec::with_capacity(saved.len());
    for entry in saved {
        views.push(build_tunnel_view(entry, &store, &registry)?);
    }
    Ok(views)
}

/// Creates or updates one saved SSH tunnel rule.
#[tauri::command]
pub fn save_tunnel(
    store: State<'_, Store>,
    registry: State<'_, TunnelRegistry>,
    request: SaveTunnelRequest,
) -> Result<TunnelView, ApiError> {
    if request.name.trim().is_empty() {
        return Err(ApiError::InvalidRequest(String::from(
            "tunnel name must not be empty",
        )));
    }
    let session = store
        .get(&request.session_id)?
        .ok_or_else(|| ApiError::UnknownSavedSession(request.session_id.clone()))?;
    if session.kind != "ssh" {
        return Err(ApiError::InvalidRequest(String::from(
            "tunnels can only use saved SSH sessions",
        )));
    }

    let bind_host = if request.bind_host.trim().is_empty() {
        String::from("127.0.0.1")
    } else {
        request.bind_host.trim().to_owned()
    };
    let target_host = if request.kind == TunnelKind::Dynamic {
        String::new()
    } else if request.target_host.trim().is_empty() {
        String::from("127.0.0.1")
    } else {
        request.target_host.trim().to_owned()
    };
    let target_port = if request.kind == TunnelKind::Dynamic {
        0
    } else {
        request.target_port
    };

    let spec = TunnelSpec {
        kind: request.kind,
        bind_host: bind_host.clone(),
        bind_port: request.bind_port,
        target_host: target_host.clone(),
        target_port,
    };
    spec.validate()?;

    let saved = store.save_tunnel(NewSavedTunnel {
        id: request.id,
        name: request.name,
        session_id: request.session_id,
        kind: request.kind.as_str().to_owned(),
        bind_host,
        bind_port: request.bind_port,
        target_host,
        target_port,
    })?;

    build_tunnel_view(saved, &store, &registry)
}

/// Stops (if running) and deletes one saved tunnel rule.
#[tauri::command]
pub async fn delete_tunnel(
    store: State<'_, Store>,
    registry: State<'_, TunnelRegistry>,
    id: String,
) -> Result<bool, ApiError> {
    if let Some(live) = registry.remove(&id)? {
        live.stop().await;
    }
    Ok(store.delete_tunnel(&id)?)
}

/// Starts a saved SSH tunnel by connecting to its linked SSH profile.
#[tauri::command]
pub async fn start_tunnel(
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    registry: State<'_, TunnelRegistry>,
    id: String,
) -> Result<TunnelView, ApiError> {
    let saved = store
        .get_tunnel(&id)?
        .ok_or_else(|| ApiError::InvalidRequest(format!("unknown tunnel `{id}`")))?;

    if registry.get(&id)?.is_some() {
        return build_tunnel_view(saved, &store, &registry);
    }

    let profile = store
        .get(&saved.session_id)?
        .ok_or_else(|| ApiError::UnknownSavedSession(saved.session_id.clone()))?;
    if profile.kind != "ssh" {
        return Err(ApiError::InvalidRequest(String::from(
            "linked session is not an SSH profile",
        )));
    }

    let req = crate::commands::store::resolve_saved_ssh_request(&profile, &secrets)?;
    let host = req.host.clone();
    let port = req.port;
    let mut ssh_config = req.into_config();
    if let Some(pinned) = store.host_key(&host, port)? {
        ssh_config = ssh_config.with_known_host_fingerprint(pinned);
    }

    let kind = TunnelKind::parse(&saved.kind).unwrap_or(TunnelKind::Local);
    let spec = TunnelSpec {
        kind,
        bind_host: saved.bind_host.clone(),
        bind_port: saved.bind_port,
        target_host: saved.target_host.clone(),
        target_port: saved.target_port,
    };

    let tunnel = SshTunnel::start(&ssh_config, spec).await?;
    if let Some(fingerprint) = tunnel.host_fingerprint() {
        let _ = store.remember_host_key(&host, port, &fingerprint);
    }

    if let Some(previous) = registry.insert(saved.id.clone(), Arc::new(tunnel))? {
        previous.stop().await;
    }

    build_tunnel_view(saved, &store, &registry)
}

/// Stops a running SSH tunnel.
#[tauri::command]
pub async fn stop_tunnel(
    store: State<'_, Store>,
    registry: State<'_, TunnelRegistry>,
    id: String,
) -> Result<TunnelView, ApiError> {
    if let Some(live) = registry.remove(&id)? {
        live.stop().await;
    }
    let saved = store
        .get_tunnel(&id)?
        .ok_or_else(|| ApiError::InvalidRequest(format!("unknown tunnel `{id}`")))?;
    build_tunnel_view(saved, &store, &registry)
}
