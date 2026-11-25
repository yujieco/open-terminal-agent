// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SavedSession, SessionKind, ShellProfile } from "../lib/ipc";
import { isMac } from "../lib/platform";
import type { SessionView } from "../types";

interface SessionSidebarProps {
  sessions: SessionView[];
  activeId: string | null;
  shells: ShellProfile[];
  saved: SavedSession[];
  creating: boolean;
  agentRunning: boolean;
  activeTunnelCount: number;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, nextLabel: string) => void;
  onCloseSession: (sessionId: string) => void;
  onExportLog: (session: SessionView) => void;
  onCreate: (shell?: string) => void;
  onOpenSaved: (id: string) => void;
  onEditSaved: (profile: SavedSession) => void;
  onDeleteSaved: (id: string) => void;
  onImportSshConfig: () => void;
  onOpenSsh: () => void;
  onOpenSerial: () => void;
  onOpenSftp: () => void;
  onOpenTunnels: () => void;
  onOpenPalette: () => void;
}

const KIND_DOT_COLOR: Record<SessionKind, string> = {
  local: "var(--status-ok)",
  ssh: "var(--accent)",
  serial: "var(--status-warn)",
};

export function SessionSidebar({
  sessions,
  activeId,
  shells,
  saved,
  creating,
  agentRunning,
  activeTunnelCount,
  onSelect,
  onRename,
  onCloseSession,
  onExportLog,
  onCreate,
  onOpenSaved,
  onEditSaved,
  onDeleteSaved,
  onImportSshConfig,
  onOpenSsh,
  onOpenSerial,
  onOpenSftp,
  onOpenTunnels,
  onOpenPalette,
}: SessionSidebarProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    session: SessionView;
  } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  const localCount = sessions.filter((s) => s.kind === "local").length;
  const sshCount = sessions.filter((s) => s.kind === "ssh").length;
  const serialCount = sessions.filter((s) => s.kind === "serial").length;

  const beginEdit = (session: SessionView) => {
    setEditingId(session.id);
    setDraftLabel(session.label);
  };

  const commitEdit = (sessionId: string) => {
    const trimmed = draftLabel.trim();
    if (trimmed.length > 0) {
      onRename(sessionId, trimmed);
    }
    setEditingId(null);
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)]">
      {/* Quick find / Command palette trigger */}
      <div className="px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={onOpenPalette}
          className="flex w-full items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-left text-xs text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]"
        >
          <svg
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5 shrink-0 opacity-70"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <span className="truncate">{t("sidebar.quickFind")}</span>
          <kbd className="ml-auto inline-flex h-5 shrink-0 items-center justify-center gap-[2px] rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-1.5 font-sans text-[10px] leading-none text-[var(--text-muted)]">
            {isMac ? (
              <>
                <span className="text-[11.5px] leading-none">⌘</span>
                <span className="font-medium leading-none">K</span>
              </>
            ) : (
              <span className="font-medium leading-none">Ctrl+K</span>
            )}
          </kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {/* WORKSPACE: active sessions */}
        <section className="mt-2">
          <div className="ota-section-label flex items-center justify-between px-2 py-1">
            <span>{t("sidebar.workspace")}</span>
            <span className="ota-tabular">{sessions.length}</span>
          </div>

          {sessions.length === 0 ? (
            <p className="px-2 py-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
              {t("sidebar.noSessions")}
            </p>
          ) : (
            <ul className="mt-0.5 space-y-0.5">
              {sessions.map((session) => {
                const active = session.id === activeId;
                const editing = editingId === session.id;
                return (
                  <li key={session.id}>
                    {editing ? (
                      <input
                        autoFocus
                        value={draftLabel}
                        onChange={(event) => setDraftLabel(event.target.value)}
                        onBlur={() => commitEdit(session.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitEdit(session.id);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingId(null);
                          }
                        }}
                        className="ota-input py-1 text-[12.5px]"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelect(session.id)}
                        onDoubleClick={() => beginEdit(session)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setContextMenu({
                            x: Math.min(event.clientX, window.innerWidth - 180),
                            y: Math.min(event.clientY, window.innerHeight - 130),
                            session,
                          });
                        }}
                        title={t("tabs.renameHint")}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition ${
                          active
                            ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)]"
                            : "font-normal text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor: session.exited
                              ? "var(--status-danger)"
                              : KIND_DOT_COLOR[session.kind],
                          }}
                        />
                        <span className="truncate">{session.label}</span>
                        <span className="ml-auto shrink-0 text-[11px] font-normal text-[var(--text-muted)]">
                          {t(`sidebar.kinds.${session.kind}`)}
                        </span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Quick connect navigation */}
          <div className="mt-2 space-y-0.5">
            <button
              type="button"
              onClick={() => onCreate()}
              disabled={creating}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M3 4.5L6.5 8L3 11.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M8 11.5H13" strokeLinecap="round" />
              </svg>
              <span className="truncate">
                {creating ? t("sidebar.creating") : t("sidebar.newSession")}
              </span>
            </button>

            <button
              type="button"
              onClick={onOpenSsh}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              >
                <rect x="2.5" y="3" width="11" height="7" rx="1.5" />
                <path d="M5.5 13H10.5M8 10V13" strokeLinecap="round" />
              </svg>
              <span className="truncate">{t("sidebar.ssh")}</span>
            </button>

            <button
              type="button"
              onClick={onOpenSerial}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              >
                <rect x="3" y="4.5" width="10" height="7" rx="1.5" />
                <path d="M5.5 7.5H6.5M9.5 7.5H10.5M7 9.5H9" strokeLinecap="round" />
              </svg>
              <span className="truncate">{t("sidebar.serial")}</span>
            </button>

            <button
              type="button"
              onClick={onOpenSftp}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              >
                <path
                  d="M2.5 4.5A1.5 1.5 0 014 3h2.6l1.3 1.5H12A1.5 1.5 0 0113.5 6v5.5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7z"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="truncate">{t("sidebar.sftp")}</span>
            </button>

            <button
              type="button"
              onClick={onOpenTunnels}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2.5 5.5h8.5M8.5 3l2.5 2.5L8.5 8" />
                <path d="M13.5 10.5H5M7.5 8L5 10.5 7.5 13" />
              </svg>
              <span className="truncate">{t("sidebar.tunnels")}</span>
              {activeTunnelCount > 0 ? (
                <span
                  className="ota-tabular ml-auto inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold"
                  style={{
                    backgroundColor: "var(--status-ok-soft)",
                    color: "var(--status-ok)",
                  }}
                >
                  {activeTunnelCount}
                </span>
              ) : null}
            </button>
          </div>
        </section>

        {/* SAVED (grouped by folder with env tags, edit & ~/.ssh/config import) */}
        <section className="mt-5">
          <div className="ota-section-label flex items-center justify-between px-2 py-1">
            <span>{t("sidebar.saved")}</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={onImportSshConfig}
                title={t("sshImport.buttonTooltip")}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
              >
                {t("sshImport.shortButton")}
              </button>
              {saved.length > 0 ? <span className="ota-tabular">{saved.length}</span> : null}
            </div>
          </div>

          {saved.length === 0 ? (
            <p className="px-2 py-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
              {t("sidebar.noSaved")}
            </p>
          ) : (
            (() => {
              const grouped = new Map<string, SavedSession[]>();
              for (const entry of saved) {
                const rawGroup =
                  typeof entry.payload?.groupName === "string"
                    ? entry.payload.groupName.trim()
                    : "";
                const key = rawGroup || "__default__";
                const bucket = grouped.get(key) ?? [];
                bucket.push(entry);
                grouped.set(key, bucket);
              }
              const hasCustomGroups = Array.from(grouped.keys()).some(
                (key) => key !== "__default__",
              );

              const renderRow = (entry: SavedSession) => {
                const envTag =
                  typeof entry.payload?.envTag === "string" ? entry.payload.envTag : undefined;
                return (
                  <li key={entry.id} className="group flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => onOpenSaved(entry.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor:
                            envTag === "prod"
                              ? "var(--status-danger)"
                              : envTag === "staging"
                                ? "var(--status-warn)"
                                : KIND_DOT_COLOR[entry.kind],
                        }}
                      />
                      <span className="truncate">{entry.name}</span>
                      {envTag === "prod" ? (
                        <span
                          className="ml-auto shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-bold"
                          style={{
                            backgroundColor: "rgba(239, 68, 68, 0.14)",
                            color: "var(--status-danger)",
                          }}
                        >
                          PROD
                        </span>
                      ) : envTag === "staging" ? (
                        <span
                          className="ml-auto shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-semibold"
                          style={{
                            backgroundColor: "rgba(245, 158, 11, 0.14)",
                            color: "var(--status-warn)",
                          }}
                        >
                          STG
                        </span>
                      ) : (
                        <span className="ml-auto text-[10.5px] text-[var(--text-muted)]">
                          {t(`sidebar.kinds.${entry.kind}`)}
                        </span>
                      )}
                    </button>
                    {entry.kind === "ssh" ? (
                      <button
                        type="button"
                        aria-label={t("sftp.edit")}
                        onClick={() => onEditSaved(entry)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-[11px] text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--text-primary)]"
                      >
                        ✎
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={t("common.delete")}
                      onClick={() => onDeleteSaved(entry.id)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--status-danger)]"
                    >
                      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </li>
                );
              };

              if (!hasCustomGroups) {
                return <ul className="mt-0.5 space-y-0.5">{saved.map(renderRow)}</ul>;
              }

              return (
                <div className="mt-1 space-y-1.5">
                  {Array.from(grouped.entries()).map(([groupKey, items]) => {
                    const collapsed = Boolean(collapsedGroups[groupKey]);
                    const label =
                      groupKey === "__default__" ? t("ssh.defaultGroup") : groupKey;
                    return (
                      <div key={groupKey}>
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedGroups((prev) => ({
                              ...prev,
                              [groupKey]: !prev[groupKey],
                            }))
                          }
                          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] font-medium text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
                        >
                          <span className="text-[9px]">{collapsed ? "▸" : "▾"}</span>
                          <span className="truncate">{label}</span>
                          <span className="ota-tabular ml-auto text-[10px] opacity-70">
                            {items.length}
                          </span>
                        </button>
                        {!collapsed ? (
                          <ul className="mt-0.5 space-y-0.5 pl-1.5">{items.map(renderRow)}</ul>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })()
          )}
        </section>

        {/* Additional shells (only shown when non-default shells are available) */}
        {shells.some((profile) => !profile.default) ? (
          <section className="mt-5">
            <div className="ota-section-label px-2 py-1">
              {t("sidebar.shells")}
            </div>
            <ul className="mt-0.5 space-y-0.5">
              {shells
                .filter((profile) => !profile.default)
                .map((profile) => (
                  <li key={profile.command}>
                    <button
                      type="button"
                      title={profile.command}
                      onClick={() => onCreate(profile.command)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center font-mono text-[11px] text-[var(--text-muted)]">
                        $
                      </span>
                      <span className="truncate">{profile.label}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* Bottom honest session overview card (real protocol counts, calibrated type scale) */}
      <div className="p-2.5">
        <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <div className="flex items-center justify-between">
            <span className="ota-section-label">{t("sidebar.telemetry")}</span>
            <span
              className="flex items-center gap-1.5 text-[11px] font-medium"
              style={{ color: agentRunning ? "var(--accent)" : "var(--status-ok)" }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: agentRunning ? "var(--accent)" : "var(--status-ok)" }}
              />
              {agentRunning ? t("agent.running") : t("sidebar.live")}
            </span>
          </div>

          <div className="mt-2.5 grid grid-cols-3 gap-1.5 text-center">
            <div className="rounded-md bg-[var(--bg-canvas)] px-1.5 py-1.5">
              <div className="ota-tabular text-[14px] font-semibold leading-tight text-[var(--text-primary)]">
                {localCount}
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                {t("sidebar.kinds.local")}
              </div>
            </div>
            <div className="rounded-md bg-[var(--bg-canvas)] px-1.5 py-1.5">
              <div className="ota-tabular text-[14px] font-semibold leading-tight text-[var(--text-primary)]">
                {sshCount}
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                {t("sidebar.kinds.ssh")}
              </div>
            </div>
            <div className="rounded-md bg-[var(--bg-canvas)] px-1.5 py-1.5">
              <div className="ota-tabular text-[14px] font-semibold leading-tight text-[var(--text-primary)]">
                {serialCount}
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                {t("sidebar.kinds.serial")}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Localized right-click menu for sidebar sessions */}
      {contextMenu ? (
        <div
          onMouseDown={(event) => event.stopPropagation()}
          className="fixed z-50 w-40 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] py-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            onClick={() => {
              const target = contextMenu.session;
              setContextMenu(null);
              beginEdit(target);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11.2 2.8l2 2L5.5 12.5 3 13l.5-2.5 7.7-7.7z" />
            </svg>
            <span>{t("tabs.rename")}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const target = contextMenu.session;
              setContextMenu(null);
              onExportLog(target);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2.5v7.5M5.2 7.2L8 10l2.8-2.8M3 12.5h10" />
            </svg>
            <span>{t("exportLog.menuItem")}</span>
          </button>
          <div className="my-1 border-t border-[var(--border-subtle)]" />
          <button
            type="button"
            onClick={() => {
              const targetId = contextMenu.session.id;
              setContextMenu(null);
              onCloseSession(targetId);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--status-danger)" }}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
            <span>{t("tabs.close")}</span>
          </button>
        </div>
      ) : null}
    </aside>
  );
}
