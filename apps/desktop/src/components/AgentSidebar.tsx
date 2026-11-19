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
import type { AgentRunSummary } from "../lib/ipc";
import { isTauri } from "../lib/ipc";
import type { PermissionMode } from "../types";

const MODES: PermissionMode[] = ["ask", "supervised", "autonomous"];

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

interface AgentSidebarProps {
  sessionId: string | null;
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  /** Tells the shell whether an agent owns this session, for Esc take-over. */
  onRunningChange: (sessionId: string, running: boolean) => void;
}

export function AgentSidebar({
  sessionId,
  mode,
  onModeChange,
  onRunningChange,
}: AgentSidebarProps) {
  const { t } = useTranslation();
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState("");
  const [thinking, setThinking] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const [cards, setCards] = useState<ToolCard[]>([]);
  const [approval, setApproval] = useState<ApprovalPayload | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [stepApproval, setStepApproval] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const sessionRef = useRef<string | null>(sessionId);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  const refreshStatus = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setLlm(await agentIpc.status());
    } catch (cause) {
      console.warn("[ota] could not read llm status", cause);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // A new session starts with a clean timeline: mixing two terminals would
  // misrepresent what actually ran where.
  useEffect(() => {
    setAnswer("");
    setThinking("");
    setCards([]);
    setApproval(null);
    setFailure(null);
    setSummary(null);
    setRunning(false);
  }, [sessionId]);

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

    // Whoever types takes the terminal back; the runtime aborts on its own side.
    void onAgentInterrupted((payload) => {
      if (disposed || payload.sessionId !== sessionRef.current) return;
      setRunning(false);
      setApproval(null);
      setFailure(t("agent.interrupted"));
      onRunningChange(payload.sessionId, false);
    }).then((stop) => (disposed ? stop() : stops.push(stop)));

    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, []);

  const apply = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "runStarted":
        setRunning(true);
        setSummary(null);
        setFailure(null);
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
      case "runFinished":
        setRunning(false);
        setApproval(null);
        setSummary(`${event.reason} · ${event.steps}`);
        if (sessionRef.current) onRunningChange(sessionRef.current, false);
        break;
      case "failed":
        setRunning(false);
        setFailure(event.message);
        if (sessionRef.current) onRunningChange(sessionRef.current, false);
        break;
      default:
        break;
    }
  }, []);

  const start = useCallback(async () => {
    if (!sessionId || task.trim().length === 0) return;
    setAnswer("");
    setThinking("");
    setCards([]);
    setSummary(null);
    setFailure(null);
    setRunning(true);
    setReplaying(null);
    onRunningChange(sessionId, true);
    try {
      await agentIpc.run({ sessionId, task: task.trim(), mode, stepApproval });
      setTask("");
    } catch (cause) {
      setRunning(false);
      setFailure(cause instanceof Error ? cause.message : String(cause));
    }
  }, [mode, sessionId, stepApproval, task]);

  const loadHistory = useCallback(async () => {
    if (!sessionId) return;
    try {
      setRuns(await agentIpc.runs(sessionId, 20));
      setHistoryOpen(true);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

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
        setReplaying(record.task);
        setHistoryOpen(false);
        for (const raw of record.events) {
          apply(raw as AgentEvent);
        }
      } catch (cause) {
        setFailure(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [apply],
  );

  const decide = useCallback(
    async (approved: boolean) => {
      if (!approval) return;
      try {
        await agentIpc.approve(approval.callId, approved);
      } catch (cause) {
        setFailure(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setApproval(null);
      }
    },
    [approval],
  );

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    try {
      await agentIpc.cancel(sessionId);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-slate-800/80 bg-slate-950/40">
      <header className="border-b border-slate-800/60 px-3 py-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[11px] font-semibold tracking-widest text-slate-400 uppercase">
            {t("agent.title")}
          </h2>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-slate-600">
              {llm ? `${llm.provider}/${llm.model}` : t("agent.noProvider")}
            </span>
            <button
              type="button"
              onClick={() => (historyOpen ? setHistoryOpen(false) : void loadHistory())}
              className="rounded px-1 py-0.5 text-[10px] text-slate-500 hover:bg-slate-800/70 hover:text-slate-200"
            >
              {t("agent.history")}
            </button>
          </div>
        </div>
      </header>

      <section className="border-b border-slate-800/60 px-3 py-2">
        <div className="flex gap-1">
          {MODES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => onModeChange(candidate)}
              className={`flex-1 rounded px-1.5 py-1 text-[11px] transition ${
                candidate === mode
                  ? "bg-cyan-500/20 text-cyan-200"
                  : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
              }`}
            >
              {t(`agent.modes.${candidate}`)}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
          {t(`agent.modesHint.${mode}`)}
        </p>
        <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-400">
          <input
            type="checkbox"
            checked={stepApproval}
            onChange={(event) => setStepApproval(event.target.checked)}
            className="h-3 w-3 accent-cyan-400"
          />
          {t("agent.stepMode")}
        </label>
      </section>

      {llm && !llm.configured ? (
        <section className="border-b border-slate-800/60 bg-amber-500/5 px-3 py-2">
          <p className="text-[11px] text-amber-200/90">{t("agent.keyHint")}</p>
          <div className="mt-1.5 flex gap-1">
            <input
              type="password"
              value={keyDraft}
              placeholder="sk-..."
              onChange={(event) => setKeyDraft(event.target.value)}
              className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950/70 px-2 py-1 font-mono text-[11px] text-slate-100 outline-none focus:border-cyan-500/60"
            />
            <button
              type="button"
              onClick={() => {
                void agentIpc.saveKey(keyDraft).then(() => {
                  setKeyDraft("");
                  void refreshStatus();
                });
              }}
              className="rounded bg-cyan-500/20 px-2 py-1 text-[11px] text-cyan-100 hover:bg-cyan-500/30"
            >
              {t("agent.saveKey")}
            </button>
          </div>
        </section>
      ) : null}

      {historyOpen ? (
        <section className="max-h-48 space-y-1 overflow-y-auto border-b border-slate-800/60 px-3 py-2">
          {runs.length === 0 ? (
            <p className="text-[11px] text-slate-600">{t("agent.noHistory")}</p>
          ) : (
            runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => void replay(run.id)}
                className="block w-full rounded px-1.5 py-1 text-left hover:bg-slate-800/60"
              >
                <span className="flex items-center gap-1.5 text-[11px] text-slate-300">
                  <span className="rounded bg-slate-800/80 px-1 text-[9px] uppercase text-slate-400">
                    {run.status}
                  </span>
                  <span className="truncate">{run.task}</span>
                </span>
                <span className="font-mono text-[10px] text-slate-600">
                  {run.commands} cmds · {new Date(run.startedAt).toLocaleString()}
                </span>
              </button>
            ))
          )}
        </section>
      ) : null}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {replaying ? (
          <div className="flex items-start gap-2 rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1">
            <span className="text-[10px] text-sky-200">{t("agent.replay")}: {replaying}</span>
            <button
              type="button"
              onClick={() => {
                setReplaying(null);
                setCards([]);
                setAnswer("");
                setSummary(null);
              }}
              className="ml-auto text-[10px] text-sky-300/80 hover:text-sky-100"
            >
              ×
            </button>
          </div>
        ) : null}
        {cards.length === 0 && answer.length === 0 && !running ? (
          <p className="text-xs leading-relaxed text-slate-500">{t("agent.empty")}</p>
        ) : null}

        {cards.map((card) => (
          <article
            key={card.callId}
            className={`rounded border ${
              card.status === "denied"
                ? "border-rose-500/40 bg-rose-500/5"
                : card.status === "done" && card.exitCode === 0
                  ? "border-emerald-500/25 bg-emerald-500/5"
                  : "border-slate-700/70 bg-slate-900/60"
            }`}
          >
            <header className="flex items-center gap-1.5 border-b border-slate-800/60 px-2 py-1">
              <span className="rounded bg-slate-800/80 px-1 py-0.5 text-[9px] tracking-wider text-slate-400 uppercase">
                {t("agent.command")}
              </span>
              {card.risk ? (
                <span
                  className={`rounded px-1 py-0.5 text-[9px] uppercase ${
                    card.risk === "readonly"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : card.risk === "mutating"
                        ? "bg-amber-500/15 text-amber-300"
                        : "bg-rose-500/15 text-rose-300"
                  }`}
                >
                  {t(`agent.risk.${card.risk}`)}
                </span>
              ) : null}
              <span className="ml-auto font-mono text-[10px] text-slate-500">
                {card.status === "running"
                  ? t("agent.running")
                  : card.status === "denied"
                    ? t("agent.rejected")
                    : `${card.exitCode ?? "-"} · ${card.durationMs}ms`}
              </span>
            </header>
            <pre className="px-2 py-1 font-mono text-[11px] whitespace-pre-wrap break-all text-cyan-200/90">
              {card.command}
            </pre>
            {card.output.length > 0 ? (
              <pre className="max-h-40 overflow-y-auto border-t border-slate-800/60 px-2 py-1 font-mono text-[10px] whitespace-pre-wrap text-slate-400">
                {card.output}
              </pre>
            ) : null}
          </article>
        ))}

        {answer.length > 0 ? (
          <div className="rounded border border-slate-800/60 bg-slate-900/40 px-2 py-1.5 text-xs leading-relaxed whitespace-pre-wrap text-slate-200">
            {answer}
          </div>
        ) : null}

        {thinking.length > 0 ? (
          <div>
            <button
              type="button"
              onClick={() => setShowThinking((open) => !open)}
              className="text-[10px] tracking-wider text-slate-500 uppercase hover:text-slate-300"
            >
              {t("agent.thinking")} {showThinking ? "▾" : "▸"}
            </button>
            {showThinking ? (
              <pre className="mt-1 max-h-32 overflow-y-auto font-mono text-[10px] whitespace-pre-wrap text-slate-500">
                {thinking}
              </pre>
            ) : null}
          </div>
        ) : null}

        {approval ? (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2">
            <p className="text-[11px] text-amber-100">{t("agent.approvalNeeded")}</p>
            <pre className="mt-1 font-mono text-[11px] whitespace-pre-wrap break-all text-amber-200">
              {approval.command}
            </pre>
            <div className="mt-1.5 flex gap-1">
              <button
                type="button"
                onClick={() => void decide(true)}
                className="flex-1 rounded bg-emerald-500/20 px-2 py-1 text-[11px] text-emerald-100 hover:bg-emerald-500/30"
              >
                {t("agent.approve")}
              </button>
              <button
                type="button"
                onClick={() => void decide(false)}
                className="flex-1 rounded bg-rose-500/20 px-2 py-1 text-[11px] text-rose-100 hover:bg-rose-500/30"
              >
                {t("agent.reject")}
              </button>
            </div>
          </div>
        ) : null}

        {failure ? <p className="text-[11px] text-rose-300">{failure}</p> : null}
        {summary ? <p className="text-[10px] text-slate-600">{summary}</p> : null}
      </div>

      <footer className="border-t border-slate-800/60 p-2">
        <textarea
          value={task}
          onChange={(event) => setTask(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void start();
            }
          }}
          rows={2}
          placeholder={t("agent.placeholder")}
          className="w-full resize-none rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500/60"
        />
        <div className="mt-1.5 flex gap-1">
          <button
            type="button"
            onClick={() => void start()}
            disabled={running || !sessionId || task.trim().length === 0}
            className="flex-1 rounded bg-cyan-500/20 px-2 py-1 text-[11px] text-cyan-100 hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? t("agent.running") : t("agent.send")}
          </button>
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={!running}
            className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("agent.takeOver")}
          </button>
        </div>
      </footer>
    </aside>
  );
}
