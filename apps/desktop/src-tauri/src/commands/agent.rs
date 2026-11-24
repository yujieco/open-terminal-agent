// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Agent execution, LLM provider settings, local model discovery and command
//! suggestion commands.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use term_agent::llm::{ChatMessage, ChatRole, LlmClient, OpenAiCompatibleClient};
use term_agent::{LoopPhase, PermissionMode, ToolSpec, tool_catalog};

use crate::agent::{AGENT_APPROVAL, AGENT_EVENT, AgentControl, SessionTerminal};
use crate::error::ApiError;
use crate::secrets::SecretStore;
use crate::state::SessionRegistry;
use crate::store::{AgentRunRecord, AgentRunSummary, Store};

/// Settings keys for the persisted provider choice.
const SETTING_PROVIDER: &str = "llm.provider";
const SETTING_BASE_URL: &str = "llm.base_url";
const SETTING_MODEL: &str = "llm.model";

/// What the agent can do right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    /// Autonomy mode from `term_agent::PermissionMode::default()`.
    pub default_mode: PermissionMode,
    /// Tools the model may call.
    pub tools: Vec<ToolSpec>,
    /// Observe -> Reason -> Act -> Verify, in order.
    pub loop_phases: Vec<LoopPhase>,
}

/// Reports the agent contract so the sidebar never hardcodes it.
#[tauri::command]
pub fn agent_capabilities() -> AgentCapabilities {
    AgentCapabilities {
        default_mode: PermissionMode::default(),
        tools: tool_catalog(),
        loop_phases: vec![
            LoopPhase::Observe,
            LoopPhase::Reason,
            LoopPhase::Act,
            LoopPhase::Verify,
        ],
    }
}

/// Provider config persisted in the database, defaults to DeepSeek flash.
pub fn stored_llm_config(store: &Store) -> term_agent::LlmProviderConfig {
    let defaults = term_agent::LlmProviderConfig::deepseek_flash();
    term_agent::LlmProviderConfig {
        provider: store
            .setting(SETTING_PROVIDER)
            .ok()
            .flatten()
            .unwrap_or(defaults.provider),
        base_url: store
            .setting(SETTING_BASE_URL)
            .ok()
            .flatten()
            .unwrap_or(defaults.base_url),
        model: store
            .setting(SETTING_MODEL)
            .ok()
            .flatten()
            .unwrap_or(defaults.model),
        api_key_ref: None,
    }
}

/// Whether a provider runs locally and therefore needs no API key.
fn is_local_provider(provider: &str, base_url: &str) -> bool {
    matches!(provider, "ollama" | "lmstudio" | "lm-studio")
        || base_url.starts_with("http://localhost")
        || base_url.starts_with("http://127.0.0.1")
}

/// Keyring account for one provider.
fn llm_key_account(provider: &str) -> String {
    format!("llm:{provider}")
}

/// Non-secret SQLite boolean hint recording whether a key was saved for this
/// provider, so startup status checks never trigger macOS Keychain password
/// dialogs on unsigned dev binaries.
fn llm_key_hint(provider: &str) -> String {
    format!("llm.key_hint.{provider}")
}

/// LLM configuration reported to the settings panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStatus {
    /// Whether an API key is stored (or not required locally).
    pub configured: bool,
    /// Provider id.
    pub provider: String,
    /// Model id.
    pub model: String,
    /// Base URL.
    pub base_url: String,
}

/// Reports the provider the runtime will use and whether it is ready to call.
/// Reads only the non-secret SQLite hint so opening the app never prompts the
/// OS Keychain until an actual AI request needs the secret.
#[tauri::command]
pub fn llm_status(store: State<'_, Store>) -> Result<LlmStatus, ApiError> {
    let config = stored_llm_config(&store);
    let has_hint = store.setting(&llm_key_hint(&config.provider))?.as_deref() == Some("1");
    let configured = is_local_provider(&config.provider, &config.base_url) || has_hint;
    Ok(LlmStatus {
        configured,
        provider: config.provider,
        model: config.model,
        base_url: config.base_url,
    })
}

/// Persists the provider choice and, optionally, a new API key.
#[tauri::command]
pub fn save_llm_config(
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    provider: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), ApiError> {
    store.set_setting(SETTING_PROVIDER, &provider)?;
    store.set_setting(SETTING_BASE_URL, &base_url)?;
    store.set_setting(SETTING_MODEL, &model)?;

    if let Some(key) = api_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            secrets.set(&llm_key_account(&provider), trimmed)?;
            store.set_setting(&llm_key_hint(&provider), "1")?;
        }
    }
    Ok(())
}

/// Probes local OpenAI-compatible servers and lists what they host.
#[tauri::command]
pub async fn discover_models() -> Result<Vec<term_agent::LocalModel>, ApiError> {
    term_agent::discovery::discover_local_models(term_agent::discovery::PROBE_TIMEOUT)
        .await
        .map_err(|error| ApiError::InvalidRequest(error.to_string()))
}

/// Stores or clears the LLM API key in the OS keyring.
#[tauri::command]
pub fn save_llm_key(
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    api_key: String,
) -> Result<(), ApiError> {
    let provider = stored_llm_config(&store).provider;
    let account = llm_key_account(&provider);
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        store.set_setting(&llm_key_hint(&provider), "0")?;
        return secrets.delete(&account);
    }
    secrets.set(&account, trimmed)?;
    store.set_setting(&llm_key_hint(&provider), "1")?;
    Ok(())
}

/// Arguments for [`agent_run`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    /// Session the agent works in.
    pub session_id: String,
    /// Natural language task.
    pub task: String,
    /// Autonomy mode; supervised when omitted.
    #[serde(default)]
    pub mode: Option<PermissionMode>,
    /// Ask before every command, even read-only ones.
    #[serde(default)]
    pub step_approval: bool,
}

/// Starts an agent run; steps stream over `agent://event` as they happen.
#[tauri::command]
pub fn agent_run(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    secrets: State<'_, SecretStore>,
    control: State<'_, Arc<AgentControl>>,
    store: State<'_, Store>,
    request: AgentRunRequest,
) -> Result<(), ApiError> {
    if control.is_running(&request.session_id) {
        return Err(ApiError::InvalidRequest(String::from(
            "a run is already in progress for this session",
        )));
    }

    let handle = registry.require(&request.session_id)?;
    let config = stored_llm_config(&store);
    let api_key = secrets.get(&llm_key_account(&config.provider))?;
    if api_key.is_some() {
        let _ = store.set_setting(&llm_key_hint(&config.provider), "1");
    }
    if api_key.is_none() && !is_local_provider(&config.provider, &config.base_url) {
        return Err(ApiError::InvalidRequest(String::from(
            "no LLM API key configured; open settings and paste a key for this provider",
        )));
    }

    let cancelled = control.begin(&request.session_id);
    let terminal = SessionTerminal {
        transport: Arc::clone(&handle.transport),
        screen: Arc::clone(&handle.screen),
        kind: handle.kind,
    };

    let control = Arc::clone(&control);
    let session_id = request.session_id.clone();
    let mode = request.mode.unwrap_or_default();
    let store: Store = (*store).clone();

    tauri::async_runtime::spawn(async move {
        let outcome = crate::agent::run_task(
            app,
            store,
            config,
            session_id.clone(),
            terminal,
            api_key,
            mode,
            cancelled,
            Arc::clone(&control.pending),
            request.task,
            request.step_approval,
        )
        .await;
        if let Err(error) = outcome {
            tracing::warn!(%error, session = %session_id, "agent run ended with an error");
        }
        control.end(&session_id);
    });

    Ok(())
}

/// Cancels the run for a session and rejects any pending approval for it.
#[tauri::command]
pub fn agent_cancel(
    control: State<'_, Arc<AgentControl>>,
    session_id: String,
) -> Result<(), ApiError> {
    control.cancel(&session_id);
    Ok(())
}

/// Answers an approval question raised by the runtime.
#[tauri::command]
pub fn agent_approve(
    control: State<'_, Arc<AgentControl>>,
    call_id: String,
    approved: bool,
) -> Result<(), ApiError> {
    control.resolve(&call_id, approved);
    Ok(())
}

/// Event names the panel listens to, mirrored for the frontend.
#[tauri::command]
pub fn agent_event_names() -> (String, String) {
    (AGENT_EVENT.to_owned(), AGENT_APPROVAL.to_owned())
}

/// Lists recent agent runs, newest first.
#[tauri::command]
pub fn list_agent_runs(
    store: State<'_, Store>,
    session_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<AgentRunSummary>, ApiError> {
    Ok(store.list_agent_runs(session_id.as_deref(), limit.unwrap_or(20))?)
}

/// Loads one stored run with its event sequence, used to replay the timeline.
#[tauri::command]
pub fn get_agent_run(
    store: State<'_, Store>,
    id: String,
) -> Result<Option<AgentRunRecord>, ApiError> {
    Ok(store.get_agent_run(&id)?)
}

/// Deletes a single stored agent run from history.
#[tauri::command]
pub fn delete_agent_run(store: State<'_, Store>, id: String) -> Result<bool, ApiError> {
    Ok(store.delete_agent_run(&id)?)
}

/// Clears stored agent runs (all, or for a single session when `session_id` is given).
#[tauri::command]
pub fn clear_agent_runs(
    store: State<'_, Store>,
    session_id: Option<String>,
) -> Result<usize, ApiError> {
    Ok(store.clear_agent_runs(session_id.as_deref())?)
}

/// System prompt for the command palette: one shell line, nothing else.
const SUGGEST_PROMPT: &str = "You write one POSIX shell command for the user's request. Reply with the command only, on a single line, inside a sh code fence. No explanation, no prompt symbol, no comments. If the request is ambiguous, pick the least destructive reading.";

/// Arguments for [`suggest_command`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestCommandRequest {
    /// What the user wants to do.
    pub prompt: String,
    /// Optional visible screen text used as context.
    #[serde(default)]
    pub context: Option<String>,
}

/// Generates one command without touching the terminal. The user reviews it
/// before anything is written, which is why this call takes no tools.
#[tauri::command]
pub async fn suggest_command(
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    request: SuggestCommandRequest,
) -> Result<String, ApiError> {
    let config = stored_llm_config(&store);
    let api_key = secrets.get(&llm_key_account(&config.provider))?;
    let client = OpenAiCompatibleClient::new(config, api_key)
        .map_err(|error| ApiError::InvalidRequest(error.to_string()))?;

    let mut user = request.prompt;
    if let Some(context) = request.context.filter(|text| !text.trim().is_empty()) {
        user.push_str("\n\nCurrent terminal screen:\n");
        user.push_str(&context);
    }

    let response = client
        .complete(
            &[
                ChatMessage::text(ChatRole::System, SUGGEST_PROMPT),
                ChatMessage::text(ChatRole::User, user),
            ],
            &[],
        )
        .await
        .map_err(|error| ApiError::InvalidRequest(error.to_string()))?;

    Ok(clean_command(&response.content))
}

/// System prompt for suggesting one likely follow-up task as an input placeholder.
const NEXT_TASK_PROMPT: &str = "You suggest one short, practical follow-up task the user might ask an AI terminal agent next, based on the current terminal screen and the previous task. Reply with ONLY one concise plain sentence (under 48 characters, no quotes, no markdown, no bullets) in the requested language.";

/// Arguments for [`suggest_next_task`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestNextTaskRequest {
    /// Active session id to inspect.
    pub session_id: String,
    /// Previous task the agent just ran, if any.
    #[serde(default)]
    pub last_task: Option<String>,
    /// Target UI language code (e.g. `zh-CN`, `en`).
    #[serde(default)]
    pub language: Option<String>,
}

/// Generates a short ghost-text placeholder suggestion for the next user action.
/// Returns `Ok(None)` quietly if no model/key is configured.
#[tauri::command]
pub async fn suggest_next_task(
    registry: State<'_, SessionRegistry>,
    store: State<'_, Store>,
    secrets: State<'_, SecretStore>,
    request: SuggestNextTaskRequest,
) -> Result<Option<String>, ApiError> {
    let config = stored_llm_config(&store);
    let api_key = secrets.get(&llm_key_account(&config.provider))?;
    if api_key.is_none() && !is_local_provider(&config.provider, &config.base_url) {
        return Ok(None);
    }

    let screen_tail = if let Some(handle) = registry.get(&request.session_id)? {
        let screen = handle.screen.lock().await;
        let text = screen.visible_text();
        let trimmed: String = text.chars().rev().take(1_200).collect();
        trimmed.chars().rev().collect()
    } else {
        String::new()
    };

    let client = match OpenAiCompatibleClient::new(config, api_key) {
        Ok(client) => client,
        Err(_) => return Ok(None),
    };

    let lang = request.language.as_deref().unwrap_or("en");
    let mut user = format!("Language: {lang}\n");
    if let Some(last) = request.last_task.filter(|value| !value.trim().is_empty()) {
        user.push_str(&format!("Previous task: {last}\n"));
    }
    if !screen_tail.trim().is_empty() {
        user.push_str(&format!("Recent terminal screen:\n{screen_tail}"));
    }

    let response = match client
        .complete(
            &[
                ChatMessage::text(ChatRole::System, NEXT_TASK_PROMPT),
                ChatMessage::text(ChatRole::User, user),
            ],
            &[],
        )
        .await
    {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };

    let cleaned = clean_suggestion(&response.content);
    if cleaned.is_empty() {
        Ok(None)
    } else {
        Ok(Some(cleaned))
    }
}

fn clean_suggestion(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("```"))
        .unwrap_or_default()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`' | '“' | '”' | '-' | '*' | '•'))
        .trim()
        .to_owned()
}

/// Strips fences, prompts and surrounding whitespace from a model answer.
fn clean_command(raw: &str) -> String {
    let mut lines: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("```"))
        .collect();
    let first = lines.drain(..).next().unwrap_or_default();
    first.trim_start_matches("$ ").trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::clean_command;

    #[test]
    fn strips_fences_and_prompt_symbols() {
        assert_eq!(clean_command("```sh\nls -la\n```"), "ls -la");
        assert_eq!(clean_command("$ ls -la"), "ls -la");
        assert_eq!(clean_command("  \n\nls -la\n"), "ls -la");
    }

    #[test]
    fn keeps_only_the_first_command_line() {
        // A chatty model must not smuggle a second command into the palette.
        assert_eq!(
            clean_command("```bash\nfind . -name '*.log'\n```\nThis lists logs."),
            "find . -name '*.log'"
        );
    }

    #[test]
    fn empty_answer_stays_empty() {
        assert_eq!(clean_command(""), "");
        assert_eq!(clean_command("```\n```"), "");
    }
}
