// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CommandSnippet, SaveSnippetInput } from "../lib/ipc";

const CATEGORY_PRESETS = ["general", "network", "system", "logs", "docker", "git"];

interface SaveSnippetDialogProps {
  initialCommand?: string;
  editing?: CommandSnippet | null;
  onSave: (input: SaveSnippetInput) => Promise<void>;
  onClose: () => void;
}

export function SaveSnippetDialog({
  initialCommand = "",
  editing = null,
  onSave,
  onClose,
}: SaveSnippetDialogProps) {
  const { t } = useTranslation();
  const [alias, setAlias] = useState(editing?.alias ?? "");
  const [command, setCommand] = useState(editing?.command ?? initialCommand);
  const [category, setCategory] = useState(editing?.category ?? "general");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliasInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    aliasInputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const ready = alias.trim().length > 0 && command.trim().length > 0;

  const submit = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: editing?.id,
        alias: alias.trim(),
        command: command.trim(),
        category: category.trim() || "general",
        description: description.trim(),
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-[2px]"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {editing ? t("snippets.editTitle") : t("snippets.saveTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="space-y-3 px-4 py-3.5">
          <label className="block">
            <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
              {t("snippets.alias")}
            </span>
            <input
              ref={aliasInputRef}
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={t("snippets.aliasPlaceholder")}
              className="ota-input"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
              {t("snippets.command")}
            </span>
            <textarea
              rows={3}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="lsof -nP -iTCP:8080 -sTCP:LISTEN"
              className="ota-input resize-none font-mono"
            />
          </label>

          <div>
            <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
              {t("snippets.category")}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_PRESETS.map((item) => {
                const selected = category === item;
                return (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setCategory(item)}
                    className="rounded-md border px-2 py-1 text-[11px] transition"
                    style={{
                      borderColor: selected ? "var(--accent-border)" : "var(--border-subtle)",
                      backgroundColor: selected ? "var(--accent-soft)" : "var(--bg-canvas)",
                      color: selected ? "var(--accent)" : "var(--text-secondary)",
                    }}
                  >
                    {t(`snippets.categories.${item}`)}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
              {t("snippets.description")}
            </span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("snippets.descriptionPlaceholder")}
              className="ota-input"
            />
          </label>

          {error ? (
            <p className="text-[11px]" style={{ color: "var(--status-danger)" }}>
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!ready || saving}
            onClick={() => void submit()}
            className="ota-btn-primary rounded-md px-3.5 py-1.5 text-xs"
          >
            {t("settings.save")}
          </button>
        </footer>
      </div>
    </div>
  );
}
