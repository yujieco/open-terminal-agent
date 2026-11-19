// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Autonomous terminal agent: policy, tools, loop state and provider contract.
//!
//! Milestone 1 establishes the seams — a permission policy that already gates
//! commands, a tool catalog, the Observe/Reason/Act/Verify machine and the
//! OpenAI-compatible provider contract. The streaming client, local discovery
//! probes and the executor that drives a real session attach to these seams in
//! later milestones.

pub mod discovery;
pub mod error;
pub mod llm;
pub mod loop_engine;
pub mod policy;
pub mod tools;

pub use discovery::{LOCAL_ENDPOINTS, LocalEndpoint, LocalModel, LocalProvider};
pub use error::{AgentError, Result};
pub use llm::{ChatMessage, ChatResponse, ChatRole, LlmClient, LlmProviderConfig, ToolCall};
pub use loop_engine::{AgentLoopState, LoopPhase, StepBudget};
pub use policy::{
    CommandRisk, ControlState, PermissionMode, PolicyDecision, SessionPolicy, classify_command,
};
pub use tools::{
    ControlSignal, EXECUTE_COMMAND, READ_TERMINAL_SCREEN, SEND_CONTROL_SIGNAL, ToolCallRequest,
    ToolSpec, tool_catalog,
};
