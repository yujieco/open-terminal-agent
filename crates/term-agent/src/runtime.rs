// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! The agent runtime: natural language in, visible terminal steps out.
//!
//! Design notes (this is where the product differs from a black-box harness):
//!
//! - The runtime knows nothing about Tauri, React or PTYs. It talks to
//!   [`AgentTerminal`] for terminal access, [`LlmClient`] for the model, and
//!   emits every decision as an [`AgentEvent`] on a channel.
//! - Nothing is hidden: before a command runs, `ToolRequested` carries the exact
//!   command line and its classified risk; after it runs, `ToolFinished` carries
//!   the captured output and exit code. A UI can therefore render a timeline that
//!   matches what the terminal actually did.
//! - The permission policy is consulted before every write, so Ask/Supervised/
//!   Autonomous behave the same here as in the rest of the app.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::error::{AgentError, Result};
use crate::llm::{ChatMessage, ChatRole, LlmClient, StreamSink, ToolCall};
use crate::loop_engine::StepBudget;
use crate::policy::{CommandRisk, PermissionMode, PolicyDecision, SessionPolicy, classify_command};
use crate::tools::{
    ControlSignal, EXECUTE_COMMAND, READ_TERMINAL_SCREEN, SEND_CONTROL_SIGNAL, ToolCallRequest,
    tool_catalog,
};

/// Default ceiling on model turns for one task.
pub const DEFAULT_MAX_STEPS: u32 = 24;

/// Default time a single command may take before it is interrupted.
pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// Scrollback lines handed to the model when it reads the screen.
pub const DEFAULT_SCROLLBACK_LINES: usize = 200;

/// System prompt that keeps the loop grounded and visible.
pub const SYSTEM_PROMPT: &str = "\
You are the terminal operator inside Open Terminal Agent. The user watches every \
step you take in a live terminal, so your work must be legible.

Rules:
1. Run exactly one command per tool call. Never chain unrelated commands with `;` \
to hide work — the user is following along.
2. After every command, use the output you received. If it is ambiguous, read the \
screen before guessing.
3. Prefer read-only inspection first (ls, cat, ps, df, git status). Explain in one \
short sentence why you are running the next command.
4. State-changing or destructive commands may require the user's approval; do not \
retry a denied command, find a safer way or ask a question.
5. Report what actually happened. Never claim a result you did not observe in tool \
output.
6. When the task is done, answer in the user's language, briefly, and list the \
commands you ran.";

/// What the agent may do with a terminal.
#[async_trait]
pub trait AgentTerminal: Send + Sync {
    /// Clean visible text plus recent scrollback, no escape sequences.
    async fn screen(&self, scrollback: usize) -> Result<String>;

    /// Runs one command and waits for completion.
    async fn execute(&self, command: &str, timeout: Duration) -> Result<CommandOutcome>;

    /// Injects raw bytes, used for control signals such as Ctrl+C.
    async fn send_bytes(&self, data: &[u8]) -> Result<()>;
}

/// Result of one terminal command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutcome {
    /// Exit code reported by the shell marker, when one was seen.
    pub exit_code: Option<i32>,
    /// Screen tail captured after the command finished.
    pub output: String,
    /// Whether the command had to be interrupted.
    pub timed_out: bool,
}

/// One approval question raised before a gated command runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// Tool call this question belongs to.
    pub call_id: String,
    /// Command line waiting for a decision.
    pub command: String,
    /// Risk classification shown to the user.
    pub risk: CommandRisk,
}

/// Decides whether a gated command may run.
#[async_trait]
pub trait Approver: Send + Sync {
    /// Returns `true` to run the command.
    async fn approve(&self, request: &ApprovalRequest) -> bool;
}

/// Approver that accepts everything, used by tests and by autonomous runs.
pub struct AlwaysApprove;

#[async_trait]
impl Approver for AlwaysApprove {
    async fn approve(&self, _request: &ApprovalRequest) -> bool {
        true
    }
}

/// Approver that rejects everything, used to test the denial path.
pub struct AlwaysDeny;

#[async_trait]
impl Approver for AlwaysDeny {
    async fn approve(&self, _request: &ApprovalRequest) -> bool {
        false
    }
}

/// Why a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunFinishReason {
    /// The model produced a final answer without further tool calls.
    Completed,
    /// The step budget ran out.
    StepBudget,
    /// The user took over or cancelled.
    Cancelled,
}

/// Everything the UI needs to render a run, as a stream of events.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    /// A run started.
    RunStarted {
        /// Task text typed by the user.
        task: String,
        /// Autonomy mode in force.
        mode: PermissionMode,
        /// Model that will be asked.
        model: String,
    },
    /// Reasoning delta from a reasoning model.
    Thinking {
        /// Incremental text.
        delta: String,
    },
    /// Answer text delta.
    Message {
        /// Incremental text.
        delta: String,
    },
    /// The model asked for a tool; the command is known before it runs.
    ToolRequested {
        /// One-based step number.
        step: u32,
        /// Tool call id.
        call_id: String,
        /// Tool name.
        tool: String,
        /// Exact command line, when the tool runs one.
        command: Option<String>,
        /// Risk classification, when the tool runs a command.
        risk: Option<CommandRisk>,
    },
    /// A gated command was approved.
    ToolApproved {
        /// Tool call id.
        call_id: String,
    },
    /// A gated command was rejected, so nothing was written to the terminal.
    ToolDenied {
        /// Tool call id.
        call_id: String,
        /// Command that did not run.
        command: String,
    },
    /// A tool finished and produced output the user can read.
    ToolFinished {
        /// One-based step number.
        step: u32,
        /// Tool call id.
        call_id: String,
        /// Exit code, when one was reported.
        exit_code: Option<i32>,
        /// Captured output tail.
        output: String,
        /// Whether the command was interrupted on timeout.
        timed_out: bool,
        /// Wall clock duration in milliseconds.
        duration_ms: u64,
    },
    /// The model read the screen.
    ScreenRead {
        /// Tool call id.
        call_id: String,
        /// Number of lines returned.
        lines: usize,
    },
    /// A control signal was injected.
    SignalSent {
        /// Tool call id.
        call_id: String,
        /// Signal name.
        signal: String,
    },
    /// The run ended.
    RunFinished {
        /// Steps consumed.
        steps: u32,
        /// Why it ended.
        reason: RunFinishReason,
    },
    /// The run failed; the message is user facing.
    Failed {
        /// Failure description.
        message: String,
    },
}

/// Knobs for one runtime instance.
#[derive(Debug, Clone)]
pub struct AgentRuntimeConfig {
    /// Maximum model turns.
    pub max_steps: u32,
    /// Per-command timeout.
    pub command_timeout: Duration,
    /// Scrollback lines included in a screen read.
    pub scrollback: usize,
}

impl Default for AgentRuntimeConfig {
    fn default() -> Self {
        Self {
            max_steps: DEFAULT_MAX_STEPS,
            command_timeout: DEFAULT_COMMAND_TIMEOUT,
            scrollback: DEFAULT_SCROLLBACK_LINES,
        }
    }
}

/// Streams deltas into [`AgentEvent`]s while a turn is in flight.
struct EventSink<'a> {
    events: &'a mpsc::UnboundedSender<AgentEvent>,
}

impl StreamSink for EventSink<'_> {
    fn on_reasoning(&mut self, delta: &str) {
        let _ = self.events.send(AgentEvent::Thinking {
            delta: delta.to_owned(),
        });
    }

    fn on_content(&mut self, delta: &str) {
        let _ = self.events.send(AgentEvent::Message {
            delta: delta.to_owned(),
        });
    }
}

/// Drives one task against one terminal.
pub struct AgentRuntime {
    client: Arc<dyn LlmClient>,
    terminal: Arc<dyn AgentTerminal>,
    approver: Arc<dyn Approver>,
    events: mpsc::UnboundedSender<AgentEvent>,
    config: AgentRuntimeConfig,
    policy: SessionPolicy,
    cancelled: Arc<AtomicBool>,
}

impl AgentRuntime {
    /// Builds a runtime for one session.
    pub fn new(
        client: Arc<dyn LlmClient>,
        terminal: Arc<dyn AgentTerminal>,
        mode: PermissionMode,
        approver: Arc<dyn Approver>,
        events: mpsc::UnboundedSender<AgentEvent>,
        cancelled: Arc<AtomicBool>,
    ) -> Self {
        Self {
            client,
            terminal,
            approver,
            events,
            config: AgentRuntimeConfig::default(),
            policy: SessionPolicy::new(mode),
            cancelled,
        }
    }

    /// Overrides the default limits.
    pub fn with_config(mut self, config: AgentRuntimeConfig) -> Self {
        self.config = config;
        self
    }

    /// Runs the task to completion, emitting an event for every visible step.
    pub async fn run(mut self, task: &str) -> Result<()> {
        let _ = self.events.send(AgentEvent::RunStarted {
            task: task.to_owned(),
            mode: self.policy.mode(),
            model: self.client.model().to_owned(),
        });

        if let Err(error) = self.policy.begin_run() {
            // A run already in flight is a programming error, not a crash.
            self.finish(0, RunFinishReason::Cancelled);
            return Err(error);
        }

        let tools = tool_catalog();
        let mut messages = vec![
            ChatMessage::text(ChatRole::System, SYSTEM_PROMPT),
            ChatMessage::text(ChatRole::User, task),
        ];
        let mut budget = StepBudget::new(self.config.max_steps);
        let mut steps = 0u32;

        loop {
            if self.cancelled.load(Ordering::SeqCst) {
                self.interrupt().await;
                self.finish(steps, RunFinishReason::Cancelled);
                return Ok(());
            }

            if let Err(error) = budget.consume() {
                self.finish(steps, RunFinishReason::StepBudget);
                return Err(error);
            }
            steps = budget.used();

            let response = {
                let mut sink = EventSink {
                    events: &self.events,
                };
                self.client
                    .complete_streaming(&messages, &tools, &mut sink)
                    .await
            };

            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    let message = error.to_string();
                    let _ = self.events.send(AgentEvent::Failed {
                        message: message.clone(),
                    });
                    self.policy.finish_run();
                    return Err(error);
                }
            };

            messages.push(ChatMessage {
                role: ChatRole::Assistant,
                content: response.content.clone(),
                reasoning_content: response.reasoning_content.clone(),
                tool_call_id: None,
                tool_calls: response.tool_calls.clone(),
            });

            if response.tool_calls.is_empty() {
                self.finish(steps, RunFinishReason::Completed);
                return Ok(());
            }

            for call in &response.tool_calls {
                if self.cancelled.load(Ordering::SeqCst) {
                    self.interrupt().await;
                    self.finish(steps, RunFinishReason::Cancelled);
                    return Ok(());
                }
                let result = self.run_tool(call, steps).await?;
                messages.push(ChatMessage::tool_result(call.id.clone(), result));
            }
        }
    }

    fn finish(&mut self, steps: u32, reason: RunFinishReason) {
        self.policy.finish_run();
        let _ = self.events.send(AgentEvent::RunFinished { steps, reason });
    }

    /// Sends Ctrl+C so a running command does not outlive the run.
    async fn interrupt(&self) {
        let _ = self.terminal.send_bytes(ControlSignal::CtrlC.bytes()).await;
    }

    /// Executes one tool call, gating commands through the policy.
    async fn run_tool(&mut self, call: &ToolCall, step: u32) -> Result<String> {
        let request = ToolCallRequest::new(call.name.clone(), call.arguments.clone());
        request.validate()?;

        match call.name.as_str() {
            READ_TERMINAL_SCREEN => {
                let text = self.terminal.screen(self.config.scrollback).await?;
                let lines = text.lines().count();
                let _ = self.events.send(AgentEvent::ScreenRead {
                    call_id: call.id.clone(),
                    lines,
                });
                Ok(format!("screen ({lines} lines):\n{text}"))
            }
            EXECUTE_COMMAND => {
                let command = request.command()?.to_owned();
                let risk = classify_command(&command);
                let _ = self.events.send(AgentEvent::ToolRequested {
                    step,
                    call_id: call.id.clone(),
                    tool: call.name.clone(),
                    command: Some(command.clone()),
                    risk: Some(risk),
                });

                if self.policy.decide(&command) == PolicyDecision::RequiresApproval {
                    let approval = ApprovalRequest {
                        call_id: call.id.clone(),
                        command: command.clone(),
                        risk,
                    };
                    if !self.approver.approve(&approval).await {
                        let _ = self.events.send(AgentEvent::ToolDenied {
                            call_id: call.id.clone(),
                            command: command.clone(),
                        });
                        return Ok(format!(
                            "denied: the user refused to run `{command}`. Do not retry it; \
                             choose a safer approach or ask a question."
                        ));
                    }
                    let _ = self.events.send(AgentEvent::ToolApproved {
                        call_id: call.id.clone(),
                    });
                }

                let started = Instant::now();
                let outcome = self
                    .terminal
                    .execute(&command, self.config.command_timeout)
                    .await?;
                let duration_ms = started.elapsed().as_millis() as u64;

                let _ = self.events.send(AgentEvent::ToolFinished {
                    step,
                    call_id: call.id.clone(),
                    exit_code: outcome.exit_code,
                    output: outcome.output.clone(),
                    timed_out: outcome.timed_out,
                    duration_ms,
                });

                Ok(format!(
                    "exit_code: {}\ntimed_out: {}\noutput:\n{}",
                    outcome
                        .exit_code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| String::from("unknown")),
                    outcome.timed_out,
                    outcome.output
                ))
            }
            SEND_CONTROL_SIGNAL => {
                let signal = request
                    .arguments
                    .get("signal")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AgentError::ToolFailure {
                        tool: call.name.clone(),
                        message: String::from("missing argument `signal`"),
                    })?;
                let signal = match signal {
                    "ctrl_c" => ControlSignal::CtrlC,
                    "ctrl_d" => ControlSignal::CtrlD,
                    "ctrl_z" => ControlSignal::CtrlZ,
                    "tab" => ControlSignal::Tab,
                    "escape" => ControlSignal::Escape,
                    "enter" => ControlSignal::Enter,
                    other => {
                        return Err(AgentError::ToolFailure {
                            tool: call.name.clone(),
                            message: format!("unknown signal `{other}`"),
                        });
                    }
                };

                self.terminal.send_bytes(signal.bytes()).await?;
                let _ = self.events.send(AgentEvent::SignalSent {
                    call_id: call.id.clone(),
                    signal: format!("{signal:?}"),
                });
                Ok(format!("sent {signal:?}"))
            }
            other => Err(AgentError::ToolFailure {
                tool: other.to_owned(),
                message: String::from("unknown tool"),
            }),
        }
    }
}
