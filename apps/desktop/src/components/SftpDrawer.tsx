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
    <div className="fixed inset-0 z-40 flex justify-start bg-slate-950/60" onClick={onClose}>
      <aside
        className="flex h-full w-[26rem] flex-col border-r border-slate-800 bg-slate-900/95 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
          <h2 className="text-sm font-medium text-slate-200">{t("sftp.title")}</h2>
          <div className="flex items-center gap-1">
            {session ? (
              <button
                type="button"
                onClick={() => void disconnect()}
                className="rounded px-2 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                {t("sftp.disconnect")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            >
              ×
            </button>
          </div>
        </header>

        {!session ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <p className="text-[11px] text-slate-500">{t("sftp.connectHint")}</p>
            {profiles.length === 0 ? (
              <p className="mt-2 text-[11px] text-amber-300/80">{t("sftp.noProfiles")}</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {profiles.map((profile) => (
                  <li key={profile.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void connect(profile.id)}
                      className="w-full rounded px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800/70 disabled:opacity-50"
                    >
                      <span className="font-mono">{profile.name}</span>
                      <span className="ml-2 text-[10px] text-slate-600">{profile.kind}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error ? <p className="mt-2 text-[11px] text-rose-300">{error}</p> : null}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1 border-b border-slate-800/70 px-2 py-1.5">
              <button
                type="button"
                onClick={() => void browse(session.connectionId, parentOf(cwd))}
                className="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                ↑
              </button>
              <span className="truncate font-mono text-[11px] text-cyan-200/90">{cwd}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void transfer("upload")}
                className="ml-auto rounded bg-cyan-500/15 px-2 py-0.5 text-[11px] text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50"
              >
                {t("sftp.upload")}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {entries.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-slate-600">{t("sftp.empty")}</p>
              ) : (
                <table className="w-full text-[11px]">
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.path} className="border-b border-slate-800/40 hover:bg-slate-800/40">
                        <td className="px-2 py-1">
                          {entry.directory ? (
                            <button
                              type="button"
                              onClick={() => void browse(session.connectionId, entry.path)}
                              className="text-cyan-200/90 hover:underline"
                            >
                              {entry.name}/
                            </button>
                          ) : (
                            <span className="text-slate-300">
                              {entry.name}
                              {entry.symlink ? " →" : ""}
                            </span>
                          )}
                        </td>
                        <td className="w-16 px-2 py-1 text-right font-mono text-slate-600">
                          {entry.size ?? "—"}
                        </td>
                        <td className="w-16 px-2 py-1 text-right">
                          {entry.directory ? null : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void transfer("download", entry)}
                              className="text-[10px] text-sky-300/80 hover:text-sky-200 disabled:opacity-50"
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

            <footer className="border-t border-slate-800 px-3 py-1.5 text-[10px] text-slate-500">
              {session.username}@{session.host}
              {note ? <span className="ml-2 text-emerald-300/80">{note}</span> : null}
              {error ? <span className="ml-2 text-rose-300">{error}</span> : null}
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}
