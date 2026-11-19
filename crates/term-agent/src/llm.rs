// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Provider abstraction: one OpenAI-compatible protocol for local models
//! (Ollama, LM Studio) and BYOK cloud endpoints.
//!
//! The client speaks streaming SSE and Function Calling over `reqwest` with
//! rustls. Reasoning text (`reasoning_content`) is preserved and echoed back on
//! the next turn, which DeepSeek-style reasoning models require.

use std::time::Duration;

use reqwest::StatusCode;

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{AgentError, Result};
use crate::tools::ToolSpec;

/// Default request timeout for one model turn.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Retries allowed for a rate limited or temporarily unavailable provider.
pub const MAX_RETRIES: u32 = 2;

/// Longest single backoff, so a retry never stalls the UI for long.
pub const MAX_BACKOFF: Duration = Duration::from_secs(2);

/// Longest `Retry-After` honoured; anything longer is capped to keep the run
/// responsive rather than silently sleeping for a minute.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(5);

/// Exponential backoff for `attempt` (0 = first retry).
pub fn backoff_delay(attempt: u32) -> Duration {
    let millis = 200u64.saturating_mul(1 << attempt.min(4));
    Duration::from_millis(millis).min(MAX_BACKOFF)
}

/// Parses a `Retry-After` header in seconds, capped by [`MAX_RETRY_AFTER`].
pub fn parse_retry_after(value: &str) -> Option<Duration> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .map(|seconds| Duration::from_secs(seconds).min(MAX_RETRY_AFTER))
}

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
    /// Tool calls requested by the model on this turn.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
}

impl ChatMessage {
    /// Builds a plain text message.
    pub fn text(role: ChatRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            reasoning_content: None,
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    /// Builds the message that answers one tool call.
    pub fn tool_result(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Tool,
            content: content.into(),
            reasoning_content: None,
            tool_call_id: Some(call_id.into()),
            tool_calls: Vec::new(),
        }
    }
}

/// Provider endpoint plus model selection. Secrets are referenced by keyring
/// entry name, never stored inline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LlmProviderConfig {
    /// Stable provider id, for example `ollama`, `lmstudio`, `deepseek`.
    pub provider: String,
    /// Base URL of the OpenAI-compatible API, e.g. `https://api.deepseek.com`.
    pub base_url: String,
    /// Model identifier passed to the API.
    pub model: String,
    /// Name of the OS keyring entry that holds the API key, if any.
    pub api_key_ref: Option<String>,
}

impl LlmProviderConfig {
    /// DeepSeek flash over the OpenAI-compatible endpoint.
    pub fn deepseek_flash() -> Self {
        Self {
            provider: String::from("deepseek"),
            base_url: String::from("https://api.deepseek.com"),
            model: String::from("deepseek-flash"),
            api_key_ref: None,
        }
    }

    /// Endpoint for one local provider.
    pub fn local(provider: crate::discovery::LocalProvider, model: impl Into<String>) -> Self {
        let endpoint = crate::discovery::endpoint_for(provider);
        Self {
            provider: provider.label().to_lowercase().replace(' ', "-"),
            base_url: endpoint
                .map(|found| found.base_url.to_owned())
                .unwrap_or_default(),
            model: model.into(),
            api_key_ref: None,
        }
    }
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

/// Receives incremental deltas while a turn streams.
pub trait StreamSink: Send {
    /// Reasoning delta, emitted by models that expose their thinking.
    fn on_reasoning(&mut self, _delta: &str) {}

    /// Answer text delta.
    fn on_content(&mut self, _delta: &str) {}
}

/// Sink used when the caller does not care about incremental text.
pub struct NullSink;

impl StreamSink for NullSink {}

/// Contract every provider implementation satisfies.
#[async_trait]
pub trait LlmClient: Send + Sync {
    /// Identifier reported back to the UI.
    fn provider_id(&self) -> &str;

    /// Model this client talks to.
    fn model(&self) -> &str;

    /// Sends one transcript turn and returns the model answer.
    async fn complete(&self, messages: &[ChatMessage], tools: &[ToolSpec]) -> Result<ChatResponse>;

    /// Same as [`complete`](LlmClient::complete) while forwarding deltas.
    async fn complete_streaming(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        sink: &mut dyn StreamSink,
    ) -> Result<ChatResponse> {
        let response = self.complete(messages, tools).await?;
        sink.on_content(&response.content);
        Ok(response)
    }
}

/// Installs the process-wide rustls provider exactly once.
///
/// `reqwest` is built with `rustls-no-provider`, so every HTTP client in this
/// crate must call this before constructing one.
pub fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// OpenAI-compatible streaming client.
pub struct OpenAiCompatibleClient {
    http: Client,
    config: LlmProviderConfig,
    api_key: Option<String>,
}

impl OpenAiCompatibleClient {
    /// Builds a client. The rustls provider is installed once per process.
    pub fn new(config: LlmProviderConfig, api_key: Option<String>) -> Result<Self> {
        ensure_crypto_provider();

        let http = Client::builder()
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .build()
            .map_err(|error| AgentError::ProviderRequest(error.to_string()))?;

        Ok(Self {
            http,
            config,
            api_key,
        })
    }

    /// Base URL without a trailing slash.
    fn endpoint(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.config.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    /// Lists model ids exposed by the endpoint, used for discovery and settings.
    pub async fn list_models(&self) -> Result<Vec<String>> {
        let mut request = self.http.get(self.endpoint("models"));
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        let response = request
            .send()
            .await
            .map_err(|error| AgentError::ProviderRequest(error.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AgentError::ProviderRequest(format!(
                "model list rejected with {status}: {body}"
            )));
        }

        let payload: Value = response
            .json()
            .await
            .map_err(|error| AgentError::ProviderRequest(error.to_string()))?;
        let models = payload
            .get("data")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Ok(models)
    }

    async fn request_stream(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<reqwest::Response> {
        let mut attempt = 0u32;

        loop {
            let response = self.send_once(messages, tools).await?;
            if response.status().is_success() {
                return Ok(response);
            }

            let status = response.status();
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_retry_after);

            let retryable = matches!(
                status,
                StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
            );
            if retryable && attempt < MAX_RETRIES {
                let delay = retry_after.unwrap_or_else(|| backoff_delay(attempt));
                tracing::debug!(
                    %status,
                    attempt,
                    delay_ms = delay.as_millis() as u64,
                    "provider asked us to slow down; retrying"
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
                continue;
            }

            let body = response.text().await.unwrap_or_default();
            return Err(AgentError::ProviderRequest(format!(
                "provider returned {status}: {body}"
            )));
        }
    }

    /// One attempt, without any retry logic.
    async fn send_once(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<reqwest::Response> {
        let mut body = json!({
            "model": self.config.model,
            "messages": encode_messages(messages),
            "stream": true,
        });
        if !tools.is_empty() {
            body["tools"] = Value::Array(encode_tools(tools));
        }

        let mut request = self
            .http
            .post(self.endpoint("chat/completions"))
            .json(&body);
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }

        request
            .send()
            .await
            .map_err(|error| AgentError::ProviderRequest(error.to_string()))
    }
}

#[async_trait]
impl LlmClient for OpenAiCompatibleClient {
    fn provider_id(&self) -> &str {
        &self.config.provider
    }

    fn model(&self) -> &str {
        &self.config.model
    }

    async fn complete(&self, messages: &[ChatMessage], tools: &[ToolSpec]) -> Result<ChatResponse> {
        self.complete_streaming(messages, tools, &mut NullSink)
            .await
    }

    async fn complete_streaming(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        sink: &mut dyn StreamSink,
    ) -> Result<ChatResponse> {
        let response = self.request_stream(messages, tools).await?;
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut accumulator = Accumulator::default();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| AgentError::ProviderRequest(error.to_string()))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // SSE frames are separated by a blank line and may be split across
            // TCP chunks, so only complete frames are consumed.
            while let Some(boundary) = buffer.find("\n\n") {
                let frame: String = buffer.drain(..boundary + 2).collect();
                for line in frame.lines() {
                    let Some(data) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let data = data.trim();
                    if data.is_empty() || data == "[DONE]" {
                        continue;
                    }
                    accumulator.absorb(data, sink)?;
                }
            }
        }

        Ok(accumulator.finish())
    }
}

/// Encodes transcript messages the way Chat Completions expects them.
fn encode_messages(messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            let mut encoded = json!({
                "role": message.role,
                "content": message.content,
            });
            if let Some(reasoning) = &message.reasoning_content {
                encoded["reasoning_content"] = Value::String(reasoning.clone());
            }
            if let Some(call_id) = &message.tool_call_id {
                encoded["tool_call_id"] = Value::String(call_id.clone());
            }
            if !message.tool_calls.is_empty() {
                encoded["tool_calls"] = Value::Array(
                    message
                        .tool_calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": call.arguments.to_string(),
                                },
                            })
                        })
                        .collect(),
                );
            }
            encoded
        })
        .collect()
}

/// Encodes the tool catalog as Chat Completions tool definitions.
fn encode_tools(tools: &[ToolSpec]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                },
            })
        })
        .collect()
}

/// Reassembles streamed deltas into one response.
#[derive(Default)]
struct Accumulator {
    content: String,
    reasoning: String,
    tool_calls: Vec<PartialToolCall>,
}

#[derive(Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

impl Accumulator {
    fn absorb(&mut self, data: &str, sink: &mut dyn StreamSink) -> Result<()> {
        let payload: Value = serde_json::from_str(data)
            .map_err(|error| AgentError::ProviderRequest(format!("bad stream frame: {error}")))?;

        let Some(choice) = payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return Ok(());
        };
        let Some(delta) = choice.get("delta") else {
            return Ok(());
        };

        if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str)
            && !reasoning.is_empty()
        {
            self.reasoning.push_str(reasoning);
            sink.on_reasoning(reasoning);
        }

        if let Some(content) = delta.get("content").and_then(Value::as_str)
            && !content.is_empty()
        {
            self.content.push_str(content);
            sink.on_content(content);
        }

        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                while self.tool_calls.len() <= index {
                    self.tool_calls.push(PartialToolCall::default());
                }
                let slot = &mut self.tool_calls[index];

                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    slot.id = id.to_owned();
                }
                if let Some(function) = call.get("function") {
                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                        slot.name.push_str(name);
                    }
                    if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                        slot.arguments.push_str(arguments);
                    }
                }
            }
        }

        Ok(())
    }

    fn finish(self) -> ChatResponse {
        let tool_calls = self
            .tool_calls
            .into_iter()
            .filter(|call| !call.name.is_empty())
            .enumerate()
            .map(|(index, call)| ToolCall {
                id: if call.id.is_empty() {
                    format!("call_{index}")
                } else {
                    call.id
                },
                name: call.name,
                arguments: serde_json::from_str(&call.arguments).unwrap_or(Value::Null),
            })
            .collect();

        ChatResponse {
            content: self.content,
            reasoning_content: if self.reasoning.is_empty() {
                None
            } else {
                Some(self.reasoning)
            },
            tool_calls,
        }
    }
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
            tool_calls: Vec::new(),
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
        assert!(encoded.get("tool_calls").is_none());
    }

    #[test]
    fn tool_calls_fragment_across_frames_and_merge_by_index() {
        let mut accumulator = Accumulator::default();
        let mut sink = NullSink;
        let frames = [
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"execute_command","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]}}]}"#,
        ];
        for frame in frames {
            accumulator.absorb(frame, &mut sink).expect("frame");
        }

        let response = accumulator.finish();
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "call_a");
        assert_eq!(response.tool_calls[0].name, "execute_command");
        assert_eq!(response.tool_calls[0].arguments["command"], "ls");
    }

    #[test]
    fn reasoning_and_content_deltas_are_forwarded_to_the_sink() {
        struct Recorder {
            reasoning: String,
            content: String,
        }
        impl StreamSink for Recorder {
            fn on_reasoning(&mut self, delta: &str) {
                self.reasoning.push_str(delta);
            }
            fn on_content(&mut self, delta: &str) {
                self.content.push_str(delta);
            }
        }

        let mut accumulator = Accumulator::default();
        let mut recorder = Recorder {
            reasoning: String::new(),
            content: String::new(),
        };
        accumulator
            .absorb(
                r#"{"choices":[{"delta":{"reasoning_content":"thinking","content":"ok"}}]}"#,
                &mut recorder,
            )
            .expect("frame");

        assert_eq!(recorder.reasoning, "thinking");
        assert_eq!(recorder.content, "ok");
        assert_eq!(
            accumulator.finish().reasoning_content.as_deref(),
            Some("thinking")
        );
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        assert_eq!(backoff_delay(0), Duration::from_millis(200));
        assert_eq!(backoff_delay(1), Duration::from_millis(400));
        assert_eq!(backoff_delay(2), Duration::from_millis(800));
        assert_eq!(backoff_delay(9), MAX_BACKOFF, "backoff must stay bounded");
    }

    #[test]
    fn retry_after_is_parsed_and_capped() {
        assert_eq!(parse_retry_after("3"), Some(Duration::from_secs(3)));
        assert_eq!(parse_retry_after(" 1 "), Some(Duration::from_secs(1)));
        assert_eq!(parse_retry_after("120"), Some(MAX_RETRY_AFTER));
        assert_eq!(parse_retry_after("soon"), None);
        assert_eq!(parse_retry_after(""), None);
    }

    #[test]
    fn tool_catalog_encodes_as_function_definitions() {
        let encoded = encode_tools(&crate::tools::tool_catalog());
        assert_eq!(encoded[0]["type"], "function");
        assert_eq!(
            encoded[0]["function"]["name"],
            crate::tools::READ_TERMINAL_SCREEN
        );
    }
}
