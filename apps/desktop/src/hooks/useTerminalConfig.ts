// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from "react";

import {
  DEFAULT_CUSTOM_COLORS,
  DEFAULT_TERMINAL_CONFIG,
  extractCustomColorsFromPreset,
  findPreset,
  type CursorStyle,
  type CustomTerminalColors,
  type TerminalAppearanceConfig,
  type TerminalPresetId,
} from "../lib/terminalThemes";
import type { ResolvedTheme } from "./useTheme";

const STORAGE_KEY = "ota.terminal.appearance";

function readStoredConfig(): TerminalAppearanceConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TERMINAL_CONFIG;
    const parsed = JSON.parse(raw) as Partial<TerminalAppearanceConfig>;
    return {
      preset: parsed.preset ?? DEFAULT_TERMINAL_CONFIG.preset,
      fontSize: clampNumber(parsed.fontSize, 11, 20, DEFAULT_TERMINAL_CONFIG.fontSize),
      lineHeight: clampNumber(parsed.lineHeight, 1.1, 1.6, DEFAULT_TERMINAL_CONFIG.lineHeight),
      cursorStyle:
        parsed.cursorStyle === "block" ||
        parsed.cursorStyle === "bar" ||
        parsed.cursorStyle === "underline"
          ? parsed.cursorStyle
          : DEFAULT_TERMINAL_CONFIG.cursorStyle,
      custom: {
        ...DEFAULT_CUSTOM_COLORS,
        ...(parsed.custom ?? {}),
      },
    };
  } catch {
    return DEFAULT_TERMINAL_CONFIG;
  }
}

function persistConfig(config: TerminalAppearanceConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage failures in restricted contexts.
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function useTerminalConfig() {
  const [config, setConfig] = useState<TerminalAppearanceConfig>(() => readStoredConfig());

  const update = useCallback(
    (updater: (prev: TerminalAppearanceConfig) => TerminalAppearanceConfig) => {
      setConfig((prev) => {
        const next = updater(prev);
        persistConfig(next);
        return next;
      });
    },
    [],
  );

  const setPreset = useCallback(
    (preset: TerminalPresetId) => {
      update((prev) => ({ ...prev, preset }));
    },
    [update],
  );

  const setFontSize = useCallback(
    (fontSize: number) => {
      update((prev) => ({ ...prev, fontSize: clampNumber(fontSize, 11, 20, prev.fontSize) }));
    },
    [update],
  );

  const setLineHeight = useCallback(
    (lineHeight: number) => {
      update((prev) => ({
        ...prev,
        lineHeight: Number(clampNumber(lineHeight, 1.1, 1.6, prev.lineHeight).toFixed(2)),
      }));
    },
    [update],
  );

  const setCursorStyle = useCallback(
    (cursorStyle: CursorStyle) => {
      update((prev) => ({ ...prev, cursorStyle }));
    },
    [update],
  );

  const setCustomColor = useCallback(
    (key: keyof CustomTerminalColors, value: string) => {
      update((prev) => ({
        ...prev,
        preset: "custom",
        custom: {
          ...prev.custom,
          [key]: value,
        },
      }));
    },
    [update],
  );

  const cloneCurrentToCustom = useCallback(
    (appTheme: ResolvedTheme) => {
      update((prev) => {
        if (prev.preset === "custom") return prev;
        const sourceId =
          prev.preset === "auto"
            ? appTheme === "dark"
              ? "studio-dark"
              : "studio-light"
            : prev.preset;
        const preset = findPreset(sourceId);
        return {
          ...prev,
          preset: "custom",
          custom: extractCustomColorsFromPreset(preset),
        };
      });
    },
    [update],
  );

  const resetTerminalConfig = useCallback(() => {
    setConfig(DEFAULT_TERMINAL_CONFIG);
    persistConfig(DEFAULT_TERMINAL_CONFIG);
  }, []);

  return {
    config,
    setPreset,
    setFontSize,
    setLineHeight,
    setCursorStyle,
    setCustomColor,
    cloneCurrentToCustom,
    resetTerminalConfig,
  };
}
