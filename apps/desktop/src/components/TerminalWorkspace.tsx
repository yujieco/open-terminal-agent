// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ResolvedTheme } from "../hooks/useTheme";
import type { TerminalAppearanceConfig } from "../lib/terminalThemes";
import type { SessionView, TabView } from "../types";
import { PaneTree } from "./PaneTree";

interface TerminalWorkspaceProps {
  sessions: SessionView[];
  tabs: TabView[];
  activeId: string | null;
  theme: ResolvedTheme;
  terminalConfig: TerminalAppearanceConfig;
  suggestedPrompt: string | null;
  agentRunning: boolean;
  exitedLabel: string;
  emptyLabel: string;
  onSelect: (sessionId: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onExit: (sessionId: string) => void;
  onSplit: (direction: "row" | "column") => void;
  onQuickRun: (task: string) => void;
  onTakeOver: () => void;
  onOpenPalette: () => void;
  onFavoriteCommand: (command: string) => void;
}

export function TerminalWorkspace({
  sessions,
  tabs,
  activeId,
  theme,
  terminalConfig,
  suggestedPrompt,
  agentRunning,
  exitedLabel,
  emptyLabel,
  onSelect,
  onResize,
  onExit,
  onSplit,
  onQuickRun,
  onTakeOver,
  onOpenPalette,
  onFavoriteCommand,
}: TerminalWorkspaceProps) {
  const { t } = useTranslation();
  const [quickTask, setQuickTask] = useState("");

  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-[var(--bg-canvas)] px-6 text-center">
        <p className="text-sm text-[var(--text-muted)]">{emptyLabel}</p>
      </div>
    );
  }

  const activeTab =
    tabs.find((tab) => tab.activeSessionId === activeId) ?? tabs[0] ?? null;
  const activeSession = sessions.find((session) => session.id === activeId) ?? null;
  const activePlaceholder = suggestedPrompt ?? t("agent.quickPromptPlaceholder");

  const submitQuickTask = () => {
    const trimmed = quickTask.trim();
    if (!trimmed || !activeId) return;
    onQuickRun(trimmed);
    setQuickTask("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-canvas)]">
      {/* Subtle editorial metadata strip above the terminal viewport */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4">
        <div className="flex min-w-0 items-center gap-2 font-mono text-[10.5px] tracking-[0.08em] text-[var(--text-muted)] uppercase">
          <span>{activeSession ? t(`sidebar.kinds.${activeSession.kind}`) : "—"}</span>
          <span className="opacity-40">·</span>
          <span className="truncate normal-case tracking-normal text-[var(--text-secondary)]">
            {activeSession?.label ?? "terminal"}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <span
            className="mr-1.5 flex items-center gap-1.5 font-mono text-[10.5px]"
            style={{
              color: agentRunning ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: agentRunning ? "var(--accent)" : "var(--status-ok)",
              }}
            />
            {agentRunning ? t("status.agentControl") : t("status.humanControl")}
          </span>

          <button
            type="button"
            title={t("tabs.splitHorizontal")}
            onClick={() => onSplit("row")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-[var(--text-muted)] transition hover:border-[var(--border-subtle)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
              <path d="M8 2.5V13.5" />
            </svg>
          </button>

          <button
            type="button"
            title={t("tabs.splitVertical")}
            onClick={() => onSplit("column")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-[var(--text-muted)] transition hover:border-[var(--border-subtle)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
              <path d="M2 8H14" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main multi-tab split pane terminal viewport */}
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 ${tab === activeTab ? "block" : "hidden"}`}
          >
            <PaneTree
              node={tab.panes}
              sessions={sessions}
              activeId={activeId}
              theme={theme}
              terminalConfig={terminalConfig}
              exitedLabel={exitedLabel}
              onSelect={onSelect}
              onResize={onResize}
              onExit={onExit}
              onFavoriteCommand={onFavoriteCommand}
            />
          </div>
        ))}
      </div>

      {/* Bottom docked Quick Agent bar with Tab-to-accept ghost placeholder */}
      <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-4 py-2.5">
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 transition focus-within:border-[var(--border-strong)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
          <span
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center select-none text-xs"
            style={{ color: "var(--accent)" }}
          >
            ✦
          </span>
          <input
            type="text"
            value={quickTask}
            disabled={agentRunning || !activeId}
            onChange={(event) => setQuickTask(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Tab" && quickTask.length === 0 && activePlaceholder.length > 0) {
                event.preventDefault();
                setQuickTask(activePlaceholder);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitQuickTask();
              }
            }}
            placeholder={activePlaceholder}
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:opacity-50"
          />

          {quickTask.length === 0 && !agentRunning ? (
            <kbd
              title={t("agent.tabAcceptHint")}
              className="hidden rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-0.5 font-mono text-[9.5px] text-[var(--text-muted)] sm:inline-flex"
            >
              Tab ⇥
            </kbd>
          ) : null}

          <button
            type="button"
            onClick={onOpenPalette}
            className="hidden rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] sm:inline-flex"
          >
            ⌘K
          </button>

          {agentRunning ? (
            <button
              type="button"
              onClick={onTakeOver}
              className="ota-btn-primary rounded-md px-2.5 py-1 text-[11px]"
            >
              {t("agent.takeOver")}
            </button>
          ) : (
            <button
              type="button"
              onClick={submitQuickTask}
              disabled={!activeId || quickTask.trim().length === 0}
              className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] transition hover:border-[var(--accent-border)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("agent.run")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
