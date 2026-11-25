// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

export type HighlightColor = "red" | "amber" | "green" | "cyan" | "magenta";

export interface HighlightRule {
  id: string;
  label: string;
  pattern: string;
  color: HighlightColor;
  enabled: boolean;
  caseInsensitive?: boolean;
}

const RULES_KEY = "ota.highlight.rules.v1";
const ENABLED_KEY = "ota.highlight.enabled.v1";

const ANSI_SGR_PREFIX: Record<HighlightColor, string> = {
  red: "\x1b[1;31m",
  amber: "\x1b[1;33m",
  green: "\x1b[1;32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[1;35m",
};

const ANSI_SGR_RESET = "\x1b[39;22m";

export const DEFAULT_HIGHLIGHT_RULES: HighlightRule[] = [
  {
    id: "errors",
    label: "ERROR / FATAL / PANIC",
    pattern: "\\b(?:ERROR|FATAL|PANIC|CRITICAL|Exception|Traceback|FAIL(?:ED)?)\\b",
    color: "red",
    enabled: true,
    caseInsensitive: false,
  },
  {
    id: "warnings",
    label: "WARN / WARNING",
    pattern: "\\b(?:WARN(?:ING)?|DEPRECATED|TIMEOUT)\\b",
    color: "amber",
    enabled: true,
    caseInsensitive: false,
  },
  {
    id: "success",
    label: "OK / SUCCESS / READY",
    pattern: "\\b(?:SUCCESS|PASSED|READY|CONNECTED|HEALTHY)\\b",
    color: "green",
    enabled: true,
    caseInsensitive: false,
  },
  {
    id: "ipv4",
    label: "IPv4",
    pattern: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?\\b",
    color: "cyan",
    enabled: true,
    caseInsensitive: false,
  },
];

export function loadHighlightEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(ENABLED_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

export function saveHighlightEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage quota / privacy errors.
  }
}

export function loadHighlightRules(): HighlightRule[] {
  try {
    const raw = window.localStorage.getItem(RULES_KEY);
    if (!raw) return DEFAULT_HIGHLIGHT_RULES;
    const parsed = JSON.parse(raw) as HighlightRule[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_HIGHLIGHT_RULES;
  } catch {
    return DEFAULT_HIGHLIGHT_RULES;
  }
}

export function saveHighlightRules(rules: HighlightRule[]): void {
  try {
    window.localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  } catch {
    // Ignore storage errors.
  }
}

// Matches ANSI CSI, OSC, and single-char escape sequences so we never corrupt them.
// eslint-disable-next-line no-control-regex
const ANSI_TOKEN_RE = /(\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/g;

// Full-screen TUI cursor/alt-screen sequences where decorating text could disturb layout.
// eslint-disable-next-line no-control-regex
const TUI_CONTROL_RE = /\x1b\[\?(?:1049|47|1047)[hl]|\x1b\[\d+;\d+[Hf]/;

interface CompiledRule {
  regex: RegExp;
  prefix: string;
}

export function compileHighlightRules(rules: HighlightRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern.trim()) continue;
    try {
      const flags = rule.caseInsensitive ? "gi" : "g";
      compiled.push({
        regex: new RegExp(rule.pattern, flags),
        prefix: ANSI_SGR_PREFIX[rule.color],
      });
    } catch {
      // Skip invalid user regex gracefully.
    }
  }
  return compiled;
}

/**
 * Decorates plain-text segments of an incoming terminal chunk with ANSI SGR
 * colors while keeping all existing ANSI/OSC escape sequences untouched.
 */
export function applyKeywordHighlights(chunk: string, rules: CompiledRule[]): string {
  if (rules.length === 0 || chunk.length === 0 || TUI_CONTROL_RE.test(chunk)) {
    return chunk;
  }

  const parts = chunk.split(ANSI_TOKEN_RE);
  let changed = false;

  for (let i = 0; i < parts.length; i += 2) {
    let segment = parts[i] ?? "";
    if (!segment) continue;
    for (const rule of rules) {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(segment)) {
        rule.regex.lastIndex = 0;
        segment = segment.replace(rule.regex, (match) => `${rule.prefix}${match}${ANSI_SGR_RESET}`);
        changed = true;
      }
    }
    parts[i] = segment;
  }

  return changed ? parts.join("") : chunk;
}
