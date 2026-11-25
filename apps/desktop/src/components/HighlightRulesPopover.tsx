// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_HIGHLIGHT_RULES,
  type HighlightColor,
  type HighlightRule,
} from "../lib/terminalHighlighter";

interface HighlightRulesPopoverProps {
  enabled: boolean;
  rules: HighlightRule[];
  onToggleEnabled: () => void;
  onChangeRules: (next: HighlightRule[]) => void;
  onClose: () => void;
}

const COLORS: { id: HighlightColor; dot: string }[] = [
  { id: "red", dot: "#ef4444" },
  { id: "amber", dot: "#f59e0b" },
  { id: "green", dot: "#22c55e" },
  { id: "cyan", dot: "#06b6d4" },
  { id: "magenta", dot: "#d946ef" },
];

export function HighlightRulesPopover({
  enabled,
  rules,
  onToggleEnabled,
  onChangeRules,
  onClose,
}: HighlightRulesPopoverProps) {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState("");
  const [color, setColor] = useState<HighlightColor>("amber");
  const [regexError, setRegexError] = useState(false);

  const addRule = () => {
    const trimmed = pattern.trim();
    if (!trimmed) return;
    try {
      new RegExp(trimmed);
    } catch {
      setRegexError(true);
      return;
    }
    setRegexError(false);
    const next: HighlightRule = {
      id: `custom-${Date.now()}`,
      label: trimmed,
      pattern: trimmed,
      color,
      enabled: true,
      caseInsensitive: true,
    };
    onChangeRules([...rules, next]);
    setPattern("");
  };

  return (
    <div
      onMouseDown={(event) => event.stopPropagation()}
      className="absolute top-10 right-4 z-40 w-80 overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            {t("highlight.title")}
          </span>
          <button
            type="button"
            onClick={onToggleEnabled}
            className="rounded-full px-2 py-0.5 text-[10px] font-medium transition"
            style={{
              backgroundColor: enabled ? "var(--accent-soft)" : "var(--bg-elevated)",
              color: enabled ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            {enabled ? t("highlight.on") : t("highlight.off")}
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onChangeRules(DEFAULT_HIGHLIGHT_RULES)}
            className="text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            {t("highlight.reset")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            ×
          </button>
        </div>
      </header>

      <div className="max-h-56 space-y-1 overflow-y-auto p-2.5">
        {rules.map((rule) => {
          const swatch = COLORS.find((item) => item.id === rule.color)?.dot ?? "#f59e0b";
          return (
            <div
              key={rule.id}
              className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs"
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={() =>
                    onChangeRules(
                      rules.map((item) =>
                        item.id === rule.id ? { ...item, enabled: !item.enabled } : item,
                      ),
                    )
                  }
                />
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: swatch }}
                />
                <span className="truncate font-mono text-[11px] text-[var(--text-primary)]">
                  {rule.label}
                </span>
              </label>
              {rule.id.startsWith("custom-") ? (
                <button
                  type="button"
                  onClick={() => onChangeRules(rules.filter((item) => item.id !== rule.id))}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--status-danger)]"
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-2.5">
        <div className="flex items-center gap-1.5">
          <input
            value={pattern}
            onChange={(event) => {
              setPattern(event.target.value);
              setRegexError(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") addRule();
            }}
            placeholder={t("highlight.addPlaceholder")}
            className="ota-input !h-7 flex-1 font-mono !text-[11px]"
          />
          <button
            type="button"
            onClick={addRule}
            className="h-7 shrink-0 rounded-md px-2.5 text-[11px] font-medium text-white"
            style={{ backgroundColor: "var(--accent)" }}
          >
            {t("highlight.add")}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          {COLORS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setColor(item.id)}
              className={`h-4 w-4 rounded-full transition ${
                color === item.id ? "ring-2 ring-[var(--text-primary)] ring-offset-1 ring-offset-[var(--bg-elevated)]" : "opacity-60 hover:opacity-100"
              }`}
              style={{ backgroundColor: item.dot }}
              aria-label={item.id}
            />
          ))}
          {regexError ? (
            <span className="ml-auto text-[10.5px] text-[var(--status-danger)]">
              {t("highlight.invalidRegex")}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
