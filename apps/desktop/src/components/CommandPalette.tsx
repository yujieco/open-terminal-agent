// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentIpc } from "../lib/agent";
import type { TerminalBackend } from "../lib/backend";

interface CommandPaletteProps {
  backend: TerminalBackend | null;
  onClose: () => void;
}

/**
 * Ctrl+K palette: turns a sentence into one shell command, shows it for review
 * and only writes it to the terminal (without Enter) when the user accepts.
 */
export function CommandPalette({ backend, onClose }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const insert = () => {
    if (!backend || suggestion.length === 0) return;
    // No trailing newline: the user presses Enter, so the command stays visible
    // and editable before it runs.
    backend.write(suggestion);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 px-4 pt-32"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border border-slate-700 bg-slate-900/95 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void generate();
          }}
          placeholder={t("palette.placeholder")}
          className="w-full bg-transparent px-4 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-600"
        />

        {suggestion.length > 0 ? (
          <div className="border-t border-slate-800 px-4 py-2">
            <pre className="rounded bg-slate-950/80 px-2 py-1.5 font-mono text-[12px] whitespace-pre-wrap text-cyan-200">
              {suggestion}
            </pre>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={insert}
                className="rounded bg-cyan-500/20 px-3 py-1 text-[11px] text-cyan-100 hover:bg-cyan-500/30"
              >
                {t("palette.insert")}
              </button>
              <button
                type="button"
                onClick={() => void generate()}
                className="rounded border border-slate-700 px-3 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
              >
                {t("palette.regenerate")}
              </button>
              <span className="ml-auto text-[10px] text-slate-600">{t("palette.hint")}</span>
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2 border-t border-slate-800 px-4 py-1.5 text-[10px] text-slate-600">
          <span>{busy ? t("palette.generating") : t("palette.generate")}</span>
          {backend === null ? <span className="text-amber-300/80">{t("palette.noSession")}</span> : null}
          {error ? <span className="text-rose-300">{error}</span> : null}
        </div>
      </div>
    </div>
  );
}
