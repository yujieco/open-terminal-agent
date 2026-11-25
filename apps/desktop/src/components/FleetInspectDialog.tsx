// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ipc,
  isTauri,
  type FleetInspectResponse,
  type SavedSession,
} from "../lib/ipc";

interface FleetInspectDialogProps {
  saved: SavedSession[];
  onClose: () => void;
}

const PRESETS = [
  { key: "disk", goal: "Check disk usage above 80% on all partitions", cmd: "df -hP | awk 'NR==1 || +$5 >= 80'" },
  { key: "memory", goal: "Check memory usage and top 5 memory processes", cmd: "free -h && ps aux --sort=-%mem | head -n 6" },
  { key: "docker", goal: "Check unhealthy or exited Docker containers", cmd: "docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null || echo 'docker not installed'" },
  { key: "uptime", goal: "Check host uptime, load average and kernel version", cmd: "uname -sr && uptime" },
];

export function FleetInspectDialog({ saved, onClose }: FleetInspectDialogProps) {
  const { t, i18n } = useTranslation();
  const sshHosts = useMemo(() => saved.filter((s) => s.kind === "ssh"), [saved]);

  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const host of sshHosts) map[host.id] = true;
    return map;
  });
  const [goal, setGoal] = useState("");
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<FleetInspectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedHost, setExpandedHost] = useState<string | null>(null);

  const chosenIds = sshHosts.filter((h) => selected[h.id]).map((h) => h.id);

  const runInspect = async (allowMutating = false) => {
    if (!isTauri() || chosenIds.length === 0) return;
    if (!goal.trim() && !command.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const res = await ipc.fleetInspect({
        sessionIds: chosenIds,
        goal: goal.trim() || command.trim(),
        command: command.trim() || undefined,
        allowMutating,
        language: i18n.language,
      });
      setResponse(res);
      if (res.command && !command.trim()) {
        setCommand(res.command);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-5 backdrop-blur-[2px]"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="ota-dialog-panel flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-[var(--bg-surface)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              {t("fleet.title")}
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              {t("fleet.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Host selector */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10.5px] font-medium text-[var(--text-muted)] uppercase">
                {t("fleet.hostsLabel", { count: chosenIds.length, total: sshHosts.length })}
              </span>
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => {
                    const next: Record<string, boolean> = {};
                    for (const h of sshHosts) next[h.id] = true;
                    setSelected(next);
                  }}
                  className="text-[var(--accent)] hover:underline"
                >
                  {t("fleet.selectAll")}
                </button>
                <button
                  type="button"
                  onClick={() => setSelected({})}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  {t("fleet.clearAll")}
                </button>
              </div>
            </div>
            {sshHosts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--border-subtle)] py-6 text-center text-xs text-[var(--text-muted)]">
                {t("fleet.noHosts")}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {sshHosts.map((host) => {
                  const active = Boolean(selected[host.id]);
                  const isProd = host.payload?.envTag === "prod";
                  return (
                    <button
                      key={host.id}
                      type="button"
                      onClick={() =>
                        setSelected((prev) => ({ ...prev, [host.id]: !prev[host.id] }))
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition"
                      style={{
                        borderColor: active ? "var(--accent-border)" : "var(--border-subtle)",
                        backgroundColor: active ? "var(--accent-soft)" : "var(--bg-elevated)",
                        color: active ? "var(--text-primary)" : "var(--text-muted)",
                      }}
                    >
                      <span className="font-medium">{host.name}</span>
                      {isProd ? (
                        <span
                          className="rounded px-1 text-[9px] font-bold"
                          style={{
                            backgroundColor: "rgba(239, 68, 68, 0.16)",
                            color: "var(--status-danger)",
                          }}
                        >
                          PROD
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Goal + quick presets + optional direct command */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => {
                    setGoal(t(`fleet.presets.${preset.key}`));
                    setCommand(preset.cmd);
                  }}
                  className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  {t(`fleet.presets.${preset.key}`)}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void runInspect(false);
                }}
                placeholder={t("fleet.goalPlaceholder")}
                className="ota-input"
              />
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void runInspect(false);
                }}
                placeholder={t("fleet.commandPlaceholder")}
                className="ota-input font-mono"
              />
            </div>
          </div>

          {/* Mutating command safety gate */}
          {response?.needsApproval ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-xs"
              style={{
                borderColor: "var(--status-danger)",
                backgroundColor: "rgba(239, 68, 68, 0.08)",
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-[var(--status-danger)]">
                  {t("fleet.approvalNeeded")}
                </div>
                <code className="mt-1 block font-mono text-[11.5px] text-[var(--text-primary)]">
                  {response.command}
                </code>
              </div>
              <button
                type="button"
                disabled={running}
                onClick={() => void runInspect(true)}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-white"
                style={{ backgroundColor: "var(--status-danger)" }}
              >
                {t("fleet.approveFleetRun")}
              </button>
            </div>
          ) : null}

          {/* AI Executive Summary */}
          {response?.summary ? (
            <div
              className="rounded-lg border p-3 text-xs leading-relaxed"
              style={{
                borderColor: "var(--accent-border)",
                backgroundColor: "var(--accent-soft)",
              }}
            >
              <div className="mb-1 text-[10.5px] font-semibold uppercase" style={{ color: "var(--accent)" }}>
                {t("fleet.aiSummary")}
              </div>
              <div className="whitespace-pre-wrap text-[var(--text-primary)]">
                {response.summary}
              </div>
            </div>
          ) : null}

          {/* Concurrent Comparison Table */}
          {response && response.results.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)]">
              <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 font-mono text-[11px] text-[var(--text-muted)]">
                $ {response.command}
              </div>
              <div className="divide-y divide-[var(--border-subtle)]">
                {response.results.map((row) => {
                  const expanded = expandedHost === row.sessionId;
                  return (
                    <div key={row.sessionId} className="bg-[var(--bg-canvas)] px-3 py-2.5 text-xs">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: row.ok ? "var(--status-ok)" : "var(--status-danger)",
                          }}
                        />
                        <span className="font-semibold text-[var(--text-primary)]">{row.name}</span>
                        <span className="font-mono text-[11px] text-[var(--text-muted)]">
                          {row.target}
                        </span>
                        <span className="ota-tabular ml-auto font-mono text-[10.5px] text-[var(--text-muted)]">
                          {row.durationMs}ms
                        </span>
                        <button
                          type="button"
                          onClick={() => setExpandedHost(expanded ? null : row.sessionId)}
                          className="text-[11px] text-[var(--accent)] hover:underline"
                        >
                          {expanded ? t("blocks.collapse") : t("fleet.details")}
                        </button>
                      </div>
                      {row.error ? (
                        <p className="mt-1.5 font-mono text-[11px] text-[var(--status-danger)]">
                          {row.error}
                        </p>
                      ) : row.output ? (
                        <pre
                          className={`mt-1.5 overflow-x-auto rounded bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--text-secondary)] ${
                            expanded ? "max-h-72 overflow-y-auto" : "max-h-20 overflow-hidden"
                          }`}
                        >
                          {row.output}
                        </pre>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="text-xs text-[var(--status-danger)]">{error}</p>
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            {t("common.close")}
          </button>
          <button
            type="button"
            disabled={running || chosenIds.length === 0 || (!goal.trim() && !command.trim())}
            onClick={() => void runInspect(false)}
            className="ota-btn-primary rounded-md px-4 py-1.5 text-xs disabled:opacity-40"
          >
            {running
              ? t("fleet.running", { count: chosenIds.length })
              : t("fleet.runAction", { count: chosenIds.length })}
          </button>
        </footer>
      </div>
    </div>
  );
}
