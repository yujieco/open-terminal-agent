// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Lightweight GitHub Releases update checker.
//!
//! Compares the running crate version (`CARGO_PKG_VERSION`) against the latest
//! GitHub Release tag for `yujieco/open-terminal-agent`. Set
//! `OTA_UPDATE_API_URL` in the environment to point at a local mock endpoint
//! when testing update prompts locally.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::ApiError;

/// Default GitHub Releases API endpoint.
pub const DEFAULT_RELEASES_API: &str =
    "https://api.github.com/repos/yujieco/open-terminal-agent/releases/latest";

/// Default GitHub Releases web page fallback.
pub const DEFAULT_RELEASES_PAGE: &str =
    "https://github.com/yujieco/open-terminal-agent/releases/latest";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// Update check result returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Version of the running app.
    pub current_version: String,
    /// Latest version reported by GitHub Releases.
    pub latest_version: String,
    /// True when `latest_version` is strictly newer than `current_version`.
    pub available: bool,
    /// Release web page URL to open when the user clicks to update.
    pub release_url: String,
    /// Release title from GitHub.
    pub release_name: String,
    /// Markdown release notes body (trimmed).
    pub notes: String,
    /// ISO-8601 publication timestamp, if provided.
    pub published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
}

/// Checks GitHub Releases (or `OTA_UPDATE_API_URL` if set) for a newer release.
#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, ApiError> {
    let endpoint = std::env::var("OTA_UPDATE_API_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_RELEASES_API.to_owned());

    check_update_from_url(&endpoint, env!("CARGO_PKG_VERSION")).await
}

/// Opens an `http://` or `https://` URL in the OS default browser.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), ApiError> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err(ApiError::InvalidRequest(String::from(
            "only http and https URLs can be opened externally",
        )));
    }

    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(trimmed).status();
    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open").arg(trimmed).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", trimmed])
        .status();

    status.map_err(|error| ApiError::InvalidRequest(format!("could not open browser: {error}")))?;
    Ok(())
}

/// Fetches release metadata from `endpoint` and compares it against `current_version`.
pub async fn check_update_from_url(
    endpoint: &str,
    current_version: &str,
) -> Result<UpdateInfo, ApiError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(format!("open-terminal-agent/{current_version}"))
        .build()
        .map_err(|error| ApiError::InvalidRequest(format!("http client error: {error}")))?;

    let response = client
        .get(endpoint)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| ApiError::InvalidRequest(format!("update check failed: {error}")))?;

    // A brand-new repo with no published releases yet returns 404; treat as up-to-date.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(UpdateInfo {
            current_version: normalize_version(current_version).to_owned(),
            latest_version: normalize_version(current_version).to_owned(),
            available: false,
            release_url: DEFAULT_RELEASES_PAGE.to_owned(),
            release_name: String::new(),
            notes: String::new(),
            published_at: None,
        });
    }

    if !response.status().is_success() {
        return Err(ApiError::InvalidRequest(format!(
            "update server returned HTTP {}",
            response.status().as_u16()
        )));
    }

    let release: GithubRelease = response
        .json()
        .await
        .map_err(|error| ApiError::InvalidRequest(format!("invalid release payload: {error}")))?;

    let current = normalize_version(current_version).to_owned();
    let latest = normalize_version(&release.tag_name).to_owned();
    let available = is_newer_version(&current, &latest);

    Ok(UpdateInfo {
        current_version: current,
        latest_version: latest.clone(),
        available,
        release_url: release
            .html_url
            .filter(|url| !url.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_RELEASES_PAGE.to_owned()),
        release_name: release
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| format!("v{latest}")),
        notes: release.body.unwrap_or_default().trim().to_owned(),
        published_at: release.published_at,
    })
}

fn normalize_version(raw: &str) -> &str {
    raw.trim().trim_start_matches(['v', 'V'])
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: bool,
}

fn parse_version(raw: &str) -> Option<ParsedVersion> {
    let cleaned = normalize_version(raw);
    let without_build = cleaned.split('+').next().unwrap_or(cleaned);
    let (core, pre) = match without_build.split_once('-') {
        Some((core, pre)) => (core, !pre.is_empty()),
        None => (without_build, false),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some(ParsedVersion {
        major,
        minor,
        patch,
        prerelease: pre,
    })
}

/// Returns `true` when `latest` is strictly newer than `current`.
pub fn is_newer_version(current: &str, latest: &str) -> bool {
    let (Some(cur), Some(lat)) = (parse_version(current), parse_version(latest)) else {
        return false;
    };
    let cur_tuple = (cur.major, cur.minor, cur.patch);
    let lat_tuple = (lat.major, lat.minor, lat.patch);
    if lat_tuple != cur_tuple {
        return lat_tuple > cur_tuple;
    }
    // Stable release (e.g. `0.2.0`) is newer than pre-release (`0.2.0-rc.1`).
    cur.prerelease && !lat.prerelease
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn semver_comparison_handles_tags_and_prereleases() {
        assert!(is_newer_version("0.1.0", "v0.1.1"));
        assert!(is_newer_version("0.1.0", "v0.2.0"));
        assert!(is_newer_version("0.1.0", "1.0.0"));
        assert!(is_newer_version("0.2.0-rc.1", "v0.2.0"));
        assert!(!is_newer_version("0.1.0", "v0.1.0"));
        assert!(!is_newer_version("0.2.0", "v0.1.9"));
        assert!(!is_newer_version("0.2.0", "v0.2.0-beta.1"));
    }

    #[tokio::test]
    async fn fetches_latest_release_from_mock_github_api_and_detects_update() {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(_) => return,
        };
        let addr = listener.local_addr().expect("addr");

        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut req = [0u8; 1024];
            let _ = socket.read(&mut req).await;

            let body = r#"{
                "tag_name": "v0.2.0",
                "name": "Open Terminal Agent v0.2.0",
                "html_url": "https://github.com/yujieco/open-terminal-agent/releases/tag/v0.2.0",
                "body": "- Studio UI redesign\n- Command handbook",
                "published_at": "2026-11-25T00:00:00Z"
            }"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write response");
        });

        let url = format!("http://{addr}/releases/latest");
        let info = check_update_from_url(&url, "0.1.0")
            .await
            .expect("update info");
        server.await.expect("server");

        assert!(info.available);
        assert_eq!(info.current_version, "0.1.0");
        assert_eq!(info.latest_version, "0.2.0");
        assert_eq!(info.release_name, "Open Terminal Agent v0.2.0");
        assert!(info.notes.contains("Command handbook"));
    }
}
