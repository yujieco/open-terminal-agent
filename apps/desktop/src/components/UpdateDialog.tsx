// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { ipc, isTauri, type UpdateInfo } from "../lib/ipc";

interface UpdateDialogProps {
  info: UpdateInfo;
  onClose: () => void;
}

export function UpdateDialog({ info, onClose }: UpdateDialogProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const openRelease = () => {
    if (isTauri()) {
      void ipc.openExternalUrl(info.releaseUrl).catch(console.error);
    } else {
      window.open(info.releaseUrl, "_blank", "noopener,noreferrer");
    }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-2xl backdrop-blur-xl"
        style={{
          backgroundColor: "color-mix(in srgb, var(--bg-surface) 88%, transparent)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--accent)" }}
            />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              {t("update.dialogTitle")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="space-y-3 px-4 py-3.5">
          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-0.5 text-[var(--text-secondary)]">
              v{info.currentVersion}
            </span>
            <span className="text-[var(--text-muted)]">→</span>
            <span
              className="rounded-md border px-2 py-0.5 font-semibold"
              style={{
                borderColor: "var(--accent-border)",
                backgroundColor: "var(--accent-soft)",
                color: "var(--accent)",
              }}
            >
              v{info.latestVersion}
            </span>
            <span className="ml-auto truncate font-sans text-[11px] text-[var(--text-muted)]">
              {info.releaseName}
            </span>
          </div>

          {info.notes ? (
            <pre className="max-h-56 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]">
              {info.notes}
            </pre>
          ) : (
            <p className="text-xs leading-relaxed text-[var(--text-muted)]">
              {t("update.noNotes")}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {t("update.later")}
          </button>
          <button
            type="button"
            onClick={openRelease}
            className="ota-btn-primary inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2M3 13.2h10" />
            </svg>
            <span>{t("update.download")}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
