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
use tokio::io::AsyncWriteExt;

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
}

/// Authenticated SFTP session.
pub struct SftpClient {
    session: Arc<SftpSession>,
    handle: Mutex<Option<Handle<SshClientHandler>>>,
    host: String,
    username: String,
}

impl SftpClient {
    /// Connects and opens the `sftp` subsystem channel.
    pub async fn connect(config: SshConfig) -> Result<Self> {
        let (handle, _fingerprint) = open_authenticated_session(&config).await?;

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
                SftpEntry {
                    name: entry.file_name(),
                    path: entry.path(),
                    directory: matches!(file_type, FileType::Dir),
                    symlink: matches!(file_type, FileType::Symlink),
                    size: entry.metadata().size,
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

    /// Streams a remote file to a local path, returning the byte count.
    pub async fn download(&self, remote: &str, local: &Path) -> Result<u64> {
        let mut source = self
            .session
            .open(remote)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not open `{remote}`: {error}")))?;

        let mut target = tokio::fs::File::create(local)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not create local file: {error}")))?;

        let written = tokio::io::copy(&mut source, &mut target)
            .await
            .map_err(|error| CoreError::Sftp(format!("transfer failed: {error}")))?;
        target
            .flush()
            .await
            .map_err(|error| CoreError::Sftp(format!("flush failed: {error}")))?;
        Ok(written)
    }

    /// Streams a local file to a remote path, returning the byte count.
    pub async fn upload(&self, local: &Path, remote: &str) -> Result<u64> {
        let mut source = tokio::fs::File::open(local)
            .await
            .map_err(|error| CoreError::Sftp(format!("could not open local file: {error}")))?;

        let mut target =
            self.session.create(remote).await.map_err(|error| {
                CoreError::Sftp(format!("could not create `{remote}`: {error}"))
            })?;

        let written = tokio::io::copy(&mut source, &mut target)
            .await
            .map_err(|error| CoreError::Sftp(format!("transfer failed: {error}")))?;
        target
            .shutdown()
            .await
            .map_err(|error| CoreError::Sftp(format!("could not close remote file: {error}")))?;
        Ok(written)
    }

    /// Closes the SFTP channel and the underlying SSH connection.
    pub async fn close(&self) {
        let handle = self.handle.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "sftp closed", "en")
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
        };
        let encoded = serde_json::to_value(&entry).expect("serialize");
        assert_eq!(encoded["name"], "boot.bin");
        assert_eq!(encoded["directory"], false);
        assert_eq!(encoded["size"], 4096);
    }
}
