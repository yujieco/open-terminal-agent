// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { SUPPORTED_LANGUAGES, applyHtmlLang, resolveLanguage } from "../lib/locale";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import ru from "./locales/ru.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";

export const resources = {
  "zh-CN": { translation: zhCN },
  "zh-TW": { translation: zhTW },
  en: { translation: en },
  ru: { translation: ru },
  ja: { translation: ja },
  ko: { translation: ko },
} as const;

/**
 * Boots i18next. The first language comes from the browser; the Tauri shell
 * overrides it a moment later with the OS locale reported by `system_locale`.
 */
export async function initI18n(initialLanguage?: string): Promise<string> {
  const language = resolveLanguage(initialLanguage ?? navigator.language);

  await i18n.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGES],
    defaultNS: "translation",
    interpolation: { escapeValue: false },
    returnNull: false,
  });

  applyHtmlLang(language);
  return language;
}

/** Switches the UI language and keeps `<html lang>` in sync. */
export async function changeLanguage(language: string): Promise<void> {
  const resolved = resolveLanguage(language);
  await i18n.changeLanguage(resolved);
  applyHtmlLang(resolved);
}

export default i18n;
