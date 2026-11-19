// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentSidebar } from "./components/AgentSidebar";
import { SessionSidebar } from "./components/SessionSidebar";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";
import { TerminalWorkspace } from "./components/TerminalWorkspace";
import { changeLanguage } from "./i18n";
import { createTerminalBackend } from "./lib/backend";
import { ipc, isTauri, type ShellProfile } from "./lib/ipc";
import { resolveLanguage } from "./lib/locale";
import type { PermissionMode, SessionView } from "./types";

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

export default function App() {
  const { t, i18n } = useTranslation();
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [mode, setMode] = useState<PermissionMode>("supervised");
  const [agentOpen, setAgentOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const demo = useMemo(() => !isTauri(), []);
  const bootstrapped = useRef(false);
  const sessionsRef = useRef<SessionView[]>([]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const createSession = useCallback(async (shell?: string) => {
    setCreating(true);
    setError(null);
    try {
      const backend = await createTerminalBackend({
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        shell,
      });
      const view: SessionView = {
        id: backend.sessionId,
        backend,
        shell: backend.shell,
        title: `${backend.shell} · ${DEFAULT_COLS}×${DEFAULT_ROWS}`,
        exited: false,
        size: { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
      };
      setSessions((previous) => [...previous, view]);
      setActiveId(view.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }, []);

  const closeSession = useCallback((sessionId: string) => {
    const target = sessionsRef.current.find((session) => session.id === sessionId);
    target?.backend.dispose();
    const remaining = sessionsRef.current.filter((session) => session.id !== sessionId);
    setSessions(remaining);
    setActiveId((current) =>
      current === sessionId ? (remaining[0]?.id ?? null) : current,
    );
  }, []);

  const markExited = useCallback((sessionId: string) => {
    setSessions((previous) =>
      previous.map((session) =>
        session.id === sessionId ? { ...session, exited: true } : session,
      ),
    );
  }, []);

  const handleResize = useCallback((sessionId: string, cols: number, rows: number) => {
    setSessions((previous) =>
      previous.map((session) => {
        if (session.id !== sessionId) return session;
        if (session.size.cols === cols && session.size.rows === rows) return session;
        return { ...session, size: { cols, rows } };
      }),
    );
  }, []);

  // Boot once: read the OS locale and shell list on the Rust side, then open the
  // first terminal. The ref guard keeps React StrictMode from spawning two PTYs.
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    void (async () => {
      if (!isTauri()) {
        await createSession();
        return;
      }
      try {
        const [locale, profiles, capabilities] = await Promise.all([
          ipc.systemLocale(),
          ipc.shellProfiles(),
          ipc.agentCapabilities(),
        ]);
        await changeLanguage(resolveLanguage(locale.normalized));
        setShells(profiles);
        setMode(capabilities.defaultMode);
      } catch (cause) {
        console.warn("[ota] could not read locale, shells or agent capabilities", cause);
      }
      await createSession();
    })();
  }, [createSession]);

  const activeSession = sessions.find((session) => session.id === activeId) ?? null;

  return (
    <div className="flex h-full flex-col bg-[#0b1220] text-slate-200">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-slate-800/80 bg-slate-950/60 px-3">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-sm font-semibold tracking-tight text-cyan-300">
            ota
          </span>
          <span className="hidden text-xs text-slate-500 sm:inline">{t("app.tagline")}</span>
          {demo ? (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] tracking-wider text-amber-300 uppercase">
              {t("app.demoBadge")}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setAgentOpen((open) => !open)}
            className={`rounded px-2.5 py-1 text-xs transition ${
              agentOpen
                ? "bg-cyan-500/15 text-cyan-200"
                : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-200"
            }`}
          >
            {t("agent.title")}
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded px-2.5 py-1 text-xs text-slate-400 transition hover:bg-slate-800/70 hover:text-slate-200"
          >
            {t("settings.title")}
          </button>
        </div>
      </header>

      {error ? (
        <div className="flex items-center justify-between gap-3 border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-200">
          <span className="truncate">
            {t("common.error")}: {error}
          </span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded px-2 py-0.5 text-rose-200/80 hover:bg-rose-500/20"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <SessionSidebar
          sessions={sessions}
          activeId={activeId}
          shells={shells}
          creating={creating}
          onSelect={setActiveId}
          onCreate={createSession}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <TerminalWorkspace
            sessions={sessions}
            activeId={activeId}
            exitedLabel={t("terminal.exited")}
            emptyLabel={t("terminal.empty")}
            closeLabel={t("tabs.close")}
            onSelect={setActiveId}
            onClose={closeSession}
            onResize={handleResize}
            onExit={markExited}
          />
        </main>

        {agentOpen ? (
          <AgentSidebar mode={mode} onModeChange={setMode} />
        ) : null}
      </div>

      <StatusBar
        shell={activeSession?.shell ?? null}
        size={activeSession?.size ?? null}
        exited={activeSession?.exited ?? false}
        mode={mode}
        locale={i18n.language}
        sessionCount={sessions.length}
        demo={demo}
      />

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
