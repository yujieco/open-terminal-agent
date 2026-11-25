// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import {
  Activity,
  ArrowUp,
  Columns2,
  Highlighter,
  Keyboard,
  Layers,
  Radio,
  Rows2,
  Search,
  Shield,
  ShieldAlert,
  Sparkles,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ResolvedTheme } from "../hooks/useTheme";
import { ipc, isTauri, type EnvTag, type SessionProbeStatus } from "../lib/ipc";
import { sessionIds } from "../lib/panes";
import { formatShortcut } from "../lib/platform";
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
import { ServerMetricsBar } from "./ServerMetricsBar";

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
  onReconnect: (session: SessionView) => void;
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
  onReconnect,
}: TerminalWorkspaceProps) {
  const { t } = useTranslation();
  const [quickTask, setQuickTask] = useState("");
  const [probe, setProbe] = useState<SessionProbeStatus | null>(null);
  const [localEditMap, setLocalEditMap] = useState<Record<string, boolean>>({});
  const [metricsMap, setMetricsMap] = useState<Record<string, boolean>>({});
  const [broadcastMap, setBroadcastMap] = useState<Record<string, boolean>>({});
  const manualToggleRef = useRef<Record<string, boolean>>({});
  const [localCmd, setLocalCmd] = useState("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [highlightEnabled, setHighlightEnabled] = useState<boolean>(() => loadHighlightEnabled());
  const [highlightRules, setHighlightRules] = useState<HighlightRule[]>(() => loadHighlightRules());
  const [highlightMenuOpen, setHighlightMenuOpen] = useState(false);
  const [searchSignal, setSearchSignal] = useState(0);
  const [blocksSignal, setBlocksSignal] = useState(0);
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
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

  // #15 Cmd/Ctrl+Shift+L toggles local-buffered SSH editing on the active SSH session.
  useEffect(() => {
    if (!isSsh || !activeSessionId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        manualToggleRef.current[activeSessionId] = true;
        setLocalEditMap((previous) => ({
          ...previous,
          [activeSessionId]: !previous[activeSessionId],
        }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSessionId, isSsh]);

  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-[var(--bg-canvas)] px-6 text-center">
        <p className="text-sm text-[var(--text-muted)]">{emptyLabel}</p>
      </div>
    );
  }

  const activeTab =
    tabs.find((tab) => tab.activeSessionId === activeId) ?? tabs[0] ?? null;
  const activeTabPaneIds = activeTab ? sessionIds(activeTab.panes) : [];
  const canBroadcast = activeTabPaneIds.length > 1;
  const broadcastEnabled = Boolean(activeTab && canBroadcast && broadcastMap[activeTab.id]);
  const metricsEnabled = Boolean(isSsh && activeSessionId && metricsMap[activeSessionId]);
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
      {/* Ultra-clean 32px native workspace toolbar — zero pill clutter */}
      <div className="relative flex h-8 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 select-none">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
            {activeSession?.label ?? "terminal"}
          </span>

          {activeSession?.envTag ? (
            <button
              type="button"
              onClick={cycleEnvTag}
              title={t("prodGuard.toggleTooltip")}
              className="inline-flex h-4.5 shrink-0 items-center gap-1 rounded px-1.5 font-mono text-[10px] font-semibold leading-none transition hover:opacity-85"
              style={{
                backgroundColor:
                  activeSession.envTag === "prod"
                    ? "var(--status-danger-soft)"
                    : activeSession.envTag === "staging"
                      ? "var(--status-warn-soft)"
                      : "var(--accent-soft)",
                color:
                  activeSession.envTag === "prod"
                    ? "var(--status-danger)"
                    : activeSession.envTag === "staging"
                      ? "var(--status-warn)"
                      : "var(--accent)",
              }}
            >
              {activeSession.envTag === "prod" ? (
                <ShieldAlert className="h-2.5 w-2.5 shrink-0" strokeWidth={2} />
              ) : null}
              <span>
                {activeSession.envTag === "prod"
                  ? "PROD"
                  : activeSession.envTag === "staging"
                    ? "STG"
                    : "DEV"}
              </span>
            </button>
          ) : null}

          {isSsh ? (
            <button
              type="button"
              onClick={() => void runProbe()}
              title={t("sshProbe.probeTooltip")}
              className="ota-tabular inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[11px] leading-none text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
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
          ) : null}
        </div>

        {/* Quiet ghost icon action rail */}
        <div className="flex items-center gap-0.5">
          {activeSession && !activeSession.envTag ? (
            <button
              type="button"
              onClick={cycleEnvTag}
              title={t("prodGuard.toggleTooltip")}
              className="ota-icon-btn"
            >
              <Shield className="h-3.5 w-3.5" strokeWidth={1.65} />
            </button>
          ) : null}

          {isSsh ? (
            <>
              <button
                type="button"
                data-active={localEditEnabled}
                onClick={toggleLocalEdit}
                title={t("sshProbe.localEditHint")}
                className="ota-icon-btn"
              >
                <Keyboard className="h-3.5 w-3.5" strokeWidth={1.65} />
              </button>
              <button
                type="button"
                data-active={metricsEnabled}
                onClick={() => {
                  if (!activeSessionId) return;
                  setMetricsMap((prev) => ({
                    ...prev,
                    [activeSessionId]: !prev[activeSessionId],
                  }));
                }}
                title={t("metrics.toggleTooltip")}
                className="ota-icon-btn"
              >
                <Activity className="h-3.5 w-3.5" strokeWidth={1.65} />
              </button>
            </>
          ) : null}

          {canBroadcast && activeTab ? (
            <button
              type="button"
              onClick={() =>
                setBroadcastMap((prev) => ({
                  ...prev,
                  [activeTab.id]: !prev[activeTab.id],
                }))
              }
              title={t("broadcast.tooltip")}
              className="ota-icon-btn"
              style={
                broadcastEnabled
                  ? {
                      backgroundColor: "var(--status-warn-soft)",
                      color: "var(--status-warn)",
                    }
                  : undefined
              }
            >
              <Radio className="h-3.5 w-3.5" strokeWidth={1.7} />
            </button>
          ) : null}

          <button
            type="button"
            title={t("blocks.tooltip")}
            onClick={() => setBlocksSignal((n) => n + 1)}
            className="ota-icon-btn"
          >
            <Layers className="h-3.5 w-3.5" strokeWidth={1.65} />
          </button>

          <button
            type="button"
            data-active={highlightMenuOpen || highlightEnabled}
            title={t("highlight.tooltip")}
            onClick={() => setHighlightMenuOpen((open) => !open)}
            className="ota-icon-btn"
          >
            <Highlighter className="h-3.5 w-3.5" strokeWidth={1.65} />
          </button>

          <button
            type="button"
            title={t("terminal.search.tooltip", { shortcut: formatShortcut("F") })}
            onClick={() => setSearchSignal((n) => n + 1)}
            className="ota-icon-btn"
          >
            <Search className="h-3.5 w-3.5" strokeWidth={1.65} />
          </button>

          <div className="mx-1 h-3.5 w-px bg-[var(--border-subtle)]" />

          <button
            type="button"
            title={t("tabs.splitHorizontal", { shortcut: formatShortcut("D") })}
            onClick={() => onSplit("row")}
            className="ota-icon-btn"
          >
            <Columns2 className="h-3.5 w-3.5" strokeWidth={1.65} />
          </button>

          <button
            type="button"
            title={t("tabs.splitVertical", { shortcut: formatShortcut("D", true) })}
            onClick={() => onSplit("column")}
            className="ota-icon-btn"
          >
            <Rows2 className="h-3.5 w-3.5" strokeWidth={1.65} />
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

      {/* #5 Multiplexed SSH live server metrics strip */}
      {metricsEnabled && activeSessionId ? (
        <ServerMetricsBar sessionId={activeSessionId} alive={sshAlive} />
      ) : null}

      {/* #3 One-click SSH reconnect banner when a remote session disconnects */}
      {isSsh && activeSession && activeSession.exited && (activeSession.savedId || activeSession.reconnectSpec) ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-2 text-xs">
          <span className="text-[var(--text-secondary)]">
            {t("ssh.disconnectedBanner", { label: activeSession.label })}
          </span>
          <button
            type="button"
            onClick={() => onReconnect(activeSession)}
            className="ota-ctrl-primary shrink-0"
          >
            {t("ssh.reconnect")}
          </button>
        </div>
      ) : null}

      {/* Main multi-tab split pane terminal viewport */}
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
          const paneIds = sessionIds(tab.panes);
          const tabBroadcast = paneIds.length > 1 && Boolean(broadcastMap[tab.id]);
          return (
            <div
              key={tab.id}
              className={`absolute inset-0 ${tab === activeTab ? "block" : "hidden"}`}
            >
              <PaneTree
                node={tab.panes}
                sessions={sessions}
                activeId={activeId}
                broadcastEnabled={tabBroadcast}
                broadcastSessionIds={paneIds}
                theme={theme}
                terminalConfig={terminalConfig}
                highlightEnabled={highlightEnabled}
                highlightRules={highlightRules}
                searchSignal={searchSignal}
                blocksSignal={blocksSignal}
                exitedLabel={exitedLabel}
                onSelect={onSelect}
                onResize={onResize}
                onExit={onExit}
                onFavoriteCommand={onFavoriteCommand}
                onExportLog={onExportLog}
                onDiagnoseError={onDiagnoseError}
              />
            </div>
          );
        })}
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

      {/* #15 0ms local-buffered SSH command composer (multi-line + Ctrl+R history search) */}
      {localEditEnabled && activeSession ? (
        <div className="relative shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2">
          {historySearchOpen ? (
            <div className="mb-2 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-xl">
              <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-1.5">
                <span className="font-mono text-[10.5px] text-[var(--accent)]">Ctrl+R</span>
                <input
                  autoFocus
                  value={historyFilter}
                  onChange={(event) => setHistoryFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setHistorySearchOpen(false);
                    } else if (event.key === "Enter") {
                      const matches = cmdHistory
                        .filter((item) =>
                          item.toLowerCase().includes(historyFilter.trim().toLowerCase()),
                        )
                        .reverse();
                      if (matches[0]) {
                        setLocalCmd(matches[0]);
                      }
                      setHistorySearchOpen(false);
                    }
                  }}
                  placeholder={t("sshProbe.historySearchPlaceholder")}
                  className="h-6 flex-1 bg-transparent font-mono text-xs text-[var(--text-primary)] outline-none placeholder:font-sans placeholder:text-[var(--text-muted)]"
                />
                <button
                  type="button"
                  onClick={() => setHistorySearchOpen(false)}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  ×
                </button>
              </div>
              <div className="max-h-36 overflow-y-auto p-1">
                {cmdHistory
                  .filter((item) =>
                    item.toLowerCase().includes(historyFilter.trim().toLowerCase()),
                  )
                  .reverse()
                  .slice(0, 12)
                  .map((item, idx) => (
                    <button
                      key={`${idx}-${item}`}
                      type="button"
                      onClick={() => {
                        setLocalCmd(item);
                        setHistorySearchOpen(false);
                      }}
                      className="block w-full truncate rounded px-2.5 py-1 text-left font-mono text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      {item}
                    </button>
                  ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-end gap-1.5 rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-1.5 pl-3 transition focus-within:border-[var(--accent-border)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <span
              className="mb-1 shrink-0 select-none font-mono text-[12px] font-semibold"
              style={{ color: "var(--accent)" }}
            >
              $
            </span>
            <textarea
              rows={Math.min(5, Math.max(1, localCmd.split("\n").length))}
              value={localCmd}
              disabled={activeSession.exited}
              onChange={(event) => {
                setLocalCmd(event.target.value);
                setHistoryIdx(-1);
              }}
              onKeyDown={(event) => {
                if (event.ctrlKey && event.key.toLowerCase() === "r") {
                  event.preventDefault();
                  setHistoryFilter("");
                  setHistorySearchOpen((open) => !open);
                  return;
                }
                if (
                  event.key === "Enter" &&
                  ((!event.shiftKey && !localCmd.includes("\n")) ||
                    event.metaKey ||
                    event.ctrlKey)
                ) {
                  event.preventDefault();
                  sendLocalCommand();
                  return;
                }
                if (event.key === "ArrowUp" && !localCmd.includes("\n") && cmdHistory.length > 0) {
                  event.preventDefault();
                  const nextIdx =
                    historyIdx === -1 ? cmdHistory.length - 1 : Math.max(0, historyIdx - 1);
                  setHistoryIdx(nextIdx);
                  setLocalCmd(cmdHistory[nextIdx] ?? "");
                  return;
                }
                if (event.key === "ArrowDown" && !localCmd.includes("\n") && historyIdx !== -1) {
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
              className="min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 font-mono text-[12.5px] leading-snug text-[var(--text-primary)] outline-none placeholder:font-sans placeholder:text-[var(--text-muted)] disabled:opacity-50"
            />
            {cmdHistory.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setHistoryFilter("");
                  setHistorySearchOpen((open) => !open);
                }}
                title="Ctrl+R"
                className="ota-ctrl font-mono text-[10.5px]"
              >
                Hist
              </button>
            ) : null}
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

      {/* Calm, minimal bottom AI prompt bar (Raycast / Cursor composer aesthetic) */}
      <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2">
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] py-1 pr-1.5 pl-2.5 transition focus-within:border-[var(--accent-border)] focus-within:shadow-[0_0_0_2.5px_var(--accent-soft)]">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.65} />
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
            className="h-6 min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:opacity-50"
          />

          {quickTask.length === 0 && !agentRunning ? (
            <button
              type="button"
              onClick={onOpenPalette}
              title={formatShortcut("K")}
              className="hidden rounded px-1.5 py-0.5 font-sans text-[10.5px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] sm:inline-flex"
            >
              {formatShortcut("K")}
            </button>
          ) : null}

          {agentRunning ? (
            <button
              type="button"
              onClick={onTakeOver}
              className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-white transition hover:opacity-90"
              style={{ backgroundColor: "var(--status-danger)" }}
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              <span>{t("agent.takeOver")}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={submitQuickTask}
              disabled={!activeId || quickTask.trim().length === 0}
              aria-label={t("agent.run")}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition disabled:opacity-30"
              style={{
                backgroundColor:
                  quickTask.trim().length > 0 && activeId
                    ? "var(--accent)"
                    : "var(--bg-elevated)",
                color:
                  quickTask.trim().length > 0 && activeId
                    ? "var(--accent-fg)"
                    : "var(--text-muted)",
              }}
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
