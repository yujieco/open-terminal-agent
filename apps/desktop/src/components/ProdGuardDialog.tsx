// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DangerousCommandMatch } from "../lib/prodGuard";

interface ProdGuardDialogProps {
  sessionLabel: string;
  match: DangerousCommandMatch;
  onCancel: (clearLine: boolean) => void;
  onProceed: () => void;
}

export function ProdGuardDialog({
  sessionLabel,
  match,
  onCancel,
  onProceed,
}: ProdGuardDialogProps) {
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState("");
  const targetToken = sessionLabel.trim() || "PROD";
  const matched =
    match.severity === "high" ||
    confirmText.trim().toLowerCase() === targetToken.toLowerCase();

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-[2px]"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={() => onCancel(false)}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--status-danger)] bg-[var(--bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide text-white"
              style={{ backgroundColor: "var(--status-danger)" }}
            >
              PROD
            </span>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              {t("prodGuard.title")}
            </h2>
          </div>
          <span className="truncate font-mono text-[11px] text-[var(--text-muted)]">
            {sessionLabel}
          </span>
        </header>

        <div className="space-y-3 px-4 py-4">
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("prodGuard.subtitle", { reason: t(match.reasonKey) })}
          </p>

          <pre className="max-h-28 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2 font-mono text-xs text-[var(--status-danger)]">
            {match.command}
          </pre>

          {match.severity === "critical" ? (
            <div>
              <label className="mb-1.5 block text-[11px] text-[var(--text-muted)]">
                {t("prodGuard.typeToConfirm", { target: targetToken })}
              </label>
              <input
                autoFocus
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && matched) onProceed();
                  if (event.key === "Escape") onCancel(false);
                }}
                placeholder={targetToken}
                className="ota-input font-mono"
              />
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-2.5">
          <button
            type="button"
            onClick={() => onCancel(true)}
            className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
          >
            {t("prodGuard.cancelAndClear")}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onCancel(false)}
              className="rounded-md px-3 py-1.5 text-xs text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={!matched}
              onClick={onProceed}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ backgroundColor: "var(--status-danger)" }}
            >
              {t("prodGuard.executeAnyway")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
