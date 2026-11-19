// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Glue between the agent runtime and one live session.
//!
//! The runtime never sees Tauri: this module adapts a registry entry to
//! [`AgentTerminal`], turns approvals into events the panel can render, and
//! forwards every `AgentEvent` to the WebView so the user watches each command
//! the moment it is decided.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use term_agent::llm::OpenAiCompatibleClient;
use term_agent::{
    AgentError, AgentEvent, AgentRuntime, AgentRuntimeConfig, AgentTerminal, ApprovalRequest,
    Approver, CommandOutcome, ControlSignal, LlmProviderConfig, PermissionMode,
    Result as AgentResult,
};
use term_core::{ShadowScreen, TerminalTransport};
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::state::SessionKind;

/// Event carrying one agent runtime event.
pub const AGENT_EVENT: &str = "agent://event";
/// Event asking the user to approve one command.
pub const AGENT_APPROVAL: &str = "agent://approval";

/// Marker prefix used to detect command completion on an echoing transport.
static COMMAND_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Payload of [`AGENT_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPayload {
    /// Session the run belongs to.
    pub session_id: String,
    /// The runtime event itself.
    pub event: AgentEvent,
}

/// Payload of [`AGENT_APPROVAL`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPayload {
    /// Session the run belongs to.
    pub session_id: String,
    /// Tool call awaiting a decision.
    pub call_id: String,
    /// Command line that will run.
    pub command: String,
    /// Risk classification.
    pub risk: String,
}

/// One session exposed to the runtime.
pub struct SessionTerminal {
    /// Transport used for writes.
    pub transport: Arc<dyn TerminalTransport>,
    /// Shadow screen used for reads.
    pub screen: Arc<AsyncMutex<ShadowScreen>>,
    /// Session kind, which decides how completion is detected.
    pub kind: SessionKind,
}

impl SessionTerminal {
    async fn snapshot(&self) -> String {
        let mut screen = self.screen.lock().await;
        let history = screen.scrollback_lines(120);
        let visible = screen.visible_text();
        if history.is_empty() {
            visible
        } else {
            format!("{}\n{visible}", history.join("\n"))
        }
    }

    fn io_error(tool: &str, error: term_core::CoreError) -> AgentError {
        AgentError::ToolFailure {
            tool: tool.to_owned(),
            message: error.to_string(),
        }
    }

    /// Detects completion with a shell sentinel, used by PTY and SSH sessions.
    async fn execute_with_sentinel(
        &self,
        command: &str,
        timeout: Duration,
    ) -> AgentResult<CommandOutcome> {
        let marker = format!(
            "__OTA_{}__",
            COMMAND_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let line = format!("{command}; printf '\\n{marker}%s\\n' $?\r");
        self.transport
            .write_bytes(line.as_bytes())
            .await
            .map_err(|error| Self::io_error("execute_command", error))?;

        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                let _ = self
                    .transport
                    .write_bytes(ControlSignal::CtrlC.bytes())
                    .await;
                return Ok(CommandOutcome {
                    exit_code: None,
                    output: self.snapshot().await,
                    timed_out: true,
                });
            }

            tokio::time::sleep(Duration::from_millis(60)).await;
            let text = self.snapshot().await;
            if let Some(position) = text.rfind(&marker) {
                let tail = &text[position + marker.len()..];
                let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
                return Ok(CommandOutcome {
                    exit_code: digits.parse().ok(),
                    output: text,
                    timed_out: false,
                });
            }
        }
    }

    /// Serial consoles run U-Boot, RTOS or AT firmware that never echo a
    /// sentinel, so completion is inferred from an idle screen instead.
    async fn execute_with_idle_detection(
        &self,
        command: &str,
        timeout: Duration,
    ) -> AgentResult<CommandOutcome> {
        self.transport
            .write_bytes(format!("{command}\r").as_bytes())
            .await
            .map_err(|error| Self::io_error("execute_command", error))?;

        let deadline = Instant::now() + timeout;
        let mut previous = String::new();
        let mut stable_since = Instant::now();

        loop {
            if Instant::now() >= deadline {
                return Ok(CommandOutcome {
                    exit_code: None,
                    output: self.snapshot().await,
                    timed_out: true,
                });
            }

            tokio::time::sleep(Duration::from_millis(80)).await;
            let text = self.snapshot().await;
            if text == previous {
                if stable_since.elapsed() >= Duration::from_millis(300) {
                    return Ok(CommandOutcome {
                        exit_code: None,
                        output: text,
                        timed_out: false,
                    });
                }
            } else {
                previous = text;
                stable_since = Instant::now();
            }
        }
    }
}

#[async_trait]
impl AgentTerminal for SessionTerminal {
    async fn screen(&self, _scrollback: usize) -> AgentResult<String> {
        Ok(self.snapshot().await)
    }

    async fn execute(&self, command: &str, timeout: Duration) -> AgentResult<CommandOutcome> {
        match self.kind {
            SessionKind::Serial => self.execute_with_idle_detection(command, timeout).await,
            SessionKind::Local | SessionKind::Ssh => {
                self.execute_with_sentinel(command, timeout).await
            }
        }
    }

    async fn send_bytes(&self, data: &[u8]) -> AgentResult<()> {
        self.transport
            .write_bytes(data)
            .await
            .map_err(|error| Self::io_error("send_control_signal", error))
    }
}

/// Approver that asks the WebView and waits for the panel's answer.
pub struct EventApprover {
    /// Application handle used to emit the question.
    pub app: AppHandle,
    /// Session the run belongs to.
    pub session_id: String,
    /// Pending decisions keyed by tool call id.
    pub pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

#[async_trait]
impl Approver for EventApprover {
    async fn approve(&self, request: &ApprovalRequest) -> bool {
        let (sender, receiver) = oneshot::channel();
        match self.pending.lock() {
            Ok(mut pending) => {
                pending.insert(request.call_id.clone(), sender);
            }
            Err(_) => return false,
        }

        let payload = ApprovalPayload {
            session_id: self.session_id.clone(),
            call_id: request.call_id.clone(),
            command: request.command.clone(),
            risk: format!("{:?}", request.risk).to_lowercase(),
        };
        if self.app.emit(AGENT_APPROVAL, payload).is_err() {
            return false;
        }

        // A cancelled or closed panel resolves to "no": never run a command the
        // user did not explicitly approve.
        receiver.await.unwrap_or(false)
    }
}

/// Runtime wiring shared by the run and cancel commands.
#[derive(Default)]
pub struct AgentControl {
    /// Cancellation flags per session.
    pub cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Pending approvals per tool call id.
    pub pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

impl AgentControl {
    /// Registers a cancellation flag for a run, replacing a previous one.
    pub fn begin(&self, session_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut cancel) = self.cancel.lock() {
            cancel.insert(session_id.to_owned(), Arc::clone(&flag));
        }
        flag
    }

    /// Finishes a run and forgets its flag.
    pub fn end(&self, session_id: &str) {
        if let Ok(mut cancel) = self.cancel.lock() {
            cancel.remove(session_id);
        }
    }

    /// Requests cancellation of the run for `session_id`.
    pub fn cancel(&self, session_id: &str) {
        if let Ok(cancel) = self.cancel.lock() {
            if let Some(flag) = cancel.get(session_id) {
                flag.store(true, Ordering::SeqCst);
            }
        }
        self.reject_all();
    }

    /// Resolves one approval question.
    pub fn resolve(&self, call_id: &str, approved: bool) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(sender) = pending.remove(call_id) {
                let _ = sender.send(approved);
            }
        }
    }

    /// Rejects every outstanding question, used by cancel and take-over.
    fn reject_all(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(false);
            }
        }
    }
}

/// Builds a DeepSeek flash client from the keyring-held API key.
pub fn build_client(api_key: Option<String>) -> AgentResult<Arc<OpenAiCompatibleClient>> {
    let config = LlmProviderConfig::deepseek_flash();
    Ok(Arc::new(OpenAiCompatibleClient::new(config, api_key)?))
}

/// Forwards runtime events to the WebView until the run ends.
pub fn forward_events(
    app: AppHandle,
    session_id: String,
    mut events: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
) {
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            let payload = AgentEventPayload {
                session_id: session_id.clone(),
                event,
            };
            if app.emit(AGENT_EVENT, payload).is_err() {
                break;
            }
        }
    });
}

/// Configures a runtime with the limits this app uses.
pub fn runtime_config() -> AgentRuntimeConfig {
    AgentRuntimeConfig {
        max_steps: 24,
        command_timeout: Duration::from_secs(120),
        scrollback: 120,
    }
}

/// Runs one task and returns when the loop stops.
#[allow(clippy::too_many_arguments)]
pub async fn run_task(
    app: AppHandle,
    session_id: String,
    terminal: SessionTerminal,
    api_key: Option<String>,
    mode: PermissionMode,
    cancelled: Arc<AtomicBool>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    task: String,
) -> AgentResult<()> {
    let client = build_client(api_key)?;
    let (events_tx, events_rx) = tokio::sync::mpsc::unbounded_channel();
    forward_events(app.clone(), session_id.clone(), events_rx);

    let runtime = AgentRuntime::new(
        client,
        Arc::new(terminal),
        mode,
        Arc::new(EventApprover {
            app,
            session_id,
            pending,
        }),
        events_tx,
        cancelled,
    )
    .with_config(runtime_config());

    runtime.run(&task).await
}
