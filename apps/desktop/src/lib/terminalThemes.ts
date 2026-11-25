// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import type { ITheme } from "@xterm/xterm";

import type { ResolvedTheme } from "../hooks/useTheme";

export type TerminalPresetId =
  | "auto"
  | "studio-dark"
  | "studio-light"
  | "catppuccin-mocha"
  | "catppuccin-latte"
  | "tokyo-night"
  | "solarized-light"
  | "nord"
  | "gruvbox-dark"
  | "custom";

export type CursorStyle = "block" | "bar" | "underline";

export interface CustomTerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  green: string;
  blue: string;
  cyan: string;
  yellow: string;
  red: string;
  magenta: string;
}

export interface TerminalAppearanceConfig {
  preset: TerminalPresetId;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  custom: CustomTerminalColors;
}

export interface TerminalThemePreset {
  id: Exclude<TerminalPresetId, "auto" | "custom">;
  name: string;
  tone: "dark" | "light";
  theme: Required<
    Pick<
      ITheme,
      | "background"
      | "foreground"
      | "cursor"
      | "cursorAccent"
      | "selectionBackground"
      | "black"
      | "red"
      | "green"
      | "yellow"
      | "blue"
      | "magenta"
      | "cyan"
      | "white"
      | "brightBlack"
      | "brightRed"
      | "brightGreen"
      | "brightYellow"
      | "brightBlue"
      | "brightMagenta"
      | "brightCyan"
      | "brightWhite"
    >
  >;
}

export const TERMINAL_PRESETS: TerminalThemePreset[] = [
  {
    id: "studio-dark",
    name: "Studio Dark",
    tone: "dark",
    theme: {
      background: "#0c0d0f",
      foreground: "#e4e6eb",
      cursor: "#3b82f6",
      cursorAccent: "#0c0d0f",
      selectionBackground: "rgba(59, 130, 246, 0.28)",
      black: "#1e2026",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#38bdf8",
      white: "#d5dae3",
      brightBlack: "#636b7a",
      brightRed: "#fca5a5",
      brightGreen: "#86efac",
      brightYellow: "#fde68a",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#7dd3fc",
      brightWhite: "#f8fafc",
    },
  },
  {
    id: "studio-light",
    name: "Studio Light",
    tone: "light",
    theme: {
      background: "#ffffff",
      foreground: "#1c1e24",
      cursor: "#007aff",
      cursorAccent: "#ffffff",
      selectionBackground: "rgba(0, 122, 255, 0.18)",
      black: "#1c1e24",
      red: "#c81e1e",
      green: "#15803d",
      yellow: "#b45309",
      blue: "#1d4ed8",
      magenta: "#7e22ce",
      cyan: "#0e7490",
      white: "#646978",
      brightBlack: "#858a99",
      brightRed: "#dc2626",
      brightGreen: "#16a34a",
      brightYellow: "#d97706",
      brightBlue: "#2563eb",
      brightMagenta: "#9333ea",
      brightCyan: "#0891b2",
      brightWhite: "#3f4452",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    tone: "dark",
    theme: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "rgba(137, 180, 250, 0.26)",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    tone: "light",
    theme: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#dc8a78",
      cursorAccent: "#eff1f5",
      selectionBackground: "rgba(30, 102, 245, 0.18)",
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#ea76cb",
      cyan: "#179299",
      white: "#acb0be",
      brightBlack: "#6c6f85",
      brightRed: "#d20f39",
      brightGreen: "#40a02b",
      brightYellow: "#df8e1d",
      brightBlue: "#1e66f5",
      brightMagenta: "#ea76cb",
      brightCyan: "#179299",
      brightWhite: "#7c7f93",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    tone: "dark",
    theme: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#ff9e64",
      cursorAccent: "#1a1b26",
      selectionBackground: "rgba(122, 162, 247, 0.25)",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#565f89",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    tone: "light",
    theme: {
      background: "#fdf6e3",
      foreground: "#586e75",
      cursor: "#cb4b16",
      cursorAccent: "#fdf6e3",
      selectionBackground: "rgba(38, 139, 210, 0.2)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#93a1a1",
      brightBlack: "#657b83",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#2aa198",
      brightWhite: "#073642",
    },
  },
  {
    id: "nord",
    name: "Nord",
    tone: "dark",
    theme: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#88c0d0",
      cursorAccent: "#2e3440",
      selectionBackground: "rgba(136, 192, 208, 0.25)",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#616e88",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    tone: "dark",
    theme: {
      background: "#1d2021",
      foreground: "#ebdbb2",
      cursor: "#fe8019",
      cursorAccent: "#1d2021",
      selectionBackground: "rgba(254, 128, 25, 0.28)",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
];

export const DEFAULT_CUSTOM_COLORS: CustomTerminalColors = {
  background: "#0e0f12",
  foreground: "#e4e7ee",
  cursor: "#f58220",
  selectionBackground: "#3b2a1c",
  green: "#4ade80",
  blue: "#60a5fa",
  cyan: "#38bdf8",
  yellow: "#fbbf24",
  red: "#f87171",
  magenta: "#c084fc",
};

export const DEFAULT_TERMINAL_CONFIG: TerminalAppearanceConfig = {
  preset: "auto",
  fontSize: 13,
  lineHeight: 1.28,
  cursorStyle: "block",
  custom: DEFAULT_CUSTOM_COLORS,
};

export function findPreset(id: TerminalThemePreset["id"]): TerminalThemePreset {
  return TERMINAL_PRESETS.find((preset) => preset.id === id) ?? TERMINAL_PRESETS[0];
}

export function extractCustomColorsFromPreset(
  preset: TerminalThemePreset,
): CustomTerminalColors {
  return {
    background: preset.theme.background,
    foreground: preset.theme.foreground,
    cursor: preset.theme.cursor,
    selectionBackground: preset.tone === "dark" ? "#3b2a1c" : "#f7dcc4",
    green: preset.theme.green,
    blue: preset.theme.blue,
    cyan: preset.theme.cyan,
    yellow: preset.theme.yellow,
    red: preset.theme.red,
    magenta: preset.theme.magenta,
  };
}

export function resolveTerminalTheme(
  config: TerminalAppearanceConfig,
  appTheme: ResolvedTheme,
): ITheme & { background: string; foreground: string; cursor: string } {
  if (config.preset === "auto") {
    return findPreset(appTheme === "dark" ? "studio-dark" : "studio-light").theme;
  }

  if (config.preset === "custom") {
    const c = config.custom;
    return {
      background: c.background,
      foreground: c.foreground,
      cursor: c.cursor,
      cursorAccent: c.background,
      selectionBackground: c.selectionBackground,
      black: "#272a34",
      red: c.red,
      green: c.green,
      yellow: c.yellow,
      blue: c.blue,
      magenta: c.magenta,
      cyan: c.cyan,
      white: c.foreground,
      brightBlack: "#767d8f",
      brightRed: c.red,
      brightGreen: c.green,
      brightYellow: c.yellow,
      brightBlue: c.blue,
      brightMagenta: c.magenta,
      brightCyan: c.cyan,
      brightWhite: c.foreground,
    };
  }

  return findPreset(config.preset).theme;
}
