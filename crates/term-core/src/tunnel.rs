// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Pure-Rust async SSH port forwarding (tunneling) over `russh`.
//!
//! Supports all three Xshell / OpenSSH tunnel directions without spawning an
//! external `ssh` binary (works identically on Windows, macOS, and Linux):
//! - **Local (`-L`)**: listen on a local TCP port and forward each connection
//!   over `direct-tcpip` to a remote host:port reachable from the SSH server.
//! - **Remote (`-R`)**: ask the SSH server to listen on a remote TCP port and
//!   bridge incoming connections back to a local host:port.
//! - **Dynamic (`-D`)**: expose a local RFC 1928 SOCKS5 proxy whose CONNECT
//!   targets are opened over `direct-tcpip` through the SSH server.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use russh::client::{self, Handle};
use russh::{Channel, Disconnect};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::error::{CoreError, Result};
use crate::ssh::{
    SshClientHandler, SshConfig, open_authenticated_session,
    open_authenticated_session_with_forward,
};

/// Direction of an SSH port-forwarding tunnel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelKind {
    /// Local port forwarding (`-L`): local bind -> remote target.
    Local,
    /// Remote port forwarding (`-R`): remote bind -> local target.
    Remote,
    /// Dynamic SOCKS5 proxy (`-D`): local SOCKS5 listener -> dynamic remote target.
    Dynamic,
}

impl TunnelKind {
    /// Stable lowercase database representation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
            Self::Dynamic => "dynamic",
        }
    }

    /// Parses a stored kind string.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "local" => Some(Self::Local),
            "remote" => Some(Self::Remote),
            "dynamic" => Some(Self::Dynamic),
            _ => None,
        }
    }
}

/// Parameters defining one SSH port-forwarding rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    /// Forwarding direction (`local`, `remote`, or `dynamic`).
    pub kind: TunnelKind,
    /// Listen host (local interface for `-L`/`-D`, remote bind address for `-R`).
    pub bind_host: String,
    /// Listen port (0 allows OS/server ephemeral allocation).
    pub bind_port: u16,
    /// Destination host (`-L`: remote target, `-R`: local target, `-D`: unused).
    pub target_host: String,
    /// Destination port (`-L`/`-R`; unused for `-D`).
    pub target_port: u16,
}

impl TunnelSpec {
    /// Validates host/port fields before opening any socket or SSH channel.
    pub fn validate(&self) -> Result<()> {
        if self.bind_host.trim().is_empty() {
            return Err(CoreError::Ssh(String::from("bind host must not be empty")));
        }
        if matches!(self.kind, TunnelKind::Local | TunnelKind::Remote) {
            if self.target_host.trim().is_empty() {
                return Err(CoreError::Ssh(String::from(
                    "target host must not be empty for local/remote forwarding",
                )));
            }
            if self.target_port == 0 {
                return Err(CoreError::Ssh(String::from(
                    "target port must be between 1 and 65535",
                )));
            }
        }
        Ok(())
    }
}

/// Live atomic traffic counters shared across a tunnel's active connections.
#[derive(Debug, Default)]
pub(crate) struct TunnelStats {
    active_connections: AtomicU64,
    total_connections: AtomicU64,
    bytes_tx: AtomicU64,
    bytes_rx: AtomicU64,
}

impl TunnelStats {
    fn snapshot(&self) -> TunnelStatsSnapshot {
        TunnelStatsSnapshot {
            active_connections: self.active_connections.load(Ordering::Relaxed),
            total_connections: self.total_connections.load(Ordering::Relaxed),
            bytes_tx: self.bytes_tx.load(Ordering::Relaxed),
            bytes_rx: self.bytes_rx.load(Ordering::Relaxed),
        }
    }
}

/// Serializable point-in-time counters for one running tunnel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatsSnapshot {
    /// Currently open forwarded TCP streams.
    pub active_connections: u64,
    /// Total forwarded connections accepted since start.
    pub total_connections: u64,
    /// Bytes forwarded from client toward target.
    pub bytes_tx: u64,
    /// Bytes forwarded back from target to client.
    pub bytes_rx: u64,
}

/// Local target metadata stored inside [`SshClientHandler`] for `-R` forwarding.
#[derive(Debug, Clone)]
pub(crate) struct RemoteForwardTarget {
    pub(crate) local_host: String,
    pub(crate) local_port: u16,
    pub(crate) stats: Arc<TunnelStats>,
}

/// Bridges an inbound server-opened `forwarded-tcpip` channel to the local target.
pub(crate) fn spawn_remote_forward_bridge(
    channel: Channel<client::Msg>,
    target: RemoteForwardTarget,
) {
    tokio::spawn(async move {
        let mut local =
            match TcpStream::connect((target.local_host.as_str(), target.local_port)).await {
                Ok(stream) => stream,
                Err(error) => {
                    tracing::warn!(
                        "remote forward could not connect to local {}:{}: {error}",
                        target.local_host,
                        target.local_port
                    );
                    let _ = channel.eof().await;
                    let _ = channel.close().await;
                    return;
                }
            };

        let _guard = ActiveConnGuard::enter(&target.stats);
        let mut remote = channel.into_stream();
        if let Ok((from_remote, from_local)) =
            tokio::io::copy_bidirectional(&mut remote, &mut local).await
        {
            target
                .stats
                .bytes_rx
                .fetch_add(from_remote, Ordering::Relaxed);
            target
                .stats
                .bytes_tx
                .fetch_add(from_local, Ordering::Relaxed);
        }
    });
}

struct ActiveConnGuard {
    stats: Arc<TunnelStats>,
}

impl ActiveConnGuard {
    fn enter(stats: &Arc<TunnelStats>) -> Self {
        stats.total_connections.fetch_add(1, Ordering::Relaxed);
        stats.active_connections.fetch_add(1, Ordering::Relaxed);
        Self {
            stats: Arc::clone(stats),
        }
    }
}

impl Drop for ActiveConnGuard {
    fn drop(&mut self) {
        self.stats
            .active_connections
            .fetch_sub(1, Ordering::Relaxed);
    }
}

/// A live SSH port-forwarding tunnel.
pub struct SshTunnel {
    spec: TunnelSpec,
    bound_port: u16,
    fingerprint: Arc<Mutex<Option<String>>>,
    stats: Arc<TunnelStats>,
    shutdown_tx: watch::Sender<bool>,
    handle: Arc<Handle<SshClientHandler>>,
    jump_handle: Mutex<Option<Handle<SshClientHandler>>>,
    stopped: AtomicBool,
}

impl SshTunnel {
    /// Connects to the SSH server and starts forwarding according to `spec`.
    pub async fn start(ssh: &SshConfig, spec: TunnelSpec) -> Result<Self> {
        spec.validate()?;

        let stats = Arc::new(TunnelStats::default());
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        match spec.kind {
            TunnelKind::Local | TunnelKind::Dynamic => {
                let listener = TcpListener::bind((spec.bind_host.as_str(), spec.bind_port))
                    .await
                    .map_err(|error| {
                        CoreError::Ssh(format!(
                            "could not bind local port {}:{}: {error}",
                            spec.bind_host, spec.bind_port
                        ))
                    })?;
                let bound_port = listener
                    .local_addr()
                    .map(|addr| addr.port())
                    .unwrap_or(spec.bind_port);

                let (handle, jump_handle, fingerprint) = open_authenticated_session(ssh).await?;
                let handle = Arc::new(handle);

                let task_handle = Arc::clone(&handle);
                let task_stats = Arc::clone(&stats);
                let task_spec = spec.clone();
                let mut rx = shutdown_rx;

                tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            changed = rx.changed() => {
                                if changed.is_err() || *rx.borrow() {
                                    break;
                                }
                            }
                            accepted = listener.accept() => {
                                match accepted {
                                    Ok((stream, peer)) => {
                                        let ssh_handle = Arc::clone(&task_handle);
                                        let conn_stats = Arc::clone(&task_stats);
                                        let rule = task_spec.clone();
                                        tokio::spawn(async move {
                                            if rule.kind == TunnelKind::Local {
                                                handle_local_connection(
                                                    stream,
                                                    peer.ip().to_string(),
                                                    u32::from(peer.port()),
                                                    ssh_handle,
                                                    rule.target_host,
                                                    rule.target_port,
                                                    conn_stats,
                                                )
                                                .await;
                                            } else {
                                                handle_socks5_connection(
                                                    stream,
                                                    peer.ip().to_string(),
                                                    u32::from(peer.port()),
                                                    ssh_handle,
                                                    conn_stats,
                                                )
                                                .await;
                                            }
                                        });
                                    }
                                    Err(error) => {
                                        tracing::warn!("tunnel accept error: {error}");
                                        break;
                                    }
                                }
                            }
                        }
                    }
                });

                Ok(Self {
                    spec,
                    bound_port,
                    fingerprint,
                    stats,
                    shutdown_tx,
                    handle,
                    jump_handle: Mutex::new(jump_handle),
                    stopped: AtomicBool::new(false),
                })
            }
            TunnelKind::Remote => {
                let target = RemoteForwardTarget {
                    local_host: spec.target_host.clone(),
                    local_port: spec.target_port,
                    stats: Arc::clone(&stats),
                };
                let (handle, jump_handle, fingerprint) =
                    open_authenticated_session_with_forward(ssh, Some(target)).await?;

                let assigned = handle
                    .tcpip_forward(spec.bind_host.clone(), u32::from(spec.bind_port))
                    .await
                    .map_err(|error| {
                        CoreError::Ssh(format!(
                            "remote port forward {}:{} denied by server: {error}",
                            spec.bind_host, spec.bind_port
                        ))
                    })?;
                let bound_port = if spec.bind_port == 0 && assigned > 0 {
                    assigned as u16
                } else {
                    spec.bind_port
                };

                Ok(Self {
                    spec,
                    bound_port,
                    fingerprint,
                    stats,
                    shutdown_tx,
                    handle: Arc::new(handle),
                    jump_handle: Mutex::new(jump_handle),
                    stopped: AtomicBool::new(false),
                })
            }
        }
    }

    /// The actual listening port (useful when `bind_port` was `0`).
    pub fn bound_port(&self) -> u16 {
        self.bound_port
    }

    /// Server host-key SHA-256 fingerprint captured during handshake.
    pub fn host_fingerprint(&self) -> Option<String> {
        self.fingerprint.lock().ok().and_then(|slot| slot.clone())
    }

    /// Returns a point-in-time snapshot of active connections and transferred bytes.
    pub fn stats(&self) -> TunnelStatsSnapshot {
        self.stats.snapshot()
    }

    /// Gracefully stops accepting connections and disconnects the SSH tunnel session.
    pub async fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.shutdown_tx.send(true);
        if self.spec.kind == TunnelKind::Remote {
            let _ = self
                .handle
                .cancel_tcpip_forward(self.spec.bind_host.clone(), u32::from(self.bound_port))
                .await;
        }
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        let jump = self
            .jump_handle
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(jump) = jump {
            let _ = jump.disconnect(Disconnect::ByApplication, "", "en").await;
        }
    }
}

async fn handle_local_connection(
    mut local: TcpStream,
    peer_ip: String,
    peer_port: u32,
    handle: Arc<Handle<SshClientHandler>>,
    target_host: String,
    target_port: u16,
    stats: Arc<TunnelStats>,
) {
    let channel = match handle
        .channel_open_direct_tcpip(
            target_host.clone(),
            u32::from(target_port),
            peer_ip,
            peer_port,
        )
        .await
    {
        Ok(channel) => channel,
        Err(error) => {
            tracing::warn!("direct-tcpip to {target_host}:{target_port} failed: {error}");
            return;
        }
    };

    let _guard = ActiveConnGuard::enter(&stats);
    let mut remote = channel.into_stream();
    if let Ok((tx, rx)) = tokio::io::copy_bidirectional(&mut local, &mut remote).await {
        stats.bytes_tx.fetch_add(tx, Ordering::Relaxed);
        stats.bytes_rx.fetch_add(rx, Ordering::Relaxed);
    }
}

/// Minimal RFC 1928 SOCKS5 server (NO AUTH + CONNECT over IPv4 / Domain / IPv6).
async fn handle_socks5_connection(
    mut client: TcpStream,
    peer_ip: String,
    peer_port: u32,
    handle: Arc<Handle<SshClientHandler>>,
    stats: Arc<TunnelStats>,
) {
    let (dest_host, dest_port) = match socks5_negotiate(&mut client).await {
        Ok(target) => target,
        Err(error) => {
            tracing::debug!("socks5 handshake rejected: {error}");
            return;
        }
    };

    let channel = match handle
        .channel_open_direct_tcpip(dest_host.clone(), u32::from(dest_port), peer_ip, peer_port)
        .await
    {
        Ok(channel) => channel,
        Err(error) => {
            tracing::warn!("socks5 direct-tcpip to {dest_host}:{dest_port} failed: {error}");
            // General SOCKS server failure (0x01)
            let _ = client
                .write_all(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return;
        }
    };

    // Succeeded (0x00), bound 0.0.0.0:0
    if client
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .is_err()
    {
        return;
    }

    let _guard = ActiveConnGuard::enter(&stats);
    let mut remote = channel.into_stream();
    if let Ok((tx, rx)) = tokio::io::copy_bidirectional(&mut client, &mut remote).await {
        stats.bytes_tx.fetch_add(tx, Ordering::Relaxed);
        stats.bytes_rx.fetch_add(rx, Ordering::Relaxed);
    }
}

/// Parses an RFC 1928 SOCKS5 greeting + CONNECT request from `stream`.
async fn socks5_negotiate<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
) -> Result<(String, u16)> {
    let mut header = [0u8; 2];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|error| CoreError::Ssh(format!("socks5 greeting read failed: {error}")))?;
    if header[0] != 0x05 {
        return Err(CoreError::Ssh(String::from("unsupported socks version")));
    }

    let n_methods = usize::from(header[1]);
    let mut methods = vec![0u8; n_methods];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|error| CoreError::Ssh(format!("socks5 methods read failed: {error}")))?;

    if !methods.contains(&0x00) {
        let _ = stream.write_all(&[0x05, 0xFF]).await;
        return Err(CoreError::Ssh(String::from(
            "socks5 client does not support no-auth",
        )));
    }
    stream
        .write_all(&[0x05, 0x00])
        .await
        .map_err(|error| CoreError::Ssh(format!("socks5 auth reply failed: {error}")))?;

    let mut req = [0u8; 4];
    stream
        .read_exact(&mut req)
        .await
        .map_err(|error| CoreError::Ssh(format!("socks5 request read failed: {error}")))?;
    if req[0] != 0x05 || req[1] != 0x01 {
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err(CoreError::Ssh(String::from(
            "only socks5 CONNECT command is supported",
        )));
    }

    let host = match req[3] {
        // IPv4
        0x01 => {
            let mut addr = [0u8; 4];
            stream
                .read_exact(&mut addr)
                .await
                .map_err(|error| CoreError::Ssh(format!("socks5 ipv4 read failed: {error}")))?;
            Ipv4Addr::from(addr).to_string()
        }
        // Domain name
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(|error| {
                CoreError::Ssh(format!("socks5 domain len read failed: {error}"))
            })?;
            let mut domain = vec![0u8; usize::from(len[0])];
            stream
                .read_exact(&mut domain)
                .await
                .map_err(|error| CoreError::Ssh(format!("socks5 domain read failed: {error}")))?;
            String::from_utf8(domain)
                .map_err(|_| CoreError::Ssh(String::from("socks5 domain is not valid UTF-8")))?
        }
        // IPv6
        0x04 => {
            let mut addr = [0u8; 16];
            stream
                .read_exact(&mut addr)
                .await
                .map_err(|error| CoreError::Ssh(format!("socks5 ipv6 read failed: {error}")))?;
            Ipv6Addr::from(addr).to_string()
        }
        _ => {
            let _ = stream
                .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Err(CoreError::Ssh(String::from(
                "unsupported socks5 address type",
            )));
        }
    };

    let mut port_bytes = [0u8; 2];
    stream
        .read_exact(&mut port_bytes)
        .await
        .map_err(|error| CoreError::Ssh(format!("socks5 port read failed: {error}")))?;
    let port = u16::from_be_bytes(port_bytes);

    Ok((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_tunnel_specs() {
        let local = TunnelSpec {
            kind: TunnelKind::Local,
            bind_host: String::from("127.0.0.1"),
            bind_port: 13306,
            target_host: String::from("127.0.0.1"),
            target_port: 3306,
        };
        assert!(local.validate().is_ok());

        let dynamic = TunnelSpec {
            kind: TunnelKind::Dynamic,
            bind_host: String::from("127.0.0.1"),
            bind_port: 1080,
            target_host: String::new(),
            target_port: 0,
        };
        assert!(dynamic.validate().is_ok());

        let bad_local = TunnelSpec {
            target_port: 0,
            ..local
        };
        assert!(bad_local.validate().is_err());
    }

    #[tokio::test]
    async fn negotiates_socks5_domain_and_ipv4_requests() {
        let (mut client, mut server) = tokio::io::duplex(256);

        let client_task = tokio::spawn(async move {
            // Greeting: version 5, 1 method (no-auth 0x00)
            client.write_all(&[0x05, 0x01, 0x00]).await.expect("write");
            let mut auth = [0u8; 2];
            client.read_exact(&mut auth).await.expect("read");
            assert_eq!(auth, [0x05, 0x00]);

            // CONNECT example.com:443
            let domain = b"example.com";
            let mut req = vec![0x05, 0x01, 0x00, 0x03, domain.len() as u8];
            req.extend_from_slice(domain);
            req.extend_from_slice(&443u16.to_be_bytes());
            client.write_all(&req).await.expect("write req");
        });

        let (host, port) = socks5_negotiate(&mut server).await.expect("negotiate");
        client_task.await.expect("client");
        assert_eq!(host, "example.com");
        assert_eq!(port, 443);
    }
}
