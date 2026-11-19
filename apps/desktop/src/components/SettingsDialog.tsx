// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { changeLanguage } from "../i18n";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, resolveLanguage } from "../lib/locale";
import { LlmSettings } from "./LlmSettings";

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const { t, i18n } = useTranslation();
  const active = resolveLanguage(i18n.language);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-slate-800 bg-slate-900/95 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
          <h2 className="text-sm font-medium text-slate-200">{t("settings.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("settings.close")}
            className="rounded px-2 py-0.5 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200"
          >
            ×
          </button>
        </header>

        <div className="px-4 py-4">
          <h3 className="text-xs font-medium text-slate-300">{t("settings.language")}</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            {t("settings.languageHint")}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {SUPPORTED_LANGUAGES.map((language) => {
              const selected = language === active;
              return (
                <button
                  key={language}
                  type="button"
                  lang={language}
                  onClick={() => void changeLanguage(language)}
                  className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs transition ${
                    selected
                      ? "bg-cyan-500/20 text-cyan-100"
                      : "text-slate-300 hover:bg-slate-800/70"
                  }`}
                >
                  <span>{LANGUAGE_LABELS[language]}</span>
                  <span className="ml-auto font-mono text-[10px] text-slate-500">
                    {language}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <LlmSettings />

        <footer className="flex items-center justify-between gap-3 border-t border-slate-800 px-4 py-2.5">
          <span className="text-[10px] leading-tight text-slate-600">{t("settings.phase")}</span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded bg-slate-800 px-3 py-1 text-xs text-slate-200 transition hover:bg-slate-700"
          >
            {t("settings.close")}
          </button>
        </footer>
      </div>
    </div>
  );
}
