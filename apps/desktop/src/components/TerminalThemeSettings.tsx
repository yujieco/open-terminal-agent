// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

import type { ResolvedTheme } from "../hooks/useTheme";
import {
  TERMINAL_PRESETS,
  resolveTerminalTheme,
  type CursorStyle,
  type CustomTerminalColors,
  type TerminalAppearanceConfig,
  type TerminalPresetId,
} from "../lib/terminalThemes";

interface TerminalThemeSettingsProps {
  config: TerminalAppearanceConfig;
  appTheme: ResolvedTheme;
  onPresetChange: (preset: TerminalPresetId) => void;
  onFontSizeChange: (size: number) => void;
  onLineHeightChange: (height: number) => void;
  onCursorStyleChange: (style: CursorStyle) => void;
  onCustomColorChange: (key: keyof CustomTerminalColors, value: string) => void;
  onCloneToCustom: () => void;
  onReset: () => void;
}

const CURSOR_STYLES: CursorStyle[] = ["block", "bar", "underline"];

const COLOR_FIELDS: Array<{ key: keyof CustomTerminalColors; labelKey: string }> = [
  { key: "background", labelKey: "settings.terminalTheme.colors.background" },
  { key: "foreground", labelKey: "settings.terminalTheme.colors.foreground" },
  { key: "cursor", labelKey: "settings.terminalTheme.colors.cursor" },
  { key: "selectionBackground", labelKey: "settings.terminalTheme.colors.selection" },
  { key: "green", labelKey: "settings.terminalTheme.colors.green" },
  { key: "blue", labelKey: "settings.terminalTheme.colors.blue" },
  { key: "cyan", labelKey: "settings.terminalTheme.colors.cyan" },
  { key: "yellow", labelKey: "settings.terminalTheme.colors.yellow" },
  { key: "red", labelKey: "settings.terminalTheme.colors.red" },
  { key: "magenta", labelKey: "settings.terminalTheme.colors.magenta" },
];

export function TerminalThemeSettings({
  config,
  appTheme,
  onPresetChange,
  onFontSizeChange,
  onLineHeightChange,
  onCursorStyleChange,
  onCustomColorChange,
  onCloneToCustom,
  onReset,
}: TerminalThemeSettingsProps) {
  const { t } = useTranslation();
  const preview = resolveTerminalTheme(config, appTheme);

  return (
    <section className="border-t border-[var(--border-subtle)] px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-[var(--text-primary)]">
          {t("settings.terminalTheme.title")}
        </h3>
        <button
          type="button"
          onClick={onReset}
          className="text-[10.5px] text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
        >
          {t("settings.terminalTheme.reset")}
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
        {t("settings.terminalTheme.hint")}
      </p>

      {/* Live mini terminal preview */}
      <div
        className="mt-2.5 overflow-hidden rounded-lg border border-[var(--border-strong)] p-3 font-mono"
        style={{
          backgroundColor: preview.background,
          color: preview.foreground,
          fontSize: `${Math.min(config.fontSize, 13)}px`,
          lineHeight: config.lineHeight,
        }}
      >
        <div className="flex flex-wrap items-center gap-x-1.5 border-l-2 pl-2" style={{ borderColor: preview.cursor }}>
          <span style={{ color: preview.green }}>yujie@mac</span>
          <span style={{ color: preview.cyan }}>~/open-terminal-agent</span>
          <span style={{ color: preview.magenta }}>(main)</span>
          <span style={{ color: preview.yellow }}>$</span>
          <span>git status --short</span>
          <span
            className="inline-block align-middle"
            style={{
              backgroundColor:
                config.cursorStyle === "underline" ? "transparent" : preview.cursor,
              borderBottom:
                config.cursorStyle === "underline" ? `2px solid ${preview.cursor}` : undefined,
              width: config.cursorStyle === "bar" ? "2px" : "7px",
              height: "1.1em",
            }}
          />
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px]">
          <span style={{ color: preview.green }}>M</span>
          <span style={{ color: preview.blue }}>apps/desktop/src/</span>
          <span style={{ color: preview.red }}>! 0 errors</span>
        </div>
      </div>

      {/* Preset cards */}
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={() => onPresetChange("auto")}
          className="flex items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-[11px] transition"
          style={{
            borderColor: config.preset === "auto" ? "var(--accent-border)" : "var(--border-subtle)",
            backgroundColor: config.preset === "auto" ? "var(--accent-soft)" : "var(--bg-canvas)",
            color: config.preset === "auto" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          <span className="truncate font-medium">{t("settings.terminalTheme.followApp")}</span>
          <span className="font-mono text-[9.5px] opacity-75">AUTO</span>
        </button>

        <button
          type="button"
          onClick={onCloneToCustom}
          className="flex items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-[11px] transition"
          style={{
            borderColor:
              config.preset === "custom" ? "var(--accent-border)" : "var(--border-subtle)",
            backgroundColor:
              config.preset === "custom" ? "var(--accent-soft)" : "var(--bg-canvas)",
            color: config.preset === "custom" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          <span className="truncate font-medium">{t("settings.terminalTheme.custom")}</span>
          <span className="flex items-center gap-0.5">
            <span
              className="h-2 w-2 rounded-full border border-black/15"
              style={{ backgroundColor: config.custom.background }}
            />
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: config.custom.cursor }}
            />
          </span>
        </button>

        {TERMINAL_PRESETS.map((preset) => {
          const selected = config.preset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onPresetChange(preset.id)}
              className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[11px] transition"
              style={{
                borderColor: selected ? "var(--accent-border)" : "var(--border-subtle)",
                backgroundColor: selected ? "var(--accent-soft)" : "var(--bg-canvas)",
                color: selected ? "var(--accent)" : "var(--text-secondary)",
              }}
            >
              <span
                className="flex h-4 w-5 shrink-0 items-center justify-center rounded border border-black/15"
                style={{ backgroundColor: preset.theme.background }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: preset.theme.cursor }}
                />
              </span>
              <span className={`truncate ${selected ? "font-medium" : ""}`}>{preset.name}</span>
              <span className="ml-auto flex shrink-0 items-center gap-0.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: preset.theme.green }}
                />
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: preset.theme.blue }}
                />
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: preset.theme.yellow }}
                />
              </span>
            </button>
          );
        })}
      </div>

      {/* Typography & Cursor controls */}
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <label className="block">
          <div className="mb-1 flex items-center justify-between text-[10px] font-medium text-[var(--text-muted)] uppercase">
            <span>{t("settings.terminalTheme.fontSize")}</span>
            <span className="font-mono text-[var(--text-secondary)]">{config.fontSize}px</span>
          </div>
          <input
            type="range"
            min={11}
            max={20}
            step={1}
            value={config.fontSize}
            onChange={(event) => onFontSizeChange(Number(event.target.value))}
            className="w-full accent-[var(--accent)]"
          />
        </label>

        <label className="block">
          <div className="mb-1 flex items-center justify-between text-[10px] font-medium text-[var(--text-muted)] uppercase">
            <span>{t("settings.terminalTheme.lineHeight")}</span>
            <span className="font-mono text-[var(--text-secondary)]">
              {config.lineHeight.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={1.1}
            max={1.6}
            step={0.04}
            value={config.lineHeight}
            onChange={(event) => onLineHeightChange(Number(event.target.value))}
            className="w-full accent-[var(--accent)]"
          />
        </label>
      </div>

      <div className="mt-2.5">
        <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
          {t("settings.terminalTheme.cursorStyle")}
        </span>
        <div className="grid grid-cols-3 gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-1">
          {CURSOR_STYLES.map((style) => {
            const selected = config.cursorStyle === style;
            return (
              <button
                key={style}
                type="button"
                onClick={() => onCursorStyleChange(style)}
                className="rounded-md px-2 py-1 text-[11px] font-medium transition"
                style={{
                  backgroundColor: selected ? "var(--bg-elevated)" : "transparent",
                  color: selected ? "var(--text-primary)" : "var(--text-muted)",
                }}
              >
                {t(`settings.terminalTheme.cursors.${style}`)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom color pickers */}
      {config.preset === "custom" ? (
        <div className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2.5">
          <div className="grid grid-cols-2 gap-2">
            {COLOR_FIELDS.map(({ key, labelKey }) => (
              <label
                key={key}
                className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1"
              >
                <input
                  type="color"
                  value={toColorInputValue(config.custom[key])}
                  onChange={(event) => onCustomColorChange(key, event.target.value)}
                  className="h-5 w-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[10px] text-[var(--text-secondary)]">
                    {t(labelKey)}
                  </div>
                  <div className="font-mono text-[9.5px] text-[var(--text-muted)] uppercase">
                    {config.custom[key]}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function toColorInputValue(raw: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : "#0e0f12";
}
