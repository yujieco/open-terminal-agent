// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Tauri commands: every byte the UI types or sees crosses one of these.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use term_agent::{LoopPhase, PermissionMode, ToolSpec, tool_catalog};
use term_core::pty::PtyTransport;
use term_core::{PtyConfig, ScreenSnapshot, ShadowScreen, TerminalTransport};
use tokio::sync::{Mutex as AsyncMutex, broadcast::error::RecvError};

use crate::error::ApiError;
use crate::locale::LocaleInfo;
use crate::state::{SessionHandle, SessionRegistry};
use crate::{TERMINAL_EXIT_EVENT, TERMINAL_OUTPUT_EVENT};

/// Smallest grid accepted from the UI, in columns.
const MIN_COLS: u16 = 20;
/// Largest grid accepted from the UI, in columns.
const MAX_COLS: u16 = 1_000;
/// Smallest grid accepted from the UI, in rows.
const MIN_ROWS: u16 = 5;
/// Largest grid accepted from the UI, in rows.
const MAX_ROWS: u16 = 500;

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

/// Session description returned to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// Session id used by every later command.
    pub session_id: String,
    /// Shell binary that was started.
    pub shell: String,
    /// Columns the PTY was created with.
    pub cols: u16,
    /// Rows the PTY was created with.
    pub rows: u16,
}

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

/// Emitted when the shell process ends.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPayload {
    /// Session that ended.
    pub session_id: String,
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

/// What the agent can do right now: the tool catalog, the loop phases and the
/// permission mode the UI should start in.
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

    let (transport, mut output) = PtyTransport::spawn_with_output(config).await?;
    let session_id = transport.session_id().as_str().to_owned();
    let shell = transport.shell().to_owned();

    let screen = Arc::new(AsyncMutex::new(ShadowScreen::new(cols, rows)?));
    let handle = Arc::new(SessionHandle {
        transport: Arc::new(transport),
        screen: Arc::clone(&screen),
        shell: shell.clone(),
        cols,
        rows,
    });
    registry.insert(Arc::clone(&handle))?;

    let app_handle = app.clone();
    let emitter_session_id = session_id.clone();
    tokio::spawn(async move {
        loop {
            match output.recv().await {
                Ok(frame) => {
                    {
                        let mut shadow = screen.lock().await;
                        shadow.feed(&frame.bytes);
                    }

                    let payload = OutputPayload {
                        session_id: emitter_session_id.clone(),
                        sequence: frame.sequence,
                        bytes: frame.bytes.len(),
                        data_base64: BASE64.encode(&frame.bytes),
                    };
                    if app_handle.emit(TERMINAL_OUTPUT_EVENT, payload).is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(
                        skipped,
                        session = %emitter_session_id,
                        "dropped terminal frames because a consumer fell behind"
                    );
                }
                Err(RecvError::Closed) => {
                    let _ = app_handle.emit(
                        TERMINAL_EXIT_EVENT,
                        ExitPayload {
                            session_id: emitter_session_id.clone(),
                        },
                    );
                    break;
                }
            }
        }
    });

    Ok(SessionInfo {
        session_id,
        shell,
        cols,
        rows,
    })
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

/// Resizes both the PTY and the shadow screen.
#[tauri::command]
pub async fn resize_session(
    registry: State<'_, SessionRegistry>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), ApiError> {
    let handle = registry.require(&session_id)?;
    handle.transport.resize(cols, rows)?;
    handle.screen.lock().await.resize(cols, rows)?;
    Ok(())
}

/// Terminates a session and frees its PTY.
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
            shell: handle.shell.clone(),
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
