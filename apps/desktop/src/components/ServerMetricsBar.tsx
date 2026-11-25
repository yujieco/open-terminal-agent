// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc, isTauri, type ServerMetrics } from "../lib/ipc";

interface ServerMetricsBarProps {
  sessionId: string;
  alive: boolean;
}

interface NetRate {
  rxKbps: number;
  txKbps: number;
}

function formatRate(kbps: number): string {
  if (kbps < 1024) return `${kbps.toFixed(1)} KB/s`;
  return `${(kbps / 1024).toFixed(2)} MB/s`;
}

function barColor(pct: number): string {
  if (pct >= 85) return "var(--status-danger)";
  if (pct >= 65) return "var(--status-warn)";
  return "var(--status-ok)";
}

export function ServerMetricsBar({ sessionId, alive }: ServerMetricsBarProps) {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [netRate, setNetRate] = useState<NetRate | null>(null);
  const [error, setError] = useState(false);
  const prevNetRef = useRef<{ rx: number; tx: number; ts: number } | null>(null);

  const poll = useCallback(async () => {
    if (!alive || !isTauri()) return;
    try {
      const next = await ipc.probeServerMetrics(sessionId);
      setError(false);
      setMetrics(next);
      if (next.netRxBytes !== null && next.netTxBytes !== null) {
        const now = Date.now();
        const prev = prevNetRef.current;
        if (prev && now > prev.ts) {
          const dt = (now - prev.ts) / 1000;
          const rxDelta = Math.max(0, next.netRxBytes - prev.rx);
          const txDelta = Math.max(0, next.netTxBytes - prev.tx);
          setNetRate({
            rxKbps: rxDelta / 1024 / dt,
            txKbps: txDelta / 1024 / dt,
          });
        }
        prevNetRef.current = { rx: next.netRxBytes, tx: next.netTxBytes, ts: now };
      }
    } catch {
      setError(true);
    }
  }, [alive, sessionId]);

  useEffect(() => {
    setMetrics(null);
    setNetRate(null);
    setError(false);
    prevNetRef.current = null;
    if (!alive || !isTauri()) return;
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 3500);
    return () => window.clearInterval(timer);
  }, [alive, poll, sessionId]);

  const memPct =
    metrics?.memUsedMb !== null &&
    metrics?.memUsedMb !== undefined &&
    metrics?.memTotalMb &&
    metrics.memTotalMb > 0
      ? Math.min(100, Math.round((metrics.memUsedMb / metrics.memTotalMb) * 100))
      : null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-1.5 text-[11px]">
      {error && !metrics ? (
        <span className="text-[var(--text-muted)]">{t("metrics.unavailable")}</span>
      ) : !metrics ? (
        <span className="text-[var(--text-muted)]">{t("metrics.collecting")}</span>
      ) : (
        <>
          {metrics.hostname ? (
            <span className="font-mono font-medium text-[var(--text-primary)]">
              {metrics.hostname}
              {metrics.os ? (
                <span className="ml-1 font-normal text-[var(--text-muted)]">({metrics.os})</span>
              ) : null}
            </span>
          ) : null}

          {metrics.cpuPercent !== null ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[var(--text-muted)]">CPU</span>
              <div className="h-1.5 w-14 overflow-hidden rounded-full bg-[var(--bg-surface)]">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.min(100, metrics.cpuPercent)}%`,
                    backgroundColor: barColor(metrics.cpuPercent),
                  }}
                />
              </div>
              <span className="ota-tabular font-mono text-[var(--text-primary)]">
                {metrics.cpuPercent.toFixed(0)}%
              </span>
            </div>
          ) : null}

          {memPct !== null && metrics.memUsedMb !== null && metrics.memTotalMb !== null ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[var(--text-muted)]">RAM</span>
              <div className="h-1.5 w-14 overflow-hidden rounded-full bg-[var(--bg-surface)]">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${memPct}%`,
                    backgroundColor: barColor(memPct),
                  }}
                />
              </div>
              <span className="ota-tabular font-mono text-[var(--text-primary)]">
                {(metrics.memUsedMb / 1024).toFixed(1)}/{(metrics.memTotalMb / 1024).toFixed(1)}G
              </span>
            </div>
          ) : null}

          {metrics.diskUsedPct !== null ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[var(--text-muted)]">{t("metrics.disk")}</span>
              <span
                className="ota-tabular font-mono font-medium"
                style={{ color: barColor(metrics.diskUsedPct) }}
              >
                {metrics.diskUsedPct}%
              </span>
            </div>
          ) : null}

          {metrics.loadAvg ? (
            <div className="hidden items-center gap-1 md:flex">
              <span className="text-[var(--text-muted)]">{t("metrics.load")}</span>
              <span className="ota-tabular font-mono text-[var(--text-secondary)]">
                {metrics.loadAvg}
              </span>
            </div>
          ) : null}

          {netRate ? (
            <div className="ml-auto hidden items-center gap-2 font-mono text-[10.5px] text-[var(--text-secondary)] lg:flex">
              <span className="ota-tabular">↓ {formatRate(netRate.rxKbps)}</span>
              <span className="ota-tabular">↑ {formatRate(netRate.txKbps)}</span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
