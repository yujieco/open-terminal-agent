// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Proves the runtime emits a visible, ordered step stream and that nothing
//! reaches the terminal without a `ToolRequested` event first.

use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;
use term_agent::llm::ToolCall;
use term_agent::llm::{ChatResponse, StreamSink};
use term_agent::runtime::{
    AgentEvent, AgentRuntime, AgentRuntimeConfig, AgentTerminal, CommandOutcome,
};
use term_agent::{
    AlwaysDeny, ApprovalRequest, Approver, LlmClient, PermissionMode, Result, ToolSpec,
};

struct ScriptedClient {
    turns: Mutex<VecDeque<ChatResponse>>,
}

#[async_trait]
impl LlmClient for ScriptedClient {
    fn provider_id(&self) -> &str {
        "scripted"
    }

    fn model(&self) -> &str {
        "scripted-model"
    }

    async fn complete(
        &self,
        _messages: &[term_agent::ChatMessage],
        _tools: &[ToolSpec],
    ) -> Result<ChatResponse> {
        let mut turns = self.turns.lock().expect("script");
        Ok(turns.pop_front().unwrap_or_default())
    }

    async fn complete_streaming(
        &self,
        messages: &[term_agent::ChatMessage],
        tools: &[ToolSpec],
        sink: &mut dyn StreamSink,
    ) -> Result<ChatResponse> {
        let response = self.complete(messages, tools).await?;
        if let Some(reasoning) = &response.reasoning_content {
            sink.on_reasoning(reasoning);
        }
        sink.on_content(&response.content);
        Ok(response)
    }
}

#[derive(Default)]
struct RecordingTerminal {
    commands: Mutex<Vec<String>>,
    signals: Mutex<Vec<Vec<u8>>>,
}

#[async_trait]
impl AgentTerminal for RecordingTerminal {
    async fn screen(&self, _scrollback: usize) -> Result<String> {
        Ok(String::from("$ "))
    }

    async fn execute(&self, command: &str, _timeout: Duration) -> Result<CommandOutcome> {
        self.commands
            .lock()
            .expect("commands")
            .push(command.to_owned());
        Ok(CommandOutcome {
            exit_code: Some(0),
            output: format!("ran {command}"),
            timed_out: false,
        })
    }

    async fn send_bytes(&self, data: &[u8]) -> Result<()> {
        self.signals.lock().expect("signals").push(data.to_vec());
        Ok(())
    }
}

fn scripted_turns() -> VecDeque<ChatResponse> {
    let mut turns = VecDeque::new();
    turns.push_back(ChatResponse {
        content: String::from("我先看一下目录。"),
        reasoning_content: Some(String::from("先读只读命令")),
        tool_calls: vec![ToolCall {
            id: String::from("call_1"),
            name: String::from("execute_command"),
            arguments: json!({ "command": "ls -la" }),
        }],
    });
    turns.push_back(ChatResponse {
        content: String::from("目录为空，任务完成。"),
        reasoning_content: None,
        tool_calls: Vec::new(),
    });
    turns
}

async fn collect(
    mode: PermissionMode,
    approver: Arc<dyn Approver>,
) -> (Vec<AgentEvent>, Arc<RecordingTerminal>) {
    collect_with(mode, approver, false).await
}

async fn collect_with(
    mode: PermissionMode,
    approver: Arc<dyn Approver>,
    step_approval: bool,
) -> (Vec<AgentEvent>, Arc<RecordingTerminal>) {
    let terminal = Arc::new(RecordingTerminal::default());
    let client = Arc::new(ScriptedClient {
        turns: Mutex::new(scripted_turns()),
    });
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

    let runtime = AgentRuntime::new(
        client,
        terminal.clone(),
        mode,
        approver,
        tx,
        Arc::new(AtomicBool::new(false)),
    )
    .with_config(AgentRuntimeConfig {
        max_steps: 4,
        command_timeout: Duration::from_secs(5),
        scrollback: 20,
        step_approval,
        max_tool_output_chars: 8_000,
    });

    let collector = tokio::spawn(async move {
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        events
    });

    runtime.run("看看目录").await.expect("run");
    let events = collector.await.expect("collector");
    (events, terminal)
}

#[tokio::test]
async fn emits_a_request_before_the_command_and_output_after() {
    let (events, terminal) = collect(PermissionMode::Supervised, Arc::new(AlwaysDeny)).await;

    assert_eq!(terminal.commands.lock().expect("commands").len(), 1);

    let requested = events
        .iter()
        .position(|event| matches!(event, AgentEvent::ToolRequested { .. }))
        .expect("tool requested");
    let finished = events
        .iter()
        .position(|event| matches!(event, AgentEvent::ToolFinished { .. }))
        .expect("tool finished");
    assert!(
        requested < finished,
        "the command must be announced before it runs"
    );

    match &events[requested] {
        AgentEvent::ToolRequested { command, .. } => {
            assert_eq!(command.as_deref(), Some("ls -la"));
        }
        other => panic!("unexpected event {other:?}"),
    }
    match &events[finished] {
        AgentEvent::ToolFinished { exit_code, .. } => assert_eq!(*exit_code, Some(0)),
        other => panic!("unexpected event {other:?}"),
    }
}

#[tokio::test]
async fn supervised_mode_auto_approves_read_only_commands() {
    let (events, _terminal) = collect(PermissionMode::Supervised, Arc::new(AlwaysDeny)).await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, AgentEvent::ToolDenied { .. })),
        "read-only `ls` must not need approval"
    );
}

#[tokio::test]
async fn step_approval_gates_even_read_only_commands() {
    let (events, terminal) =
        collect_with(PermissionMode::Supervised, Arc::new(AlwaysDeny), true).await;

    assert!(
        terminal.commands.lock().expect("commands").is_empty(),
        "step mode must gate `ls` as well"
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, AgentEvent::ToolDenied { .. }))
    );
}

#[tokio::test]
async fn ask_mode_denies_and_writes_nothing() {
    let (events, terminal) = collect(PermissionMode::Ask, Arc::new(AlwaysDeny)).await;

    assert!(
        terminal.commands.lock().expect("commands").is_empty(),
        "denied commands must never reach the terminal"
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, AgentEvent::ToolDenied { .. }))
    );
}

#[tokio::test]
async fn reasoning_and_answer_stream_as_events() {
    let (events, _terminal) = collect(PermissionMode::Supervised, Arc::new(AlwaysDeny)).await;

    assert!(
        events
            .iter()
            .any(|event| matches!(event, AgentEvent::Thinking { .. }))
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, AgentEvent::Message { .. }))
    );
    assert!(matches!(
        events.last(),
        Some(AgentEvent::RunFinished { .. })
    ));
}

#[allow(dead_code)]
fn assert_approver_bounds(_: &dyn Approver, _: &ApprovalRequest) {}
