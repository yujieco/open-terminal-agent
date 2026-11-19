// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

import type { ShellProfile } from "../lib/ipc";
import type { SessionView } from "../types";

interface SessionSidebarProps {
  sessions: SessionView[];
  activeId: string | null;
  shells: ShellProfile[];
  creating: boolean;
  onSelect: (sessionId: string) => void;
  onCreate: (shell?: string) => void;
}

export function SessionSidebar({
  sessions,
  activeId,
  shells,
  creating,
  onSelect,
  onCreate,
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
                    <span className="truncate font-mono">{session.shell}</span>
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

        <section className="mt-5">
          <h2 className="px-2 text-[10px] tracking-widest text-slate-600 uppercase">
            {t("sidebar.phase2Group")}
          </h2>
          <ul className="mt-1 space-y-1">
            <Phase2Row label={t("sidebar.serial")} />
            <Phase2Row label={t("sidebar.sftp")} />
          </ul>
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
    </aside>
  );
}

function Phase2Row({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <li>
      <div
        aria-disabled="true"
        title={t("common.phase2")}
        className="flex cursor-not-allowed items-center justify-between rounded px-2 py-1 text-xs text-slate-600"
      >
        <span>{label}</span>
        <span className="rounded bg-slate-800/60 px-1 py-0.5 text-[9px] tracking-wide uppercase">
          {t("common.phase2")}
        </span>
      </div>
    </li>
  );
}
