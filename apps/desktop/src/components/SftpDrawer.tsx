// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  ipc,
  isTauri,
  type SavedSession,
  type SftpEntry,
  type SftpProgressEvent,
  type SftpSessionInfo,
} from "../lib/ipc";
import { isMac } from "../lib/platform";

interface SftpDrawerProps {
  saved: SavedSession[];
  activeSessionId?: string | null;
  onClose: () => void;
}

interface EditorState {
  path: string;
  name: string;
  initial: string;
  content: string;
  saving: boolean;
}

function parentOf(path: string): string {
  if (path === "/" || path.length === 0) return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function joinRemote(dir: string, name: string): string {
  if (dir === "/" || dir.length === 0) return `/${name.replace(/^\/+/, "")}`;
  return `${dir.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;
}

function formatBytes(size: number | null): string {
  if (size === null || size === undefined) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMode(mode?: number | null): string {
  if (mode === null || mode === undefined) return "";
  const perms = mode & 0o777;
  return perms.toString(8).padStart(3, "0");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Extracts a likely remote working directory from the latest visible prompt line. */
function guessCwdFromLines(lines: string[]): string | null {
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx]?.trim() ?? "";
    if (!line) continue;
    // Matches `user@host:/var/www$` or `[user@host /etc/nginx]#` or `~/projects $`
    const colonMatch = line.match(/:(\/[^\s$#%>]*|~(?:\/[^\s$#%>]*)?)\s*[$#%>]/);
    if (colonMatch?.[1]) return colonMatch[1];
    const bracketMatch = line.match(/\[[^\]]+\s(\/[^\]\s]*|~(?:\/[^\]\s]*)?)\]/);
    if (bracketMatch?.[1]) return bracketMatch[1];
  }
  return null;
}

export function SftpDrawer({ saved, activeSessionId, onClose }: SftpDrawerProps) {
  const { t } = useTranslation();
  const [session, setSession] = useState<SftpSessionInfo | null>(null);
  const [cwd, setCwd] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [editingPath, setEditingPath] = useState(false);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<SftpProgressEvent | null>(null);
  const [dragging, setDragging] = useState(false);

  const [creatingDir, setCreatingDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<SftpEntry | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const profiles = useMemo(
    () => saved.filter((profile) => profile.kind === "ssh"),
    [saved],
  );

  const filteredEntries = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [entries, filter]);

  const breadcrumbs = useMemo(() => {
    if (!cwd || cwd === "/") return [{ label: "/", path: "/" }];
    const parts = cwd.split("/").filter(Boolean);
    const segments = [{ label: "/", path: "/" }];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      segments.push({ label: part, path: acc });
    }
    return segments;
  }, [cwd]);

  const browse = useCallback(async (connectionId: string, path: string) => {
    setBusy(true);
    setError(null);
    try {
      const listed = await ipc.sftpListDir(connectionId, path);
      setEntries(listed);
      setCwd(path);
      setPathDraft(path);
      setConfirmDelete(null);
      setRenamingPath(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const connect = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const info = await ipc.sftpConnectSaved(id);
        setSession(info);
        await browse(info.connectionId, info.home);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
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
    setFilter("");
    setProgress(null);
    setEditor(null);
  }, [session]);

  useEffect(() => {
    if (!isTauri() || !session) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<SftpProgressEvent>("ota:sftp-progress", (event) => {
      if (!active || event.payload.connectionId !== session.connectionId) return;
      setProgress(event.payload);
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [session]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (editor) {
          setEditor(null);
          return;
        }
        if (creatingDir) {
          setCreatingDir(false);
          return;
        }
        if (renamingPath) {
          setRenamingPath(null);
          return;
        }
        if (editingPath) {
          setEditingPath(false);
          return;
        }
        void disconnect();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [creatingDir, disconnect, editingPath, editor, onClose, renamingPath]);

  const handleUploadPicker = useCallback(async () => {
    if (!session || !isTauri()) return;
    setError(null);
    try {
      const selected = await openDialog({ multiple: true, directory: false });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      setBusy(true);
      let totalBytes = 0;
      for (const localPath of paths) {
        const remotePath = joinRemote(cwd, baseName(localPath));
        totalBytes += await ipc.sftpUpload(session.connectionId, localPath, remotePath);
      }
      setProgress(null);
      setNote(
        t("sftp.uploadedSummary", {
          count: paths.length,
          size: formatBytes(totalBytes),
        }),
      );
      await browse(session.connectionId, cwd);
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }, [browse, cwd, session, t]);

  const handleDownload = useCallback(
    async (entry: SftpEntry) => {
      if (!session || !isTauri()) return;
      setError(null);
      try {
        const localPath = await saveDialog({ defaultPath: entry.name });
        if (!localPath) return;
        setBusy(true);
        const bytes = await ipc.sftpDownload(session.connectionId, entry.path, localPath);
        setProgress(null);
        setNote(`${t("sftp.downloaded")}: ${entry.name} (${formatBytes(bytes)})`);
      } catch (cause) {
        setProgress(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [session, t],
  );

  const handleDropFiles = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      if (!session || !isTauri()) return;
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length === 0) return;

      setBusy(true);
      setError(null);
      try {
        let totalBytes = 0;
        for (const file of files) {
          const buffer = await file.arrayBuffer();
          const b64 = bytesToBase64(new Uint8Array(buffer));
          const remotePath = joinRemote(cwd, file.name);
          totalBytes += await ipc.sftpUploadBytes(session.connectionId, remotePath, b64);
        }
        setProgress(null);
        setNote(
          t("sftp.uploadedSummary", {
            count: files.length,
            size: formatBytes(totalBytes),
          }),
        );
        await browse(session.connectionId, cwd);
      } catch (cause) {
        setProgress(null);
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      }
    },
    [browse, cwd, session, t],
  );

  const handleCreateDir = async () => {
    if (!session) return;
    const trimmed = newDirName.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.sftpMkdir(session.connectionId, joinRemote(cwd, trimmed));
      setNewDirName("");
      setCreatingDir(false);
      await browse(session.connectionId, cwd);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const handleRenameCommit = async (entry: SftpEntry) => {
    if (!session) return;
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === entry.name) {
      setRenamingPath(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextPath = joinRemote(parentOf(entry.path), trimmed);
      await ipc.sftpRename(session.connectionId, entry.path, nextPath);
      setRenamingPath(null);
      await browse(session.connectionId, cwd);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const handleDeleteConfirm = async (entry: SftpEntry) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.sftpDelete(session.connectionId, entry.path, entry.directory);
      setConfirmDelete(null);
      await browse(session.connectionId, cwd);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const openEditor = async (entry: SftpEntry) => {
    if (!session || entry.directory) return;
    setBusy(true);
    setError(null);
    try {
      const text = await ipc.sftpReadText(session.connectionId, entry.path);
      setEditor({
        path: entry.path,
        name: entry.name,
        initial: text,
        content: text,
        saving: false,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveEditor = useCallback(async () => {
    if (!session || !editor || editor.saving) return;
    setEditor((prev) => (prev ? { ...prev, saving: true } : null));
    setError(null);
    try {
      const bytes = await ipc.sftpWriteText(session.connectionId, editor.path, editor.content);
      setEditor((prev) =>
        prev ? { ...prev, initial: prev.content, saving: false } : null,
      );
      setNote(`${t("sftp.savedFile")}: ${editor.name} (${formatBytes(bytes)})`);
      await browse(session.connectionId, cwd);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setEditor((prev) => (prev ? { ...prev, saving: false } : null));
    }
  }, [browse, cwd, editor, session, t]);

  const handleFollowTerminalCwd = async () => {
    if (!session || !activeSessionId || !isTauri()) return;
    setError(null);
    try {
      const snap = await ipc.screenSnapshot(activeSessionId);
      const guessed = guessCwdFromLines(snap.lines);
      if (!guessed) {
        setNote(t("sftp.followNotDetected"));
        return;
      }
      const target =
        guessed === "~"
          ? session.home
          : guessed.startsWith("~/")
            ? joinRemote(session.home, guessed.slice(2))
            : guessed;
      await browse(session.connectionId, target);
      setNote(`${t("sftp.followedCwd")}: ${target}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const progressPct =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.transferred / progress.total) * 100))
      : null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-start backdrop-blur-[2px]"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <aside
        className="flex h-full w-[32rem] max-w-[92vw] flex-col border-r border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">
              {t("sftp.title")}
            </h2>
            {session ? (
              <p className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                {session.username}@{session.host}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            {session ? (
              <button
                type="button"
                onClick={() => void disconnect()}
                className="rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
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
          </div>
        </header>

        {!session ? (
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <p className="mb-3 text-[11.5px] text-[var(--text-muted)]">
              {t("sftp.pickProfile")}
            </p>
            {profiles.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--border-subtle)] px-3 py-6 text-center text-xs text-[var(--text-muted)]">
                {t("sftp.noProfiles")}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {profiles.map((profile) => {
                  const host = String(profile.payload.host ?? "");
                  const user = String(profile.payload.username ?? "");
                  return (
                    <li key={profile.id}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void connect(profile.id)}
                        className="flex w-full items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-left transition hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-[var(--text-primary)]">
                            {profile.name}
                          </div>
                          <div className="truncate font-mono text-[10.5px] text-[var(--text-muted)]">
                            {user}@{host}
                          </div>
                        </div>
                        <span
                          className="shrink-0 text-[11px] font-medium"
                          style={{ color: "var(--accent)" }}
                        >
                          {t("sftp.browse")}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div
            className="relative flex min-h-0 flex-1 flex-col"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDragging(false);
            }}
            onDrop={(event) => void handleDropFiles(event)}
          >
            {/* Path bar & breadcrumbs */}
            <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy || cwd === "/"}
                  onClick={() => void browse(session.connectionId, parentOf(cwd))}
                  title={t("sftp.up")}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-xs text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-40"
                >
                  ↑
                </button>
                {editingPath ? (
                  <input
                    autoFocus
                    value={pathDraft}
                    onChange={(event) => setPathDraft(event.target.value)}
                    onBlur={() => setEditingPath(false)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        setEditingPath(false);
                        const next = pathDraft.trim() || "/";
                        void browse(session.connectionId, next);
                      }
                    }}
                    className="ota-input !h-7 flex-1 font-mono !text-[11.5px]"
                  />
                ) : (
                  <div
                    onClick={() => {
                      setPathDraft(cwd);
                      setEditingPath(true);
                    }}
                    title={t("sftp.clickToEditPath")}
                    className="flex h-7 min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-x-auto rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] text-[var(--text-secondary)]"
                  >
                    {breadcrumbs.map((crumb, idx) => (
                      <span key={crumb.path} className="flex shrink-0 items-center">
                        {idx > 0 ? (
                          <span className="mx-0.5 text-[var(--text-muted)] opacity-50">/</span>
                        ) : null}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void browse(session.connectionId, crumb.path);
                          }}
                          className="rounded px-1 py-0.5 transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                          {crumb.label}
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void browse(session.connectionId, cwd)}
                  title={t("serial.refresh")}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-xs text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-40"
                >
                  ↻
                </button>
              </div>

              {/* Action bar */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleUploadPicker()}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                  style={{ backgroundColor: "var(--accent)" }}
                >
                  <span>↑</span>
                  <span>{t("sftp.upload")}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setCreatingDir((prev) => !prev);
                    setNewDirName("");
                  }}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px] text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-40"
                >
                  <span>+</span>
                  <span>{t("sftp.newFolder")}</span>
                </button>
                {activeSessionId ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleFollowTerminalCwd()}
                    title={t("sftp.followCwdTooltip")}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[11px] text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-40"
                  >
                    <span>⌖</span>
                    <span>{t("sftp.followCwd")}</span>
                  </button>
                ) : null}
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t("sftp.filterPlaceholder")}
                  className="ota-input ml-auto !h-7 !w-32 !text-[11px]"
                />
              </div>

              {creatingDir ? (
                <div className="mt-2 flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={newDirName}
                    onChange={(event) => setNewDirName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleCreateDir();
                    }}
                    placeholder={t("sftp.newFolderPlaceholder")}
                    className="ota-input !h-7 flex-1 font-mono !text-[11.5px]"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCreateDir()}
                    className="h-7 rounded-md px-2.5 text-[11px] font-medium text-white"
                    style={{ backgroundColor: "var(--accent)" }}
                  >
                    {t("common.create")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreatingDir(false)}
                    className="h-7 rounded-md px-2 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              ) : null}
            </div>

            {/* Live progress bar */}
            {progress ? (
              <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span className="truncate font-mono text-[var(--text-primary)]">
                    {progress.kind === "upload" ? "↑" : "↓"} {progress.name}
                  </span>
                  <span className="ota-tabular shrink-0 font-mono text-[var(--text-muted)]">
                    {formatBytes(progress.transferred)}
                    {progress.total ? ` / ${formatBytes(progress.total)}` : ""}
                    {progressPct !== null ? ` (${progressPct}%)` : ""}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                  <div
                    className="h-full rounded-full transition-all duration-150"
                    style={{
                      width: `${progressPct ?? 40}%`,
                      backgroundColor: "var(--accent)",
                    }}
                  />
                </div>
              </div>
            ) : null}

            {/* File list */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
              {filteredEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-center text-xs text-[var(--text-muted)]">
                  <span>{busy ? t("sftp.loading") : t("sftp.emptyDir")}</span>
                  <span className="text-[11px] opacity-75">{t("sftp.dropHint")}</span>
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {filteredEntries.map((entry) => {
                    const isRenaming = renamingPath === entry.path;
                    const isConfirming = confirmDelete?.path === entry.path;
                    return (
                      <li
                        key={entry.path}
                        className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition hover:bg-[var(--bg-hover)]"
                      >
                        {isRenaming ? (
                          <div className="flex flex-1 items-center gap-1.5">
                            <input
                              autoFocus
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void handleRenameCommit(entry);
                                if (event.key === "Escape") setRenamingPath(null);
                              }}
                              className="ota-input !h-6 flex-1 font-mono !text-[11.5px]"
                            />
                            <button
                              type="button"
                              onClick={() => void handleRenameCommit(entry)}
                              className="rounded px-2 py-0.5 text-[10.5px] font-medium text-white"
                              style={{ backgroundColor: "var(--accent)" }}
                            >
                              {t("common.save")}
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                if (entry.directory) {
                                  void browse(session.connectionId, entry.path);
                                }
                              }}
                              onDoubleClick={() => {
                                if (entry.directory) {
                                  void browse(session.connectionId, entry.path);
                                } else {
                                  void openEditor(entry);
                                }
                              }}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                              <span
                                className="shrink-0 font-mono text-[10.5px] font-semibold"
                                style={{
                                  color: entry.directory
                                    ? "var(--accent)"
                                    : "var(--text-muted)",
                                }}
                              >
                                {entry.directory ? "DIR" : entry.symlink ? "LNK" : "FILE"}
                              </span>
                              <span className="truncate font-mono text-[12px] text-[var(--text-primary)]">
                                {entry.name}
                              </span>
                            </button>

                            <span className="ota-tabular hidden shrink-0 font-mono text-[10px] text-[var(--text-muted)] sm:inline">
                              {formatMode(entry.permissions)}
                            </span>
                            <span className="ota-tabular shrink-0 font-mono text-[10.5px] text-[var(--text-muted)]">
                              {entry.directory ? "" : formatBytes(entry.size)}
                            </span>

                            {isConfirming ? (
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleDeleteConfirm(entry)}
                                  className="rounded px-1.5 py-0.5 text-[10.5px] font-medium text-white"
                                  style={{ backgroundColor: "var(--status-danger)" }}
                                >
                                  {t("sftp.confirmDelete")}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDelete(null)}
                                  className="rounded px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]"
                                >
                                  {t("common.cancel")}
                                </button>
                              </div>
                            ) : (
                              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                                {!entry.directory ? (
                                  <>
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => void openEditor(entry)}
                                      title={t("sftp.editInline")}
                                      className="rounded px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                                    >
                                      {t("sftp.edit")}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => void handleDownload(entry)}
                                      title={t("sftp.download")}
                                      className="rounded px-1.5 py-0.5 text-[10.5px] font-medium hover:bg-[var(--bg-elevated)]"
                                      style={{ color: "var(--accent)" }}
                                    >
                                      ↓
                                    </button>
                                  </>
                                ) : null}
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setRenamingPath(entry.path);
                                    setRenameDraft(entry.name);
                                  }}
                                  title={t("sftp.rename")}
                                  className="rounded px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                                >
                                  ✎
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setConfirmDelete(entry)}
                                  title={t("sftp.delete")}
                                  className="rounded px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--status-danger)]"
                                >
                                  ×
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Drag-and-drop overlay */}
            {dragging ? (
              <div
                className="pointer-events-none absolute inset-2 flex flex-col items-center justify-center rounded-xl border-2 border-dashed backdrop-blur-[1px]"
                style={{
                  borderColor: "var(--accent)",
                  backgroundColor: "var(--accent-soft)",
                }}
              >
                <span className="text-sm font-semibold" style={{ color: "var(--accent)" }}>
                  {t("sftp.dropToUpload")}
                </span>
                <span className="mt-1 font-mono text-[11px] text-[var(--text-secondary)]">
                  → {cwd}
                </span>
              </div>
            ) : null}

            {/* Footer hint */}
            <div className="border-t border-[var(--border-subtle)] px-3 py-1.5 text-[10.5px] text-[var(--text-muted)]">
              {t("sftp.footerHint")}
            </div>
          </div>
        )}

        {note ? (
          <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-2 text-[11px] text-[var(--status-ok)]">
            {note}
          </div>
        ) : null}
        {error ? (
          <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-2 text-[11px] text-[var(--status-danger)]">
            {error}
          </div>
        ) : null}
      </aside>

      {/* Inline remote text/config editor modal */}
      {editor ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-[2px]"
          style={{ backgroundColor: "var(--overlay)" }}
          onClick={() => setEditor(null)}
        >
          <div
            className="flex h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-xs font-semibold text-[var(--text-primary)]">
                  {editor.path}
                </span>
                {editor.content !== editor.initial ? (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: "var(--accent-soft)",
                      color: "var(--accent)",
                    }}
                  >
                    {t("sftp.unsaved")}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
                  {editor.content.split("\n").length} {t("sftp.lines")}
                </span>
                <button
                  type="button"
                  disabled={editor.saving || editor.content === editor.initial}
                  onClick={() => void saveEditor()}
                  className="rounded-md px-3 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                  style={{ backgroundColor: "var(--accent)" }}
                >
                  {editor.saving
                    ? t("sftp.saving")
                    : `${t("common.save")} (${isMac ? "⌘S" : "Ctrl+S"})`}
                </button>
                <button
                  type="button"
                  onClick={() => setEditor(null)}
                  className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  {t("common.close")}
                </button>
              </div>
            </header>
            <textarea
              value={editor.content}
              onChange={(event) =>
                setEditor((prev) => (prev ? { ...prev, content: event.target.value } : null))
              }
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  void saveEditor();
                }
              }}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none bg-[var(--bg-canvas)] p-4 font-mono text-[12.5px] leading-relaxed text-[var(--text-primary)] outline-none"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
