// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Async SSH transport over `russh`, with password and private-key auth.
//!
//! The transport opens one interactive shell channel and exposes it through the
//! shared [`TerminalTransport`] contract, so an SSH tab behaves like a local PTY
//! tab for both the UI and the agent. The handshake + authentication step is
//! shared with the SFTP client so both reuse the same code path.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, Config, Handle};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate, load_secret_key};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use tokio::sync::{broadcast, mpsc};

use crate::error::{CoreError, Result};
use crate::transport::{
    CHUNK_CHANNEL_CAPACITY, OUTPUT_CHANNEL_CAPACITY, SessionId, StreamBatcher, TerminalOutput,
    TerminalTransport, generate_session_id,
};
use crate::tunnel::RemoteForwardTarget;

/// Terminal type advertised to the remote host.
const TERM_VALUE: &str = "xterm-256color";

/// How the client proves its identity.
#[derive(Debug, Clone)]
pub enum SshAuth {
    /// Password authentication.
    Password(String),
    /// Private key authentication, optionally unlocked by a passphrase.
    PrivateKey {
        /// Path to an OpenSSH key file.
        path: PathBuf,
        /// Passphrase for an encrypted key.
        passphrase: Option<String>,
    },
}

/// Bastion / jump-host parameters for `ProxyJump` tunneling.
#[derive(Debug, Clone)]
pub struct SshJumpConfig {
    /// Bastion hostname or IP address.
    pub host: String,
    /// Bastion TCP port, usually 22.
    pub port: u16,
    /// Bastion remote user.
    pub username: String,
    /// Bastion authentication method.
    pub auth: SshAuth,
    /// Optional pinned fingerprint for the bastion host.
    pub known_host_fingerprint: Option<String>,
}

/// Connection parameters for one SSH session.
#[derive(Debug, Clone)]
pub struct SshConfig {
    /// Hostname or IP address.
    pub host: String,
    /// TCP port, usually 22.
    pub port: u16,
    /// Remote user.
    pub username: String,
    /// Authentication method.
    pub auth: SshAuth,
    /// Initial column count.
    pub cols: u16,
    /// Initial row count.
    pub rows: u16,
    /// Fingerprint pinned by a previous connection. When set, a server
    /// presenting a different key is rejected instead of trusted.
    pub known_host_fingerprint: Option<String>,
    /// Optional bastion host (`ProxyJump`) to tunnel this SSH connection through.
    pub jump: Option<Box<SshJumpConfig>>,
}

impl SshConfig {
    /// Builds a config with an 80x24 grid.
    pub fn new(
        host: impl Into<String>,
        port: u16,
        username: impl Into<String>,
        auth: SshAuth,
    ) -> Self {
        Self {
            host: host.into(),
            port,
            username: username.into(),
            auth,
            cols: 80,
            rows: 24,
            known_host_fingerprint: None,
            jump: None,
        }
    }

    /// Sets the initial grid size.
    pub fn with_grid(mut self, cols: u16, rows: u16) -> Self {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self
    }

    /// Pins the expected server key fingerprint.
    pub fn with_known_host_fingerprint(mut self, fingerprint: impl Into<String>) -> Self {
        let fingerprint = fingerprint.into();
        self.known_host_fingerprint = if fingerprint.is_empty() {
            None
        } else {
            Some(fingerprint)
        };
        self
    }

    /// Routes this connection through an SSH jump / bastion host.
    pub fn with_jump(mut self, jump: SshJumpConfig) -> Self {
        self.jump = Some(Box::new(jump));
        self
    }
}

fn expand_home(path: &std::path::Path) -> PathBuf {
    if let Some(raw) = path.to_str()
        && let Some(stripped) = raw.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    {
        return PathBuf::from(home).join(stripped);
    }
    path.to_path_buf()
}

/// Client handler that records the server key fingerprint and optionally routes
/// inbound remote-forwarded (`-R`) TCP channels to a local target.
#[derive(Debug, Clone)]
pub(crate) struct SshClientHandler {
    pub(crate) fingerprint: Arc<Mutex<Option<String>>>,
    expected: Option<String>,
    mismatch: Arc<AtomicBool>,
    /// Stop after capturing the key instead of completing the handshake.
    capture_only: bool,
    /// Optional local target for inbound remote port forwarding (`-R`).
    remote_forward: Option<RemoteForwardTarget>,
}

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // First contact records the fingerprint; later contacts must match it.
        // The Tauri layer persists the value, so a swapped key fails the
        // handshake instead of silently trusting a new host.
        let fingerprint = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
            }
            PublicKeyOrCertificate::Certificate(certificate) => certificate
                .public_key()
                .fingerprint(russh::keys::HashAlg::Sha256)
                .to_string(),
        };
        // Probe mode: capture the key and refuse it, which aborts the handshake
        // right after we learned what the server offers.
        if self.capture_only {
            if let Ok(mut slot) = self.fingerprint.lock() {
                *slot = Some(fingerprint);
            }
            return Ok(false);
        }

        if let Some(expected) = &self.expected
            && expected != &fingerprint
        {
            self.mismatch.store(true, Ordering::SeqCst);
            if let Ok(mut slot) = self.fingerprint.lock() {
                *slot = Some(fingerprint);
            }
            return Ok(false);
        }

        if let Ok(mut slot) = self.fingerprint.lock() {
            *slot = Some(fingerprint);
        }
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let Some(target) = self.remote_forward.clone() else {
            return Ok(());
        };
        reply.accept().await;
        crate::tunnel::spawn_remote_forward_bridge(channel, target);
        Ok(())
    }
}

/// Authenticated primary SSH handle, optional bastion handle, and captured
/// server key fingerprint.
pub(crate) type AuthenticatedSsh = (
    Handle<SshClientHandler>,
    Option<Handle<SshClientHandler>>,
    Arc<Mutex<Option<String>>>,
);

/// Handshake plus authentication, shared by the shell transport, SFTP, and tunnels.
pub(crate) async fn open_authenticated_session(config: &SshConfig) -> Result<AuthenticatedSsh> {
    open_authenticated_session_with_forward(config, None).await
}

async fn authenticate_handle(
    handle: &mut Handle<SshClientHandler>,
    username: &str,
    auth: &SshAuth,
) -> Result<()> {
    let authenticated = match auth {
        SshAuth::Password(password) => handle
            .authenticate_password(username.to_owned(), password.clone())
            .await
            .map_err(|error| CoreError::Ssh(format!("password auth failed: {error}")))?
            .success(),
        SshAuth::PrivateKey { path, passphrase } => {
            let resolved = expand_home(path);
            let key = load_secret_key(&resolved, passphrase.as_deref()).map_err(|error| {
                CoreError::Ssh(format!("could not load `{}`: {error}", resolved.display()))
            })?;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            handle
                .authenticate_publickey(
                    username.to_owned(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|error| CoreError::Ssh(format!("key auth failed: {error}")))?
                .success()
        }
    };

    if !authenticated {
        return Err(CoreError::SshAuth {
            username: username.to_owned(),
        });
    }
    Ok(())
}

/// Handshake plus authentication with an optional remote-forward (`-R`) target
/// and optional `ProxyJump` bastion hop.
pub(crate) async fn open_authenticated_session_with_forward(
    config: &SshConfig,
    remote_forward: Option<RemoteForwardTarget>,
) -> Result<AuthenticatedSsh> {
    let fingerprint = Arc::new(Mutex::new(None));
    let mismatch = Arc::new(AtomicBool::new(false));
    let handler = SshClientHandler {
        fingerprint: Arc::clone(&fingerprint),
        expected: config.known_host_fingerprint.clone(),
        mismatch: Arc::clone(&mismatch),
        capture_only: false,
        remote_forward,
    };

    let (mut handle, jump_handle) = if let Some(jump) = &config.jump {
        let jump_fp = Arc::new(Mutex::new(None));
        let jump_mismatch = Arc::new(AtomicBool::new(false));
        let jump_handler = SshClientHandler {
            fingerprint: Arc::clone(&jump_fp),
            expected: jump.known_host_fingerprint.clone(),
            mismatch: Arc::clone(&jump_mismatch),
            capture_only: false,
            remote_forward: None,
        };
        let mut bastion = client::connect(
            Arc::new(Config::default()),
            (jump.host.clone(), jump.port),
            jump_handler,
        )
        .await
        .map_err(|error| {
            CoreError::Ssh(format!(
                "bastion handshake with {}:{} failed: {error}",
                jump.host, jump.port
            ))
        })?;
        authenticate_handle(&mut bastion, &jump.username, &jump.auth).await?;

        let channel = bastion
            .channel_open_direct_tcpip(
                config.host.clone(),
                u32::from(config.port),
                String::from("127.0.0.1"),
                0,
            )
            .await
            .map_err(|error| {
                CoreError::Ssh(format!(
                    "bastion could not forward to {}:{}: {error}",
                    config.host, config.port
                ))
            })?;

        let inner =
            client::connect_stream(Arc::new(Config::default()), channel.into_stream(), handler)
                .await
                .map_err(|error| {
                    if mismatch.load(Ordering::SeqCst) {
                        let actual = fingerprint
                            .lock()
                            .ok()
                            .and_then(|slot| slot.clone())
                            .unwrap_or_default();
                        return CoreError::SshHostKeyMismatch {
                            host: config.host.clone(),
                            expected: config.known_host_fingerprint.clone().unwrap_or_default(),
                            actual,
                        };
                    }
                    CoreError::Ssh(format!(
                        "handshake with {}:{} via bastion {}:{} failed: {error}",
                        config.host, config.port, jump.host, jump.port
                    ))
                })?;
        (inner, Some(bastion))
    } else {
        let direct = client::connect(
            Arc::new(Config::default()),
            (config.host.clone(), config.port),
            handler,
        )
        .await
        .map_err(|error| {
            if mismatch.load(Ordering::SeqCst) {
                let actual = fingerprint
                    .lock()
                    .ok()
                    .and_then(|slot| slot.clone())
                    .unwrap_or_default();
                return CoreError::SshHostKeyMismatch {
                    host: config.host.clone(),
                    expected: config.known_host_fingerprint.clone().unwrap_or_default(),
                    actual,
                };
            }
            CoreError::Ssh(format!(
                "handshake with {}:{} failed: {error}",
                config.host, config.port
            ))
        })?;
        (direct, None)
    };

    authenticate_handle(&mut handle, &config.username, &config.auth).await?;

    Ok((handle, jump_handle, fingerprint))
}

/// Connects only far enough to learn the server key, then aborts.
///
/// This is what lets the UI show a fingerprint *before* a shell opens, instead of
/// trusting first contact silently.
pub async fn probe_host_key(host: &str, port: u16, timeout: Duration) -> Result<String> {
    let fingerprint = Arc::new(Mutex::new(None));
    let handler = SshClientHandler {
        fingerprint: Arc::clone(&fingerprint),
        expected: None,
        mismatch: Arc::new(AtomicBool::new(false)),
        capture_only: true,
        remote_forward: None,
    };

    // The handshake is expected to fail; only the captured key matters.
    let _ = tokio::time::timeout(
        timeout,
        client::connect(
            Arc::new(Config::default()),
            (host.to_owned(), port),
            handler,
        ),
    )
    .await;

    fingerprint
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .ok_or_else(|| CoreError::Ssh(String::from("host did not present a key")))
}

/// A live SSH shell session.
pub struct SshTransport {
    session_id: SessionId,
    host: String,
    username: String,
    handle: Mutex<Option<Arc<Handle<SshClientHandler>>>>,
    jump_handle: Mutex<Option<Handle<SshClientHandler>>>,
    writer: ChannelWriteHalf<client::Msg>,
    output: broadcast::Sender<TerminalOutput>,
    fingerprint: Arc<Mutex<Option<String>>>,
    closed: AtomicBool,
}

impl SshTransport {
    /// Connects, authenticates and opens an interactive shell channel.
    pub async fn connect(config: SshConfig) -> Result<(Self, broadcast::Receiver<TerminalOutput>)> {
        let session_id = generate_session_id("ssh");
        let (handle, jump_handle, fingerprint) = open_authenticated_session(&config).await?;

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|error| CoreError::Ssh(format!("could not open shell channel: {error}")))?;

        channel
            .request_pty(
                true,
                TERM_VALUE,
                u32::from(config.cols),
                u32::from(config.rows),
                0,
                0,
                &[],
            )
            .await
            .map_err(|error| CoreError::Ssh(format!("pty request rejected: {error}")))?;

        channel
            .request_shell(true)
            .await
            .map_err(|error| CoreError::Ssh(format!("shell request rejected: {error}")))?;

        let (mut read_half, writer) = channel.split();

        let (output, output_rx) = broadcast::channel(OUTPUT_CHANNEL_CAPACITY);
        let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>(CHUNK_CHANNEL_CAPACITY);

        let batcher = StreamBatcher::new(session_id.clone(), chunk_rx, output.clone());
        tokio::spawn(async move {
            batcher.run().await;
        });

        tokio::spawn(async move {
            while let Some(message) = read_half.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        if chunk_tx.send(data.to_vec()).await.is_err() {
                            break;
                        }
                    }
                    // stderr from a shell also belongs on the user's screen.
                    ChannelMsg::ExtendedData { data, .. } => {
                        if chunk_tx.send(data.to_vec()).await.is_err() {
                            break;
                        }
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
        });

        let transport = Self {
            session_id,
            host: config.host,
            username: config.username,
            handle: Mutex::new(Some(Arc::new(handle))),
            jump_handle: Mutex::new(jump_handle),
            writer,
            output,
            fingerprint,
            closed: AtomicBool::new(false),
        };

        Ok((transport, output_rx))
    }

    /// Remote host this session is connected to.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// Remote user this session authenticated as.
    pub fn username(&self) -> &str {
        &self.username
    }

    /// SHA-256 fingerprint of the server key, once the handshake completed.
    pub fn server_key_fingerprint(&self) -> Option<String> {
        self.fingerprint.lock().ok().and_then(|slot| slot.clone())
    }
}

#[async_trait]
impl TerminalTransport for SshTransport {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    async fn write_bytes(&self, data: &[u8]) -> Result<()> {
        if self.closed.load(Ordering::Relaxed) {
            return Err(CoreError::SessionClosed(
                self.session_id.as_str().to_owned(),
            ));
        }
        self.writer
            .data_bytes(data.to_vec())
            .await
            .map_err(|error| CoreError::Ssh(format!("write failed: {error}")))
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 {
            return Err(CoreError::InvalidGeometry { cols, rows });
        }
        self.writer
            .window_change(u32::from(cols), u32::from(rows), 0, 0)
            .await
            .map_err(|error| CoreError::Ssh(format!("window change failed: {error}")))
    }

    fn subscribe_output(&self) -> broadcast::Receiver<TerminalOutput> {
        self.output.subscribe()
    }

    async fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let _ = self.writer.eof().await;
        let _ = self.writer.close().await;

        let handle = self.handle.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "session closed", "en")
                .await;
        }
        let jump_handle = self
            .jump_handle
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(jump) = jump_handle {
            let _ = jump
                .disconnect(Disconnect::ByApplication, "bastion closed", "en")
                .await;
        }
        Ok(())
    }

    async fn probe_latency(&self) -> Result<Option<u64>> {
        if self.closed.load(Ordering::Relaxed) {
            return Err(CoreError::SessionClosed(
                self.session_id.as_str().to_owned(),
            ));
        }
        let handle = self
            .handle
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(Arc::clone));
        let Some(handle) = handle else {
            return Err(CoreError::SessionClosed(
                self.session_id.as_str().to_owned(),
            ));
        };

        let started = std::time::Instant::now();
        match tokio::time::timeout(Duration::from_secs(4), handle.send_ping()).await {
            Ok(Ok(())) => Ok(Some(started.elapsed().as_millis().max(1) as u64)),
            Ok(Err(error)) => Err(CoreError::Ssh(format!("latency probe failed: {error}"))),
            Err(_) => Err(CoreError::Ssh(String::from("latency probe timed out"))),
        }
    }

    async fn exec_aux(&self, command: &str) -> Result<Option<String>> {
        if self.closed.load(Ordering::Relaxed) {
            return Err(CoreError::SessionClosed(
                self.session_id.as_str().to_owned(),
            ));
        }
        let handle = self
            .handle
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(Arc::clone));
        let Some(handle) = handle else {
            return Err(CoreError::SessionClosed(
                self.session_id.as_str().to_owned(),
            ));
        };

        let fut = async {
            let mut channel = handle
                .channel_open_session()
                .await
                .map_err(|error| CoreError::Ssh(format!("aux exec channel failed: {error}")))?;
            channel
                .exec(true, command)
                .await
                .map_err(|error| CoreError::Ssh(format!("aux exec rejected: {error}")))?;

            let mut out = Vec::with_capacity(1024);
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => {
                        if out.len() < 64 * 1024 {
                            out.extend_from_slice(&data);
                        }
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let _ = channel.close().await;
            Ok::<Option<String>, CoreError>(Some(String::from_utf8_lossy(&out).into_owned()))
        };

        match tokio::time::timeout(Duration::from_secs(5), fut).await {
            Ok(res) => res,
            Err(_) => Err(CoreError::Ssh(String::from("aux exec timed out"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_to_a_standard_grid() {
        let config = SshConfig::new(
            "example.internal",
            22,
            "root",
            SshAuth::Password("x".into()),
        );
        assert_eq!(config.cols, 80);
        assert_eq!(config.rows, 24);
        assert_eq!(config.port, 22);
    }

    #[test]
    fn grid_is_clamped_to_at_least_one_cell() {
        let config =
            SshConfig::new("host", 22, "user", SshAuth::Password("x".into())).with_grid(0, 0);
        assert_eq!(config.cols, 1);
        assert_eq!(config.rows, 1);
    }
}
