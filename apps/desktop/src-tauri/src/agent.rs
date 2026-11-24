// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Glue between the agent runtime and one live session.
//!
//! The runtime never sees Tauri: this module adapts a registry entry to
//! [`AgentTerminal`], turns approvals into events the panel can render, and
//! forwards every `AgentEvent` to the WebView so the user watches each command
//! the moment it is decided.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tokio::time::Instant;

use crate::state::SessionKind;

/// Event carrying one agent runtime event.
pub const AGENT_EVENT: &str = "agent://event";
/// Event asking the user to approve one command.
pub const AGENT_APPROVAL: &str = "agent://approval";
/// Event emitted when human input takes the terminal back mid-run.
pub const AGENT_INTERRUPTED: &str = "agent://interrupted";

/// Maximum raw bytes buffered while waiting for command completion.
const MAX_CAPTURE_BYTES: usize = 256 * 1024;

/// Quiet window after a shell prompt reappears on sessions without OSC 133;D
/// (such as remote SSH hosts) before treating the command as finished.
const PROMPT_SETTLE_WINDOW: Duration = Duration::from_millis(350);

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

/// One pending approval tagged with the session that owns it, so cancelling or
/// taking over one tab never rejects approvals waiting in another tab.
pub struct PendingApproval {
    /// Session that requested approval.
    pub session_id: String,
    /// Channel back to the waiting runtime.
    pub sender: oneshot::Sender<bool>,
}

/// One session exposed to the runtime.
pub struct SessionTerminal {
    /// Transport used for writes and reactive output subscriptions.
    pub transport: Arc<dyn TerminalTransport>,
    /// Shadow screen used for clean text reads.
    pub screen: Arc<AsyncMutex<ShadowScreen>>,
    /// Session kind, which decides how completion is detected.
    pub kind: SessionKind,
}

impl SessionTerminal {
    async fn snapshot(&self, scrollback: usize) -> String {
        let mut screen = self.screen.lock().await;
        let history = screen.scrollback_lines(scrollback);
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

    /// Executes a command cleanly without appending any synthetic `printf`
    /// sentinel to the user's terminal or remote shell history.
    ///
    /// Completion detection works in two layers:
    /// 1. **Instant exact path**: standard invisible `OSC 133;D;<exit_code>`
    ///    emitted automatically by local shell integration (or remote shells
    ///    that support OSC 133).
    /// 2. **Smart prompt-return path** (remote SSH / plain shells): watches for
    ///    the stream to settle for [`PROMPT_SETTLE_WINDOW`] while the cursor is
    ///    resting on a live shell prompt line (never prematurely firing while
    ///    slow commands like `sleep` or `apt-get` have the cursor on a blank or
    ///    output line).
    async fn execute_shell_command(
        &self,
        command: &str,
        timeout: Duration,
    ) -> AgentResult<CommandOutcome> {
        let pre_prompt = self.current_cursor_line().await;
        let prompt_prefix = extract_prompt_prefix(&pre_prompt);

        let mut output_rx = self.transport.subscribe_output();
        self.transport
            .write_bytes(format!("{command}\r").as_bytes())
            .await
            .map_err(|error| Self::io_error("execute_command", error))?;

        let deadline = Instant::now() + timeout;
        let mut buffer: Vec<u8> = Vec::with_capacity(8 * 1024);
        let mut saw_newline = false;
        let mut settle_deadline: Option<Instant> = None;

        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    let _ = self
                        .transport
                        .write_bytes(ControlSignal::CtrlC.bytes())
                        .await;
                    return Ok(CommandOutcome {
                        exit_code: None,
                        output: self.snapshot(120).await,
                        timed_out: true,
                    });
                }
                _ = wait_optional(settle_deadline) => {
                    settle_deadline = None;
                    let cursor_line = self.current_cursor_line().await;
                    if looks_like_shell_prompt(&cursor_line, prompt_prefix.as_deref(), command) {
                        return Ok(CommandOutcome {
                            exit_code: None,
                            output: self.snapshot(120).await,
                            timed_out: false,
                        });
                    }
                }
                received = output_rx.recv() => match received {
                    Ok(frame) => {
                        if frame.bytes.contains(&b'\n') {
                            saw_newline = true;
                        }
                        append_bounded(&mut buffer, &frame.bytes, MAX_CAPTURE_BYTES);
                        if let Some(exit_code) = find_osc133_exit_code(&buffer) {
                            // Yield briefly so the shared output forwarder feeds
                            // this frame into the shadow screen before we read it.
                            tokio::time::sleep(Duration::from_millis(20)).await;
                            return Ok(CommandOutcome {
                                exit_code: Some(exit_code),
                                output: self.snapshot(120).await,
                                timed_out: false,
                            });
                        }
                        if saw_newline {
                            settle_deadline = Some(Instant::now() + PROMPT_SETTLE_WINDOW);
                        }
                    }
                    Err(RecvError::Lagged(_)) => {
                        saw_newline = true;
                        settle_deadline = Some(Instant::now() + PROMPT_SETTLE_WINDOW);
                    }
                    Err(RecvError::Closed) => {
                        return Ok(CommandOutcome {
                            exit_code: None,
                            output: self.snapshot(120).await,
                            timed_out: false,
                        });
                    }
                }
            }
        }
    }

    async fn current_cursor_line(&self) -> String {
        let screen = self.screen.lock().await;
        let row = screen.cursor().row as usize;
        screen.visible_lines().get(row).cloned().unwrap_or_default()
    }

    /// Serial consoles run U-Boot, RTOS or AT firmware that never echo a
    /// sentinel, so completion is inferred from a 300ms stream idle window.
    async fn execute_with_idle_detection(
        &self,
        command: &str,
        timeout: Duration,
    ) -> AgentResult<CommandOutcome> {
        let mut output_rx = self.transport.subscribe_output();
        self.transport
            .write_bytes(format!("{command}\r").as_bytes())
            .await
            .map_err(|error| Self::io_error("execute_command", error))?;

        let deadline = Instant::now() + timeout;
        let idle_window = Duration::from_millis(300);
        let mut idle_deadline = Instant::now() + idle_window;

        loop {
            let next_wake = deadline.min(idle_deadline);
            tokio::select! {
                _ = tokio::time::sleep_until(next_wake) => {
                    let timed_out = Instant::now() >= deadline;
                    return Ok(CommandOutcome {
                        exit_code: None,
                        output: self.snapshot(120).await,
                        timed_out,
                    });
                }
                received = output_rx.recv() => match received {
                    Ok(_) | Err(RecvError::Lagged(_)) => {
                        idle_deadline = Instant::now() + idle_window;
                    }
                    Err(RecvError::Closed) => {
                        return Ok(CommandOutcome {
                            exit_code: None,
                            output: self.snapshot(120).await,
                            timed_out: false,
                        });
                    }
                }
            }
        }
    }
}

/// Appends bytes while keeping the buffer bounded to the most recent `limit` bytes.
fn append_bounded(buffer: &mut Vec<u8>, chunk: &[u8], limit: usize) {
    buffer.extend_from_slice(chunk);
    if buffer.len() > limit {
        let excess = buffer.len() - limit;
        buffer.drain(..excess);
    }
}

async fn wait_optional(deadline: Option<Instant>) {
    match deadline {
        Some(instant) => tokio::time::sleep_until(instant).await,
        None => std::future::pending().await,
    }
}

/// Finds a standard `OSC 133;D;<exit_code>` sequence in captured transport bytes.
fn find_osc133_exit_code(bytes: &[u8]) -> Option<i32> {
    const PREFIX: &str = "\x1b]133;D;";
    let text = String::from_utf8_lossy(bytes);
    let mut search_from = 0;
    let mut matched = None;
    while let Some(offset) = text[search_from..].find(PREFIX) {
        let after = search_from + offset + PREFIX.len();
        let rest = &text[after..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            let after_digits = &rest[digits.len()..];
            if (after_digits.starts_with('\x07')
                || after_digits.starts_with("\x1b\\")
                || after_digits.starts_with(';'))
                && let Ok(code) = digits.parse::<i32>()
            {
                matched = Some(code);
            }
        }
        search_from = after;
    }
    matched
}

/// Extracts a stable host/user prefix from a shell prompt line such as
/// `ubuntu@VM-0-8-ubuntu:~$` -> `Some("ubuntu@VM-0-8-ubuntu")`.
fn extract_prompt_prefix(prompt_line: &str) -> Option<String> {
    let trimmed = prompt_line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((prefix, _)) = trimmed.split_once(':')
        && prefix.contains('@')
        && prefix.len() >= 3
    {
        return Some(prefix.to_owned());
    }
    trimmed
        .split_whitespace()
        .next()
        .filter(|token| token.contains('@') && token.len() >= 3)
        .map(str::to_owned)
}

/// Heuristic for detecting when the cursor has returned to an interactive shell
/// prompt on remote SSH sessions that do not emit OSC 133;D.
fn looks_like_shell_prompt(
    cursor_line: &str,
    prompt_prefix: Option<&str>,
    executed_command: &str,
) -> bool {
    let trimmed = cursor_line.trim_end();
    if trimmed.is_empty() {
        return false;
    }
    let first_cmd_piece = executed_command.trim().lines().next().unwrap_or_default();
    if !first_cmd_piece.is_empty() && trimmed.ends_with(first_cmd_piece) {
        return false;
    }

    let ends_with_prompt_char = trimmed
        .chars()
        .last()
        .is_some_and(|ch| matches!(ch, '$' | '#' | '%' | '>' | '❯' | '➜' | 'λ' | '»' | '›'));
    if !ends_with_prompt_char {
        return false;
    }

    if let Some(prefix) = prompt_prefix
        && trimmed.contains(prefix)
    {
        return true;
    }

    // Standard short prompt lines (e.g. `root@box:~#`, `$`, `bash-5.2$`, `~ %`).
    trimmed.len() <= 120
}

#[async_trait]
impl AgentTerminal for SessionTerminal {
    async fn screen(&self, scrollback: usize) -> AgentResult<String> {
        Ok(self.snapshot(scrollback).await)
    }

    async fn execute(&self, command: &str, timeout: Duration) -> AgentResult<CommandOutcome> {
        match self.kind {
            SessionKind::Serial => self.execute_with_idle_detection(command, timeout).await,
            SessionKind::Local | SessionKind::Ssh => {
                self.execute_shell_command(command, timeout).await
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
    pub pending: Arc<Mutex<HashMap<String, PendingApproval>>>,
}

#[async_trait]
impl Approver for EventApprover {
    async fn approve(&self, request: &ApprovalRequest) -> bool {
        let (sender, receiver) = oneshot::channel();
        match self.pending.lock() {
            Ok(mut pending) => {
                pending.insert(
                    request.call_id.clone(),
                    PendingApproval {
                        session_id: self.session_id.clone(),
                        sender,
                    },
                );
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
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&request.call_id);
            }
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
    /// Pending approvals per tool call id, tagged with their owning session.
    pub pending: Arc<Mutex<HashMap<String, PendingApproval>>>,
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
        self.reject_session(session_id);
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
                self.reject_session(session_id);
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
        self.reject_session(session_id);
    }

    /// Resolves one approval question.
    pub fn resolve(&self, call_id: &str, approved: bool) {
        if let Ok(mut pending) = self.pending.lock()
            && let Some(entry) = pending.remove(call_id)
        {
            let _ = entry.sender.send(approved);
        }
    }

    /// Rejects only the pending approvals belonging to `session_id`.
    fn reject_session(&self, session_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            let matching: Vec<String> = pending
                .iter()
                .filter(|(_, entry)| entry.session_id == session_id)
                .map(|(call_id, _)| call_id.clone())
                .collect();
            for call_id in matching {
                if let Some(entry) = pending.remove(&call_id) {
                    let _ = entry.sender.send(false);
                }
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
    pending: Arc<Mutex<HashMap<String, PendingApproval>>>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_is_visible_and_human_input_wins() {
        let control = AgentControl::default();
        assert!(!control.is_running("local-1"));

        let flag = control.begin("local-1");
        assert!(control.is_running("local-1"));
        assert!(!flag.load(Ordering::SeqCst), "a fresh run is not cancelled");

        // Typing in the terminal must cancel the run, not race with it.
        assert!(control.interrupt_for_human("local-1"));
        assert!(flag.load(Ordering::SeqCst));

        // A session with no run reports "nothing to interrupt" instead of
        // pretending it stopped something.
        assert!(!control.interrupt_for_human("local-2"));

        control.end("local-1");
        assert!(!control.is_running("local-1"));
    }

    #[tokio::test]
    async fn approve_sends_the_decision_to_the_waiting_runtime() {
        let control = AgentControl::default();
        let (sender, receiver) = oneshot::channel();
        control.pending.lock().expect("pending").insert(
            String::from("call-1"),
            PendingApproval {
                session_id: String::from("local-1"),
                sender,
            },
        );

        control.resolve("call-1", false);
        assert!(!receiver.await.expect("decision"));
        // A second answer for the same call is a no-op, not a panic.
        control.resolve("call-1", true);
    }

    #[tokio::test]
    async fn cancelling_one_session_keeps_other_sessions_approvals_alive() {
        let control = AgentControl::default();
        let (first_tx, first_rx) = oneshot::channel();
        let (second_tx, mut second_rx) = oneshot::channel();
        {
            let mut pending = control.pending.lock().expect("pending");
            pending.insert(
                String::from("call-a"),
                PendingApproval {
                    session_id: String::from("ssh-1"),
                    sender: first_tx,
                },
            );
            pending.insert(
                String::from("call-b"),
                PendingApproval {
                    session_id: String::from("local-2"),
                    sender: second_tx,
                },
            );
        }
        let _flag_a = control.begin("ssh-1");
        let _flag_b = control.begin("local-2");

        control.cancel("ssh-1");

        assert!(!first_rx.await.expect("first cancelled"));
        assert!(
            second_rx.try_recv().is_err(),
            "unrelated session approval must stay pending"
        );
        assert_eq!(control.pending.lock().expect("pending").len(), 1);
    }

    #[test]
    fn osc133_exit_code_is_parsed_and_invisible_on_screen() {
        let completed = b"hello world\r\n\x1b]133;D;127\x07\x1b]133;A\x07$ ";
        assert_eq!(find_osc133_exit_code(completed), Some(127));
        assert_eq!(find_osc133_exit_code(b"plain output only\r\n"), None);

        let mut screen = ShadowScreen::new(80, 10).expect("screen");
        screen.feed(completed);
        let visible = screen.visible_text();
        assert!(visible.contains("hello world"));
        assert!(!visible.contains("133"));
    }

    #[test]
    fn prompt_detector_recognizes_ssh_prompt_return_and_ignores_blank_or_echo_lines() {
        let prefix = extract_prompt_prefix("ubuntu@VM-0-8-ubuntu:~$ ");
        assert_eq!(prefix.as_deref(), Some("ubuntu@VM-0-8-ubuntu"));

        // Blank cursor line while a slow command is still running must not match.
        assert!(!looks_like_shell_prompt(
            "",
            prefix.as_deref(),
            "apt-get -s upgrade"
        ));
        // The echoed command itself must not match.
        assert!(!looks_like_shell_prompt(
            "ubuntu@VM-0-8-ubuntu:~$ apt-get -s upgrade",
            prefix.as_deref(),
            "apt-get -s upgrade"
        ));
        // Returned prompt (even after `cd /var/log`) matches cleanly.
        assert!(looks_like_shell_prompt(
            "ubuntu@VM-0-8-ubuntu:/var/log$ ",
            prefix.as_deref(),
            "cd /var/log"
        ));
    }
}
