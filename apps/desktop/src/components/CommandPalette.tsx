// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentIpc } from "../lib/agent";
import type { TerminalBackend } from "../lib/backend";
import { formatLlmError, type FriendlyError } from "../lib/friendlyError";
import type { CommandSnippet, SavedSession } from "../lib/ipc";

interface CommandPaletteProps {
  backend: TerminalBackend | null;
  saved: SavedSession[];
  snippets: CommandSnippet[];
  onOpenSaved: (id: string) => void;
  onPasteSnippet: (snippet: CommandSnippet) => void;
  onNewLocal: () => void;
  onOpenSsh: () => void;
  onOpenSerial: () => void;
  onOpenSftp: () => void;
  onOpenTunnels: () => void;
  onSplit: (direction: "row" | "column") => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

interface PaletteItem {
  id: string;
  section: "saved" | "snippets" | "actions";
  title: string;
  subtitle?: string;
  badge?: string;
  badgeDanger?: boolean;
  onRun: () => void;
}

/**
 * Ctrl+K / Cmd+K unified Studio launcher:
 * - Instant fuzzy search across saved SSH hosts, command snippets, and workbench actions.
 * - Built-in AI natural-language shell command generator (Enter when no action matched or click AI row).
 */
export function CommandPalette({
  backend,
  saved,
  snippets,
  onOpenSaved,
  onPasteSnippet,
  onNewLocal,
  onOpenSsh,
  onOpenSerial,
  onOpenSftp,
  onOpenTunnels,
  onSplit,
  onToggleTheme,
  onOpenSettings,
  onClose,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [suggestion, setSuggestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const all: PaletteItem[] = [];

    for (const profile of saved) {
      const host = String(profile.payload.host ?? "");
      const user = String(profile.payload.username ?? "");
      const envTag = typeof profile.payload.envTag === "string" ? profile.payload.envTag : undefined;
      all.push({
        id: `saved:${profile.id}`,
        section: "saved",
        title: profile.name,
        subtitle: host ? `${user}@${host}` : profile.kind,
        badge: envTag === "prod" ? "PROD" : profile.kind.toUpperCase(),
        badgeDanger: envTag === "prod",
        onRun: () => {
          onClose();
          onOpenSaved(profile.id);
        },
      });
    }

    for (const snippet of snippets) {
      all.push({
        id: `snippet:${snippet.id}`,
        section: "snippets",
        title: snippet.alias,
        subtitle: snippet.command,
        badge: snippet.category || "CMD",
        onRun: () => {
          onClose();
          onPasteSnippet(snippet);
        },
      });
    }

    all.push(
      {
        id: "action:local",
        section: "actions",
        title: t("sidebar.newSession"),
        subtitle: "Local shell",
        onRun: () => {
          onClose();
          onNewLocal();
        },
      },
      {
        id: "action:ssh",
        section: "actions",
        title: t("sidebar.ssh"),
        subtitle: "SSH",
        onRun: () => {
          onClose();
          onOpenSsh();
        },
      },
      {
        id: "action:sftp",
        section: "actions",
        title: t("sidebar.sftp"),
        subtitle: "SFTP",
        onRun: () => {
          onClose();
          onOpenSftp();
        },
      },
      {
        id: "action:tunnels",
        section: "actions",
        title: t("sidebar.tunnels"),
        subtitle: "-L / -R / SOCKS5",
        onRun: () => {
          onClose();
          onOpenTunnels();
        },
      },
      {
        id: "action:serial",
        section: "actions",
        title: t("sidebar.serial"),
        subtitle: "UART / RS232",
        onRun: () => {
          onClose();
          onOpenSerial();
        },
      },
      {
        id: "action:split-h",
        section: "actions",
        title: t("palette.actions.splitRight"),
        onRun: () => {
          onClose();
          onSplit("row");
        },
      },
      {
        id: "action:split-v",
        section: "actions",
        title: t("palette.actions.splitDown"),
        onRun: () => {
          onClose();
          onSplit("column");
        },
      },
      {
        id: "action:theme",
        section: "actions",
        title: t("palette.actions.toggleTheme"),
        onRun: () => {
          onClose();
          onToggleTheme();
        },
      },
      {
        id: "action:settings",
        section: "actions",
        title: t("settings.title"),
        onRun: () => {
          onClose();
          onOpenSettings();
        },
      },
    );

    const needle = query.trim().toLowerCase();
    if (!needle) return all.slice(0, 10);
    return all
      .filter(
        (item) =>
          item.title.toLowerCase().includes(needle) ||
          (item.subtitle?.toLowerCase().includes(needle) ?? false) ||
          (item.badge?.toLowerCase().includes(needle) ?? false),
      )
      .slice(0, 10);
  }, [
    onClose,
    onNewLocal,
    onOpenSaved,
    onOpenSerial,
    onOpenSettings,
    onOpenSftp,
    onOpenSsh,
    onOpenTunnels,
    onPasteSnippet,
    onSplit,
    onToggleTheme,
    query,
    saved,
    snippets,
    t,
  ]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const generate = async () => {
    if (query.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setSuggestion(await agentIpc.suggest({ prompt: query.trim() }));
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

  const totalRows = items.length + (query.trim().length > 0 ? 1 : 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-24 backdrop-blur-[2px]"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="ota-dialog-panel w-full max-w-xl overflow-hidden rounded-xl bg-[var(--bg-surface)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <svg
            viewBox="0 0 16 16"
            className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSuggestion("");
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && totalRows > 0) {
                event.preventDefault();
                setActiveIndex((idx) => (idx + 1) % totalRows);
                return;
              }
              if (event.key === "ArrowUp" && totalRows > 0) {
                event.preventDefault();
                setActiveIndex((idx) => (idx - 1 + totalRows) % totalRows);
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                if (activeIndex < items.length) {
                  items[activeIndex]?.onRun();
                } else {
                  void generate();
                }
              }
            }}
            placeholder={t("palette.unifiedPlaceholder")}
            className="h-7 w-full bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          {query.trim().length > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void generate()}
              className="ota-ctrl-primary shrink-0"
            >
              {busy ? t("palette.generating") : "AI"}
            </button>
          ) : null}
        </div>

        {/* Unified search results */}
        {!suggestion ? (
          <div className="max-h-72 overflow-y-auto border-t border-[var(--border-subtle)] p-1.5">
            {items.map((item, idx) => {
              const selected = idx === activeIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={item.onRun}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition"
                  style={{
                    backgroundColor: selected ? "var(--bg-hover)" : "transparent",
                  }}
                >
                  <span className="shrink-0 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                    {t(`palette.sections.${item.section}`)}
                  </span>
                  <span className="truncate font-medium text-[var(--text-primary)]">
                    {item.title}
                  </span>
                  {item.subtitle ? (
                    <span className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                      {item.subtitle}
                    </span>
                  ) : null}
                  {item.badge ? (
                    <span
                      className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
                      style={{
                        backgroundColor: item.badgeDanger
                          ? "rgba(239, 68, 68, 0.14)"
                          : "var(--bg-elevated)",
                        color: item.badgeDanger
                          ? "var(--status-danger)"
                          : "var(--text-secondary)",
                      }}
                    >
                      {item.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}

            {query.trim().length > 0 ? (
              <button
                type="button"
                onMouseEnter={() => setActiveIndex(items.length)}
                onClick={() => void generate()}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition"
                style={{
                  backgroundColor:
                    activeIndex === items.length ? "var(--accent-soft)" : "transparent",
                  color: "var(--accent)",
                }}
              >
                <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[10px] font-semibold">
                  AI
                </span>
                <span className="truncate font-medium">
                  {t("palette.askAiRow", { query: query.trim() })}
                </span>
              </button>
            ) : null}
          </div>
        ) : null}

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
          <span>↑↓ {t("palette.navHint")} · Enter · Esc</span>
          {backend === null ? (
            <span className="ml-auto" style={{ color: "var(--accent)" }}>
              {t("palette.noSession")}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
