// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Provider abstraction: one OpenAI-compatible protocol for local models
//! (Ollama, LM Studio) and BYOK cloud endpoints.
//!
//! Milestone 1 ships the data model and the client contract. The streaming SSE
//! transport lands together with the agent loop, so every provider is exercised
//! through the same trait.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::tools::ToolSpec;

/// Role of one message in a chat transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    /// System prompt.
    System,
    /// Human or synthesized user turn.
    User,
    /// Model turn, possibly carrying tool calls.
    Assistant,
    /// Result of a tool call, fed back to the model.
    Tool,
}

/// One message in a chat transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    /// Who produced the message.
    pub role: ChatRole,
    /// Text content; empty when the message only carries tool calls.
    pub content: String,
    /// Chain-of-thought returned by reasoning models; must be echoed back
    /// verbatim on the next turn for providers such as DeepSeek.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning_content: Option<String>,
    /// Identifier of the tool call this message answers.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    /// Builds a plain text message.
    pub fn text(role: ChatRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            reasoning_content: None,
            tool_call_id: None,
        }
    }
}

/// Provider endpoint plus model selection. Secrets are referenced by keyring
/// entry name, never stored inline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LlmProviderConfig {
    /// Stable provider id, for example `ollama`, `lmstudio`, `deepseek`.
    pub provider: String,
    /// Base URL of the OpenAI-compatible API, e.g. `http://localhost:11434/v1`.
    pub base_url: String,
    /// Model identifier passed to the API.
    pub model: String,
    /// Name of the OS keyring entry that holds the API key, if any.
    pub api_key_ref: Option<String>,
}

/// One tool call emitted by the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    /// Provider-assigned call id.
    pub id: String,
    /// Name of the tool to run.
    pub name: String,
    /// Raw JSON arguments.
    pub arguments: Value,
}

/// One model turn.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ChatResponse {
    /// Free-form answer text.
    pub content: String,
    /// Reasoning trace, when the provider exposes one.
    pub reasoning_content: Option<String>,
    /// Tool calls the model wants executed before continuing.
    pub tool_calls: Vec<ToolCall>,
}

/// Contract every provider implementation satisfies.
#[async_trait]
pub trait LlmClient: Send + Sync {
    /// Identifier reported back to the UI.
    fn provider_id(&self) -> &str;

    /// Model this client talks to.
    fn model(&self) -> &str;

    /// Sends one transcript turn and returns the model answer.
    async fn complete(&self, messages: &[ChatMessage], tools: &[ToolSpec]) -> Result<ChatResponse>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_content_survives_a_round_trip() {
        let message = ChatMessage {
            role: ChatRole::Assistant,
            content: "done".to_owned(),
            reasoning_content: Some("checked the disk first".to_owned()),
            tool_call_id: None,
        };

        let encoded = serde_json::to_string(&message).expect("serialize");
        let decoded: ChatMessage = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(decoded, message);
    }

    #[test]
    fn absent_reasoning_is_omitted_from_the_payload() {
        let encoded = serde_json::to_value(ChatMessage::text(ChatRole::User, "hi")).expect("json");
        assert!(encoded.get("reasoning_content").is_none());
        assert!(encoded.get("tool_call_id").is_none());
    }
}
