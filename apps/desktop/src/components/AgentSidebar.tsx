// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  agentIpc,
  onAgentApproval,
  onAgentEvent,
  onAgentInterrupted,
  type AgentEvent,
  type ApprovalPayload,
  type LlmStatus,
} from "../lib/agent";
import { formatLlmError, type FriendlyError } from "../lib/friendlyError";
import type { AgentRunSummary } from "../lib/ipc";
import { isTauri } from "../lib/ipc";
import type { PermissionMode } from "../types";

type LoopPhase = "observe" | "reason" | "act" | "verify";
const PHASES: LoopPhase[] = ["observe", "reason", "act", "verify"];

interface ToolCard {
  callId: string;
  command: string;
  risk: string | null;
  status: "pending" | "running" | "done" | "denied";
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ExternalTaskTrigger {
  id: number;
  text: string;
}

interface AgentSidebarProps {
  sessionId: string | null;
  mode: PermissionMode;
  suggestedPrompt: string | null;
  externalTask: ExternalTaskTrigger | null;
  onNextSuggestion: (sessionId: string, suggestion: string | null) => void;
  onOpenSettings: () => void;
  /** Tells the shell whether an agent owns this session, for Esc take-over. */
  onRunningChange: (sessionId: string, running: boolean) => void;
}

export function AgentSidebar({
  sessionId,
  mode,
  suggestedPrompt,
  externalTask,
  onNextSuggestion,
  onOpenSettings,
  onRunningChange,
}: AgentSidebarProps) {
  const { t, i18n } = useTranslation();
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<LoopPhase | null>(null);
  const [answer, setAnswer] = useState("");
  const [thinking, setThinking] = useState("");
  const [showThinking, setShowThinking] = useState(true);
  const [cards, setCards] = useState<ToolCard[]>([]);
  const [approval, setApproval] = useState<ApprovalPayload | null>(null);
  const [failure, setFailure] = useState<FriendlyError | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [stepApproval, setStepApproval] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");

  const sessionRef = useRef<string | null>(sessionId);
  const lastExternalIdRef = useRef<number>(0);
  const lastTaskRef = useRef<string>("");
  const timelineEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  // Always keep the newest card, reasoning update, answer, or approval prompt in view.
  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [cards, approval, answer, thinking, failure, running]);

  const refreshStatus = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setLlm(await agentIpc.status());
    } catch (cause) {
      console.warn("[ota] could not read llm status", cause);
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setRuns(await agentIpc.runs(undefined, 8));
    } catch (cause) {
      console.warn("[ota] could not list recent runs", cause);
    }
  }, []);

  const fetchNextSuggestion = useCallback(
    async (targetSessionId: string, previousTask: string) => {
      if (!isTauri()) return;
      try {
        const next = await agentIpc.suggestNextTask({
          sessionId: targetSessionId,
          lastTask: previousTask,
          language: i18n.language,
        });
        if (next && next.trim().length > 0) {
          onNextSuggestion(targetSessionId, next.trim());
        }
      } catch {
        // Suggestion is best-effort; never interrupt the user on failure.
      }
    },
    [i18n.language, onNextSuggestion],
  );

  useEffect(() => {
    void refreshStatus();
    void refreshRuns();
  }, [refreshStatus, refreshRuns]);

  // A new session starts with a clean timeline: mixing two terminals would
  // misrepresent what actually ran where.
  useEffect(() => {
    setAnswer("");
    setThinking("");
    setCards([]);
    setApproval(null);
    setFailure(null);
    setSummary(null);
    setPhase(null);
    setRunning(false);
    setReplaying(null);
  }, [sessionId]);

  const apply = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "runStarted":
          setRunning(true);
          setSummary(null);
          setFailure(null);
          lastTaskRef.current = event.task;
          break;
        case "phaseChanged":
          setPhase(event.phase);
          break;
        case "thinking":
          setThinking((previous) => previous + event.delta);
          break;
        case "message":
          setAnswer((previous) => previous + event.delta);
          break;
        case "toolRequested":
          setCards((previous) => [
            ...previous,
            {
              callId: event.call_id,
              command: event.command ?? event.tool,
              risk: event.risk,
              status: "running",
              exitCode: null,
              output: "",
              durationMs: 0,
              timedOut: false,
            },
          ]);
          break;
        case "toolFinished":
          setCards((previous) =>
            previous.map((card) =>
              card.callId === event.call_id
                ? {
                    ...card,
                    status: "done",
                    exitCode: event.exit_code,
                    output: event.output,
                    durationMs: event.duration_ms,
                    timedOut: event.timed_out,
                  }
                : card,
            ),
          );
          break;
        case "toolDenied":
          setCards((previous) =>
            previous.map((card) =>
              card.callId === event.call_id ? { ...card, status: "denied" } : card,
            ),
          );
          setApproval((current) => (current?.callId === event.call_id ? null : current));
          break;
        case "runFinished": {
          setRunning(false);
          setApproval(null);
          setPhase(null);
          setSummary(`${event.reason} · ${event.steps}`);
          const finishedSession = sessionRef.current;
          if (finishedSession) {
            onRunningChange(finishedSession, false);
            void fetchNextSuggestion(finishedSession, lastTaskRef.current);
          }
          void refreshRuns();
          break;
        }
        case "failed":
          setRunning(false);
          setPhase(null);
          setFailure(formatLlmError(event.message, t));
          if (sessionRef.current) onRunningChange(sessionRef.current, false);
          void refreshRuns();
          break;
        default:
          break;
      }
    },
    [fetchNextSuggestion, onRunningChange, refreshRuns, t],
  );

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const stops: Array<() => void> = [];

    void onAgentEvent((payload) => {
      if (disposed || payload.sessionId !== sessionRef.current) return;
      apply(payload.event);
    }).then((stop) => (disposed ? stop() : stops.push(stop)));

    void onAgentApproval((payload) => {
      if (disposed || payload.sessionId !== sessionRef.current) return;
      setApproval(payload);
    }).then((stop) => (disposed ? stop() : stops.push(stop)));

    void onAgentInterrupted((payload) => {
      if (disposed || payload.sessionId !== sessionRef.current) return;
      setRunning(false);
      setPhase(null);
      setApproval(null);
      setFailure({ message: t("agent.interrupted"), openSettings: false });
      onRunningChange(payload.sessionId, false);
      void refreshRuns();
    }).then((stop) => (disposed ? stop() : stops.push(stop)));

    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [apply, onRunningChange, refreshRuns, t]);

  const startTask = useCallback(
    async (promptText: string) => {
      const trimmed = promptText.trim();
      if (!sessionId || trimmed.length === 0) return;
      lastTaskRef.current = trimmed;
      setAnswer("");
      setThinking("");
      setCards([]);
      setSummary(null);
      setFailure(null);
      setRunning(true);
      setPhase("observe");
      setReplaying(null);
      onRunningChange(sessionId, true);
      try {
        await agentIpc.run({ sessionId, task: trimmed, mode, stepApproval });
      } catch (cause) {
        setRunning(false);
        setPhase(null);
        onRunningChange(sessionId, false);
        setFailure(formatLlmError(cause, t));
      }
    },
    [mode, onRunningChange, sessionId, stepApproval, t],
  );

  // Triggered when the user submits from the center quick-prompt bar.
  useEffect(() => {
    if (!externalTask || externalTask.id === lastExternalIdRef.current) return;
    lastExternalIdRef.current = externalTask.id;
    void startTask(externalTask.text);
  }, [externalTask, startTask]);

  const replay = useCallback(
    async (id: string) => {
      try {
        const record = await agentIpc.runDetail(id);
        if (!record) return;
        setAnswer("");
        setThinking("");
        setCards([]);
        setApproval(null);
        setFailure(null);
        setSummary(`${record.status} · ${record.commands}`);
        setRunning(false);
        setPhase(null);
        setReplaying(record.task);
        for (const raw of record.events) {
          apply(raw as AgentEvent);
        }
      } catch (cause) {
        setFailure(formatLlmError(cause, t));
      }
    },
    [apply, t],
  );

  const decide = useCallback(
    async (approved: boolean) => {
      if (!approval) return;
      try {
        await agentIpc.approve(approval.callId, approved);
      } catch (cause) {
        setFailure(formatLlmError(cause, t));
      } finally {
        setApproval(null);
      }
    },
    [approval, t],
  );

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    try {
      await agentIpc.cancel(sessionId);
    } catch (cause) {
      setFailure(formatLlmError(cause, t));
    }
  }, [sessionId, t]);

  const activePlaceholder = suggestedPrompt ?? t("agent.placeholder");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <header className="border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[10px] font-semibold tracking-[0.12em] text-[var(--text-muted)] uppercase">
            {t("agent.timeline")}
          </h2>
          <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
            {t("agent.stepsCount", { count: cards.length })}
          </span>
        </div>

        {/* Observe -> Reason -> Act -> Verify live phase strip */}
        <div className="mt-2.5 flex items-center gap-1">
          {PHASES.map((item) => {
            const active = phase === item;
            return (
              <span
                key={item}
                className="flex-1 rounded px-1.5 py-0.5 text-center font-mono text-[9.5px] uppercase transition"
                style={{
                  backgroundColor: active ? "var(--accent-soft)" : "var(--bg-surface)",
                  color: active ? "var(--accent)" : "var(--text-muted)",
                  border: `1px solid ${active ? "var(--accent-border)" : "var(--border-subtle)"}`,
                }}
              >
                {t(`agent.phases.${item}`)}
              </span>
            );
          })}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 text-[10.5px]">
          <span className="truncate font-mono text-[var(--text-muted)]">
            {llm ? `${llm.provider}/${llm.model}` : t("agent.noProvider")}
          </span>
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={stepApproval}
              onChange={(event) => setStepApproval(event.target.checked)}
              className="h-3 w-3 accent-[var(--accent)]"
            />
            <span className="text-[10px]">{t("agent.modes.ask")}</span>
          </label>
        </div>
      </header>

      {/* Missing API key friendly notice */}
      {llm && !llm.configured ? (
        <section
          className="border-b border-[var(--border-subtle)] px-4 py-2.5"
          style={{ backgroundColor: "var(--accent-soft)" }}
        >
          <p className="text-[11px] leading-snug text-[var(--text-primary)]">
            {t("agent.keyHint")}
          </p>
          <div className="mt-2 flex gap-1.5">
            <input
              type="password"
              value={keyDraft}
              placeholder="sk-..."
              onChange={(event) => setKeyDraft(event.target.value)}
              className="ota-input flex-1 font-mono"
            />
            <button
              type="button"
              onClick={() => {
                void agentIpc.saveKey(keyDraft).then(() => {
                  setKeyDraft("");
                  setFailure(null);
                  void refreshStatus();
                });
              }}
              className="ota-btn-primary rounded-md px-2.5 py-1 text-[11px]"
            >
              {t("agent.saveKey")}
            </button>
          </div>
        </section>
      ) : null}

      {/* Scrollable numbered step cards + approval + log (auto-scrolls to newest) */}
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3.5 py-3">
        {replaying ? (
          <div className="flex items-center gap-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)]">
            <span className="truncate">
              {t("agent.replay")}: {replaying}
            </span>
            <button
              type="button"
              onClick={() => {
                setReplaying(null);
                setCards([]);
                setAnswer("");
                setThinking("");
                setSummary(null);
              }}
              className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              ×
            </button>
          </div>
        ) : null}

        {thinking.length > 0 ? (
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <button
              type="button"
              onClick={() => setShowThinking((open) => !open)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[10.5px] text-[var(--text-secondary)]"
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: running ? "var(--accent)" : "var(--status-ok)" }}
              />
              <span className="uppercase tracking-wider">{t("agent.thinking")}</span>
              <span className="ml-auto text-[10px] text-[var(--text-muted)]">
                {showThinking ? "▾" : "▸"}
              </span>
            </button>
            {showThinking ? (
              <pre className="max-h-32 overflow-y-auto border-t border-[var(--border-subtle)] px-3 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-[var(--text-muted)]">
                {thinking}
              </pre>
            ) : null}
          </div>
        ) : null}

        {cards.length === 0 && answer.length === 0 && !running && !approval && !failure ? (
          <div className="rounded-lg border border-dashed border-[var(--border-subtle)] px-3.5 py-4 text-xs leading-relaxed text-[var(--text-muted)]">
            {t("agent.empty")}
          </div>
        ) : null}

        {/* Numbered step cards (01, 02, 03…) */}
        {cards.map((card, index) => {
          const isRunningCard = card.status === "running";
          const isDenied = card.status === "denied";
          const isOk = card.status === "done" && card.exitCode === 0;
          const badgeNum = String(index + 1).padStart(2, "0");

          return (
            <article
              key={card.callId}
              className="overflow-hidden rounded-lg border bg-[var(--bg-surface)] transition"
              style={{
                borderColor: isRunningCard
                  ? "var(--accent-border)"
                  : isDenied
                    ? "var(--status-danger)"
                    : "var(--border-subtle)",
              }}
            >
              <header className="flex items-center gap-2 px-3 py-2">
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
                  style={{
                    backgroundColor: isRunningCard ? "var(--accent)" : "var(--bg-elevated)",
                    color: isRunningCard ? "var(--accent-fg)" : "var(--text-secondary)",
                  }}
                >
                  {badgeNum}
                </span>

                {card.risk ? (
                  <span
                    className="rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase"
                    style={{
                      backgroundColor:
                        card.risk === "readonly"
                          ? "var(--status-ok-soft)"
                          : card.risk === "mutating"
                            ? "var(--accent-soft)"
                            : "var(--status-danger-soft)",
                      color:
                        card.risk === "readonly"
                          ? "var(--status-ok)"
                          : card.risk === "mutating"
                            ? "var(--accent)"
                            : "var(--status-danger)",
                    }}
                  >
                    {t(`agent.risk.${card.risk}`)}
                  </span>
                ) : null}

                <span
                  className="ml-auto font-mono text-[10px]"
                  style={{
                    color: isRunningCard
                      ? "var(--accent)"
                      : isOk
                        ? "var(--status-ok)"
                        : isDenied
                          ? "var(--status-danger)"
                          : "var(--text-muted)",
                  }}
                >
                  {isRunningCard
                    ? t("agent.running")
                    : isDenied
                      ? t("agent.rejected")
                      : `exit ${card.exitCode ?? "-"} · ${card.durationMs}ms`}
                </span>
              </header>

              <pre className="border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all text-[var(--text-primary)]">
                $ {card.command}
              </pre>

              {card.output.length > 0 ? (
                <pre className="max-h-36 overflow-y-auto border-t border-[var(--border-subtle)] px-3 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]">
                  {card.output}
                </pre>
              ) : null}
            </article>
          );
        })}

        {/* Highlighted inline approval card */}
        {approval ? (
          <div
            className="rounded-lg border p-3"
            style={{
              borderColor: "var(--accent-border)",
              backgroundColor: "var(--accent-soft)",
            }}
          >
            <div className="flex items-center gap-2">
              <span
                className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-fg)",
                }}
              >
                !
              </span>
              <span className="text-xs font-medium text-[var(--text-primary)]">
                {t("agent.approvalNeeded")}
              </span>
            </div>

            <pre className="mt-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap break-all text-[var(--text-primary)]">
              {approval.command}
            </pre>

            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                onClick={() => void decide(true)}
                className="ota-btn-primary flex-1 rounded-md px-3 py-1.5 text-xs"
              >
                {t("agent.approve")}
              </button>
              <button
                type="button"
                onClick={() => void decide(false)}
                className="flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition hover:border-[var(--status-danger)] hover:text-[var(--status-danger)]"
              >
                {t("agent.reject")}
              </button>
            </div>
          </div>
        ) : null}

        {answer.length > 0 ? (
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-[var(--text-primary)]">
            {answer}
          </div>
        ) : null}

        {/* Human-friendly failure notice with optional Open Settings shortcut */}
        {failure ? (
          <div
            className="rounded-lg border px-3 py-2.5 text-xs leading-relaxed"
            style={{
              borderColor: "var(--border-strong)",
              backgroundColor: "var(--status-danger-soft)",
              color: "var(--text-primary)",
            }}
          >
            <p style={{ color: "var(--status-danger)" }}>{failure.message}</p>
            {failure.openSettings ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="mt-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] transition hover:border-[var(--accent-border)] hover:text-[var(--accent)]"
              >
                {t("agent.openSettings")}
              </button>
            ) : null}
          </div>
        ) : null}

        {summary ? (
          <p className="font-mono text-[10px] text-[var(--text-muted)]">{summary}</p>
        ) : null}

        <div ref={timelineEndRef} />
      </div>

      {/* Bottom section: RECENT RUNS */}
      <section className="max-h-36 shrink-0 overflow-y-auto border-t border-[var(--border-subtle)] px-3.5 py-2.5">
        <div className="flex items-center justify-between text-[10px] font-semibold tracking-[0.12em] text-[var(--text-muted)] uppercase">
          <span>{t("agent.recentRuns")}</span>
          <span className="font-mono">{runs.length}</span>
        </div>

        {runs.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">{t("agent.noHistory")}</p>
        ) : (
          <ul className="mt-1.5 space-y-0.5">
            {runs.map((run) => {
              const lower = run.status.toLowerCase();
              const statusColor = lower.includes("complet")
                ? "var(--status-ok)"
                : lower.includes("fail")
                  ? "var(--status-danger)"
                  : "var(--accent)";
              const stamp = new Date(run.startedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              });
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => void replay(run.id)}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] transition hover:bg-[var(--bg-hover)]"
                  >
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
                      {stamp}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                      {run.task}
                    </span>
                    <span className="shrink-0 font-mono text-[10px]" style={{ color: statusColor }}>
                      {run.status}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Sidebar composer with Tab-to-accept placeholder */}
      <footer className="border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] p-3">
        <div className="relative">
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Tab" && task.length === 0 && activePlaceholder.length > 0) {
                event.preventDefault();
                setTask(activePlaceholder);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void startTask(task).then(() => setTask(""));
              }
            }}
            rows={2}
            placeholder={activePlaceholder}
            className="ota-input resize-none pr-12"
          />
          {task.length === 0 && !running ? (
            <kbd
              title={t("agent.tabAcceptHint")}
              className="pointer-events-none absolute right-2 bottom-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1 py-0.5 font-mono text-[9px] text-[var(--text-muted)]"
            >
              Tab ⇥
            </kbd>
          ) : null}
        </div>
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            onClick={() => void startTask(task).then(() => setTask(""))}
            disabled={running || !sessionId || task.trim().length === 0}
            className="ota-btn-primary flex-1 rounded-md px-3 py-1.5 text-xs"
          >
            {running ? t("agent.running") : t("agent.send")}
          </button>
          {running ? (
            <button
              type="button"
              onClick={() => void cancel()}
              className="rounded-md border px-2.5 py-1.5 text-xs font-medium transition"
              style={{
                borderColor: "var(--status-danger)",
                backgroundColor: "var(--status-danger-soft)",
                color: "var(--status-danger)",
              }}
            >
              {t("agent.takeOver")}
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
