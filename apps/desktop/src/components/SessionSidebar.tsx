// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  FolderOpen,
  Moon,
  Pencil,
  Plus,
  Radar,
  Search,
  Server,
  Settings,
  Sun,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ResolvedTheme } from "../hooks/useTheme";
import type { SavedSession, SessionKind, ShellProfile } from "../lib/ipc";
import { isMac } from "../lib/platform";
import type { SessionView } from "../types";

interface SessionSidebarProps {
  sessions: SessionView[];
  activeId: string | null;
  shells: ShellProfile[];
  saved: SavedSession[];
  creating: boolean;
  activeTunnelCount: number;
  resolvedTheme: ResolvedTheme;
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
  onOpenFleet: () => void;
  onOpenPalette: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
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
  activeTunnelCount,
  resolvedTheme,
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
  onOpenFleet,
  onOpenPalette,
  onToggleTheme,
  onOpenSettings,
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
    <aside className="flex w-[228px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)] select-none">
      {/* Quiet command palette search trigger */}
      <div className="px-2.5 pt-2.5 pb-1.5">
        <button
          type="button"
          onClick={onOpenPalette}
          className="flex h-7 w-full items-center gap-2 rounded-md bg-[var(--bg-elevated)] px-2 text-left text-[12px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
        >
          <Search className="h-3.5 w-3.5 shrink-0 opacity-75" strokeWidth={1.65} />
          <span className="truncate">{t("sidebar.quickFind")}</span>
          <kbd className="ml-auto shrink-0 font-sans text-[10.5px] leading-none text-[var(--text-muted)] opacity-75">
            {isMac ? "⌘K" : "Ctrl+K"}
          </kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* Open Sessions */}
        <section className="mt-2">
          <div className="ota-section-label flex items-center justify-between px-2 py-1">
            <span>{t("sidebar.workspace")}</span>
            <button
              type="button"
              disabled={creating}
              onClick={() => onCreate()}
              title={t("sidebar.newSession")}
              className="inline-flex h-4 w-4 items-center justify-center rounded text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              <Plus className="h-3 w-3" strokeWidth={1.8} />
            </button>
          </div>

          {sessions.length === 0 ? (
            <p className="px-2 py-1.5 text-[11.5px] text-[var(--text-muted)]">
              {t("sidebar.noSessions")}
            </p>
          ) : (
            <ul className="space-y-0.5">
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
                        className="ota-input !h-7 py-0 text-[12px]"
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
                        className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition ${
                          active
                            ? "bg-[var(--bg-active)] font-medium text-[var(--text-primary)]"
                            : "font-normal text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor: session.exited
                              ? "var(--status-danger)"
                              : session.envTag === "prod"
                                ? "var(--status-danger)"
                                : KIND_DOT_COLOR[session.kind],
                          }}
                        />
                        <span className="truncate">{session.label}</span>
                        {session.envTag === "prod" ? (
                          <span
                            className="ml-auto shrink-0 font-mono text-[9.5px] font-semibold"
                            style={{ color: "var(--status-danger)" }}
                          >
                            PROD
                          </span>
                        ) : null}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Tools & Connections — compact Linear-style navigation list */}
        <section className="mt-4">
          <div className="space-y-0.5">
            <button
              type="button"
              onClick={onOpenSsh}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Server className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
              <span className="truncate">{t("sidebar.ssh")}</span>
            </button>

            <button
              type="button"
              onClick={onOpenSftp}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
              <span className="truncate">{t("sidebar.sftp")}</span>
            </button>

            <button
              type="button"
              onClick={onOpenTunnels}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
              <span className="truncate">{t("sidebar.tunnels")}</span>
              {activeTunnelCount > 0 ? (
                <span
                  className="ota-tabular ml-auto font-mono text-[10.5px] font-medium"
                  style={{ color: "var(--status-ok)" }}
                >
                  {activeTunnelCount}
                </span>
              ) : null}
            </button>

            <button
              type="button"
              onClick={onOpenFleet}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Radar className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
              <span className="truncate">{t("fleet.sidebarLabel")}</span>
            </button>

            <button
              type="button"
              onClick={onOpenSerial}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Cpu className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
              <span className="truncate">{t("sidebar.serial")}</span>
            </button>
          </div>
        </section>

        {/* Saved Hosts (grouped folders, edit & ~/.ssh/config import) */}
        <section className="mt-4">
          <div className="ota-section-label flex items-center justify-between px-2 py-1">
            <span>{t("sidebar.saved")}</span>
            <button
              type="button"
              onClick={onImportSshConfig}
              title={t("sshImport.buttonTooltip")}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Download className="h-2.5 w-2.5" strokeWidth={1.7} />
              <span>{t("sshImport.shortButton")}</span>
            </button>
          </div>

          {saved.length === 0 ? (
            <p className="px-2 py-1 text-[11.5px] leading-relaxed text-[var(--text-muted)] opacity-80">
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
                      className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
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
                          className="ml-auto shrink-0 font-mono text-[9.5px] font-semibold"
                          style={{ color: "var(--status-danger)" }}
                        >
                          PROD
                        </span>
                      ) : envTag === "staging" ? (
                        <span
                          className="ml-auto shrink-0 font-mono text-[9.5px] font-semibold"
                          style={{ color: "var(--status-warn)" }}
                        >
                          STG
                        </span>
                      ) : null}
                    </button>
                    {entry.kind === "ssh" ? (
                      <button
                        type="button"
                        aria-label={t("sftp.edit")}
                        onClick={() => onEditSaved(entry)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--text-primary)]"
                      >
                        <Pencil className="h-3 w-3" strokeWidth={1.6} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={t("common.delete")}
                      onClick={() => onDeleteSaved(entry.id)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--status-danger)]"
                    >
                      <Trash2 className="h-3 w-3" strokeWidth={1.6} />
                    </button>
                  </li>
                );
              };

              if (!hasCustomGroups) {
                return <ul className="space-y-0.5">{saved.map(renderRow)}</ul>;
              }

              return (
                <div className="space-y-1">
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
                          className="flex h-6 w-full items-center gap-1 rounded px-2 text-left text-[11px] font-medium text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
                        >
                          {collapsed ? (
                            <ChevronRight className="h-3 w-3 shrink-0" strokeWidth={1.7} />
                          ) : (
                            <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={1.7} />
                          )}
                          <span className="truncate">{label}</span>
                          <span className="ota-tabular ml-auto text-[10px] opacity-65">
                            {items.length}
                          </span>
                        </button>
                        {!collapsed ? (
                          <ul className="mt-0.5 space-y-0.5 pl-2">{items.map(renderRow)}</ul>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })()
          )}
        </section>

        {/* Additional shells */}
        {shells.some((profile) => !profile.default) ? (
          <section className="mt-4">
            <div className="ota-section-label px-2 py-1">{t("sidebar.shells")}</div>
            <ul className="space-y-0.5">
              {shells
                .filter((profile) => !profile.default)
                .map((profile) => (
                  <li key={profile.command}>
                    <button
                      type="button"
                      title={profile.command}
                      onClick={() => onCreate(profile.command)}
                      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      <Terminal className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
                      <span className="truncate">{profile.label}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* Calm Linear/Raycast single-row bottom utility bar (zero KPI dashboard clutter) */}
      <div className="flex h-9 shrink-0 items-center justify-between border-t border-[var(--border-subtle)] px-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Settings className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.6} />
          <span>{t("settings.title")}</span>
        </button>

        <button
          type="button"
          onClick={onToggleTheme}
          title={`${t("settings.appearance")}: ${t(`settings.theme.${resolvedTheme}`)}`}
          aria-label={t("settings.appearance")}
          className="ota-icon-btn"
        >
          {resolvedTheme === "light" ? (
            <Sun className="h-3.5 w-3.5" strokeWidth={1.65} />
          ) : (
            <Moon className="h-3.5 w-3.5" strokeWidth={1.65} />
          )}
        </button>
      </div>

      {/* Localized right-click menu for sidebar sessions */}
      {contextMenu ? (
        <div
          onMouseDown={(event) => event.stopPropagation()}
          className="ota-dialog-panel fixed z-50 w-40 overflow-hidden rounded-lg bg-[var(--bg-surface)] py-1"
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
            <Pencil className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
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
            <Download className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.6} />
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
            <X className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
            <span>{t("tabs.close")}</span>
          </button>
        </div>
      ) : null}
    </aside>
  );
}
