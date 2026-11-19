// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

import type { SavedSession, SessionKind } from "../lib/ipc";
import type { ShellProfile } from "../lib/ipc";
import type { SessionView } from "../types";

interface SessionSidebarProps {
  sessions: SessionView[];
  activeId: string | null;
  shells: ShellProfile[];
  saved: SavedSession[];
  creating: boolean;
  onSelect: (sessionId: string) => void;
  onCreate: (shell?: string) => void;
  onOpenSaved: (id: string) => void;
  onDeleteSaved: (id: string) => void;
  onOpenSsh: () => void;
  onOpenSerial: () => void;
  onOpenSftp: () => void;
}

const KIND_BADGE: Record<SessionKind, string> = {
  local: "bg-emerald-500/15 text-emerald-300",
  ssh: "bg-sky-500/15 text-sky-300",
  serial: "bg-violet-500/15 text-violet-300",
};

export function SessionSidebar({
  sessions,
  activeId,
  shells,
  saved,
  creating,
  onSelect,
  onCreate,
  onOpenSaved,
  onDeleteSaved,
  onOpenSsh,
  onOpenSerial,
  onOpenSftp,
}: SessionSidebarProps) {
  const { t } = useTranslation();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800/80 bg-slate-950/40">
      <div className="flex items-center justify-between px-3 py-2 text-[11px] font-semibold tracking-widest text-slate-500 uppercase">
        <span>{t("sidebar.sessions")}</span>
        <span className="rounded bg-slate-800/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
          {sessions.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {sessions.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-slate-500">
            {t("sidebar.noSessions")}
          </p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((session) => {
              const active = session.id === activeId;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(session.id)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition ${
                      active
                        ? "bg-slate-800/80 text-slate-100"
                        : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        session.exited ? "bg-rose-400" : "bg-emerald-400"
                      }`}
                    />
                    <span className="truncate font-mono">{session.label}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-500">
                      {session.size.cols}×{session.size.rows}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <button
          type="button"
          onClick={() => onCreate()}
          disabled={creating}
          className="mt-3 w-full rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1.5 text-xs text-cyan-200 transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? t("sidebar.creating") : t("sidebar.newSession")}
        </button>

        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={onOpenSsh}
            className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1.5 text-xs text-sky-200 transition hover:bg-sky-500/20"
          >
            {t("sidebar.ssh")}
          </button>
          <button
            type="button"
            onClick={onOpenSerial}
            className="rounded border border-violet-500/30 bg-violet-500/10 px-2 py-1.5 text-xs text-violet-200 transition hover:bg-violet-500/20"
          >
            {t("sidebar.serial")}
          </button>
        </div>

        <section className="mt-5">
          <h2 className="px-2 text-[10px] tracking-widest text-slate-600 uppercase">
            {t("sidebar.saved")}
          </h2>
          {saved.length === 0 ? (
            <p className="px-2 py-1 text-[11px] leading-relaxed text-slate-600">
              {t("sidebar.noSaved")}
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {saved.map((entry) => (
                <li key={entry.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onOpenSaved(entry.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-200"
                  >
                    <span className={`rounded px-1 py-0.5 text-[9px] uppercase ${KIND_BADGE[entry.kind]}`}>
                      {t(`sidebar.kinds.${entry.kind}`)}
                    </span>
                    <span className="truncate">{entry.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t("common.delete")}
                    onClick={() => onDeleteSaved(entry.id)}
                    className="rounded px-1 text-slate-600 opacity-0 transition group-hover:opacity-100 hover:text-rose-300"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5">
          <h2 className="px-2 text-[10px] tracking-widest text-slate-600 uppercase">
            {t("sidebar.filesGroup")}
          </h2>
          <button
            type="button"
            onClick={onOpenSftp}
            className="mt-1 w-full truncate rounded border border-sky-500/25 bg-sky-500/5 px-2 py-1.5 text-left text-xs text-sky-200/90 transition hover:bg-sky-500/15"
          >
            {t("sidebar.sftp")}
          </button>
        </section>

        {shells.length > 1 ? (
          <section className="mt-5">
            <h2 className="px-2 text-[10px] tracking-widest text-slate-600 uppercase">
              {t("sidebar.shells")}
            </h2>
            <ul className="mt-1 space-y-0.5">
              {shells
                .filter((profile) => !profile.default)
                .map((profile) => (
                  <li key={profile.command}>
                    <button
                      type="button"
                      title={profile.command}
                      onClick={() => onCreate(profile.command)}
                      className="w-full truncate rounded px-2 py-1 text-left text-xs text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-200"
                    >
                      {profile.label}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="border-t border-slate-800/60 px-2 py-2">
        <div className="flex flex-wrap gap-1">
          {(Object.keys(KIND_BADGE) as SessionKind[]).map((kind) => (
            <span
              key={kind}
              className={`rounded px-1.5 py-0.5 text-[9px] tracking-wider uppercase ${KIND_BADGE[kind]}`}
            >
              {t(`sidebar.kinds.${kind}`)}
            </span>
          ))}
        </div>
      </div>
    </aside>
  );
}
