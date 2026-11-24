// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc, type SavedSession, type SftpEntry, type SftpSessionInfo } from "../lib/ipc";

interface SftpDrawerProps {
  saved: SavedSession[];
  onClose: () => void;
}

function parentOf(path: string): string {
  if (path === "/" || path.length === 0) return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function baseName(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function SftpDrawer({ saved, onClose }: SftpDrawerProps) {
  const { t } = useTranslation();
  const [session, setSession] = useState<SftpSessionInfo | null>(null);
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const profiles = saved.filter((profile) => profile.kind === "ssh");

  const browse = useCallback(async (connectionId: string, path: string) => {
    const listed = await ipc.sftpListDir(connectionId, path);
    setEntries(listed);
    setCwd(path);
  }, []);

  const connect = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const info = await ipc.sftpConnectSaved(id);
        setSession(info);
        await browse(info.connectionId, info.home);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [browse],
  );

  const disconnect = useCallback(async () => {
    if (session) {
      await ipc.sftpClose(session.connectionId).catch(console.error);
    }
    setSession(null);
    setEntries([]);
    setCwd("");
  }, [session]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void disconnect();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disconnect, onClose]);

  const transfer = useCallback(
    async (kind: "download" | "upload", entry?: SftpEntry) => {
      if (!session) return;
      const local = window.prompt(t(`sftp.${kind}Local`), kind === "upload" ? "" : "/tmp");
      if (!local) return;

      const remote =
        kind === "upload"
          ? window.prompt(t("sftp.uploadRemote"), `${cwd.replace(/\/$/, "")}/${baseName(local)}`)
          : entry?.path;
      if (!remote) return;

      setBusy(true);
      setError(null);
      try {
        const bytes =
          kind === "download"
            ? await ipc.sftpDownload(session.connectionId, remote, local)
            : await ipc.sftpUpload(session.connectionId, local, remote);
        setNote(`${t("sftp.transferred")}: ${bytes}`);
        await browse(session.connectionId, cwd);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [browse, cwd, session, t],
  );

  return (
    <div
      className="fixed inset-0 z-40 flex justify-start backdrop-blur-[2px]"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <aside
        className="flex h-full w-[26rem] flex-col border-r border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("sftp.title")}</h2>
          <div className="flex items-center gap-1.5">
            {session ? (
              <button
                type="button"
                onClick={() => void disconnect()}
                className="rounded-md border border-[var(--border-subtle)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                {t("sftp.disconnect")}
              </button>
            ) : null}
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
          </div>
        </header>

        {!session ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
            <p className="text-xs text-[var(--text-muted)]">{t("sftp.connectHint")}</p>
            {profiles.length === 0 ? (
              <p className="mt-2 text-xs" style={{ color: "var(--accent)" }}>
                {t("sftp.noProfiles")}
              </p>
            ) : (
              <ul className="mt-3 space-y-1">
                {profiles.map((profile) => (
                  <li key={profile.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void connect(profile.id)}
                      className="flex w-full items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2 text-left text-xs text-[var(--text-primary)] transition hover:border-[var(--accent-border)] disabled:opacity-50"
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: "var(--accent)" }}
                      />
                      <span className="font-mono">{profile.name}</span>
                      <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)] uppercase">
                        {profile.kind}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error ? (
              <p className="mt-2 text-[11px]" style={{ color: "var(--status-danger)" }}>
                {error}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-3 py-2">
              <button
                type="button"
                onClick={() => void browse(session.connectionId, parentOf(cwd))}
                className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono text-xs text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
              >
                ↑
              </button>
              <span className="truncate font-mono text-[11px] text-[var(--text-primary)]">
                {cwd}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void transfer("upload")}
                className="ota-btn-primary ml-auto rounded-md px-2.5 py-1 text-[11px]"
              >
                {t("sftp.upload")}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {entries.length === 0 ? (
                <p className="px-4 py-3 text-xs text-[var(--text-muted)]">{t("sftp.empty")}</p>
              ) : (
                <table className="w-full text-[11.5px]">
                  <tbody>
                    {entries.map((entry) => (
                      <tr
                        key={entry.path}
                        className="border-b border-[var(--border-subtle)] transition hover:bg-[var(--bg-hover)]"
                      >
                        <td className="px-3 py-1.5">
                          {entry.directory ? (
                            <button
                              type="button"
                              onClick={() => void browse(session.connectionId, entry.path)}
                              className="font-medium hover:underline"
                              style={{ color: "var(--accent)" }}
                            >
                              {entry.name}/
                            </button>
                          ) : (
                            <span className="text-[var(--text-primary)]">
                              {entry.name}
                              {entry.symlink ? " →" : ""}
                            </span>
                          )}
                        </td>
                        <td className="w-20 px-2 py-1.5 text-right font-mono text-[10.5px] text-[var(--text-muted)]">
                          {entry.size ?? "—"}
                        </td>
                        <td className="w-20 px-3 py-1.5 text-right">
                          {entry.directory ? null : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void transfer("download", entry)}
                              className="font-mono text-[10.5px] transition hover:underline disabled:opacity-50"
                              style={{ color: "var(--accent)" }}
                            >
                              {t("sftp.download")}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <footer className="border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2 font-mono text-[10.5px] text-[var(--text-muted)]">
              <span>
                {session.username}@{session.host}
              </span>
              {note ? (
                <span className="ml-2" style={{ color: "var(--status-ok)" }}>
                  {note}
                </span>
              ) : null}
              {error ? (
                <span className="ml-2" style={{ color: "var(--status-danger)" }}>
                  {error}
                </span>
              ) : null}
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}
