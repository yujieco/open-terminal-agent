// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! SFTP file browser commands.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter as _, State};
use term_core::SftpEntry;

/// Event emitted during SFTP upload/download transfers.
pub const SFTP_PROGRESS_EVENT: &str = "ota:sftp-progress";

/// Maximum file size (512 KB) permitted in the inline SFTP text editor.
const MAX_INLINE_EDIT_BYTES: usize = 512 * 1024;

/// Progress event payload streamed to the SFTP drawer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpProgressEvent {
    pub connection_id: String,
    pub kind: String,
    pub name: String,
    pub transferred: u64,
    pub total: Option<u64>,
}

use crate::commands::SshConnectRequest;
use crate::error::ApiError;
use crate::secrets::SecretStore;
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

    let request = crate::commands::store::resolve_saved_ssh_request(&saved, &secrets)?;
    sftp_connect(registry, request).await
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

/// Downloads a remote file to a local path, streaming progress events and
/// returning the byte count.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    remote_path: String,
    local_path: String,
) -> Result<u64, ApiError> {
    let client = registry.require(&connection_id)?;
    let name = remote_path
        .rsplit('/')
        .next()
        .unwrap_or(&remote_path)
        .to_owned();
    let conn_id = connection_id.clone();
    let mut last_emitted = 0u64;
    Ok(client
        .download_with_progress(
            &remote_path,
            &PathBuf::from(local_path),
            |transferred, total| {
                let finished = total.is_some_and(|size| transferred >= size);
                if transferred == 0
                    || finished
                    || transferred.saturating_sub(last_emitted) >= 64 * 1024
                {
                    last_emitted = transferred;
                    let _ = app.emit(
                        SFTP_PROGRESS_EVENT,
                        SftpProgressEvent {
                            connection_id: conn_id.clone(),
                            kind: String::from("download"),
                            name: name.clone(),
                            transferred,
                            total,
                        },
                    );
                }
            },
        )
        .await?)
}

/// Uploads a local file to a remote path, streaming progress events and
/// returning the byte count.
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    local_path: String,
    remote_path: String,
) -> Result<u64, ApiError> {
    let client = registry.require(&connection_id)?;
    let name = remote_path
        .rsplit('/')
        .next()
        .unwrap_or(&remote_path)
        .to_owned();
    let conn_id = connection_id.clone();
    let mut last_emitted = 0u64;
    Ok(client
        .upload_with_progress(
            &PathBuf::from(local_path),
            &remote_path,
            |transferred, total| {
                let finished = total.is_some_and(|size| transferred >= size);
                if transferred == 0
                    || finished
                    || transferred.saturating_sub(last_emitted) >= 64 * 1024
                {
                    last_emitted = transferred;
                    let _ = app.emit(
                        SFTP_PROGRESS_EVENT,
                        SftpProgressEvent {
                            connection_id: conn_id.clone(),
                            kind: String::from("upload"),
                            name: name.clone(),
                            transferred,
                            total,
                        },
                    );
                }
            },
        )
        .await?)
}

/// Uploads base64-encoded bytes (from drag-and-drop) to a remote path.
#[tauri::command]
pub async fn sftp_upload_bytes(
    app: AppHandle,
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    remote_path: String,
    data_base64: String,
) -> Result<u64, ApiError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|error| ApiError::InvalidRequest(format!("invalid base64 payload: {error}")))?;
    let total = Some(bytes.len() as u64);
    let name = remote_path
        .rsplit('/')
        .next()
        .unwrap_or(&remote_path)
        .to_owned();
    let _ = app.emit(
        SFTP_PROGRESS_EVENT,
        SftpProgressEvent {
            connection_id: connection_id.clone(),
            kind: String::from("upload"),
            name: name.clone(),
            transferred: 0,
            total,
        },
    );
    let client = registry.require(&connection_id)?;
    let written = client.upload_bytes(&bytes, &remote_path).await?;
    let _ = app.emit(
        SFTP_PROGRESS_EVENT,
        SftpProgressEvent {
            connection_id,
            kind: String::from("upload"),
            name,
            transferred: written,
            total,
        },
    );
    Ok(written)
}

/// Creates a remote directory.
#[tauri::command]
pub async fn sftp_mkdir(
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    path: String,
) -> Result<(), ApiError> {
    let client = registry.require(&connection_id)?;
    Ok(client.mkdir(&path).await?)
}

/// Removes a remote file or empty directory.
#[tauri::command]
pub async fn sftp_delete(
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), ApiError> {
    let client = registry.require(&connection_id)?;
    Ok(client.remove(&path, is_dir).await?)
}

/// Renames or moves a remote file or directory.
#[tauri::command]
pub async fn sftp_rename(
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), ApiError> {
    let client = registry.require(&connection_id)?;
    Ok(client.rename(&old_path, &new_path).await?)
}

/// Reads a remote UTF-8 text file (up to 512 KB) for inline editing.
#[tauri::command]
pub async fn sftp_read_text(
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    remote_path: String,
) -> Result<String, ApiError> {
    let client = registry.require(&connection_id)?;
    Ok(client
        .read_text(&remote_path, MAX_INLINE_EDIT_BYTES)
        .await?)
}

/// Saves UTF-8 text back to a remote file.
#[tauri::command]
pub async fn sftp_write_text(
    registry: State<'_, SftpRegistry>,
    connection_id: String,
    remote_path: String,
    content: String,
) -> Result<u64, ApiError> {
    let client = registry.require(&connection_id)?;
    Ok(client.write_text(&remote_path, &content).await?)
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
