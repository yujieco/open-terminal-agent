// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Saved connections and SSH known-host commands.

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::State;
use tauri::ipc::Channel;

use crate::commands::session::{
    SerialConnectRequest, SessionInfo, SpawnSessionRequest, TerminalStreamEvent, connect_ssh,
    default_data_bits, default_flow_control, default_parity, default_stop_bits, open_serial,
    spawn_session,
};
use crate::commands::{
    SshAuthRequest, SshConnectRequest, default_cols, default_rows, string_field,
};
use crate::error::ApiError;
use crate::secrets::{SecretStore, ssh_secret_account};
use crate::shell_integration::ShellIntegration;
use crate::state::SessionRegistry;
use crate::store::{
    CommandSnippet, KnownHost, NewCommandSnippet, NewSavedSession, SavedSession, Store,
};

/// Arguments for [`save_ssh_session`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSshSessionRequest {
    /// Display name for the sidebar.
    pub name: String,
    /// Hostname or IP address.
    pub host: String,
    /// TCP port.
    pub port: u16,
    /// Remote user.
    pub username: String,
    /// Authentication choice.
    pub auth: SshAuthRequest,
    /// Whether a password should be remembered in the OS keyring.
    #[serde(default)]
    pub remember_password: bool,
}

/// Persists an SSH connection, storing the password in the OS keyring only.
#[tauri::command]
pub fn save_ssh_session(
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    request: SaveSshSessionRequest,
) -> Result<SavedSession, ApiError> {
    let account = ssh_secret_account(&request.host, request.port, &request.username);

    let (auth_payload, secret_ref) = match request.auth {
        SshAuthRequest::Password { password } => {
            if request.remember_password {
                secrets.set(&account, &password)?;
                (json!({ "method": "password" }), Some(account))
            } else {
                (json!({ "method": "password" }), None)
            }
        }
        SshAuthRequest::PrivateKey { path, .. } => {
            (json!({ "method": "privateKey", "path": path }), None)
        }
    };

    let payload = json!({
        "host": request.host,
        "port": request.port,
        "username": request.username,
        "auth": auth_payload,
    });

    Ok(store.save(NewSavedSession {
        name: request.name,
        kind: String::from("ssh"),
        payload,
        secret_ref,
    })?)
}

/// Lists saved connections, newest first.
#[tauri::command]
pub fn list_saved_sessions(store: State<'_, Store>) -> Result<Vec<SavedSession>, ApiError> {
    Ok(store.list()?)
}

/// Deletes a saved connection and any keyring secret attached to it.
#[tauri::command]
pub fn delete_saved_session(
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    id: String,
) -> Result<bool, ApiError> {
    let existing = store.get(&id)?;
    if let Some(saved) = &existing
        && let Some(account) = &saved.secret_ref
    {
        // A missing entry is fine; the row is what matters.
        secrets.delete(account)?;
    }
    Ok(store.delete(&id)?)
}

/// Reopens a saved connection, resolving secrets and pinned keys first.
#[tauri::command]
pub async fn connect_saved_session(
    registry: State<'_, SessionRegistry>,
    shell_integration: State<'_, ShellIntegration>,
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    id: String,
    on_event: Channel<TerminalStreamEvent>,
) -> Result<SessionInfo, ApiError> {
    let saved = store
        .get(&id)?
        .ok_or_else(|| ApiError::UnknownSavedSession(id.clone()))?;

    match saved.kind.as_str() {
        "local" => {
            let shell = saved
                .payload
                .get("shell")
                .and_then(Value::as_str)
                .map(str::to_owned);
            spawn_session(
                registry,
                shell_integration,
                SpawnSessionRequest {
                    cols: default_cols(),
                    rows: default_rows(),
                    shell,
                    cwd: None,
                },
                on_event,
            )
            .await
        }
        "ssh" => {
            let host = string_field(&saved.payload, "host")?;
            let username = string_field(&saved.payload, "username")?;
            let port = saved
                .payload
                .get("port")
                .and_then(Value::as_u64)
                .unwrap_or(22) as u16;

            let method = saved
                .payload
                .get("auth")
                .and_then(|auth| auth.get("method"))
                .and_then(Value::as_str)
                .unwrap_or("password");

            let auth = if method == "privateKey" {
                let path = saved
                    .payload
                    .get("auth")
                    .and_then(|auth| auth.get("path"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                SshAuthRequest::PrivateKey {
                    path,
                    passphrase: None,
                }
            } else {
                let account = saved
                    .secret_ref
                    .clone()
                    .unwrap_or_else(|| ssh_secret_account(&host, port, &username));
                let password = secrets
                    .get(&account)?
                    .ok_or_else(|| ApiError::SecretMissing {
                        account: account.clone(),
                    })?;
                SshAuthRequest::Password { password }
            };

            connect_ssh(
                registry,
                store,
                SshConnectRequest {
                    host,
                    port,
                    username,
                    auth,
                    cols: default_cols(),
                    rows: default_rows(),
                    trust_fingerprint: None,
                },
                on_event,
            )
            .await
        }
        "serial" => {
            let path = string_field(&saved.payload, "path")?;
            let baud_rate = saved
                .payload
                .get("baudRate")
                .and_then(Value::as_u64)
                .unwrap_or(115200) as u32;
            open_serial(
                registry,
                SerialConnectRequest {
                    path,
                    baud_rate,
                    data_bits: default_data_bits(),
                    stop_bits: default_stop_bits(),
                    parity: default_parity(),
                    flow_control: default_flow_control(),
                    cols: default_cols(),
                    rows: default_rows(),
                    log_path: None,
                },
                on_event,
            )
            .await
        }
        other => Err(ApiError::InvalidRequest(format!(
            "unsupported saved session kind `{other}`"
        ))),
    }
}

/// Lists pinned SSH host keys for review.
#[tauri::command]
pub fn list_known_hosts(store: State<'_, Store>) -> Result<Vec<KnownHost>, ApiError> {
    Ok(store.list_known_hosts()?)
}

/// Forgets one pinned host key, so the next connection trusts it again.
#[tauri::command]
pub fn forget_host_key(store: State<'_, Store>, host: String, port: u16) -> Result<bool, ApiError> {
    Ok(store.forget_host_key(&host, port)?)
}

/// Reports the server key fingerprint without opening a shell.
#[tauri::command]
pub async fn probe_ssh_host_key(host: String, port: u16) -> Result<String, ApiError> {
    term_core::probe_host_key(&host, port, std::time::Duration::from_secs(8))
        .await
        .map_err(|error| ApiError::InvalidRequest(error.to_string()))
}

/// Arguments for [`save_snippet`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSnippetRequest {
    /// Existing id when editing an existing snippet.
    #[serde(default)]
    pub id: Option<String>,
    /// Human-friendly alias.
    pub alias: String,
    /// Shell command text.
    pub command: String,
    /// Optional category name.
    #[serde(default)]
    pub category: String,
    /// Optional short description.
    #[serde(default)]
    pub description: String,
}

/// Lists all saved command snippets, most used / recently updated first.
#[tauri::command]
pub fn list_snippets(store: State<'_, Store>) -> Result<Vec<CommandSnippet>, ApiError> {
    Ok(store.list_snippets()?)
}

/// Creates or updates a saved command snippet.
#[tauri::command]
pub fn save_snippet(
    store: State<'_, Store>,
    request: SaveSnippetRequest,
) -> Result<CommandSnippet, ApiError> {
    if request.alias.trim().is_empty() {
        return Err(ApiError::InvalidRequest(String::from(
            "snippet alias cannot be empty",
        )));
    }
    if request.command.trim().is_empty() {
        return Err(ApiError::InvalidRequest(String::from(
            "snippet command cannot be empty",
        )));
    }
    Ok(store.save_snippet(NewCommandSnippet {
        id: request.id,
        alias: request.alias,
        command: request.command,
        category: request.category,
        description: request.description,
    })?)
}

/// Deletes one saved command snippet.
#[tauri::command]
pub fn delete_snippet(store: State<'_, Store>, id: String) -> Result<bool, ApiError> {
    Ok(store.delete_snippet(&id)?)
}

/// Increments the usage counter of a snippet when pasted.
#[tauri::command]
pub fn bump_snippet_usage(store: State<'_, Store>, id: String) -> Result<(), ApiError> {
    Ok(store.bump_snippet_usage(&id)?)
}
