// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Saved connections and SSH known-host commands.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;
use tauri::ipc::Channel;

use crate::commands::session::{
    SerialConnectRequest, SessionInfo, SpawnSessionRequest, TerminalStreamEvent, connect_ssh,
    default_data_bits, default_flow_control, default_parity, default_stop_bits, open_serial,
    spawn_session,
};
use crate::commands::{
    SshAuthRequest, SshConnectRequest, SshJumpRequest, default_cols, default_rows, string_field,
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
    /// Optional existing saved-session id when editing in place.
    #[serde(default)]
    pub id: Option<String>,
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
    /// Optional environment tag (`prod`, `staging`, `dev`) for safety badges
    /// and production guardrails.
    #[serde(default)]
    pub env_tag: Option<String>,
    /// Optional sidebar folder / group label (e.g. `Production`, `Edge`).
    #[serde(default)]
    pub group_name: Option<String>,
    /// Optional bastion host (`ProxyJump`) configuration.
    #[serde(default)]
    pub jump: Option<SshJumpRequest>,
}

/// Persists (or updates) an SSH connection, storing secrets in the OS keyring only.
#[tauri::command]
pub fn save_ssh_session(
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    request: SaveSshSessionRequest,
) -> Result<SavedSession, ApiError> {
    let existing = match &request.id {
        Some(id) if !id.trim().is_empty() => store.get(id.trim())?,
        _ => None,
    };

    let account = ssh_secret_account(&request.host, request.port, &request.username);

    let (auth_payload, secret_ref) = match request.auth {
        SshAuthRequest::Password { password } => {
            if !password.is_empty() && request.remember_password {
                secrets.set(&account, &password)?;
                (json!({ "method": "password" }), Some(account))
            } else if password.is_empty()
                && request.remember_password
                && let Some(prev_ref) = existing.as_ref().and_then(|s| s.secret_ref.clone())
            {
                // Preserve existing password when editing metadata without retyping it.
                (json!({ "method": "password" }), Some(prev_ref))
            } else {
                (json!({ "method": "password" }), None)
            }
        }
        SshAuthRequest::PrivateKey { path, .. } => {
            (json!({ "method": "privateKey", "path": path }), None)
        }
    };

    let mut payload = json!({
        "host": request.host,
        "port": request.port,
        "username": request.username,
        "auth": auth_payload,
    });
    if let Some(object) = payload.as_object_mut() {
        if let Some(tag) = request
            .env_tag
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            object.insert(String::from("envTag"), json!(tag));
        }
        if let Some(group) = request
            .group_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            object.insert(String::from("groupName"), json!(group));
        }
        if let Some(jump) = request.jump {
            let jump_account = ssh_secret_account(&jump.host, jump.port, &jump.username);
            let jump_auth = match jump.auth {
                SshAuthRequest::Password { password } => {
                    if !password.is_empty() {
                        secrets.set(&jump_account, &password)?;
                    }
                    json!({ "method": "password", "secretRef": jump_account })
                }
                SshAuthRequest::PrivateKey { path, .. } => {
                    json!({ "method": "privateKey", "path": path })
                }
            };
            object.insert(
                String::from("jump"),
                json!({
                    "host": jump.host,
                    "port": jump.port,
                    "username": jump.username,
                    "auth": jump_auth,
                }),
            );
        }
    }

    let draft = NewSavedSession {
        name: request.name,
        kind: String::from("ssh"),
        payload,
        secret_ref,
    };

    if let Some(prev) = existing
        && let Some(updated) = store.update_session(&prev.id, draft.clone())?
    {
        return Ok(updated);
    }

    Ok(store.save(draft)?)
}

/// Resolves a stored SSH profile (including keyring secrets and optional
/// bastion `ProxyJump`) into an [`SshConnectRequest`].
pub(crate) fn resolve_saved_ssh_request(
    saved: &SavedSession,
    secrets: &SecretStore,
) -> Result<SshConnectRequest, ApiError> {
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

    let jump = if let Some(jump_val) = saved.payload.get("jump").and_then(Value::as_object) {
        let j_host = jump_val
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        let j_user = jump_val
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        let j_port = jump_val.get("port").and_then(Value::as_u64).unwrap_or(22) as u16;
        if !j_host.is_empty() && !j_user.is_empty() {
            let j_method = jump_val
                .get("auth")
                .and_then(|a| a.get("method"))
                .and_then(Value::as_str)
                .unwrap_or("privateKey");
            let j_auth = if j_method == "password" {
                let j_acct = jump_val
                    .get("auth")
                    .and_then(|a| a.get("secretRef"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| ssh_secret_account(&j_host, j_port, &j_user));
                let j_pass = secrets.get(&j_acct)?.unwrap_or_default();
                SshAuthRequest::Password { password: j_pass }
            } else {
                let path = jump_val
                    .get("auth")
                    .and_then(|a| a.get("path"))
                    .and_then(Value::as_str)
                    .unwrap_or("~/.ssh/id_ed25519")
                    .to_owned();
                SshAuthRequest::PrivateKey {
                    path,
                    passphrase: None,
                }
            };
            Some(SshJumpRequest {
                host: j_host,
                port: j_port,
                username: j_user,
                auth: j_auth,
            })
        } else {
            None
        }
    } else {
        None
    };

    Ok(SshConnectRequest {
        host,
        port,
        username,
        auth,
        cols: default_cols(),
        rows: default_rows(),
        trust_fingerprint: None,
        jump,
    })
}

/// One host block discovered in the user's `~/.ssh/config`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSshHost {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

/// Scans `~/.ssh/config` and returns concrete host entries suitable for
/// one-click import into saved sessions.
#[tauri::command]
pub fn scan_ssh_config() -> Result<Vec<ImportedSshHost>, ApiError> {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return Ok(Vec::new());
    };
    let config_path = std::path::PathBuf::from(home).join(".ssh").join("config");
    if !config_path.is_file() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&config_path).map_err(|error| {
        ApiError::InvalidRequest(format!("could not read ~/.ssh/config: {error}"))
    })?;
    let default_user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| String::from("root"));
    Ok(parse_ssh_config(&content, &default_user))
}

fn parse_ssh_config(content: &str, default_user: &str) -> Vec<ImportedSshHost> {
    let mut hosts = Vec::new();
    let mut current_aliases: Vec<String> = Vec::new();
    let mut hostname: Option<String> = None;
    let mut port: u16 = 22;
    let mut user: Option<String> = None;
    let mut identity_file: Option<String> = None;
    let mut proxy_jump: Option<String> = None;

    let flush = |hosts: &mut Vec<ImportedSshHost>,
                 aliases: &mut Vec<String>,
                 hostname: &mut Option<String>,
                 port: &mut u16,
                 user: &mut Option<String>,
                 identity_file: &mut Option<String>,
                 proxy_jump: &mut Option<String>| {
        for alias in aliases.drain(..) {
            if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                continue;
            }
            let resolved_host = hostname.clone().unwrap_or_else(|| alias.clone());
            hosts.push(ImportedSshHost {
                alias,
                host: resolved_host,
                port: *port,
                username: user.clone().unwrap_or_else(|| default_user.to_owned()),
                identity_file: identity_file.clone(),
                proxy_jump: proxy_jump.clone(),
            });
        }
        *hostname = None;
        *port = 22;
        *user = None;
        *identity_file = None;
        *proxy_jump = None;
    };

    for raw_line in content.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, |c: char| c.is_whitespace() || c == '=');
        let key = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        let val = parts
            .next()
            .unwrap_or("")
            .trim()
            .trim_start_matches('=')
            .trim()
            .trim_matches('"')
            .to_owned();
        if val.is_empty() {
            continue;
        }
        match key.as_str() {
            "host" => {
                flush(
                    &mut hosts,
                    &mut current_aliases,
                    &mut hostname,
                    &mut port,
                    &mut user,
                    &mut identity_file,
                    &mut proxy_jump,
                );
                current_aliases = val.split_whitespace().map(str::to_owned).collect();
            }
            "hostname" => hostname = Some(val),
            "port" => {
                if let Ok(parsed) = val.parse::<u16>() {
                    port = parsed;
                }
            }
            "user" => user = Some(val),
            "identityfile" => {
                if identity_file.is_none() {
                    identity_file = Some(val);
                }
            }
            "proxyjump" => proxy_jump = Some(val),
            _ => {}
        }
    }

    flush(
        &mut hosts,
        &mut current_aliases,
        &mut hostname,
        &mut port,
        &mut user,
        &mut identity_file,
        &mut proxy_jump,
    );

    hosts
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
            let request = resolve_saved_ssh_request(&saved, &secrets)?;
            connect_ssh(registry, store, request, on_event).await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_config_hosts_and_skips_wildcards() {
        let raw = r#"
# Global defaults
Host *
    ServerAliveInterval 60

Host prod-api
    HostName 10.20.0.15
    User deploy
    Port 2222
    IdentityFile ~/.ssh/prod_ed25519
    ProxyJump bastion@198.51.100.2

Host edge-a edge-b
    User ubuntu
"#;
        let hosts = parse_ssh_config(raw, "yujie");
        assert_eq!(hosts.len(), 3);
        assert_eq!(hosts[0].alias, "prod-api");
        assert_eq!(hosts[0].host, "10.20.0.15");
        assert_eq!(hosts[0].port, 2222);
        assert_eq!(hosts[0].username, "deploy");
        assert_eq!(
            hosts[0].identity_file.as_deref(),
            Some("~/.ssh/prod_ed25519")
        );
        assert_eq!(hosts[0].proxy_jump.as_deref(), Some("bastion@198.51.100.2"));
        assert_eq!(hosts[1].alias, "edge-a");
        assert_eq!(hosts[1].host, "edge-a");
        assert_eq!(hosts[1].username, "ubuntu");
        assert_eq!(hosts[2].alias, "edge-b");
    }
}
