// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Zero-config discovery of local model servers.
//!
//! The endpoint table is the single source of truth for both the settings UI
//! and the probe logic. HTTP probing is wired when the streaming client lands;
//! until then [`discover_local_models`] reports an empty catalog instead of
//! inventing models that are not there.

use std::time::Duration;

use serde::{Deserialize, Serialize};

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

/// Lists models hosted by local servers.
///
/// Milestone 1 returns an empty catalog; the HTTP probes land with the
/// streaming client so the UI never renders models that were not confirmed.
pub async fn discover_local_models() -> Result<Vec<LocalModel>> {
    tracing::debug!(
        endpoints = LOCAL_ENDPOINTS.len(),
        "local model discovery is not wired yet"
    );
    Ok(Vec::new())
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
    async fn discovery_is_empty_but_not_failing() {
        assert!(discover_local_models().await.expect("discovery").is_empty());
    }
}
