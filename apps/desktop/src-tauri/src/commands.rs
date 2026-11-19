// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Tauri commands: local PTY, SSH, serial and SFTP.
//!
//! Every session kind funnels into the same registry and the same output
//! forwarder, so the WebView never branches on transport type. SFTP keeps its
//! own registry because a file browser connection outlives individual transfers.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use term_agent::{LoopPhase, PermissionMode, ToolSpec, tool_catalog};
use term_core::pty::PtyTransport;
use term_core::{
    PtyConfig, ScreenSnapshot, SerialConfig, SerialFlowControl, SerialParity, SerialStopBits,
    SerialTransport, SftpEntry, ShadowScreen, SshAuth, SshConfig, SshTransport, TerminalOutput,
    TerminalTransport, list_serial_ports as enumerate_serial_ports,
};
use tokio::sync::{Mutex as AsyncMutex, broadcast::error::RecvError};

use crate::agent::{AGENT_APPROVAL, AGENT_EVENT, AGENT_INTERRUPTED, AgentControl, SessionTerminal};
use crate::error::ApiError;
use crate::locale::LocaleInfo;
use crate::secrets::{SecretStore, ssh_secret_account};
use crate::state::{SessionHandle, SessionKind, SessionRegistry, SftpRegistry};
use crate::store::{AgentRunRecord, AgentRunSummary, NewSavedSession, SavedSession, Store};
use crate::{TERMINAL_EXIT_EVENT, TERMINAL_OUTPUT_EVENT};

/// Identifier for a row in the saved-session table.
pub fn new_stored_id() -> String {
    term_core::generate_session_id("saved").into_string()
}

/// Smallest grid accepted from the UI, in columns.
const MIN_COLS: u16 = 20;
/// Largest grid accepted from the UI, in columns.
const MAX_COLS: u16 = 1_000;
/// Smallest grid accepted from the UI, in rows.
const MIN_ROWS: u16 = 5;
/// Largest grid accepted from the UI, in rows.
const MAX_ROWS: u16 = 500;

/// Batched output frame pushed to the WebView.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPayload {
    /// Session that produced the bytes.
    pub session_id: String,
    /// Monotonic frame counter.
    pub sequence: u64,
    /// Base64 payload; decoded to bytes before UTF-8 streaming on the JS side.
    pub data_base64: String,
    /// Raw byte length, handy for throughput logging.
    pub bytes: usize,
}

/// Emitted when the shell process or connection ends.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPayload {
    /// Session that ended.
    pub session_id: String,
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

/// Authentication choice coming from the SSH dialog.
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
    fn into_auth(self) -> SshAuth {
        match self {
            Self::Password { password } => SshAuth::Password(password),
            Self::PrivateKey { path, passphrase } => SshAuth::PrivateKey {
                path: PathBuf::from(path),
                passphrase,
            },
        }
    }
}

/// Arguments for [`connect_ssh`] and [`sftp_connect`].
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
}

impl SshConnectRequest {
    fn into_config(self) -> SshConfig {
        SshConfig::new(self.host, self.port, self.username, self.auth.into_auth())
            .with_grid(self.cols, self.rows)
    }
}

fn default_cols() -> u16 {
    100
}

fn default_rows() -> u16 {
    30
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

fn default_data_bits() -> u8 {
    8
}

fn default_stop_bits() -> SerialStopBits {
    SerialStopBits::One
}

fn default_parity() -> SerialParity {
    SerialParity::None
}

fn default_flow_control() -> SerialFlowControl {
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

/// What the agent can do right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    /// Autonomy mode from `term_agent::PermissionMode::default()`.
    pub default_mode: PermissionMode,
    /// Tools the model may call.
    pub tools: Vec<ToolSpec>,
    /// Observe -> Reason -> Act -> Verify, in order.
    pub loop_phases: Vec<LoopPhase>,
}

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

/// Starts a local shell and streams its output to the WebView.
#[tauri::command]
pub async fn spawn_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    request: SpawnSessionRequest,
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

    let (transport, output) = PtyTransport::spawn_with_output(config).await?;
    let label = transport.shell().to_owned();
    let transport: Arc<dyn TerminalTransport> = Arc::new(transport);

    register_session(
        app,
        &registry,
        transport,
        SessionKind::Local,
        label,
        cols,
        rows,
        output,
    )
}

/// Connects to a remote host over SSH and opens an interactive shell.
#[tauri::command]
pub async fn connect_ssh(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    store: State<'_, Store>,
    request: SshConnectRequest,
) -> Result<SessionInfo, ApiError> {
    let cols = request.cols.clamp(MIN_COLS, MAX_COLS);
    let rows = request.rows.clamp(MIN_ROWS, MAX_ROWS);
    let host = request.host.clone();
    let port = request.port;
    let username = request.username.clone();
    let mut config = request.into_config();

    // Trust on first contact, verify every contact after that.
    if let Some(pinned) = store.host_key(&host, port)? {
        config = config.with_known_host_fingerprint(pinned);
    }

    let (transport, output) = SshTransport::connect(config).await?;
    if let Some(fingerprint) = transport.server_key_fingerprint() {
        store.remember_host_key(&host, port, &fingerprint)?;
    }
    let label = format!("{username}@{host}");
    let transport: Arc<dyn TerminalTransport> = Arc::new(transport);

    register_session(
        app,
        &registry,
        transport,
        SessionKind::Ssh,
        label,
        cols,
        rows,
        output,
    )
}

/// Opens a serial console.
#[tauri::command]
pub async fn open_serial(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    request: SerialConnectRequest,
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
        app,
        &registry,
        transport,
        SessionKind::Serial,
        label,
        cols,
        rows,
        output,
    )
}

/// Shared registration: one shadow screen, one forwarder, one registry entry.
#[allow(clippy::too_many_arguments)]
fn register_session(
    app: AppHandle,
    registry: &State<'_, SessionRegistry>,
    transport: Arc<dyn TerminalTransport>,
    kind: SessionKind,
    label: String,
    cols: u16,
    rows: u16,
    output: tokio::sync::broadcast::Receiver<TerminalOutput>,
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

    forward_output(app, session_id.clone(), screen, output);

    Ok(SessionInfo {
        session_id,
        kind,
        label,
        cols,
        rows,
    })
}

/// Feeds batched frames into the shadow screen and the WebView.
fn forward_output(
    app: AppHandle,
    session_id: String,
    screen: Arc<AsyncMutex<ShadowScreen>>,
    mut output: tokio::sync::broadcast::Receiver<TerminalOutput>,
) {
    tokio::spawn(async move {
        loop {
            match output.recv().await {
                Ok(frame) => {
                    {
                        let mut shadow = screen.lock().await;
                        shadow.feed(&frame.bytes);
                    }

                    let payload = OutputPayload {
                        session_id: session_id.clone(),
                        sequence: frame.sequence,
                        bytes: frame.bytes.len(),
                        data_base64: BASE64.encode(&frame.bytes),
                    };
                    if app.emit(TERMINAL_OUTPUT_EVENT, payload).is_err() {
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
                    let _ = app.emit(
                        TERMINAL_EXIT_EVENT,
                        ExitPayload {
                            session_id: session_id.clone(),
                        },
                    );
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
    session_id: String,
) -> Result<(), ApiError> {
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

/// Reports the agent contract so the sidebar never hardcodes it.
#[tauri::command]
pub fn agent_capabilities() -> AgentCapabilities {
    AgentCapabilities {
        default_mode: PermissionMode::default(),
        tools: tool_catalog(),
        loop_phases: vec![
            LoopPhase::Observe,
            LoopPhase::Reason,
            LoopPhase::Act,
            LoopPhase::Verify,
        ],
    }
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

fn shell_exists(command: &str) -> bool {
    if command.contains(std::path::MAIN_SEPARATOR) {
        return std::path::Path::new(command).is_file();
    }
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(command).is_file()))
        .unwrap_or(false)
}

/// Arguments for [`save_ssh_session`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSshSessionRequest {
    /// Display name for the sidebar.
    pub name: String,
    /// Hostname or IP address.
    pub host: String,
    /// TCP port.
    pub port: u16,
    /// Remote user.
    pub username: String,
    /// Authentication choice.
    pub auth: SshAuthRequest,
    /// Whether a password should be remembered in the OS keyring.
    #[serde(default)]
    pub remember_password: bool,
}

/// Persists an SSH connection, storing the password in the OS keyring only.
#[tauri::command]
pub fn save_ssh_session(
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    request: SaveSshSessionRequest,
) -> Result<SavedSession, ApiError> {
    let account = ssh_secret_account(&request.host, request.port, &request.username);

    let (auth_payload, secret_ref) = match request.auth {
        SshAuthRequest::Password { password } => {
            if request.remember_password {
                secrets.set(&account, &password)?;
                (json!({ "method": "password" }), Some(account))
            } else {
                (json!({ "method": "password" }), None)
            }
        }
        SshAuthRequest::PrivateKey { path, .. } => {
            (json!({ "method": "privateKey", "path": path }), None)
        }
    };

    let payload = json!({
        "host": request.host,
        "port": request.port,
        "username": request.username,
        "auth": auth_payload,
    });

    Ok(store.save(NewSavedSession {
        name: request.name,
        kind: String::from("ssh"),
        payload,
        secret_ref,
    })?)
}

/// Lists saved connections, newest first.
#[tauri::command]
pub fn list_saved_sessions(store: State<'_, Store>) -> Result<Vec<SavedSession>, ApiError> {
    Ok(store.list()?)
}

/// Deletes a saved connection and any keyring secret attached to it.
#[tauri::command]
pub fn delete_saved_session(
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    id: String,
) -> Result<bool, ApiError> {
    let existing = store.get(&id)?;
    if let Some(saved) = &existing
        && let Some(account) = &saved.secret_ref
    {
        // A missing entry is fine; the row is what matters.
        secrets.delete(account)?;
    }
    Ok(store.delete(&id)?)
}

/// Reopens a saved connection, resolving secrets and pinned keys first.
#[tauri::command]
pub async fn connect_saved_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    id: String,
) -> Result<SessionInfo, ApiError> {
    let saved = store
        .get(&id)?
        .ok_or_else(|| ApiError::UnknownSavedSession(id.clone()))?;

    match saved.kind.as_str() {
        "local" => {
            let shell = saved
                .payload
                .get("shell")
                .and_then(Value::as_str)
                .map(str::to_owned);
            spawn_session(
                app,
                registry,
                SpawnSessionRequest {
                    cols: default_cols(),
                    rows: default_rows(),
                    shell,
                    cwd: None,
                },
            )
            .await
        }
        "ssh" => {
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
                    .ok_or_else(|| ApiError::SecretMissing {
                        account: account.clone(),
                    })?;
                SshAuthRequest::Password { password }
            };

            connect_ssh(
                app,
                registry,
                store,
                SshConnectRequest {
                    host,
                    port,
                    username,
                    auth,
                    cols: default_cols(),
                    rows: default_rows(),
                },
            )
            .await
        }
        "serial" => {
            let path = string_field(&saved.payload, "path")?;
            let baud_rate = saved
                .payload
                .get("baudRate")
                .and_then(Value::as_u64)
                .unwrap_or(115200) as u32;
            open_serial(
                app,
                registry,
                SerialConnectRequest {
                    path,
                    baud_rate,
                    data_bits: default_data_bits(),
                    stop_bits: default_stop_bits(),
                    parity: default_parity(),
                    flow_control: default_flow_control(),
                    cols: default_cols(),
                    rows: default_rows(),
                    log_path: None,
                },
            )
            .await
        }
        other => Err(ApiError::InvalidRequest(format!(
            "unsupported saved session kind `{other}`"
        ))),
    }
}

fn string_field(payload: &Value, key: &str) -> Result<String, ApiError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ApiError::InvalidRequest(format!("missing field `{key}`")))
}

/// Keyring account holding the LLM API key.
pub const LLM_KEY_ACCOUNT: &str = "llm:deepseek";

/// LLM configuration reported to the settings panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStatus {
    /// Whether an API key is stored in the keyring.
    pub configured: bool,
    /// Provider id.
    pub provider: String,
    /// Model id.
    pub model: String,
    /// Base URL.
    pub base_url: String,
}

/// Reports the provider the runtime will use and whether a key is stored.
#[tauri::command]
pub fn llm_status(secrets: State<'_, SecretStore>) -> Result<LlmStatus, ApiError> {
    let config = term_agent::LlmProviderConfig::deepseek_flash();
    Ok(LlmStatus {
        configured: secrets.get(LLM_KEY_ACCOUNT)?.is_some(),
        provider: config.provider,
        model: config.model,
        base_url: config.base_url,
    })
}

/// Stores or clears the LLM API key in the OS keyring.
#[tauri::command]
pub fn save_llm_key(secrets: State<'_, SecretStore>, api_key: String) -> Result<(), ApiError> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return secrets.delete(LLM_KEY_ACCOUNT);
    }
    secrets.set(LLM_KEY_ACCOUNT, trimmed)
}

/// Arguments for [`agent_run`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    /// Session the agent works in.
    pub session_id: String,
    /// Natural language task.
    pub task: String,
    /// Autonomy mode; supervised when omitted.
    #[serde(default)]
    pub mode: Option<PermissionMode>,
    /// Ask before every command, even read-only ones.
    #[serde(default)]
    pub step_approval: bool,
}

/// Starts an agent run; steps stream over `agent://event` as they happen.
#[tauri::command]
pub fn agent_run(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    secrets: State<'_, SecretStore>,
    control: State<'_, Arc<AgentControl>>,
    store: State<'_, Store>,
    request: AgentRunRequest,
) -> Result<(), ApiError> {
    if control.is_running(&request.session_id) {
        return Err(ApiError::InvalidRequest(String::from(
            "a run is already in progress for this session",
        )));
    }

    let handle = registry.require(&request.session_id)?;
    let api_key = secrets.get(LLM_KEY_ACCOUNT)?.ok_or_else(|| {
        ApiError::InvalidRequest(String::from(
            "no LLM API key configured; open settings and paste a DeepSeek key",
        ))
    })?;

    let cancelled = control.begin(&request.session_id);
    let terminal = SessionTerminal {
        transport: Arc::clone(&handle.transport),
        screen: Arc::clone(&handle.screen),
        kind: handle.kind,
    };

    let control = Arc::clone(&control);
    let session_id = request.session_id.clone();
    let mode = request.mode.unwrap_or_default();
    let store: Store = (*store).clone();

    tauri::async_runtime::spawn(async move {
        let outcome = crate::agent::run_task(
            app,
            store,
            session_id.clone(),
            terminal,
            Some(api_key),
            mode,
            cancelled,
            Arc::clone(&control.pending),
            request.task,
            request.step_approval,
        )
        .await;
        if let Err(error) = outcome {
            tracing::warn!(%error, session = %session_id, "agent run ended with an error");
        }
        control.end(&session_id);
    });

    Ok(())
}

/// Cancels the run for a session and rejects any pending approval.
#[tauri::command]
pub fn agent_cancel(
    control: State<'_, Arc<AgentControl>>,
    session_id: String,
) -> Result<(), ApiError> {
    control.cancel(&session_id);
    Ok(())
}

/// Answers an approval question raised by the runtime.
#[tauri::command]
pub fn agent_approve(
    control: State<'_, Arc<AgentControl>>,
    call_id: String,
    approved: bool,
) -> Result<(), ApiError> {
    control.resolve(&call_id, approved);
    Ok(())
}

/// Event names the panel listens to, mirrored for the frontend.
#[tauri::command]
pub fn agent_event_names() -> (String, String) {
    (AGENT_EVENT.to_owned(), AGENT_APPROVAL.to_owned())
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

/// Lists recent agent runs, newest first.
#[tauri::command]
pub fn list_agent_runs(
    store: State<'_, Store>,
    session_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<AgentRunSummary>, ApiError> {
    Ok(store.list_agent_runs(session_id.as_deref(), limit.unwrap_or(20))?)
}

/// Loads one stored run with its event sequence, used to replay the timeline.
#[tauri::command]
pub fn get_agent_run(
    store: State<'_, Store>,
    id: String,
) -> Result<Option<AgentRunRecord>, ApiError> {
    Ok(store.get_agent_run(&id)?)
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
        },
    )
    .await
}
