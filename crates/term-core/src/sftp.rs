// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! SFTP browsing and file transfer over an authenticated SSH session.
//!
//! A directory listing is what the sidebar file browser needs; download and
//! upload use the high level `File` handle from `russh-sftp`, which implements
//! `AsyncRead` / `AsyncWrite`, so transfers are streamed rather than buffered.

use std::path::Path;
use std::sync::{Arc, Mutex};

use russh::client::Handle;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{CoreError, Result};
use crate::ssh::{SshClientHandler, SshConfig, open_authenticated_session};

/// One remote directory entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    /// File name without a path.
    pub name: String,
    /// Full remote path, built by joining the listed directory with the name.
    pub path: String,
    /// Whether the entry is a directory.
    pub directory: bool,
    /// Whether the entry is a symbolic link.
    pub symlink: bool,
    /// Size in bytes, when the server reports it.
    pub size: Option<u64>,
    /// POSIX mode bits (e.g. `0o100644`), when the server reports them.
    pub permissions: Option<u32>,
    /// Last modification time (Unix seconds), when the server reports it.
    pub modified: Option<u32>,
}

/// Authenticated SFTP session.
pub struct SftpClient {
    session: Arc<SftpSession>,
    handle: Mutex<Option<Handle<SshClientHandler>>>,
    jump_handle: Mutex<Option<Handle<SshClientHandler>>>,
    host: String,
    username: String,
}

impl SftpClient {
    /// Connects and opens the `sftp` subsystem channel.
    pub async fn connect(config: SshConfig) -> Result<Self> {
        let (handle, jump_handle, _fingerprint) = open_authenticated_session(&config).await?;

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|error| CoreError::Sftp(format!("could not open sftp channel: {error}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| CoreError::Sftp(format!("sftp subsystem rejected: {error}")))?;

        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| CoreError::Sftp(format!("sftp handshake failed: {error}")))?;

        Ok(Self {
            session: Arc::new(session),
            handle: Mutex::new(Some(handle)),
            jump_handle: Mutex::new(jump_handle),
            host: config.host,
            username: config.username,
        })
    }

    /// Remote host this client is connected to.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// Remote user this client authenticated as.
    pub fn username(&self) -> &str {
        &self.username
    }

    /// Lists a remote directory, directories first then case-insensitive by name.
    pub async fn list_dir(&self, path: &str) -> Result<Vec<SftpEntry>> {
        let entries = self
            .session
            .read_dir(path)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not list `{path}`: {error}")))?;

        let mut described: Vec<SftpEntry> = entries
            .map(|entry| {
                let file_type = entry.file_type();
                let meta = entry.metadata();
                SftpEntry {
                    name: entry.file_name(),
                    path: entry.path(),
                    directory: matches!(file_type, FileType::Dir),
                    symlink: matches!(file_type, FileType::Symlink),
                    size: meta.size,
                    permissions: meta.permissions,
                    modified: meta.mtime,
                }
            })
            .collect();

        described.sort_by(|left, right| {
            right
                .directory
                .cmp(&left.directory)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(described)
    }

    /// Resolves `.` or any relative path to an absolute remote path.
    pub async fn canonicalize(&self, path: &str) -> Result<String> {
        self.session
            .canonicalize(path)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not resolve `{path}`: {error}")))
    }

    /// Creates a new remote directory.
    pub async fn mkdir(&self, path: &str) -> Result<()> {
        self.session
            .create_dir(path)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not create dir `{path}`: {error}")))
    }

    /// Removes a remote file or empty directory.
    pub async fn remove(&self, path: &str, is_dir: bool) -> Result<()> {
        if is_dir {
            self.session
                .remove_dir(path)
                .await
                .map_err(|error| CoreError::Sftp(format!("could not remove dir `{path}`: {error}")))
        } else {
            self.session.remove_file(path).await.map_err(|error| {
                CoreError::Sftp(format!("could not remove file `{path}`: {error}"))
            })
        }
    }

    /// Renames or moves a remote file or directory.
    pub async fn rename(&self, old_path: &str, new_path: &str) -> Result<()> {
        self.session
            .rename(old_path, new_path)
            .await
            .map_err(|error| {
                CoreError::Sftp(format!(
                    "could not rename `{old_path}` to `{new_path}`: {error}"
                ))
            })
    }

    /// Reads a remote text file up to `max_bytes` for inline preview/editing.
    pub async fn read_text(&self, remote: &str, max_bytes: usize) -> Result<String> {
        let mut source = self
            .session
            .open(remote)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not open `{remote}`: {error}")))?;

        let mut buffer = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let read = source
                .read(&mut chunk)
                .await
                .map_err(|error| CoreError::Sftp(format!("could not read `{remote}`: {error}")))?;
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.len() > max_bytes {
                return Err(CoreError::Sftp(format!(
                    "file exceeds inline editor limit ({} KB)",
                    max_bytes / 1024
                )));
            }
        }
        if buffer.contains(&0) {
            return Err(CoreError::Sftp(String::from(
                "binary files cannot be opened in the inline text editor",
            )));
        }
        String::from_utf8(buffer).map_err(|_| {
            CoreError::Sftp(String::from(
                "file is not valid UTF-8 text and cannot be edited inline",
            ))
        })
    }

    /// Writes UTF-8 text to a remote file, returning the byte count written.
    pub async fn write_text(&self, remote: &str, content: &str) -> Result<u64> {
        self.upload_bytes(content.as_bytes(), remote).await
    }

    /// Writes raw bytes directly to a remote file (used by drag-and-drop uploads).
    pub async fn upload_bytes(&self, data: &[u8], remote: &str) -> Result<u64> {
        let mut target =
            self.session.create(remote).await.map_err(|error| {
                CoreError::Sftp(format!("could not create `{remote}`: {error}"))
            })?;
        target
            .write_all(data)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not write `{remote}`: {error}")))?;
        target
            .shutdown()
            .await
            .map_err(|error| CoreError::Sftp(format!("could not close `{remote}`: {error}")))?;
        Ok(data.len() as u64)
    }

    /// Streams a remote file to a local path with progress callback.
    pub async fn download_with_progress<F>(
        &self,
        remote: &str,
        local: &Path,
        mut on_progress: F,
    ) -> Result<u64>
    where
        F: FnMut(u64, Option<u64>),
    {
        let total = self
            .session
            .metadata(remote)
            .await
            .ok()
            .and_then(|meta| meta.size);

        let mut source = self
            .session
            .open(remote)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not open `{remote}`: {error}")))?;

        let mut target = tokio::fs::File::create(local)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not create local file: {error}")))?;

        let mut transferred = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];
        on_progress(0, total);
        loop {
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|error| CoreError::Sftp(format!("transfer failed: {error}")))?;
            if read == 0 {
                break;
            }
            target
                .write_all(&buffer[..read])
                .await
                .map_err(|error| CoreError::Sftp(format!("transfer failed: {error}")))?;
            transferred += read as u64;
            on_progress(transferred, total);
        }
        target
            .flush()
            .await
            .map_err(|error| CoreError::Sftp(format!("flush failed: {error}")))?;
        Ok(transferred)
    }

    /// Streams a remote file to a local path, returning the byte count.
    pub async fn download(&self, remote: &str, local: &Path) -> Result<u64> {
        self.download_with_progress(remote, local, |_, _| {}).await
    }

    /// Streams a local file to a remote path with progress callback.
    pub async fn upload_with_progress<F>(
        &self,
        local: &Path,
        remote: &str,
        mut on_progress: F,
    ) -> Result<u64>
    where
        F: FnMut(u64, Option<u64>),
    {
        let total = tokio::fs::metadata(local).await.ok().map(|meta| meta.len());

        let mut source = tokio::fs::File::open(local)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not open local file: {error}")))?;

        let mut target =
            self.session.create(remote).await.map_err(|error| {
                CoreError::Sftp(format!("could not create `{remote}`: {error}"))
            })?;

        let mut transferred = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];
        on_progress(0, total);
        loop {
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|error| CoreError::Sftp(format!("transfer failed: {error}")))?;
            if read == 0 {
                break;
            }
            target
                .write_all(&buffer[..read])
                .await
                .map_err(|error| CoreError::Sftp(format!("transfer failed: {error}")))?;
            transferred += read as u64;
            on_progress(transferred, total);
        }
        target
            .shutdown()
            .await
            .map_err(|error| CoreError::Sftp(format!("could not close remote file: {error}")))?;
        Ok(transferred)
    }

    /// Streams a local file to a remote path, returning the byte count.
    pub async fn upload(&self, local: &Path, remote: &str) -> Result<u64> {
        self.upload_with_progress(local, remote, |_, _| {}).await
    }

    /// Closes the SFTP channel and the underlying SSH connection.
    pub async fn close(&self) {
        let handle = self.handle.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "sftp closed", "en")
                .await;
        }
        let jump = self
            .jump_handle
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(jump) = jump {
            let _ = jump
                .disconnect(russh::Disconnect::ByApplication, "bastion closed", "en")
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_serialize_as_camel_case_for_the_webview() {
        let entry = SftpEntry {
            name: String::from("boot.bin"),
            path: String::from("/tmp/boot.bin"),
            directory: false,
            symlink: false,
            size: Some(4096),
            permissions: Some(0o100644),
            modified: Some(1_700_000_000),
        };
        let encoded = serde_json::to_value(&entry).expect("serialize");
        assert_eq!(encoded["name"], "boot.bin");
        assert_eq!(encoded["directory"], false);
        assert_eq!(encoded["size"], 4096);
        assert_eq!(encoded["permissions"], 0o100644);
        assert_eq!(encoded["modified"], 1_700_000_000);
    }
}
