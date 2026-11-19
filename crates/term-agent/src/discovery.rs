// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Zero-config discovery of local model servers.
//!
//! Both probes are plain `GET /models` calls against the OpenAI-compatible
//! surface Ollama and LM Studio expose. A closed port or a slow server never
//! fails the whole discovery; unreachable endpoints are simply skipped, which is
//! what "zero config" has to mean when nothing is running.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;

/// Local providers the app can talk to without any configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalProvider {
    /// Ollama listening on 11434.
    Ollama,
    /// LM Studio listening on 1234.
    LmStudio,
}

impl LocalProvider {
    /// Human readable provider name.
    pub fn label(self) -> &'static str {
        match self {
            Self::Ollama => "Ollama",
            Self::LmStudio => "LM Studio",
        }
    }
}

/// One local endpoint candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalEndpoint {
    /// Provider served by this port.
    pub provider: LocalProvider,
    /// Base URL of the OpenAI-compatible API.
    pub base_url: &'static str,
    /// Port the server listens on.
    pub port: u16,
}

/// Endpoints probed on startup and whenever settings are refreshed.
pub const LOCAL_ENDPOINTS: &[LocalEndpoint] = &[
    LocalEndpoint {
        provider: LocalProvider::Ollama,
        base_url: "http://localhost:11434/v1",
        port: 11434,
    },
    LocalEndpoint {
        provider: LocalProvider::LmStudio,
        base_url: "http://localhost:1234/v1",
        port: 1234,
    },
];

/// Timeout applied to each probe so a closed port does not stall startup.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(400);

/// One model exposed by a local server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalModel {
    /// Server that hosts the model.
    pub provider: LocalProvider,
    /// Model identifier accepted by the API.
    pub id: String,
}

/// Returns the endpoint table without touching the network.
pub fn endpoints() -> &'static [LocalEndpoint] {
    LOCAL_ENDPOINTS
}

/// Looks up the endpoint for one provider.
pub fn endpoint_for(provider: LocalProvider) -> Option<&'static LocalEndpoint> {
    LOCAL_ENDPOINTS
        .iter()
        .find(|endpoint| endpoint.provider == provider)
}

/// Probes every local endpoint concurrently and returns the models found.
pub async fn discover_local_models(timeout: Duration) -> Result<Vec<LocalModel>> {
    crate::llm::ensure_crypto_provider();
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| crate::error::AgentError::Discovery(error.to_string()))?;

    let probes = LOCAL_ENDPOINTS.iter().map(|endpoint| {
        let client = client.clone();
        async move { probe(client, endpoint).await }
    });
    let results = futures_util::future::join_all(probes).await;

    let mut models: Vec<LocalModel> = results.into_iter().flatten().collect();
    models.sort_by(|left, right| {
        left.provider
            .label()
            .cmp(right.provider.label())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(models)
}

async fn probe(client: reqwest::Client, endpoint: &LocalEndpoint) -> Vec<LocalModel> {
    let url = format!("{}/models", endpoint.base_url.trim_end_matches('/'));
    let response = match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            tracing::debug!(
                provider = endpoint.provider.label(),
                status = %response.status(),
                "local provider rejected the model list"
            );
            return Vec::new();
        }
        Err(error) => {
            tracing::trace!(
                provider = endpoint.provider.label(),
                %error,
                "local provider is not listening"
            );
            return Vec::new();
        }
    };

    let payload: Value = match response.json().await {
        Ok(payload) => payload,
        Err(error) => {
            tracing::debug!(provider = endpoint.provider.label(), %error, "unreadable model list");
            return Vec::new();
        }
    };

    payload
        .get("data")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                .map(|id| LocalModel {
                    provider: endpoint.provider,
                    id: id.to_owned(),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_table_matches_the_documented_ports() {
        let ollama = endpoint_for(LocalProvider::Ollama).expect("ollama endpoint");
        assert_eq!(ollama.port, 11434);
        assert!(ollama.base_url.contains("11434"));

        let lmstudio = endpoint_for(LocalProvider::LmStudio).expect("lmstudio endpoint");
        assert_eq!(lmstudio.port, 1234);
        assert!(lmstudio.base_url.contains("1234"));
    }

    #[tokio::test]
    async fn discovery_skips_servers_that_are_not_running() {
        // Nothing listens on 11434/1234 in the test environment; the call must
        // still succeed with an empty catalog rather than failing startup.
        let models = discover_local_models(Duration::from_millis(50))
            .await
            .expect("discovery");
        assert!(models.iter().all(|model| !model.id.is_empty()));
    }
}
