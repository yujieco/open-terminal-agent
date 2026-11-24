// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { ResolvedTheme, ThemePreference } from "../hooks/useTheme";
import { changeLanguage } from "../i18n";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, resolveLanguage } from "../lib/locale";
import type {
  CursorStyle,
  CustomTerminalColors,
  TerminalAppearanceConfig,
  TerminalPresetId,
} from "../lib/terminalThemes";
import { KnownHosts } from "./KnownHosts";
import { LlmSettings } from "./LlmSettings";
import { TerminalThemeSettings } from "./TerminalThemeSettings";

const THEME_OPTIONS: ThemePreference[] = ["system", "light", "dark"];

interface SettingsDialogProps {
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  onThemeChange: (next: ThemePreference) => void;
  terminalConfig: TerminalAppearanceConfig;
  onTerminalPresetChange: (preset: TerminalPresetId) => void;
  onTerminalFontSizeChange: (size: number) => void;
  onTerminalLineHeightChange: (height: number) => void;
  onTerminalCursorStyleChange: (style: CursorStyle) => void;
  onTerminalCustomColorChange: (key: keyof CustomTerminalColors, value: string) => void;
  onTerminalCloneToCustom: () => void;
  onTerminalReset: () => void;
  onClose: () => void;
}

export function SettingsDialog({
  themePreference,
  resolvedTheme,
  onThemeChange,
  terminalConfig,
  onTerminalPresetChange,
  onTerminalFontSizeChange,
  onTerminalLineHeightChange,
  onTerminalCursorStyleChange,
  onTerminalCustomColorChange,
  onTerminalCloneToCustom,
  onTerminalReset,
  onClose,
}: SettingsDialogProps) {
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-[2px]"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {t("settings.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("settings.close")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Appearance / Theme selector */}
          <section className="px-4 py-3.5">
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">
              {t("settings.appearance")}
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {t("settings.appearanceHint")}
            </p>
            <div className="mt-2.5 grid grid-cols-3 gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-1">
              {THEME_OPTIONS.map((option) => {
                const selected = option === themePreference;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onThemeChange(option)}
                    className="rounded-md px-2.5 py-1.5 text-xs font-medium transition"
                    style={{
                      backgroundColor: selected ? "var(--accent)" : "transparent",
                      color: selected ? "var(--accent-fg)" : "var(--text-secondary)",
                    }}
                  >
                    {t(`settings.theme.${option}`)}
                  </button>
                );
              })}
            </div>
          </section>

          <TerminalThemeSettings
            config={terminalConfig}
            appTheme={resolvedTheme}
            onPresetChange={onTerminalPresetChange}
            onFontSizeChange={onTerminalFontSizeChange}
            onLineHeightChange={onTerminalLineHeightChange}
            onCursorStyleChange={onTerminalCursorStyleChange}
            onCustomColorChange={onTerminalCustomColorChange}
            onCloneToCustom={onTerminalCloneToCustom}
            onReset={onTerminalReset}
          />

          {/* Language selector */}
          <section className="border-t border-[var(--border-subtle)] px-4 py-3.5">
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">
              {t("settings.language")}
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {t("settings.languageHint")}
            </p>

            <div className="mt-2.5 grid grid-cols-2 gap-1.5">
              {SUPPORTED_LANGUAGES.map((language) => {
                const selected = language === active;
                return (
                  <button
                    key={language}
                    type="button"
                    lang={language}
                    onClick={() => void changeLanguage(language)}
                    className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition"
                    style={{
                      borderColor: selected ? "var(--accent-border)" : "var(--border-subtle)",
                      backgroundColor: selected ? "var(--accent-soft)" : "var(--bg-canvas)",
                      color: selected ? "var(--accent)" : "var(--text-secondary)",
                    }}
                  >
                    <span className={selected ? "font-medium" : ""}>
                      {LANGUAGE_LABELS[language]}
                    </span>
                    <span className="ml-auto font-mono text-[10px] opacity-70">{language}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <LlmSettings />

          <KnownHosts />
        </div>

        <footer className="flex shrink-0 items-center justify-end border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1 text-xs font-medium text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
          >
            {t("settings.close")}
          </button>
        </footer>
      </div>
    </div>
  );
}
