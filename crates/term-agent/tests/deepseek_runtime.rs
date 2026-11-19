// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! End-to-end run against a real model and a real PTY.
//!
//! Ignored by default because it needs network access and an API key. Run it
//! with:
//!
//! ```text
//! DEEPSEEK_API_KEY=sk-... cargo test -p term-agent --test deepseek_runtime -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use term_agent::llm::{LlmProviderConfig, OpenAiCompatibleClient};
use term_agent::runtime::{
    AgentEvent, AgentRuntime, AgentRuntimeConfig, AgentTerminal, CommandOutcome,
};
use term_agent::{AlwaysApprove, PermissionMode, Result};
use term_core::{PtyConfig, PtyTransport, ShadowScreen, TerminalTransport};
use tokio::sync::Mutex as AsyncMutex;

/// PTY-backed terminal for the runtime, fed by the transport's output stream.
struct PtyTerminal {
    transport: Arc<PtyTransport>,
    screen: Arc<AsyncMutex<ShadowScreen>>,
}

#[async_trait]
impl AgentTerminal for PtyTerminal {
    async fn screen(&self, scrollback: usize) -> Result<String> {
        let mut screen = self.screen.lock().await;
        let visible = screen.visible_text();
        let history = screen.scrollback_lines(scrollback);
        Ok(format!("{}\n{}", history.join("\n"), visible))
    }

    async fn execute(&self, command: &str, timeout: Duration) -> Result<CommandOutcome> {
        // A sentinel makes completion observable without guessing prompts.
        let marker = "__OTA_END__";
        self.transport
            .write_bytes(format!("{command}; echo {marker}$?\r").as_bytes())
            .await
            .map_err(|error| term_agent::AgentError::ToolFailure {
                tool: String::from("execute_command"),
                message: error.to_string(),
            })?;

        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() > deadline {
                let _ = self.transport.write_bytes(b"\x03").await;
                let visible = self.screen.lock().await.visible_text();
                return Ok(CommandOutcome {
                    exit_code: None,
                    output: visible,
                    timed_out: true,
                });
            }

            tokio::time::sleep(Duration::from_millis(60)).await;
            let visible = self.screen.lock().await.visible_text();

            if let Some(position) = visible.rfind(marker) {
                let tail = &visible[position + marker.len()..];
                let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
                let exit_code = digits.parse::<i32>().ok();
                return Ok(CommandOutcome {
                    exit_code,
                    output: visible,
                    timed_out: false,
                });
            }
        }
    }

    async fn send_bytes(&self, data: &[u8]) -> Result<()> {
        self.transport.write_bytes(data).await.map_err(|error| {
            term_agent::AgentError::ToolFailure {
                tool: String::from("send_control_signal"),
                message: error.to_string(),
            }
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires DEEPSEEK_API_KEY and network access"]
async fn deepseek_flash_creates_a_file_through_visible_steps() {
    let api_key = std::env::var("DEEPSEEK_API_KEY").expect("DEEPSEEK_API_KEY must be set");
    let workspace = std::env::temp_dir().join(format!("ota-agent-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&workspace).expect("workspace");

    let (transport, mut output) = PtyTransport::spawn_with_output(
        PtyConfig::new(100, 30)
            .with_shell("/bin/sh")
            .with_cwd(workspace.to_string_lossy().to_string()),
    )
    .await
    .expect("spawn pty");

    let screen = Arc::new(AsyncMutex::new(ShadowScreen::new(100, 30).expect("screen")));
    let screen_for_reader = Arc::clone(&screen);
    tokio::spawn(async move {
        while let Ok(frame) = output.recv().await {
            screen_for_reader.lock().await.feed(&frame.bytes);
        }
    });

    let terminal = Arc::new(PtyTerminal {
        transport: Arc::new(transport),
        screen,
    });

    let client = Arc::new(
        OpenAiCompatibleClient::new(LlmProviderConfig::deepseek_flash(), Some(api_key))
            .expect("client"),
    );

    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
    let runtime = AgentRuntime::new(
        client,
        terminal,
        PermissionMode::Autonomous,
        Arc::new(AlwaysApprove),
        events_tx,
        Arc::new(AtomicBool::new(false)),
    )
    .with_config(AgentRuntimeConfig {
        max_steps: 10,
        command_timeout: Duration::from_secs(45),
        scrollback: 120,
    });

    let collector = tokio::spawn(async move {
        let mut events = Vec::new();
        while let Some(event) = events_rx.recv().await {
            match &event {
                AgentEvent::ToolRequested { command, risk, .. } => {
                    println!("[step] requested {risk:?}: {command:?}");
                }
                AgentEvent::ToolFinished {
                    exit_code, output, ..
                } => {
                    println!("[step] exit={exit_code:?} output={output:?}");
                }
                AgentEvent::Message { delta } => print!("{delta}"),
                AgentEvent::RunFinished { steps, reason } => {
                    println!("\n[run] finished after {steps} steps: {reason:?}");
                }
                other => println!("[event] {other:?}"),
            }
            events.push(event);
        }
        events
    });

    runtime
        .run(
            "请创建一个名为 hello.txt 的文件，内容为 ota，然后打印该文件内容确认。\
             最后用一句话告诉我你执行了哪些命令。",
        )
        .await
        .expect("agent run");

    let events = collector.await.expect("collector");
    let requested: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ToolRequested { command, .. } => command.clone(),
            _ => None,
        })
        .collect();
    println!("commands announced to the user: {requested:?}");
    assert!(
        !requested.is_empty(),
        "the runtime must announce at least one command"
    );

    let file: PathBuf = workspace.join("hello.txt");
    let content = std::fs::read_to_string(&file).unwrap_or_default();
    assert!(
        content.to_lowercase().contains("ota"),
        "expected hello.txt to contain `ota`, got {content:?} (workspace {workspace:?})"
    );
}
