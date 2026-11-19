// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Locale detection on the Rust side, so the UI can start in the user's system
//! language before any network or settings storage exists.

use serde::Serialize;

/// UI languages shipped in this milestone.
pub const SUPPORTED_LOCALES: &[&str] = &["zh-CN", "zh-TW", "en", "ru", "ja", "ko"];

/// Language reported to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleInfo {
    /// Raw locale reported by the OS, e.g. `zh-Hans-CN`.
    pub raw: String,
    /// Locale normalized to one of [`SUPPORTED_LOCALES`].
    pub normalized: String,
    /// Every locale the UI can switch to.
    pub supported: Vec<String>,
}

impl LocaleInfo {
    /// Reads the OS locale and normalizes it.
    pub fn detect() -> Self {
        let raw = sys_locale::get_locale().unwrap_or_else(|| String::from("en"));
        Self {
            normalized: normalize_locale(&raw),
            raw,
            supported: SUPPORTED_LOCALES
                .iter()
                .map(|locale| (*locale).to_owned())
                .collect(),
        }
    }
}

/// Maps any BCP-47 tag to a shipped UI language, defaulting to English.
pub fn normalize_locale(raw: &str) -> String {
    let cleaned = raw.trim().replace('_', "-").to_ascii_lowercase();
    let mut parts = cleaned.split('-');
    let language = parts.next().unwrap_or_default();
    let subtags: Vec<&str> = parts.collect();

    match language {
        "zh" => {
            let traditional = subtags
                .iter()
                .any(|subtag| matches!(*subtag, "hant" | "tw" | "hk" | "mo"));
            if traditional {
                String::from("zh-TW")
            } else {
                String::from("zh-CN")
            }
        }
        "en" => String::from("en"),
        "ru" => String::from("ru"),
        "ja" => String::from("ja"),
        "ko" => String::from("ko"),
        _ => String::from("en"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_simplified_chinese() {
        assert_eq!(normalize_locale("zh-Hans-CN"), "zh-CN");
        assert_eq!(normalize_locale("zh_CN"), "zh-CN");
        assert_eq!(normalize_locale("zh"), "zh-CN");
    }

    #[test]
    fn normalizes_traditional_chinese() {
        assert_eq!(normalize_locale("zh-Hant-TW"), "zh-TW");
        assert_eq!(normalize_locale("zh-HK"), "zh-TW");
    }

    #[test]
    fn maps_other_languages_and_falls_back() {
        assert_eq!(normalize_locale("ru-RU"), "ru");
        assert_eq!(normalize_locale("ja-JP"), "ja");
        assert_eq!(normalize_locale("ko-KR"), "ko");
        assert_eq!(normalize_locale("en-GB"), "en");
        assert_eq!(normalize_locale("fr-FR"), "en");
        assert_eq!(normalize_locale(""), "en");
    }
}
