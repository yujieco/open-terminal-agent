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
  onExportLog: (sessionId: string, label: string, lines?: string[]) => void;
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
  onExportLog,
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
      {/* Subtle metadata strip above the terminal viewport */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] font-medium text-[var(--text-muted)]">
            {activeSession ? t(`sidebar.kinds.${activeSession.kind}`) : "—"}
          </span>
          <span className="text-[var(--text-muted)] opacity-40">·</span>
          <span className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">
            {activeSession?.label ?? "terminal"}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <span
            className="mr-1.5 flex items-center gap-1.5 text-[11px] font-medium"
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
              onExportLog={onExportLog}
            />
          </div>
        ))}
      </div>

      {/* Bottom docked Quick Agent bar — clean Apple-style composer with uniform 28px controls */}
      <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-4 py-2.5">
        <div className="flex items-center gap-1.5 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1.5 pl-3 transition focus-within:border-[var(--border-strong)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
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
            className="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:opacity-50"
          />

          {quickTask.length === 0 && !agentRunning ? (
            <button
              type="button"
              onClick={() => {
                if (activePlaceholder.length > 0) setQuickTask(activePlaceholder);
              }}
              title={t("agent.tabAcceptHint")}
              className="ota-ctrl hidden font-sans sm:inline-flex"
            >
              <span className="inline-flex items-center justify-center gap-[3px]">
                <span className="text-[13px] leading-none">⇥</span>
                <span className="text-[11px] font-medium leading-none">Tab</span>
              </span>
            </button>
          ) : null}

          <button
            type="button"
            onClick={onOpenPalette}
            className="ota-ctrl hidden font-sans sm:inline-flex"
          >
            <span className="inline-flex items-center justify-center gap-[3px]">
              <span className="text-[13px] leading-none">⌘</span>
              <span className="text-[11px] font-medium leading-none">K</span>
            </span>
          </button>

          {agentRunning ? (
            <button type="button" onClick={onTakeOver} className="ota-ctrl-primary">
              {t("agent.takeOver")}
            </button>
          ) : (
            <button
              type="button"
              onClick={submitQuickTask}
              disabled={!activeId || quickTask.trim().length === 0}
              className={
                quickTask.trim().length > 0 && activeId ? "ota-ctrl-primary" : "ota-ctrl"
              }
            >
              {t("agent.run")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
