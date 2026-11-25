// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ResolvedTheme } from "../hooks/useTheme";
import { ipc, isTauri, type EnvTag, type SessionProbeStatus } from "../lib/ipc";
import { formatShortcut, isMac } from "../lib/platform";
import { matchDangerousCommand, type DangerousCommandMatch } from "../lib/prodGuard";
import {
  loadHighlightEnabled,
  loadHighlightRules,
  saveHighlightEnabled,
  saveHighlightRules,
  type HighlightRule,
} from "../lib/terminalHighlighter";
import type { TerminalAppearanceConfig } from "../lib/terminalThemes";
import type { SessionView, TabView } from "../types";
import { HighlightRulesPopover } from "./HighlightRulesPopover";
import { PaneTree } from "./PaneTree";
import { ProdGuardDialog } from "./ProdGuardDialog";

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
  onDiagnoseError: (sessionId: string, prompt: string) => void;
  onSetEnvTag: (sessionId: string, envTag?: EnvTag) => void;
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
  onDiagnoseError,
  onSetEnvTag,
}: TerminalWorkspaceProps) {
  const { t } = useTranslation();
  const [quickTask, setQuickTask] = useState("");
  const [probe, setProbe] = useState<SessionProbeStatus | null>(null);
  const [localEditMap, setLocalEditMap] = useState<Record<string, boolean>>({});
  const manualToggleRef = useRef<Record<string, boolean>>({});
  const [localCmd, setLocalCmd] = useState("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [highlightEnabled, setHighlightEnabled] = useState<boolean>(() => loadHighlightEnabled());
  const [highlightRules, setHighlightRules] = useState<HighlightRule[]>(() => loadHighlightRules());
  const [highlightMenuOpen, setHighlightMenuOpen] = useState(false);
  const [searchSignal, setSearchSignal] = useState(0);
  const [localGuardPending, setLocalGuardPending] = useState<{
    match: DangerousCommandMatch;
    raw: string;
  } | null>(null);

  const activeSession = sessions.find((session) => session.id === activeId) ?? null;
  const isSsh = activeSession?.kind === "ssh";
  const sshAlive = Boolean(isSsh && activeSession && !activeSession.exited);
  const activeSessionId = activeSession?.id ?? null;

  const runProbe = useCallback(async () => {
    if (!sshAlive || !activeSessionId || !isTauri()) return;
    try {
      const result = await ipc.probeSessionLatency(activeSessionId);
      setProbe(result);
      // Auto-enable local line editing on high-latency links (>160ms) unless user chose otherwise.
      if (
        result.rttMs !== null &&
        result.rttMs >= 160 &&
        !manualToggleRef.current[activeSessionId]
      ) {
        setLocalEditMap((previous) =>
          previous[activeSessionId] ? previous : { ...previous, [activeSessionId]: true },
        );
      }
    } catch {
      setProbe({ rttMs: null, quality: "offline" });
    }
  }, [activeSessionId, sshAlive]);

  useEffect(() => {
    setProbe(null);
    if (!sshAlive || !activeSessionId || !isTauri()) return;
    void runProbe();
    const timer = window.setInterval(() => {
      void runProbe();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeSessionId, runProbe, sshAlive]);

  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-[var(--bg-canvas)] px-6 text-center">
        <p className="text-sm text-[var(--text-muted)]">{emptyLabel}</p>
      </div>
    );
  }

  const activeTab =
    tabs.find((tab) => tab.activeSessionId === activeId) ?? tabs[0] ?? null;
  const activePlaceholder = suggestedPrompt ?? t("agent.quickPromptPlaceholder");
  const localEditEnabled = Boolean(isSsh && activeSessionId && localEditMap[activeSessionId]);

  const toggleLocalEdit = () => {
    if (!activeSessionId) return;
    manualToggleRef.current[activeSessionId] = true;
    setLocalEditMap((previous) => ({
      ...previous,
      [activeSessionId]: !previous[activeSessionId],
    }));
  };

  const commitLocalCommand = (raw: string) => {
    if (!activeSession || activeSession.exited) return;
    activeSession.backend.write(`${raw}\r`);
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      setCmdHistory((previous) => {
        if (previous[previous.length - 1] === trimmed) return previous;
        const next = [...previous, trimmed];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
    }
    setLocalCmd("");
    setHistoryIdx(-1);
  };

  const sendLocalCommand = () => {
    if (!activeSession || activeSession.exited) return;
    const raw = localCmd;
    if (activeSession.envTag === "prod") {
      const hit = matchDangerousCommand(raw);
      if (hit) {
        setLocalGuardPending({ match: hit, raw });
        return;
      }
    }
    commitLocalCommand(raw);
  };

  const cycleEnvTag = () => {
    if (!activeSession) return;
    const order: (EnvTag | undefined)[] = [undefined, "dev", "staging", "prod"];
    const idx = order.indexOf(activeSession.envTag);
    const next = order[(idx + 1) % order.length];
    onSetEnvTag(activeSession.id, next);
  };

  const submitQuickTask = () => {
    const trimmed = quickTask.trim();
    if (!trimmed || !activeId) return;
    onQuickRun(trimmed);
    setQuickTask("");
  };

  const probeDotColor =
    probe?.quality === "good"
      ? "var(--status-ok)"
      : probe?.quality === "fair"
        ? "var(--status-warn)"
        : probe?.quality === "poor" || probe?.quality === "offline"
          ? "var(--status-danger)"
          : "var(--text-muted)";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-canvas)]">
      {/* Subtle metadata strip above the terminal viewport */}
      <div className="relative flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] font-medium text-[var(--text-muted)]">
            {activeSession ? t(`sidebar.kinds.${activeSession.kind}`) : "—"}
          </span>
          <span className="text-[var(--text-muted)] opacity-40">·</span>
          <span className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">
            {activeSession?.label ?? "terminal"}
          </span>

          {activeSession ? (
            <button
              type="button"
              onClick={cycleEnvTag}
              title={t("prodGuard.toggleTooltip")}
              className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[10.5px] font-semibold leading-none transition hover:opacity-90"
              style={{
                borderColor:
                  activeSession.envTag === "prod"
                    ? "var(--status-danger)"
                    : activeSession.envTag === "staging"
                      ? "var(--status-warn)"
                      : "var(--border-subtle)",
                backgroundColor:
                  activeSession.envTag === "prod"
                    ? "rgba(239, 68, 68, 0.14)"
                    : activeSession.envTag === "staging"
                      ? "rgba(245, 158, 11, 0.14)"
                      : "var(--bg-surface)",
                color:
                  activeSession.envTag === "prod"
                    ? "var(--status-danger)"
                    : activeSession.envTag === "staging"
                      ? "var(--status-warn)"
                      : "var(--text-muted)",
              }}
            >
              {activeSession.envTag === "prod"
                ? t("prodGuard.badgeProd")
                : activeSession.envTag === "staging"
                  ? t("prodGuard.envStaging")
                  : activeSession.envTag === "dev"
                    ? t("prodGuard.envDev")
                    : t("prodGuard.guardOff")}
            </button>
          ) : null}

          {isSsh ? (
            <>
              <button
                type="button"
                onClick={() => void runProbe()}
                title={t("sshProbe.probeTooltip")}
                className="ota-tabular inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] leading-none text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: probeDotColor }}
                />
                <span>
                  {probe?.rttMs !== null && probe?.rttMs !== undefined
                    ? `${probe.rttMs} ms`
                    : probe?.quality === "offline"
                      ? t("sshProbe.offline")
                      : "…"}
                </span>
              </button>

              <button
                type="button"
                onClick={toggleLocalEdit}
                title={t("sshProbe.localEditHint")}
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium leading-none transition active:scale-[0.97]"
                style={{
                  borderColor: localEditEnabled ? "var(--accent-border)" : "var(--border-subtle)",
                  backgroundColor: localEditEnabled ? "var(--accent-soft)" : "var(--bg-surface)",
                  color: localEditEnabled ? "var(--accent)" : "var(--text-secondary)",
                }}
              >
                <span>{t("sshProbe.localEdit")}</span>
              </button>
            </>
          ) : null}
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
            title={t("terminal.search.tooltip", { shortcut: formatShortcut("F") })}
            onClick={() => setSearchSignal((n) => n + 1)}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-[var(--text-muted)] transition hover:border-[var(--border-subtle)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="7" cy="7" r="4.2" />
              <path d="M10.5 10.5L14 14" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            title={t("highlight.tooltip")}
            onClick={() => setHighlightMenuOpen((open) => !open)}
            className="inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10.5px] font-medium transition"
            style={{
              borderColor:
                highlightMenuOpen || highlightEnabled
                  ? "var(--border-subtle)"
                  : "transparent",
              backgroundColor: highlightMenuOpen ? "var(--bg-surface)" : "transparent",
              color: highlightEnabled ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: highlightEnabled ? "var(--accent)" : "var(--text-muted)",
              }}
            />
            <span>{t("highlight.shortLabel")}</span>
          </button>

          <button
            type="button"
            title={t("tabs.splitHorizontal", { shortcut: formatShortcut("D") })}
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
            title={t("tabs.splitVertical", { shortcut: formatShortcut("D", true) })}
            onClick={() => onSplit("column")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-[var(--text-muted)] transition hover:border-[var(--border-subtle)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
              <path d="M2 8H14" />
            </svg>
          </button>
        </div>

        {highlightMenuOpen ? (
          <HighlightRulesPopover
            enabled={highlightEnabled}
            rules={highlightRules}
            onToggleEnabled={() => {
              setHighlightEnabled((prev) => {
                const next = !prev;
                saveHighlightEnabled(next);
                return next;
              });
            }}
            onChangeRules={(next) => {
              setHighlightRules(next);
              saveHighlightRules(next);
            }}
            onClose={() => setHighlightMenuOpen(false)}
          />
        ) : null}
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
              highlightEnabled={highlightEnabled}
              highlightRules={highlightRules}
              searchSignal={searchSignal}
              exitedLabel={exitedLabel}
              onSelect={onSelect}
              onResize={onResize}
              onExit={onExit}
              onFavoriteCommand={onFavoriteCommand}
              onExportLog={onExportLog}
              onDiagnoseError={onDiagnoseError}
            />
          </div>
        ))}
      </div>

      {localGuardPending && activeSession ? (
        <ProdGuardDialog
          sessionLabel={activeSession.label}
          match={localGuardPending.match}
          onCancel={(clearLine) => {
            setLocalGuardPending(null);
            if (clearLine) setLocalCmd("");
          }}
          onProceed={() => {
            const raw = localGuardPending.raw;
            setLocalGuardPending(null);
            commitLocalCommand(raw);
          }}
        />
      ) : null}

      {/* 0ms local-buffered SSH command composer (eliminates high-latency typing lag) */}
      {localEditEnabled && activeSession ? (
        <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2">
          <div className="flex items-center gap-1.5 rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-1.5 pl-3 transition focus-within:border-[var(--accent-border)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <span
              className="shrink-0 select-none font-mono text-[12px] font-semibold"
              style={{ color: "var(--accent)" }}
            >
              $
            </span>
            <input
              type="text"
              value={localCmd}
              disabled={activeSession.exited}
              onChange={(event) => {
                setLocalCmd(event.target.value);
                setHistoryIdx(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendLocalCommand();
                  return;
                }
                if (event.key === "ArrowUp" && cmdHistory.length > 0) {
                  event.preventDefault();
                  const nextIdx =
                    historyIdx === -1 ? cmdHistory.length - 1 : Math.max(0, historyIdx - 1);
                  setHistoryIdx(nextIdx);
                  setLocalCmd(cmdHistory[nextIdx] ?? "");
                  return;
                }
                if (event.key === "ArrowDown" && historyIdx !== -1) {
                  event.preventDefault();
                  if (historyIdx + 1 >= cmdHistory.length) {
                    setHistoryIdx(-1);
                    setLocalCmd("");
                  } else {
                    const nextIdx = historyIdx + 1;
                    setHistoryIdx(nextIdx);
                    setLocalCmd(cmdHistory[nextIdx] ?? "");
                  }
                }
              }}
              placeholder={t("sshProbe.localInputPlaceholder")}
              className="h-7 min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-[var(--text-primary)] outline-none placeholder:font-sans placeholder:text-[var(--text-muted)] disabled:opacity-50"
            />
            <button
              type="button"
              disabled={activeSession.exited}
              onClick={() => activeSession.backend.write("\x03")}
              title={t("sshProbe.interrupt")}
              className="ota-ctrl font-mono text-[11px]"
            >
              Ctrl+C
            </button>
            <button
              type="button"
              disabled={activeSession.exited}
              onClick={sendLocalCommand}
              className={localCmd.trim().length > 0 ? "ota-ctrl-primary" : "ota-ctrl"}
            >
              {t("sshProbe.sendCommand")}
            </button>
          </div>
        </div>
      ) : null}

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
              <span className="inline-flex items-center justify-center gap-1">
                <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 8h8M7.8 5l3 3-3 3M13 4.2v7.6" />
                </svg>
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
              {isMac ? (
                <>
                  <span className="text-[13px] leading-none">⌘</span>
                  <span className="text-[11px] font-medium leading-none">K</span>
                </>
              ) : (
                <span className="text-[11px] font-medium leading-none">Ctrl+K</span>
              )}
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
