// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Typed failures for the agent crate.

use thiserror::Error;

/// Crate-wide result alias bound to [`AgentError`].
pub type Result<T, E = AgentError> = std::result::Result<T, E>;

/// Everything the agent loop can refuse or fail to do.
#[derive(Debug, Error)]
pub enum AgentError {
    /// No provider credentials or endpoint have been configured yet.
    #[error("LLM provider `{provider}` is not configured")]
    ProviderNotConfigured {
        /// Provider identifier, for example `ollama` or `deepseek`.
        provider: String,
    },

    /// The provider answered with an error or an unparseable payload.
    #[error("LLM request failed: {0}")]
    ProviderRequest(String),

    /// Local provider probing failed for every candidate endpoint.
    #[error("local provider discovery failed: {0}")]
    Discovery(String),

    /// A tool invocation failed.
    #[error("tool `{tool}` failed: {message}")]
    ToolFailure {
        /// Tool name as exposed to the model.
        tool: String,
        /// Human readable failure cause.
        message: String,
    },

    /// The permission policy requires an explicit human decision.
    #[error("policy denied `{command}` ({risk}); explicit approval required")]
    PolicyDenied {
        /// Command that was blocked.
        command: String,
        /// Risk classification that triggered the block.
        risk: String,
    },

    /// The loop hit its step ceiling before finishing the task.
    #[error("agent step budget exhausted after {0} steps")]
    StepBudgetExhausted(u32),

    /// A control-state transition was attempted from the wrong state.
    #[error("control transition rejected: {0}")]
    ControlTransition(&'static str),

    /// Reserved for milestones that are not wired yet.
    #[error("not implemented yet: {0}")]
    NotImplemented(&'static str),
}
