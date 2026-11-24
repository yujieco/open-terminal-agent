// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Terminal session commands: local PTY, SSH shell, serial consoles, keystrokes,
//! screen snapshots and per-session Tauri IPC Channel streaming.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use term_core::pty::PtyTransport;
use term_core::{
    PtyConfig, ScreenSnapshot, SerialConfig, SerialFlowControl, SerialParity, SerialStopBits,
    SerialTransport, ShadowScreen, SshTransport, TerminalOutput, TerminalTransport,
    list_serial_ports as enumerate_serial_ports,
};
use tokio::sync::{Mutex as AsyncMutex, broadcast::error::RecvError};

use crate::agent::{AGENT_INTERRUPTED, AgentControl};
use crate::commands::{SshConnectRequest, default_cols, default_rows};
use crate::error::ApiError;
use crate::locale::LocaleInfo;
use crate::shell_integration::ShellIntegration;
use crate::state::{SessionHandle, SessionKind, SessionRegistry};
use crate::store::Store;

/// Smallest grid accepted from the UI, in columns.
const MIN_COLS: u16 = 20;
/// Largest grid accepted from the UI, in columns.
const MAX_COLS: u16 = 1_000;
/// Smallest grid accepted from the UI, in rows.
const MIN_ROWS: u16 = 5;
/// Largest grid accepted from the UI, in rows.
const MAX_ROWS: u16 = 500;

/// Per-session stream event delivered over a dedicated Tauri v2 IPC Channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum TerminalStreamEvent {
    /// One 16ms-batched frame of transport output.
    Output {
        /// Monotonic frame counter.
        sequence: u64,
        /// Base64 payload; decoded to bytes before UTF-8 streaming on the JS side.
        #[serde(rename = "dataBase64")]
        data_base64: String,
        /// Raw byte length, handy for throughput logging.
        bytes: usize,
    },
    /// The underlying process or connection ended.
    Exited,
}

/// Session description returned to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// Session id used by every later command.
    pub session_id: String,
    /// Transport kind: `local`, `ssh` or `serial`.
    pub kind: SessionKind,
    /// Short label shown in tabs and the sidebar.
    pub label: String,
    /// Columns the session was created with.
    pub cols: u16,
    /// Rows the session was created with.
    pub rows: u16,
}

/// Arguments for [`spawn_session`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSessionRequest {
    /// Requested columns, clamped to a sane range.
    pub cols: u16,
    /// Requested rows, clamped to a sane range.
    pub rows: u16,
    /// Shell binary; the platform default when omitted.
    #[serde(default)]
    pub shell: Option<String>,
    /// Working directory; the app cwd when omitted.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Arguments for [`open_serial`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConnectRequest {
    /// Device path or COM port name.
    pub path: String,
    /// Baud rate.
    pub baud_rate: u32,
    /// Data bits, 5 to 8.
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    /// Stop bits.
    #[serde(default = "default_stop_bits")]
    pub stop_bits: SerialStopBits,
    /// Parity.
    #[serde(default = "default_parity")]
    pub parity: SerialParity,
    /// Flow control.
    #[serde(default = "default_flow_control")]
    pub flow_control: SerialFlowControl,
    /// Requested columns.
    #[serde(default = "default_cols")]
    pub cols: u16,
    /// Requested rows.
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// Optional raw session log destination.
    #[serde(default)]
    pub log_path: Option<String>,
}

pub(crate) fn default_data_bits() -> u8 {
    8
}

pub(crate) fn default_stop_bits() -> SerialStopBits {
    SerialStopBits::One
}

pub(crate) fn default_parity() -> SerialParity {
    SerialParity::None
}

pub(crate) fn default_flow_control() -> SerialFlowControl {
    SerialFlowControl::None
}

/// One shell the user can start.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    /// Display name.
    pub label: String,
    /// Binary path or command name.
    pub command: String,
    /// Whether this is the platform default shell.
    pub default: bool,
}

/// Starts a local shell and streams its output over a dedicated IPC Channel.
#[tauri::command]
pub async fn spawn_session(
    registry: State<'_, SessionRegistry>,
    shell_integration: State<'_, ShellIntegration>,
    request: SpawnSessionRequest,
    on_event: Channel<TerminalStreamEvent>,
) -> Result<SessionInfo, ApiError> {
    let cols = request.cols.clamp(MIN_COLS, MAX_COLS);
    let rows = request.rows.clamp(MIN_ROWS, MAX_ROWS);

    let mut config = PtyConfig::new(cols, rows);
    if let Some(shell) = request.shell {
        config = config.with_shell(shell);
    }
    if let Some(cwd) = request.cwd {
        config = config.with_cwd(cwd);
    }

    shell_integration.attach_to_pty(&mut config);

    let (transport, output) = PtyTransport::spawn_with_output(config).await?;
    let label = transport.shell().to_owned();
    let transport: Arc<dyn TerminalTransport> = Arc::new(transport);

    register_session(
        &registry,
        transport,
        SessionKind::Local,
        label,
        cols,
        rows,
        output,
        on_event,
    )
}

/// Connects to a remote host over SSH and opens an interactive shell.
#[tauri::command]
pub async fn connect_ssh(
    registry: State<'_, SessionRegistry>,
    store: State<'_, Store>,
    request: SshConnectRequest,
    on_event: Channel<TerminalStreamEvent>,
) -> Result<SessionInfo, ApiError> {
    let cols = request.cols.clamp(MIN_COLS, MAX_COLS);
    let rows = request.rows.clamp(MIN_ROWS, MAX_ROWS);
    let host = request.host.clone();
    let port = request.port;
    let username = request.username.clone();
    let request_trust_fingerprint = request.trust_fingerprint.clone();
    let mut config = request.into_config();

    // Trust on first contact, verify every contact after that. A fingerprint the
    // user just approved wins, because it is the one they actually looked at.
    if let Some(trusted) = request_trust_fingerprint {
        config = config.with_known_host_fingerprint(trusted);
    } else if let Some(pinned) = store.host_key(&host, port)? {
        config = config.with_known_host_fingerprint(pinned);
    }

    let (transport, output) = SshTransport::connect(config).await?;
    if let Some(fingerprint) = transport.server_key_fingerprint() {
        store.remember_host_key(&host, port, &fingerprint)?;
    }
    let label = format!("{username}@{host}");
    let transport: Arc<dyn TerminalTransport> = Arc::new(transport);

    register_session(
        &registry,
        transport,
        SessionKind::Ssh,
        label,
        cols,
        rows,
        output,
        on_event,
    )
}

/// Opens a serial console.
#[tauri::command]
pub async fn open_serial(
    registry: State<'_, SessionRegistry>,
    request: SerialConnectRequest,
    on_event: Channel<TerminalStreamEvent>,
) -> Result<SessionInfo, ApiError> {
    let cols = request.cols.clamp(MIN_COLS, MAX_COLS);
    let rows = request.rows.clamp(MIN_ROWS, MAX_ROWS);

    let mut config = SerialConfig::new(request.path.clone(), request.baud_rate)
        .with_grid(cols, rows)
        .with_framing(
            request.data_bits,
            request.stop_bits,
            request.parity,
            request.flow_control,
        );
    if let Some(path) = request.log_path {
        config = config.with_log(path);
    }

    let (transport, output) = SerialTransport::open(config).await?;
    let label = format!(
        "{path} @ {baud}",
        path = request.path,
        baud = request.baud_rate
    );
    let transport: Arc<dyn TerminalTransport> = Arc::new(transport);

    register_session(
        &registry,
        transport,
        SessionKind::Serial,
        label,
        cols,
        rows,
        output,
        on_event,
    )
}

/// Shared registration: one shadow screen, one Channel forwarder, one registry entry.
#[allow(clippy::too_many_arguments)]
fn register_session(
    registry: &State<'_, SessionRegistry>,
    transport: Arc<dyn TerminalTransport>,
    kind: SessionKind,
    label: String,
    cols: u16,
    rows: u16,
    output: tokio::sync::broadcast::Receiver<TerminalOutput>,
    on_event: Channel<TerminalStreamEvent>,
) -> Result<SessionInfo, ApiError> {
    let session_id = transport.session_id().as_str().to_owned();
    let screen = Arc::new(AsyncMutex::new(ShadowScreen::new(cols, rows)?));

    registry.insert(Arc::new(SessionHandle {
        transport,
        screen: Arc::clone(&screen),
        kind,
        label: label.clone(),
        cols,
        rows,
    }))?;

    forward_output(session_id.clone(), screen, output, on_event);

    Ok(SessionInfo {
        session_id,
        kind,
        label,
        cols,
        rows,
    })
}

/// Feeds batched frames into the shadow screen and directly over the session's
/// dedicated Tauri IPC Channel (no global event broadcast across unrelated tabs).
fn forward_output(
    session_id: String,
    screen: Arc<AsyncMutex<ShadowScreen>>,
    mut output: tokio::sync::broadcast::Receiver<TerminalOutput>,
    on_event: Channel<TerminalStreamEvent>,
) {
    tokio::spawn(async move {
        loop {
            match output.recv().await {
                Ok(frame) => {
                    {
                        let mut shadow = screen.lock().await;
                        shadow.feed(&frame.bytes);
                    }

                    let event = TerminalStreamEvent::Output {
                        sequence: frame.sequence,
                        bytes: frame.bytes.len(),
                        data_base64: BASE64.encode(&frame.bytes),
                    };
                    if on_event.send(event).is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(
                        skipped,
                        session = %session_id,
                        "dropped terminal frames because a consumer fell behind"
                    );
                }
                Err(RecvError::Closed) => {
                    let _ = on_event.send(TerminalStreamEvent::Exited);
                    break;
                }
            }
        }
    });
}

/// Writes keystrokes or agent commands into a session.
#[tauri::command]
pub async fn write_session(
    registry: State<'_, SessionRegistry>,
    session_id: String,
    data: String,
) -> Result<(), ApiError> {
    let handle = registry.require(&session_id)?;
    handle.transport.write_bytes(data.as_bytes()).await?;
    Ok(())
}

/// Human keystroke path: takes the terminal back from a running agent.
///
/// The terminal pane always goes through this command, so "whoever types wins"
/// needs no cooperation from the model or the runtime.
#[tauri::command]
pub async fn write_keystrokes(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    control: State<'_, Arc<AgentControl>>,
    session_id: String,
    data: String,
) -> Result<(), ApiError> {
    if control.interrupt_for_human(&session_id) {
        let _ = app.emit(
            AGENT_INTERRUPTED,
            serde_json::json!({ "sessionId": session_id }),
        );
    }
    let handle = registry.require(&session_id)?;
    handle.transport.write_bytes(data.as_bytes()).await?;
    Ok(())
}

/// Human path for raw bytes: HEX input on a serial console.
#[tauri::command]
pub async fn write_session_bytes(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    control: State<'_, Arc<AgentControl>>,
    session_id: String,
    data_base64: String,
) -> Result<(), ApiError> {
    if control.interrupt_for_human(&session_id) {
        let _ = app.emit(
            AGENT_INTERRUPTED,
            serde_json::json!({ "sessionId": session_id }),
        );
    }

    let bytes = BASE64
        .decode(data_base64)
        .map_err(|error| ApiError::InvalidRequest(format!("invalid base64 payload: {error}")))?;
    let handle = registry.require(&session_id)?;
    handle.transport.write_bytes(&bytes).await?;
    Ok(())
}

/// Resizes both the transport and the shadow screen.
#[tauri::command]
pub async fn resize_session(
    registry: State<'_, SessionRegistry>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), ApiError> {
    let handle = registry.require(&session_id)?;
    handle.transport.resize(cols, rows).await?;
    handle.screen.lock().await.resize(cols, rows)?;
    Ok(())
}

/// Terminates a session and frees its OS resources.
#[tauri::command]
pub async fn close_session(
    registry: State<'_, SessionRegistry>,
    control: State<'_, Arc<AgentControl>>,
    session_id: String,
) -> Result<(), ApiError> {
    control.cancel(&session_id);
    match registry.remove(&session_id)? {
        Some(handle) => {
            handle.transport.close().await?;
            Ok(())
        }
        None => Err(ApiError::UnknownSession(session_id)),
    }
}

/// Lists live sessions, used to rebuild the sidebar after a reload.
#[tauri::command]
pub fn list_sessions(registry: State<'_, SessionRegistry>) -> Result<Vec<SessionInfo>, ApiError> {
    let handles = registry.list()?;
    Ok(handles
        .into_iter()
        .map(|handle| SessionInfo {
            session_id: handle.id(),
            kind: handle.kind,
            label: handle.label.clone(),
            cols: handle.cols,
            rows: handle.rows,
        })
        .collect())
}

/// Returns the clean screen text the agent will read.
#[tauri::command]
pub async fn screen_snapshot(
    registry: State<'_, SessionRegistry>,
    session_id: String,
) -> Result<ScreenSnapshot, ApiError> {
    let handle = registry.require(&session_id)?;
    let mut screen = handle.screen.lock().await;
    Ok(screen.snapshot())
}

/// Lists serial ports with USB identifiers and descriptions.
#[tauri::command]
pub fn serial_ports() -> Result<Vec<term_core::SerialPortDescriptor>, ApiError> {
    Ok(enumerate_serial_ports()?)
}

/// Reports the OS locale and the shipped UI languages.
#[tauri::command]
pub fn system_locale() -> LocaleInfo {
    LocaleInfo::detect()
}

/// Lists shells that actually exist on this machine.
#[tauri::command]
pub fn shell_profiles() -> Vec<ShellProfile> {
    let default_shell = term_core::default_shell();
    let mut candidates: Vec<(String, String)> = vec![
        (default_shell.clone(), String::from("Default shell")),
        (String::from("/bin/zsh"), String::from("zsh")),
        (String::from("/bin/bash"), String::from("bash")),
        (String::from("/bin/sh"), String::from("sh")),
        (String::from("/opt/homebrew/bin/fish"), String::from("fish")),
        (String::from("/usr/local/bin/fish"), String::from("fish")),
        (String::from("/opt/homebrew/bin/pwsh"), String::from("pwsh")),
        (String::from("cmd.exe"), String::from("Command Prompt")),
        (
            String::from("powershell.exe"),
            String::from("Windows PowerShell"),
        ),
        (String::from("pwsh.exe"), String::from("PowerShell 7")),
    ];

    let mut profiles: Vec<ShellProfile> = Vec::new();
    for (command, label) in candidates.drain(..) {
        if !shell_exists(&command) {
            continue;
        }
        if profiles.iter().any(|profile| profile.command == command) {
            continue;
        }
        profiles.push(ShellProfile {
            default: command == default_shell,
            label,
            command,
        });
    }

    profiles.sort_by(|left, right| {
        right
            .default
            .cmp(&left.default)
            .then_with(|| left.label.cmp(&right.label))
    });
    profiles
}

fn shell_exists(command: &str) -> bool {
    if command.contains(std::path::MAIN_SEPARATOR) {
        return std::path::Path::new(command).is_file();
    }
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(command).is_file()))
        .unwrap_or(false)
}
