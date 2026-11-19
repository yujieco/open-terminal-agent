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
    Approver, CommandOutcome, ControlSignal, LlmClient, LlmProviderConfig, PermissionMode,
    Result as AgentResult,
};
use term_core::{ShadowScreen, TerminalTransport};
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::state::SessionKind;

/// Event carrying one agent runtime event.
pub const AGENT_EVENT: &str = "agent://event";
/// Event asking the user to approve one command.
pub const AGENT_APPROVAL: &str = "agent://approval";
/// Event emitted when human input takes the terminal back mid-run.
pub const AGENT_INTERRUPTED: &str = "agent://interrupted";

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

    /// Whether a run is currently in flight for `session_id`.
    pub fn is_running(&self, session_id: &str) -> bool {
        self.cancel
            .lock()
            .map(|cancel| cancel.contains_key(session_id))
            .unwrap_or(false)
    }

    /// Human keystroke arbitration: whoever types takes the terminal back.
    ///
    /// Returns `true` when an agent run was actually interrupted, so the caller
    /// can tell the UI what just happened.
    pub fn interrupt_for_human(&self, session_id: &str) -> bool {
        let flag = self
            .cancel
            .lock()
            .ok()
            .and_then(|cancel| cancel.get(session_id).cloned());

        match flag {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                self.reject_all();
                true
            }
            None => false,
        }
    }

    /// Requests cancellation of the run for `session_id`.
    pub fn cancel(&self, session_id: &str) {
        if let Ok(cancel) = self.cancel.lock()
            && let Some(flag) = cancel.get(session_id)
        {
            flag.store(true, Ordering::SeqCst);
        }
        self.reject_all();
    }

    /// Resolves one approval question.
    pub fn resolve(&self, call_id: &str, approved: bool) {
        if let Ok(mut pending) = self.pending.lock()
            && let Some(sender) = pending.remove(call_id)
        {
            let _ = sender.send(approved);
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

/// Builds a client for the configured provider using the keyring-held key.
pub fn build_client(
    config: LlmProviderConfig,
    api_key: Option<String>,
) -> AgentResult<Arc<OpenAiCompatibleClient>> {
    Ok(Arc::new(OpenAiCompatibleClient::new(config, api_key)?))
}

/// Forwards runtime events to the WebView, collecting them for the run record.
pub fn forward_events(
    app: AppHandle,
    session_id: String,
    mut events: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
) -> tokio::task::JoinHandle<Vec<AgentEvent>> {
    tokio::spawn(async move {
        let mut collected = Vec::new();
        while let Some(event) = events.recv().await {
            let payload = AgentEventPayload {
                session_id: session_id.clone(),
                event: event.clone(),
            };
            collected.push(event);
            if app.emit(AGENT_EVENT, payload).is_err() {
                // The window is gone; keep draining so the record stays complete.
                continue;
            }
        }
        collected
    })
}

/// Configures a runtime with the limits this app uses.
pub fn runtime_config(step_approval: bool) -> AgentRuntimeConfig {
    AgentRuntimeConfig {
        max_steps: 24,
        command_timeout: Duration::from_secs(120),
        scrollback: 120,
        step_approval,
        ..AgentRuntimeConfig::default()
    }
}

/// Runs one task, records it, and returns when the loop stops.
#[allow(clippy::too_many_arguments)]
pub async fn run_task(
    app: AppHandle,
    store: crate::store::Store,
    config: LlmProviderConfig,
    session_id: String,
    terminal: SessionTerminal,
    api_key: Option<String>,
    mode: PermissionMode,
    cancelled: Arc<AtomicBool>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    task: String,
    step_approval: bool,
) -> AgentResult<()> {
    let client = build_client(config, api_key)?;
    let model = client.model().to_owned();
    let started_at = now_millis();

    let (events_tx, events_rx) = tokio::sync::mpsc::unbounded_channel();
    let collector = forward_events(app.clone(), session_id.clone(), events_rx);

    let runtime = AgentRuntime::new(
        client,
        Arc::new(terminal),
        mode,
        Arc::new(EventApprover {
            app,
            session_id: session_id.clone(),
            pending,
        }),
        events_tx,
        cancelled,
    )
    .with_config(runtime_config(step_approval));

    let outcome = runtime.run(&task).await;

    // Persist before returning so a crash cannot lose what the user just watched.
    let events = collector.await.unwrap_or_default();
    let status = outcome_status(&events, outcome.is_err());
    let commands = events
        .iter()
        .filter(|event| matches!(event, AgentEvent::ToolFinished { .. }))
        .count() as u32;
    let mode_label = match mode {
        PermissionMode::Ask => "ask",
        PermissionMode::Supervised => "supervised",
        PermissionMode::Autonomous => "autonomous",
    };

    let events_json = serde_json::to_value(&events).unwrap_or(serde_json::Value::Null);
    if let Err(error) = store.save_agent_run(crate::store::NewAgentRun {
        session_id,
        task,
        mode: mode_label.to_owned(),
        model,
        status,
        commands,
        started_at,
        finished_at: now_millis(),
        events: events_json,
    }) {
        tracing::warn!(%error, "could not persist the agent run");
    }

    outcome
}

/// Derives the stored status label from the event stream.
fn outcome_status(events: &[AgentEvent], failed: bool) -> String {
    if failed
        || events
            .iter()
            .any(|event| matches!(event, AgentEvent::Failed { .. }))
    {
        return String::from("failed");
    }
    match events.last() {
        Some(AgentEvent::RunFinished { reason, .. }) => format!("{reason:?}"),
        _ => String::from("unknown"),
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
