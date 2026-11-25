// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { ArrowDownToLine } from "lucide-react";
import { useTranslation } from "react-i18next";

import pkg from "../../package.json";
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
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-3 text-[11px] text-[var(--text-muted)] select-none">
      <div className="flex items-center gap-2">
        {updateInfo?.available ? (
          <button
            type="button"
            onClick={onOpenUpdate}
            className="inline-flex h-4 items-center gap-1 rounded px-1.5 text-[10.5px] font-medium transition hover:bg-[var(--accent-soft)]"
            style={{ color: "var(--accent)" }}
          >
            <ArrowDownToLine className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            <span>{t("update.availableBadge", { version: updateInfo.latestVersion })}</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={checkingUpdate}
            onClick={onCheckUpdate}
            title={t("update.checkTooltip")}
            className="ota-tabular inline-flex h-4 items-center rounded px-1 font-mono text-[10.5px] text-[var(--text-muted)] transition hover:text-[var(--text-secondary)] disabled:opacity-50"
          >
            {checkingUpdate
              ? t("update.checking")
              : `v${updateInfo?.currentVersion ?? pkg.version}`}
          </button>
        )}

        {agentRunning ? (
          <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium" style={{ color: "var(--accent)" }}>
            <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ backgroundColor: "var(--accent)" }} />
            {t("status.agentControl")}
          </span>
        ) : null}

        {demo ? (
          <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            {t("status.demo")}
          </span>
        ) : null}
      </div>

      <span className="ml-auto flex h-full min-w-0 items-center gap-2 text-[var(--text-secondary)]">
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
        <span className="truncate text-[11px] font-normal leading-none">
          {label ?? "—"}
        </span>
        {size ? (
          <span
            className="ota-tabular shrink-0 font-mono text-[10.5px] leading-none text-[var(--text-muted)]"
            title={t("status.gridTooltip", { cols: size.cols, rows: size.rows })}
          >
            {size.cols}×{size.rows}
          </span>
        ) : null}
      </span>
    </footer>
  );
}
