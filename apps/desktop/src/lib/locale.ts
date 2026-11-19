// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

/**
 * Locale plumbing shared by the i18n bootstrap and the settings panel.
 *
 * The Rust side reports the OS locale through `system_locale`; this module maps
 * any BCP-47 tag onto the six shipped UI languages.
 */

export const SUPPORTED_LANGUAGES = ["zh-CN", "zh-TW", "en", "ru", "ja", "ko"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
  ru: "Русский",
  ja: "日本語",
  ko: "한국어",
};

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export function resolveLanguage(raw: string | null | undefined): SupportedLanguage {
  const cleaned = (raw ?? "").trim().replace(/_/g, "-").toLowerCase();
  const [language = "", ...subtags] = cleaned.split("-");

  switch (language) {
    case "zh": {
      const traditional = subtags.some(
        (subtag) => subtag === "hant" || subtag === "tw" || subtag === "hk" || subtag === "mo",
      );
      return traditional ? "zh-TW" : "zh-CN";
    }
    case "en":
      return "en";
    case "ru":
      return "ru";
    case "ja":
      return "ja";
    case "ko":
      return "ko";
    default:
      return "en";
  }
}

export function applyHtmlLang(language: string): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
}
