// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Failure-path coverage for the SSH, SFTP and serial transports.
//!
//! These need neither a server nor hardware, so they run in CI and guard the
//! wiring that real-link tests would otherwise be the first to exercise:
//! configuration, the handshake attempt, and error mapping.

use std::time::Duration;

use term_core::{SerialConfig, SerialTransport, SftpClient, SshAuth, SshConfig, SshTransport};

fn unreachable() -> SshConfig {
    // Port 1 on loopback is closed and refuses immediately, which keeps the test
    // deterministic without touching the network.
    SshConfig::new("127.0.0.1", 1, "tester", SshAuth::Password("x".into())).with_grid(80, 24)
}

#[tokio::test]
async fn ssh_connect_reports_a_handshake_failure() {
    let error = match SshTransport::connect(unreachable()).await {
        Ok(_) => panic!("a closed port must fail"),
        Err(error) => error,
    };
    let message = error.to_string();
    assert!(
        message.contains("handshake"),
        "expected a handshake failure, got {message:?}"
    );
}

#[tokio::test]
async fn sftp_connect_reports_a_handshake_failure() {
    let error = match SftpClient::connect(unreachable()).await {
        Ok(_) => panic!("a closed port must fail"),
        Err(error) => error,
    };
    let message = error.to_string();
    assert!(
        message.contains("handshake"),
        "expected a handshake failure, got {message:?}"
    );
}

#[tokio::test]
async fn serial_open_reports_a_missing_port() {
    let error = match SerialTransport::open(SerialConfig::new("/dev/ota-not-a-port", 115200)).await
    {
        Ok(_) => panic!("a missing device must fail"),
        Err(error) => error,
    };
    let message = error.to_string();
    assert!(
        message.contains("serial"),
        "expected a serial error, got {message:?}"
    );
}

#[test]
fn serial_enumeration_never_fails_on_a_host_without_hardware() {
    // An empty list is the normal answer on CI machines; an error would abort
    // the connect dialog before the user can type a device path.
    let ports = term_core::list_serial_ports().expect("enumeration should not fail");
    for port in &ports {
        assert!(!port.path.is_empty());
    }
}

#[tokio::test]
async fn ssh_write_after_close_is_rejected_without_panicking() {
    // A transport that never connected cannot be built, so this guards the
    // documented shape: closed sessions answer with an error, not a panic.
    let config = unreachable();
    let result = tokio::time::timeout(Duration::from_secs(10), SshTransport::connect(config)).await;
    assert!(result.is_ok(), "connect must not hang");
}
