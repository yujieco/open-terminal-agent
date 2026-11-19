// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Real SSH round trip against an in-process server.
//!
//! `russh` is both the client and the server implementation, so the transport can
//! be exercised end to end on loopback with no external daemon: password auth,
//! pty request, shell request and data in both directions.

use std::sync::Arc;
use std::time::Duration;

use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use term_core::{SshAuth, SshConfig, SshTransport, TerminalTransport};
use tokio::net::TcpListener;

/// Throwaway ed25519 key for the loopback server only.
const HOST_KEY: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACC433V0p/iLzJd2ChrnSHhODHzDeg9LS7NLqvlkYoQk3wAAAJAup5+8Lqef
vAAAAAtzc2gtZWQyNTUxOQAAACC433V0p/iLzJd2ChrnSHhODHzDeg9LS7NLqvlkYoQk3w
AAAEAHqdGrSjwMNnUR9ant7g8HdzX4bmo26miFAxqRlywFhLjfdXSn+IvMl3YKGudIeE4M
fMN6D0tLs0uq+WRihCTfAAAACG90YS10ZXN0AQIDBAU=
-----END OPENSSH PRIVATE KEY-----"#;

#[derive(Clone)]
struct EchoServer;

impl russh::server::Server for EchoServer {
    type Handler = Self;

    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> Self {
        EchoServer
    }
}

impl russh::server::Handler for EchoServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == "secret" {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let echo = format!("echo:{}\r\n", String::from_utf8_lossy(data)).into_bytes();
        session.data(channel, echo)?;
        Ok(())
    }
}

/// Starts the echo server on an ephemeral loopback port.
async fn start_server() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let port = listener.local_addr().expect("addr").port();

    let config = Arc::new(russh::server::Config {
        keys: vec![
            // Deterministic test-only key, so the fixture needs no RNG and no
            // filesystem access at test time.
            russh::keys::PrivateKey::from_openssh(HOST_KEY).expect("host key"),
        ],
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    });

    let mut server = EchoServer;
    tokio::spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
    });

    // Give the accept loop a moment to poll before the client dials in.
    tokio::time::sleep(Duration::from_millis(50)).await;
    port
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_transport_round_trips_through_a_real_server() {
    let port = start_server().await;
    let config = SshConfig::new(
        "127.0.0.1",
        port,
        "tester",
        SshAuth::Password("secret".into()),
    )
    .with_grid(80, 24);

    let (transport, mut output) = SshTransport::connect(config).await.expect("connect");
    transport.write_bytes(b"ping").await.expect("write");

    let frame = tokio::time::timeout(Duration::from_secs(5), output.recv())
        .await
        .expect("a frame within the deadline")
        .expect("frame");
    assert!(
        frame.to_utf8_lossy().contains("echo:ping"),
        "server should echo the payload, got {:?}",
        frame.to_utf8_lossy()
    );

    transport.close().await.expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_password_is_rejected_by_the_server() {
    let port = start_server().await;
    let config = SshConfig::new(
        "127.0.0.1",
        port,
        "tester",
        SshAuth::Password("wrong".into()),
    );

    match SshTransport::connect(config).await {
        Ok(_) => panic!("a rejected password must fail"),
        Err(error) => {
            let message = error.to_string();
            assert!(
                message.contains("authentication rejected") || message.contains("auth"),
                "expected an auth failure, got {message:?}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sftp_connect_reports_a_refused_subsystem() {
    // The echo server only speaks shell, so it rejects the `sftp` subsystem.
    // A server without SFTP must produce a clear error instead of hanging.
    let port = start_server().await;
    let config = SshConfig::new(
        "127.0.0.1",
        port,
        "tester",
        SshAuth::Password("secret".into()),
    );

    let result = tokio::time::timeout(
        Duration::from_secs(10),
        term_core::SftpClient::connect(config),
    )
    .await
    .expect("sftp connect must not hang");

    match result {
        Ok(_) => panic!("a server without the sftp subsystem must fail"),
        Err(error) => {
            let message = error.to_string();
            assert!(
                message.contains("sftp"),
                "expected an sftp subsystem error, got {message:?}"
            );
        }
    }
}
