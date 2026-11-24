// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentIpc } from "../lib/agent";
import type { TerminalBackend } from "../lib/backend";
import { formatLlmError, type FriendlyError } from "../lib/friendlyError";

interface CommandPaletteProps {
  backend: TerminalBackend | null;
  onOpenSettings: () => void;
  onClose: () => void;
}

/**
 * Ctrl+K / Cmd+K palette: turns a sentence into one shell command, shows it for
 * review and only writes it to the terminal (without Enter) when accepted.
 */
export function CommandPalette({ backend, onOpenSettings, onClose }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const placeholderText = t("palette.placeholder");

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const generate = async () => {
    if (prompt.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setSuggestion(await agentIpc.suggest({ prompt: prompt.trim() }));
    } catch (cause) {
      setError(formatLlmError(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const insert = () => {
    if (!backend || suggestion.length === 0) return;
    backend.write(suggestion);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-28 backdrop-blur-[2px]"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <input
            ref={inputRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Tab" && prompt.length === 0) {
                event.preventDefault();
                setPrompt(placeholderText);
                return;
              }
              if (event.key === "Enter") void generate();
            }}
            placeholder={placeholderText}
            className="h-7 w-full bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          {prompt.length === 0 ? (
            <button
              type="button"
              onClick={() => setPrompt(placeholderText)}
              className="ota-ctrl font-mono text-[11px]"
            >
              Tab
            </button>
          ) : null}
        </div>

        {suggestion.length > 0 ? (
          <div className="border-t border-[var(--border-subtle)] px-4 py-3">
            <pre className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2 font-mono text-xs whitespace-pre-wrap text-[var(--text-primary)]">
              $ {suggestion}
            </pre>
            <div className="mt-2.5 flex items-center gap-2">
              <button type="button" onClick={insert} className="ota-ctrl-primary">
                {t("palette.insert")}
              </button>
              <button type="button" onClick={() => void generate()} className="ota-ctrl">
                {t("palette.regenerate")}
              </button>
              <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">
                {t("palette.hint")}
              </span>
            </div>
          </div>
        ) : null}

        {error ? (
          <div
            className="flex items-center justify-between gap-3 border-t px-4 py-2.5 text-xs"
            style={{
              borderColor: "var(--border-subtle)",
              backgroundColor: "var(--status-danger-soft)",
              color: "var(--status-danger)",
            }}
          >
            <span>{error.message}</span>
            {error.openSettings ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
                className="shrink-0 rounded-md border border-current px-2.5 py-1 text-[11px] font-medium hover:opacity-80"
              >
                {t("agent.openSettings")}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2 font-mono text-[10px] text-[var(--text-muted)]">
          <span>{busy ? t("palette.generating") : t("palette.generate")}</span>
          {backend === null ? (
            <span style={{ color: "var(--accent)" }}>{t("palette.noSession")}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
