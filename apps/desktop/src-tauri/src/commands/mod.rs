// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Domain-organized Tauri command modules.

pub mod agent;
pub mod session;
pub mod sftp;
pub mod store;
pub mod tunnel;

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use term_core::{SshAuth, SshConfig, SshJumpConfig};

use crate::error::ApiError;

/// Identifier for a row in the saved-session table.
pub fn new_stored_id() -> String {
    term_core::generate_session_id("saved").into_string()
}

/// Default initial column count when omitted by a caller.
pub(crate) fn default_cols() -> u16 {
    100
}

/// Default initial row count when omitted by a caller.
pub(crate) fn default_rows() -> u16 {
    30
}

/// Authentication choice coming from the SSH dialog or saved profile.
#[derive(Debug, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum SshAuthRequest {
    /// Password authentication.
    Password {
        /// Password to try.
        password: String,
    },
    /// Private key authentication.
    PrivateKey {
        /// Path to the key file.
        path: String,
        /// Passphrase for an encrypted key.
        #[serde(default)]
        passphrase: Option<String>,
    },
}

impl SshAuthRequest {
    pub(crate) fn into_auth(self) -> SshAuth {
        match self {
            Self::Password { password } => SshAuth::Password(password),
            Self::PrivateKey { path, passphrase } => SshAuth::PrivateKey {
                path: PathBuf::from(path),
                passphrase,
            },
        }
    }
}

/// Bastion / jump-host parameters (`ProxyJump`) passed from the UI or saved profile.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshJumpRequest {
    /// Bastion hostname or IP address.
    pub host: String,
    /// Bastion TCP port.
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    /// Bastion remote user.
    pub username: String,
    /// Bastion authentication choice.
    pub auth: SshAuthRequest,
}

fn default_ssh_port() -> u16 {
    22
}

/// Arguments for SSH shell and SFTP connection commands.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectRequest {
    /// Hostname or IP address.
    pub host: String,
    /// TCP port.
    pub port: u16,
    /// Remote user.
    pub username: String,
    /// Authentication choice.
    pub auth: SshAuthRequest,
    /// Requested columns.
    #[serde(default = "default_cols")]
    pub cols: u16,
    /// Requested rows.
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// Fingerprint the user just approved on first contact.
    #[serde(default)]
    pub trust_fingerprint: Option<String>,
    /// Optional bastion host (`ProxyJump`) to connect through.
    #[serde(default)]
    pub jump: Option<SshJumpRequest>,
}

impl SshConnectRequest {
    pub(crate) fn into_config(self) -> SshConfig {
        let mut config = SshConfig::new(self.host, self.port, self.username, self.auth.into_auth())
            .with_grid(self.cols, self.rows);
        if let Some(jump) = self.jump {
            config = config.with_jump(SshJumpConfig {
                host: jump.host,
                port: jump.port,
                username: jump.username,
                auth: jump.auth.into_auth(),
                known_host_fingerprint: None,
            });
        }
        config
    }
}

pub(crate) fn string_field(payload: &Value, key: &str) -> Result<String, ApiError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ApiError::InvalidRequest(format!("missing field `{key}`")))
}
