// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc, isTauri, type UpdateDownloadEvent, type UpdateInfo } from "../lib/ipc";

interface UpdateDialogProps {
  info: UpdateInfo;
  onClose: () => void;
}

type InstallPhase = "idle" | "downloading" | "installing" | "restarting" | "error";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function UpdateDialog({ info, onClose }: UpdateDialogProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<InstallPhase>("idle");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const busy = phase === "downloading" || phase === "installing" || phase === "restarting";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const openRelease = () => {
    if (isTauri()) {
      void ipc.openExternalUrl(info.releaseUrl).catch(console.error);
    } else {
      window.open(info.releaseUrl, "_blank", "noopener,noreferrer");
    }
    onClose();
  };

  const installInApp = async () => {
    if (!isTauri() || busy) return;
    setPhase("downloading");
    setDownloaded(0);
    setTotal(null);
    setErrorMessage(null);

    try {
      await ipc.installAndRelaunchUpdate((event: UpdateDownloadEvent) => {
        if (event.event === "started") {
          setTotal(event.contentLength);
        } else if (event.event === "progress") {
          setDownloaded(event.downloaded);
          if (event.total !== null) setTotal(event.total);
        } else if (event.event === "installing") {
          setPhase("installing");
        } else if (event.event === "restarting") {
          setPhase("restarting");
        }
      });
    } catch (cause) {
      setPhase("error");
      setErrorMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const percent =
    total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-2xl backdrop-blur-xl"
        style={{
          backgroundColor: "color-mix(in srgb, var(--bg-surface) 90%, transparent)",
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
            disabled={busy}
            onClick={onClose}
            aria-label={t("common.close")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <svg
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
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

          {/* Live in-app download / signature verification / restart progress */}
          {busy ? (
            <div className="space-y-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium text-[var(--text-primary)]">
                  {phase === "downloading"
                    ? t("update.downloading")
                    : phase === "installing"
                      ? t("update.installing")
                      : t("update.restarting")}
                </span>
                <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
                  {phase === "downloading"
                    ? total && total > 0
                      ? `${percent}% · ${formatBytes(downloaded)} / ${formatBytes(total)}`
                      : formatBytes(downloaded)
                    : "100%"}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                <div
                  className="h-full rounded-full transition-all duration-200"
                  style={{
                    width:
                      phase === "downloading"
                        ? `${percent ?? 35}%`
                        : "100%",
                    backgroundColor: "var(--accent)",
                  }}
                />
              </div>
            </div>
          ) : null}

          {!info.canAutoInstall && phase === "idle" ? (
            <p className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {t("update.manualHint")}
            </p>
          ) : null}

          {errorMessage ? (
            <div
              className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed"
              style={{
                borderColor: "var(--status-danger)",
                backgroundColor: "var(--status-danger-soft)",
                color: "var(--status-danger)",
              }}
            >
              {t("update.failed")}: {errorMessage}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2.5">
          {!busy ? (
            <button type="button" onClick={onClose} className="ota-ctrl">
              {t("update.later")}
            </button>
          ) : null}

          {info.canAutoInstall ? (
            <>
              {!busy ? (
                <button type="button" onClick={openRelease} className="ota-ctrl">
                  {t("update.viewRelease")}
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => void installInApp()}
                className="ota-ctrl-primary"
              >
                {phase === "downloading"
                  ? t("update.downloading")
                  : phase === "installing"
                    ? t("update.installing")
                    : phase === "restarting"
                      ? t("update.restarting")
                      : t("update.installAndRestart")}
              </button>
            </>
          ) : (
            <button type="button" onClick={openRelease} className="ota-ctrl-primary">
              {t("update.download")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
