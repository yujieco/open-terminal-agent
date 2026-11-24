// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! SFTP file browser commands.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;
use term_core::SftpEntry;

use crate::commands::{
    SshAuthRequest, SshConnectRequest, default_cols, default_rows, string_field,
};
use crate::error::ApiError;
use crate::secrets::{SecretStore, ssh_secret_account};
use crate::state::SftpRegistry;
use crate::store::Store;

/// Handle returned by [`sftp_connect`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpSessionInfo {
    /// Connection id used by later SFTP commands.
    pub connection_id: String,
    /// Remote host.
    pub host: String,
    /// Remote user.
    pub username: String,
    /// Absolute path of the user's home directory.
    pub home: String,
}

/// Opens a long-lived SFTP connection for the file browser.
#[tauri::command]
pub async fn sftp_connect(
    registry: State<'_, SftpRegistry>,
    request: SshConnectRequest,
) -> Result<SftpSessionInfo, ApiError> {
    let config = request.into_config();
    let host = config.host.clone();
    let username = config.username.clone();

    let client = term_core::SftpClient::connect(config).await?;
    let home = client
        .canonicalize(".")
        .await
        .unwrap_or_else(|_| String::from("."));
    let connection_id = registry.insert(Arc::new(client))?;

    Ok(SftpSessionInfo {
        connection_id,
        host,
        username,
        home,
    })
}

/// Opens SFTP using a stored SSH profile, resolving its secret first.
#[tauri::command]
pub async fn sftp_connect_saved(
    registry: State<'_, SftpRegistry>,
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    id: String,
) -> Result<SftpSessionInfo, ApiError> {
    let saved = store
        .get(&id)?
        .ok_or_else(|| ApiError::UnknownSavedSession(id.clone()))?;
    if saved.kind != "ssh" {
        return Err(ApiError::InvalidRequest(String::from(
            "only SSH profiles can open an SFTP browser",
        )));
    }

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
            .ok_or(ApiError::SecretMissing { account })?;
        SshAuthRequest::Password { password }
    };

    sftp_connect(
        registry,
        SshConnectRequest {
            host,
            port,
            username,
            auth,
            cols: default_cols(),
            rows: default_rows(),
            trust_fingerprint: None,
        },
    )
    .await
}

/// Lists one remote directory.
#[tauri::command]
pub async fn sftp_list_dir(
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, ApiError> {
    let client = registry.require(&connection_id)?;
    Ok(client.list_dir(&path).await?)
}

/// Downloads a remote file to a local path, returning the byte count.
#[tauri::command]
pub async fn sftp_download(
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    remote_path: String,
    local_path: String,
) -> Result<u64, ApiError> {
    let client = registry.require(&connection_id)?;
    Ok(client
        .download(&remote_path, &PathBuf::from(local_path))
        .await?)
}

/// Uploads a local file to a remote path, returning the byte count.
#[tauri::command]
pub async fn sftp_upload(
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    local_path: String,
    remote_path: String,
) -> Result<u64, ApiError> {
    let client = registry.require(&connection_id)?;
    Ok(client
        .upload(&PathBuf::from(local_path), &remote_path)
        .await?)
}

/// Closes an SFTP connection.
#[tauri::command]
pub async fn sftp_close(
    registry: State<'_, SftpRegistry>,
    connection_id: String,
) -> Result<(), ApiError> {
    match registry.remove(&connection_id)? {
        Some(client) => {
            client.close().await;
            Ok(())
        }
        None => Err(ApiError::UnknownSftpSession(connection_id)),
    }
}
