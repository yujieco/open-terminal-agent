// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

import type { UpdateInfo } from "../lib/ipc";

interface StatusBarProps {
  label: string | null;
  size: { cols: number; rows: number } | null;
  exited: boolean;
  demo: boolean;
  agentRunning: boolean;
  updateInfo: UpdateInfo | null;
  checkingUpdate: boolean;
  onCheckUpdate: () => void;
  onOpenUpdate: () => void;
}

export function StatusBar({
  label,
  size,
  exited,
  demo,
  agentRunning,
  updateInfo,
  checkingUpdate,
  onCheckUpdate,
  onOpenUpdate,
}: StatusBarProps) {
  const { t } = useTranslation();

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-3.5 font-mono text-[10.5px] text-[var(--text-muted)]">
      {/* Left: frosted-glass update button when a newer GitHub Release exists */}
      <div className="flex items-center gap-2">
        {updateInfo?.available ? (
          <button
            type="button"
            onClick={onOpenUpdate}
            className="inline-flex h-6 items-center justify-center gap-1.5 rounded-full border px-2.5 font-sans text-[11px] font-medium shadow-sm backdrop-blur-md transition hover:brightness-105"
            style={{
              backgroundColor: "color-mix(in srgb, var(--bg-surface) 62%, transparent)",
              borderColor: "var(--accent-border)",
              color: "var(--text-primary)",
              boxShadow: "0 2px 10px -2px var(--accent-soft), inset 0 1px 0 rgba(255,255,255,0.12)",
            }}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: "var(--accent)" }}
            />
            <svg
              viewBox="0 0 16 16"
              className="h-3 w-3 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: "var(--accent)" }}
            >
              <path d="M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2M3 13.2h10" />
            </svg>
            <span>{t("update.availableBadge", { version: updateInfo.latestVersion })}</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={checkingUpdate}
            onClick={onCheckUpdate}
            title={t("update.checkTooltip")}
            className="inline-flex h-6 items-center gap-1.5 rounded-full px-2 font-mono text-[10px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] disabled:opacity-50"
          >
            <span>
              {checkingUpdate
                ? t("update.checking")
                : `v${updateInfo?.currentVersion ?? "0.1.0"}`}
            </span>
          </button>
        )}

        {agentRunning ? (
          <span style={{ color: "var(--accent)" }}>{t("status.agentControl")}</span>
        ) : null}

        {demo ? (
          <span
            className="rounded px-1.5 py-0.5 text-[9.5px] font-medium uppercase"
            style={{
              backgroundColor: "var(--accent-soft)",
              color: "var(--accent)",
            }}
          >
            {t("status.demo")}
          </span>
        ) : null}
      </div>

      {/* Right: quiet active session readout */}
      <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[var(--text-secondary)]">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            backgroundColor:
              label === null
                ? "var(--text-muted)"
                : exited
                  ? "var(--status-danger)"
                  : agentRunning
                    ? "var(--accent)"
                    : "var(--status-ok)",
          }}
        />
        <span className="truncate">{label ?? "—"}</span>
        {size ? (
          <span
            className="shrink-0 text-[var(--text-muted)]"
            title={t("status.gridTooltip", { cols: size.cols, rows: size.rows })}
          >
            {size.cols}×{size.rows}
          </span>
        ) : null}
      </span>
    </footer>
  );
}
