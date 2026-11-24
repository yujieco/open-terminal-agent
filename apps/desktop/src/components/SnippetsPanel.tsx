// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CommandSnippet } from "../lib/ipc";

interface HandbookEntry {
  id: string;
  category: "network" | "system" | "logs" | "docker" | "git";
  labelKey: string;
  command: string;
}

const BUILTIN_HANDBOOK: HandbookEntry[] = [
  {
    id: "hb-listen",
    category: "network",
    labelKey: "snippets.handbook.listenPorts",
    command: "lsof -nP -iTCP -sTCP:LISTEN",
  },
  {
    id: "hb-port-8080",
    category: "network",
    labelKey: "snippets.handbook.checkPort",
    command: "lsof -nP -i :8080",
  },
  {
    id: "hb-disk",
    category: "system",
    labelKey: "snippets.handbook.diskUsage",
    command: "df -h",
  },
  {
    id: "hb-large-dirs",
    category: "system",
    labelKey: "snippets.handbook.largestDirs",
    command: "du -sh * 2>/dev/null | sort -hr | head -n 15",
  },
  {
    id: "hb-top-mem",
    category: "system",
    labelKey: "snippets.handbook.topMemory",
    command: "ps aux | sort -rk 4 | head -n 12",
  },
  {
    id: "hb-tail-log",
    category: "logs",
    labelKey: "snippets.handbook.tailLog",
    command: "tail -f -n 100 ",
  },
  {
    id: "hb-grep-err",
    category: "logs",
    labelKey: "snippets.handbook.grepErrors",
    command: "grep -rnE \"ERROR|WARN|FATAL\" .",
  },
  {
    id: "hb-docker-ps",
    category: "docker",
    labelKey: "snippets.handbook.dockerPs",
    command: "docker ps --format \"table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\"",
  },
  {
    id: "hb-docker-logs",
    category: "docker",
    labelKey: "snippets.handbook.dockerLogs",
    command: "docker logs -f --tail 100 ",
  },
  {
    id: "hb-git-graph",
    category: "git",
    labelKey: "snippets.handbook.gitGraph",
    command: "git log --oneline --graph --decorate -n 15",
  },
  {
    id: "hb-git-diff",
    category: "git",
    labelKey: "snippets.handbook.gitDiffStat",
    command: "git status -sb && git diff --stat",
  },
];

interface SnippetsPanelProps {
  snippets: CommandSnippet[];
  hasSession: boolean;
  onPaste: (command: string, snippetId?: string) => void;
  onAddNew: () => void;
  onEdit: (snippet: CommandSnippet) => void;
  onDelete: (id: string) => void;
  onFavoriteHandbook: (command: string) => void;
}

export function SnippetsPanel({
  snippets,
  hasSession,
  onPaste,
  onAddNew,
  onEdit,
  onDelete,
  onFavoriteHandbook,
}: SnippetsPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [handbookOpen, setHandbookOpen] = useState(true);

  const normalized = query.trim().toLowerCase();

  const filteredSnippets = useMemo(() => {
    if (!normalized) return snippets;
    return snippets.filter(
      (item) =>
        item.alias.toLowerCase().includes(normalized) ||
        item.command.toLowerCase().includes(normalized) ||
        item.category.toLowerCase().includes(normalized) ||
        item.description.toLowerCase().includes(normalized),
    );
  }, [normalized, snippets]);

  const filteredHandbook = useMemo(() => {
    if (!normalized) return BUILTIN_HANDBOOK;
    return BUILTIN_HANDBOOK.filter((item) => {
      const label = t(item.labelKey).toLowerCase();
      return (
        label.includes(normalized) ||
        item.command.toLowerCase().includes(normalized) ||
        item.category.toLowerCase().includes(normalized)
      );
    });
  }, [normalized, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search + Add toolbar (equal-height controls) */}
      <div className="border-b border-[var(--border-subtle)] px-3.5 py-2.5">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("snippets.searchPlaceholder")}
            className="ota-input !h-7 flex-1 !py-0"
          />
          <button
            type="button"
            onClick={onAddNew}
            title={t("snippets.add")}
            className="ota-ctrl-primary"
          >
            {t("snippets.addShort")}
          </button>
        </div>
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
          {t("snippets.pasteHint")}
        </p>
      </div>

      {/* Scrollable list: Saved Snippets + Built-in Handbook */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3.5 py-3">
        {/* Saved personal snippets */}
        <section>
          <div className="flex items-center justify-between text-[10px] font-semibold tracking-[0.12em] text-[var(--text-muted)] uppercase">
            <span>{t("snippets.savedTitle")}</span>
            <span className="font-mono">{filteredSnippets.length}</span>
          </div>

          {filteredSnippets.length === 0 ? (
            <div className="mt-2 rounded-lg border border-dashed border-[var(--border-subtle)] px-3 py-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {snippets.length === 0 ? t("snippets.empty") : t("snippets.noMatch")}
            </div>
          ) : (
            <ul className="mt-2 space-y-2">
              {filteredSnippets.map((item) => (
                <li
                  key={item.id}
                  className="group overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] transition hover:border-[var(--accent-border)]"
                >
                  <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1">
                    <button
                      type="button"
                      disabled={!hasSession}
                      onClick={() => onPaste(item.command, item.id)}
                      title={t("snippets.clickToPaste")}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="truncate text-xs font-medium text-[var(--text-primary)]">
                        {item.alias}
                      </span>
                      <span className="shrink-0 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-muted)] uppercase">
                        {t(`snippets.categories.${item.category}`, { defaultValue: item.category })}
                      </span>
                    </button>

                    <button
                      type="button"
                      aria-label={t("snippets.editTitle")}
                      onClick={() => onEdit(item)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11.2 2.8l2 2L5.5 12.5 3 13l.5-2.5 7.7-7.7z" />
                      </svg>
                    </button>

                    <button
                      type="button"
                      aria-label={t("common.delete")}
                      onClick={() => onDelete(item.id)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--bg-hover)] hover:text-[var(--status-danger)]"
                    >
                      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </div>

                  <button
                    type="button"
                    disabled={!hasSession}
                    onClick={() => onPaste(item.command, item.id)}
                    className="block w-full border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-left font-mono text-[11px] break-all text-[var(--text-secondary)] transition hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    $ {item.command}
                  </button>

                  {item.description ? (
                    <p className="border-t border-[var(--border-subtle)] px-2.5 py-1 text-[10.5px] text-[var(--text-muted)]">
                      {item.description}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Built-in Ops Handbook */}
        <section>
          <button
            type="button"
            onClick={() => setHandbookOpen((open) => !open)}
            className="flex w-full items-center justify-between text-[10px] font-semibold tracking-[0.12em] text-[var(--text-muted)] uppercase transition hover:text-[var(--text-secondary)]"
          >
            <span>{t("snippets.handbookTitle")}</span>
            <span className="font-mono">{handbookOpen ? "▾" : "▸"}</span>
          </button>

          {handbookOpen ? (
            <ul className="mt-2 space-y-1.5">
              {filteredHandbook.map((entry) => (
                <li
                  key={entry.id}
                  className="group overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] transition hover:border-[var(--border-strong)]"
                >
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                    <button
                      type="button"
                      disabled={!hasSession}
                      onClick={() => onPaste(entry.command)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="truncate text-[11.5px] font-medium text-[var(--text-primary)]">
                        {t(entry.labelKey)}
                      </span>
                      <span className="shrink-0 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-muted)] uppercase">
                        {t(`snippets.categories.${entry.category}`)}
                      </span>
                    </button>
                    <button
                      type="button"
                      title={t("snippets.saveSelection")}
                      onClick={() => onFavoriteHandbook(entry.command)}
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--accent)]"
                    >
                      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M8 2.2l1.75 3.55 3.92.57-2.83 2.76.67 3.9L8 11.14 4.49 12.98l.67-3.9-2.83-2.76 3.92-.57L8 2.2z" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={!hasSession}
                    onClick={() => onPaste(entry.command)}
                    className="block w-full border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 text-left font-mono text-[10.5px] break-all text-[var(--text-muted)] transition hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    $ {entry.command}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  );
}
