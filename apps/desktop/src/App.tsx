// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentSidebar, type ExternalTaskTrigger } from "./components/AgentSidebar";
import { CommandPalette } from "./components/CommandPalette";
import { ExportLogDialog } from "./components/ExportLogDialog";
import { GlobalContextMenu } from "./components/GlobalContextMenu";
import { SaveSnippetDialog } from "./components/SaveSnippetDialog";
import { SerialConnectDialog } from "./components/SerialConnectDialog";
import { SessionSidebar } from "./components/SessionSidebar";
import { SettingsDialog } from "./components/SettingsDialog";
import { SftpDrawer } from "./components/SftpDrawer";
import { SnippetsPanel } from "./components/SnippetsPanel";
import { SshConnectDialog } from "./components/SshConnectDialog";
import { StatusBar } from "./components/StatusBar";
import { TerminalWorkspace } from "./components/TerminalWorkspace";
import { TunnelDrawer } from "./components/TunnelDrawer";
import { UpdateDialog } from "./components/UpdateDialog";
import { useTerminalConfig } from "./hooks/useTerminalConfig";
import { useTheme } from "./hooks/useTheme";
import { changeLanguage } from "./i18n";
import { agentIpc } from "./lib/agent";
import {
  connectSavedTerminalBackend,
  createTerminalBackend,
  type SessionSpec,
} from "./lib/backend";
import {
  ipc,
  isTauri,
  type CommandSnippet,
  type EnvTag,
  type SavedSession,
  type SaveSnippetInput,
  type SerialConnectInput,
  type ShellProfile,
  type SshConnectInput,
  type UpdateInfo,
} from "./lib/ipc";
import { resolveLanguage } from "./lib/locale";
import { leaf, remove, sessionIds, split } from "./lib/panes";
import { formatShortcut } from "./lib/platform";
import type { PermissionMode, SessionView, TabView } from "./types";

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MODES: PermissionMode[] = ["ask", "supervised", "autonomous"];
const DEMO_SNIPPETS_KEY = "ota.demo.snippets";

type DialogKind = "ssh" | "serial" | null;
type RightTabKind = "agent" | "snippets";

interface TabContextMenu {
  x: number;
  y: number;
  tabId: string;
  leadSessionId: string;
  leadLabel: string;
  allSessionIds: string[];
}

interface SnippetModalState {
  initialCommand: string;
  editing: CommandSnippet | null;
}

function shortShellLabel(raw: string, ordinal: number): string {
  const base = raw.split(/[\\/]/).filter(Boolean).pop() ?? raw;
  return ordinal <= 1 ? base : `${base} ${ordinal}`;
}

function readDemoSnippets(): CommandSnippet[] {
  try {
    const raw = window.localStorage.getItem(DEMO_SNIPPETS_KEY);
    return raw ? (JSON.parse(raw) as CommandSnippet[]) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const { t } = useTranslation();
  const { resolved: resolvedTheme, setPreference, toggleTheme } = useTheme();
  const {
    config: terminalConfig,
    setPreset: setTerminalPreset,
    setFontSize: setTerminalFontSize,
    setLineHeight: setTerminalLineHeight,
    setCursorStyle: setTerminalCursorStyle,
    setCustomColor: setTerminalCustomColor,
    cloneCurrentToCustom: cloneTerminalToCustom,
    resetTerminalConfig,
  } = useTerminalConfig();

  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [tabs, setTabs] = useState<TabView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [saved, setSaved] = useState<SavedSession[]>([]);
  const [snippets, setSnippets] = useState<CommandSnippet[]>([]);
  const [mode, setMode] = useState<PermissionMode>("supervised");
  const [rightOpen, setRightOpen] = useState(true);
  const [rightTab, setRightTab] = useState<RightTabKind>("agent");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  const [tunnelsOpen, setTunnelsOpen] = useState(false);
  const [activeTunnelCount, setActiveTunnelCount] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [snippetModal, setSnippetModal] = useState<SnippetModalState | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentRunning, setAgentRunning] = useState<Record<string, boolean>>({});
  const [externalTask, setExternalTask] = useState<ExternalTaskTrigger | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [tabNameDraft, setTabNameDraft] = useState("");
  const [tabMenu, setTabMenu] = useState<TabContextMenu | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<{
    sessionId: string;
    label: string;
    lines?: string[];
  } | null>(null);

  const demo = useMemo(() => !isTauri(), []);
  const bootstrapped = useRef(false);
  const sessionsRef = useRef<SessionView[]>([]);
  const tabsRef = useRef<TabView[]>([]);
  const taskCounterRef = useRef(1);
  const localCounterRef = useRef(0);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTabMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tabMenu]);

  const refreshSnippets = useCallback(async () => {
    if (!isTauri()) {
      setSnippets(readDemoSnippets());
      return;
    }
    try {
      setSnippets(await ipc.listSnippets());
    } catch (cause) {
      console.warn("[ota] could not list command snippets", cause);
    }
  }, []);

  const saveSnippet = useCallback(
    async (input: SaveSnippetInput) => {
      if (!isTauri()) {
        const now = Date.now();
        setSnippets((previous) => {
          const next = input.id
            ? previous.map((item) =>
                item.id === input.id
                  ? {
                      ...item,
                      alias: input.alias,
                      command: input.command,
                      category: input.category ?? "general",
                      description: input.description ?? "",
                      updatedAt: now,
                    }
                  : item,
              )
            : [
                {
                  id: `demo-snip-${now}`,
                  alias: input.alias,
                  command: input.command,
                  category: input.category ?? "general",
                  description: input.description ?? "",
                  usageCount: 0,
                  createdAt: now,
                  updatedAt: now,
                },
                ...previous,
              ];
          try {
            window.localStorage.setItem(DEMO_SNIPPETS_KEY, JSON.stringify(next));
          } catch {
            // Ignore storage errors.
          }
          return next;
        });
        setRightOpen(true);
        setRightTab("snippets");
        return;
      }

      await ipc.saveSnippet(input);
      await refreshSnippets();
      setRightOpen(true);
      setRightTab("snippets");
    },
    [refreshSnippets],
  );

  const deleteSnippet = useCallback(
    async (id: string) => {
      if (!isTauri()) {
        setSnippets((previous) => {
          const next = previous.filter((item) => item.id !== id);
          try {
            window.localStorage.setItem(DEMO_SNIPPETS_KEY, JSON.stringify(next));
          } catch {
            // Ignore storage errors.
          }
          return next;
        });
        return;
      }
      try {
        await ipc.deleteSnippet(id);
        await refreshSnippets();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [refreshSnippets],
  );

  const pasteSnippetToTerminal = useCallback(
    (command: string, snippetId?: string) => {
      const target = sessionsRef.current.find((session) => session.id === activeId);
      if (!target) return;
      // Paste into the active terminal without trailing newline so the user stays in control.
      target.backend.write(command);
      if (snippetId && isTauri()) {
        void ipc
          .bumpSnippetUsage(snippetId)
          .then(() => refreshSnippets())
          .catch(console.warn);
      }
    },
    [activeId, refreshSnippets],
  );

  const registerView = useCallback((view: SessionView) => {
    setSessions((previous) => [...previous, view]);
    setTabs((previous) => [
      ...previous,
      { id: view.id, panes: leaf(view.id), activeSessionId: view.id },
    ]);
    setActiveId(view.id);
  }, []);

  const renameSession = useCallback((sessionId: string, nextLabel: string) => {
    const trimmed = nextLabel.trim();
    if (!trimmed) return;
    setSessions((previous) =>
      previous.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              label: trimmed,
              title: `${trimmed} · ${session.size.cols}×${session.size.rows}`,
            }
          : session,
      ),
    );
  }, []);

  const openSession = useCallback(
    async (spec: SessionSpec, envTag?: EnvTag) => {
      setCreating(true);
      setError(null);
      try {
        const backend = await createTerminalBackend(spec);
        const displayLabel =
          backend.kind === "local"
            ? shortShellLabel(backend.label, ++localCounterRef.current)
            : backend.label;
        registerView({
          id: backend.sessionId,
          kind: backend.kind,
          backend,
          label: displayLabel,
          title: `${displayLabel} · ${spec.cols}×${spec.rows}`,
          envTag,
          exited: false,
          size: { cols: spec.cols, rows: spec.rows },
        });
        return true;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setDialogError(message);
        setError(message);
        return false;
      } finally {
        setCreating(false);
      }
    },
    [registerView],
  );

  const refreshSaved = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setSaved(await ipc.listSavedSessions());
    } catch (cause) {
      console.warn("[ota] could not list saved sessions", cause);
    }
  }, []);

  const openSaved = useCallback(
    async (id: string) => {
      setCreating(true);
      setError(null);
      try {
        const savedProfile = saved.find((item) => item.id === id);
        const rawEnv = savedProfile?.payload?.envTag;
        const envTag: EnvTag | undefined =
          rawEnv === "prod" || rawEnv === "staging" || rawEnv === "dev" ? rawEnv : undefined;
        const backend = await connectSavedTerminalBackend(id);
        const displayLabel =
          backend.kind === "local"
            ? shortShellLabel(backend.label, ++localCounterRef.current)
            : backend.label;
        registerView({
          id: backend.sessionId,
          kind: backend.kind,
          backend,
          label: displayLabel,
          title: `${displayLabel} · ${DEFAULT_COLS}×${DEFAULT_ROWS}`,
          envTag,
          exited: false,
          size: { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setCreating(false);
      }
    },
    [registerView, saved],
  );

  const deleteSaved = useCallback(
    async (id: string) => {
      try {
        await ipc.deleteSavedSession(id);
        await refreshSaved();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [refreshSaved],
  );

  const createLocalSession = useCallback(
    async (shell?: string) => {
      await openSession({ kind: "local", cols: DEFAULT_COLS, rows: DEFAULT_ROWS, shell });
    },
    [openSession],
  );

  const connectSsh = useCallback(
    async (
      input: Omit<SshConnectInput, "cols" | "rows">,
      save: { name: string; rememberPassword: boolean; envTag?: EnvTag } | null,
      envTag?: EnvTag,
    ) => {
      const opened = await openSession(
        {
          kind: "ssh",
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          ...input,
        },
        envTag,
      );
      if (!opened) return;

      if (save && isTauri()) {
        try {
          await ipc.saveSshSession({
            name: save.name.length > 0 ? save.name : `${input.username}@${input.host}`,
            host: input.host,
            port: input.port,
            username: input.username,
            auth: input.auth,
            rememberPassword: save.rememberPassword,
            envTag: save.envTag,
          });
          await refreshSaved();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }

      setDialog(null);
      setDialogError(null);
    },
    [openSession, refreshSaved],
  );

  const openSerial = useCallback(
    async (input: SerialConnectInput) => {
      const opened = await openSession({
        kind: "serial",
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        ...input,
      });
      if (opened) {
        setDialog(null);
        setDialogError(null);
      }
    },
    [openSession],
  );

  const handleAgentRunning = useCallback((sessionId: string, running: boolean) => {
    setAgentRunning((previous) => {
      if (Boolean(previous[sessionId]) === running) return previous;
      const next = { ...previous };
      if (running) {
        next[sessionId] = true;
      } else {
        delete next[sessionId];
      }
      return next;
    });
  }, []);

  const handleNextSuggestion = useCallback((sessionId: string, suggestion: string | null) => {
    setSuggestions((previous) => {
      const next = { ...previous };
      if (suggestion && suggestion.length > 0) {
        next[sessionId] = suggestion;
      } else {
        delete next[sessionId];
      }
      return next;
    });
  }, []);

  const handleQuickRun = useCallback((text: string) => {
    setRightOpen(true);
    setRightTab("agent");
    setExternalTask({ id: taskCounterRef.current++, text });
  }, []);

  const handleDiagnoseError = useCallback((sessionId: string, prompt: string) => {
    setActiveId(sessionId);
    setRightOpen(true);
    setRightTab("agent");
    setExternalTask({ id: taskCounterRef.current++, text: prompt });
  }, []);

  const handleSetEnvTag = useCallback((sessionId: string, envTag?: EnvTag) => {
    setSessions((previous) =>
      previous.map((item) => (item.id === sessionId ? { ...item, envTag } : item)),
    );
  }, []);

  const handleTakeOver = useCallback(() => {
    if (!activeId) return;
    void agentIpc.cancel(activeId);
  }, [activeId]);

  // Ctrl+K / Cmd+K opens the command palette from anywhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Global take-over: Esc hands the terminal back, no matter where focus is.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !activeId) return;
      if (!agentRunning[activeId]) return;
      event.preventDefault();
      void agentIpc.cancel(activeId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, agentRunning]);

  const splitActive = useCallback(
    async (direction: "row" | "column", targetOverride?: string) => {
      const target = targetOverride ?? activeId;
      if (!target) return;

      setCreating(true);
      setError(null);
      try {
        const backend = await createTerminalBackend({
          kind: "local",
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        });
        const displayLabel = shortShellLabel(backend.label, ++localCounterRef.current);
        const view: SessionView = {
          id: backend.sessionId,
          kind: backend.kind,
          backend,
          label: displayLabel,
          title: `${displayLabel} · ${DEFAULT_COLS}×${DEFAULT_ROWS}`,
          exited: false,
          size: { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
        };
        setSessions((previous) => [...previous, view]);

        let placed = false;
        const nextTabs = tabsRef.current.map((tab) => {
          if (placed) return tab;
          const panes = split(tab.panes, target, view.id, direction);
          if (panes === null) return tab;
          placed = true;
          return { ...tab, panes, activeSessionId: view.id };
        });
        if (!placed) {
          nextTabs.push({
            id: view.id,
            panes: leaf(view.id),
            activeSessionId: view.id,
          });
        }
        setTabs(nextTabs);
        setActiveId(view.id);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setCreating(false);
      }
    },
    [activeId],
  );

  const closeSession = useCallback((sessionId: string) => {
    const target = sessionsRef.current.find((session) => session.id === sessionId);
    target?.backend.dispose();
    const remaining = sessionsRef.current.filter((session) => session.id !== sessionId);
    setSessions(remaining);

    setTabs((previous) =>
      previous.flatMap((tab) => {
        const panes = remove(tab.panes, sessionId);
        if (panes === null) return [];
        const fallback = sessionIds(panes)[0] ?? null;
        return [
          {
            ...tab,
            panes,
            activeSessionId: tab.activeSessionId === sessionId ? fallback : tab.activeSessionId,
          },
        ];
      }),
    );
    setActiveId((current) => (current === sessionId ? (remaining[0]?.id ?? null) : current));
  }, []);

  const closeOtherTabs = useCallback((keepTabId: string) => {
    const keepTab = tabsRef.current.find((tab) => tab.id === keepTabId);
    if (!keepTab) return;
    const keepIds = new Set(sessionIds(keepTab.panes));
    for (const session of sessionsRef.current) {
      if (!keepIds.has(session.id)) {
        session.backend.dispose();
      }
    }
    setSessions((previous) => previous.filter((session) => keepIds.has(session.id)));
    setTabs([keepTab]);
    if (keepTab.activeSessionId) {
      setActiveId(keepTab.activeSessionId);
    }
  }, []);

  // Split and close shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      const key = event.key.toLowerCase();

      if (key === "d") {
        event.preventDefault();
        void splitActive(event.shiftKey ? "column" : "row");
      } else if (key === "w" && activeId) {
        event.preventDefault();
        closeSession(activeId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, closeSession, splitActive]);

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

  const checkUpdates = useCallback(async () => {
    if (!isTauri()) return;
    setCheckingUpdate(true);
    try {
      setUpdateInfo(await ipc.checkForUpdates());
    } catch (cause) {
      console.warn("[ota] update check skipped", cause);
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    void (async () => {
      if (!isTauri()) {
        await refreshSnippets();
        await createLocalSession();
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
      await Promise.all([refreshSaved(), refreshSnippets()]);
      await createLocalSession();
      void checkUpdates();
    })();
  }, [checkUpdates, createLocalSession, refreshSaved, refreshSnippets]);

  const orderedSessions = useMemo(() => {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return tabs
      .flatMap((tab) => sessionIds(tab.panes))
      .map((id) => byId.get(id))
      .filter((session): session is SessionView => session !== undefined);
  }, [sessions, tabs]);

  const activeSession = sessions.find((session) => session.id === activeId) ?? null;
  const activeTab = tabs.find((tab) => tab.activeSessionId === activeId) ?? tabs[0] ?? null;
  const activeAgentRunning = activeId ? Boolean(agentRunning[activeId]) : false;
  const activeSuggestion = activeId ? (suggestions[activeId] ?? null) : null;

  return (
    <div className="flex h-full flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* Clean top chrome: inline renamable tabs + autonomy mode + accent CTA + theme + settings */}
      <header className="flex h-11 shrink-0 items-center border-b border-[var(--border-subtle)] bg-[var(--bg-chrome)]">
        {/* Session tabs start cleanly from the left */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-3">
          {demo ? (
            <span
              className="mr-1 shrink-0 rounded px-1.5 py-0.5 font-mono text-[9.5px] font-medium uppercase"
              style={{
                backgroundColor: "var(--accent-soft)",
                color: "var(--accent)",
              }}
            >
              {t("status.demo")}
            </span>
          ) : null}

          {tabs.map((tab) => {
            const tabIds = sessionIds(tab.panes);
            const lead = orderedSessions.find((s) => s.id === tabIds[0]);
            const isActive = tab === activeTab;
            const isEditing = editingTabId === tab.id && lead !== undefined;

            return (
              <div
                key={tab.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (!lead) return;
                  setTabMenu({
                    x: Math.min(event.clientX, window.innerWidth - 190),
                    y: Math.min(event.clientY, window.innerHeight - 190),
                    tabId: tab.id,
                    leadSessionId: lead.id,
                    leadLabel: lead.label,
                    allSessionIds: tabIds,
                  });
                }}
                className={`group relative flex h-7 shrink-0 items-center gap-1.5 overflow-hidden rounded-[7px] border px-2.5 transition ${
                  isActive
                    ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                    : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                }`}
              >
                {lead?.envTag === "prod" || lead?.envTag === "staging" ? (
                  <span
                    className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
                    style={{
                      backgroundColor:
                        lead.envTag === "prod" ? "var(--status-danger)" : "var(--status-warn)",
                    }}
                  />
                ) : null}
                {isEditing && lead ? (
                  <input
                    autoFocus
                    value={tabNameDraft}
                    onChange={(event) => setTabNameDraft(event.target.value)}
                    onBlur={() => {
                      renameSession(lead.id, tabNameDraft);
                      setEditingTabId(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        renameSession(lead.id, tabNameDraft);
                        setEditingTabId(null);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setEditingTabId(null);
                      }
                    }}
                    className="w-28 rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[12.5px] text-[var(--text-primary)] outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (tab.activeSessionId) setActiveId(tab.activeSessionId);
                    }}
                    onDoubleClick={() => {
                      if (!lead) return;
                      setEditingTabId(tab.id);
                      setTabNameDraft(lead.label);
                    }}
                    title={t("tabs.renameHint")}
                    className={`flex items-center gap-1.5 text-[12.5px] ${
                      isActive ? "font-medium" : "font-normal"
                    }`}
                  >
                    <span className="max-w-[11rem] truncate">{lead?.label ?? "terminal"}</span>
                    {tabIds.length > 1 ? (
                      <span className="ota-tabular rounded bg-[var(--bg-surface)] px-1 text-[11px] text-[var(--text-muted)]">
                        ×{tabIds.length}
                      </span>
                    ) : null}
                  </button>
                )}

                <button
                  type="button"
                  aria-label={t("tabs.close")}
                  onClick={() => {
                    for (const id of tabIds) closeSession(id);
                  }}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
                >
                  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                    <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
                  </svg>
                </button>
              </div>
            );
          })}

          {/* Optically centered SVG + button */}
          <button
            type="button"
            onClick={() => void createLocalSession()}
            disabled={creating}
            title={t("sidebar.newSession")}
            aria-label={t("sidebar.newSession")}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M8 3.2v9.6M3.2 8h9.6" />
            </svg>
          </button>
        </div>

        {/* Right studio controls */}
        <div className="flex shrink-0 items-center gap-2 px-3">
          <div className="ota-segmented hidden grid-cols-3 lg:inline-grid">
            {MODES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                data-active={candidate === mode}
                onClick={() => setMode(candidate)}
                className="ota-segment"
              >
                {t(`agent.modes.${candidate}`)}
              </button>
            ))}
          </div>

          {activeAgentRunning ? (
            <button type="button" onClick={handleTakeOver} className="ota-ctrl-primary">
              {t("agent.takeOver")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setRightOpen((open) => !open)}
              className={rightOpen ? "ota-ctrl-primary" : "ota-ctrl"}
            >
              {t("agent.title")}
            </button>
          )}

          {/* Theme toggle: clean Light (Sun) / Dark (Moon) binary switch */}
          <button
            type="button"
            onClick={toggleTheme}
            title={`${t("settings.appearance")}: ${t(`settings.theme.${resolvedTheme}`)}`}
            aria-label={t("settings.appearance")}
            className="ota-ctrl !w-7 !px-0"
          >
            {resolvedTheme === "light" ? (
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>

          {/* Settings cog/gear button */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={t("settings.title")}
            aria-label={t("settings.title")}
            className="ota-ctrl !w-7 !px-0"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {error ? (
        <div
          className="flex items-center justify-between gap-3 border-b px-4 py-1.5 text-xs"
          style={{
            borderColor: "var(--status-danger)",
            backgroundColor: "var(--status-danger-soft)",
            color: "var(--status-danger)",
          }}
        >
          <span className="truncate">
            {t("common.error")}: {error}
          </span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded px-2 py-0.5 text-xs font-medium hover:opacity-80"
          >
            {t("common.dismiss")}
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <SessionSidebar
          sessions={orderedSessions}
          activeId={activeId}
          shells={shells}
          saved={saved}
          creating={creating}
          agentRunning={activeAgentRunning}
          activeTunnelCount={activeTunnelCount}
          onSelect={setActiveId}
          onRename={renameSession}
          onCloseSession={closeSession}
          onExportLog={(session) =>
            setExportTarget({ sessionId: session.id, label: session.label })
          }
          onCreate={createLocalSession}
          onOpenSaved={(id) => void openSaved(id)}
          onDeleteSaved={(id) => void deleteSaved(id)}
          onOpenSsh={() => {
            setDialogError(null);
            setDialog("ssh");
          }}
          onOpenSerial={() => {
            setDialogError(null);
            setDialog("serial");
          }}
          onOpenSftp={() => setSftpOpen(true)}
          onOpenTunnels={() => setTunnelsOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <TerminalWorkspace
            sessions={orderedSessions}
            tabs={tabs}
            activeId={activeId}
            theme={resolvedTheme}
            terminalConfig={terminalConfig}
            suggestedPrompt={activeSuggestion}
            agentRunning={activeAgentRunning}
            exitedLabel={t("terminal.exited")}
            emptyLabel={t("terminal.empty")}
            onSelect={setActiveId}
            onResize={handleResize}
            onExit={markExited}
            onSplit={(direction) => void splitActive(direction)}
            onQuickRun={handleQuickRun}
            onTakeOver={handleTakeOver}
            onOpenPalette={() => setPaletteOpen(true)}
            onFavoriteCommand={(command) =>
              setSnippetModal({ initialCommand: command, editing: null })
            }
            onExportLog={(sessionId, label, lines) =>
              setExportTarget({ sessionId, label, lines })
            }
            onDiagnoseError={handleDiagnoseError}
            onSetEnvTag={handleSetEnvTag}
          />
        </main>

        {/* Right collapsible dual-tab panel: AI Agent | Command Handbook (pure typography segmented control) */}
        {rightOpen ? (
          <aside className="flex w-[21rem] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-sidebar)]">
            <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-3 py-2">
              <div className="ota-segmented w-full grid-cols-2">
                <button
                  type="button"
                  data-active={rightTab === "agent"}
                  onClick={() => setRightTab("agent")}
                  className="ota-segment"
                >
                  <span>{t("agent.title")}</span>
                </button>
                <button
                  type="button"
                  data-active={rightTab === "snippets"}
                  onClick={() => setRightTab("snippets")}
                  className="ota-segment"
                >
                  <span>{t("snippets.tabTitle")}</span>
                  {snippets.length > 0 ? (
                    <span className="ota-tabular rounded bg-[var(--bg-canvas)] px-1.5 text-[11px] font-normal text-[var(--text-muted)]">
                      {snippets.length}
                    </span>
                  ) : null}
                </button>
              </div>
            </div>

            <div className={rightTab === "agent" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              <AgentSidebar
                sessionId={activeId}
                mode={mode}
                suggestedPrompt={activeSuggestion}
                externalTask={externalTask}
                onNextSuggestion={handleNextSuggestion}
                onOpenSettings={() => setSettingsOpen(true)}
                onRunningChange={handleAgentRunning}
              />
            </div>

            {rightTab === "snippets" ? (
              <SnippetsPanel
                snippets={snippets}
                hasSession={activeSession !== null}
                onPaste={pasteSnippetToTerminal}
                onAddNew={() => setSnippetModal({ initialCommand: "", editing: null })}
                onEdit={(snippet) =>
                  setSnippetModal({ initialCommand: snippet.command, editing: snippet })
                }
                onDelete={(id) => void deleteSnippet(id)}
                onFavoriteHandbook={(command) =>
                  setSnippetModal({ initialCommand: command, editing: null })
                }
              />
            ) : null}
          </aside>
        ) : null}
      </div>

      <StatusBar
        label={activeSession?.label ?? null}
        size={activeSession?.size ?? null}
        exited={activeSession?.exited ?? false}
        demo={demo}
        agentRunning={activeAgentRunning}
        updateInfo={updateInfo}
        checkingUpdate={checkingUpdate}
        onCheckUpdate={() => void checkUpdates()}
        onOpenUpdate={() => setUpdateModalOpen(true)}
      />

      {updateModalOpen && updateInfo ? (
        <UpdateDialog info={updateInfo} onClose={() => setUpdateModalOpen(false)} />
      ) : null}

      {exportTarget ? (
        <ExportLogDialog
          sessionId={exportTarget.sessionId}
          label={exportTarget.label}
          lines={exportTarget.lines}
          onClose={() => setExportTarget(null)}
        />
      ) : null}

      <GlobalContextMenu
        onFavoriteCommand={(command) =>
          setSnippetModal({ initialCommand: command, editing: null })
        }
      />

      {/* Localized Tab right-click context menu */}
      {tabMenu ? (
        <div
          onMouseDown={(event) => event.stopPropagation()}
          className="fixed z-50 w-44 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] py-1 shadow-xl"
          style={{ left: tabMenu.x, top: tabMenu.y }}
        >
          <button
            type="button"
            onClick={() => {
              const { tabId, leadLabel } = tabMenu;
              setTabMenu(null);
              setEditingTabId(tabId);
              setTabNameDraft(leadLabel);
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
              const target = tabMenu.leadSessionId;
              setTabMenu(null);
              void splitActive("row", target);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
              <path d="M8 2.5V13.5" />
            </svg>
            <span>{t("tabs.splitHorizontal", { shortcut: formatShortcut("D") })}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const target = tabMenu.leadSessionId;
              setTabMenu(null);
              void splitActive("column", target);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
              <path d="M2 8H14" />
            </svg>
            <span>{t("tabs.splitVertical", { shortcut: formatShortcut("D", true) })}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const { leadSessionId, leadLabel } = tabMenu;
              setTabMenu(null);
              setExportTarget({ sessionId: leadSessionId, label: leadLabel });
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
            disabled={tabs.length <= 1}
            onClick={() => {
              const keepTabId = tabMenu.tabId;
              setTabMenu(null);
              closeOtherTabs(keepTabId);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M3 4.5h10M4.5 8h7M6 11.5h4" />
            </svg>
            <span>{t("tabs.closeOthers")}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const ids = tabMenu.allSessionIds;
              setTabMenu(null);
              for (const id of ids) closeSession(id);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--status-danger)" }}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
            <span>{t("tabs.close")}</span>
          </button>
        </div>
      ) : null}

      {snippetModal ? (
        <SaveSnippetDialog
          initialCommand={snippetModal.initialCommand}
          editing={snippetModal.editing}
          onSave={saveSnippet}
          onClose={() => setSnippetModal(null)}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          resolvedTheme={resolvedTheme}
          onThemeChange={setPreference}
          terminalConfig={terminalConfig}
          onTerminalPresetChange={setTerminalPreset}
          onTerminalFontSizeChange={setTerminalFontSize}
          onTerminalLineHeightChange={setTerminalLineHeight}
          onTerminalCursorStyleChange={setTerminalCursorStyle}
          onTerminalCustomColorChange={setTerminalCustomColor}
          onTerminalCloneToCustom={() => cloneTerminalToCustom(resolvedTheme)}
          onTerminalReset={resetTerminalConfig}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {sftpOpen ? (
        <SftpDrawer
          saved={saved}
          activeSessionId={activeId}
          onClose={() => setSftpOpen(false)}
        />
      ) : null}

      {tunnelsOpen ? (
        <TunnelDrawer
          saved={saved}
          onOpenSsh={() => {
            setDialogError(null);
            setDialog("ssh");
          }}
          onActiveCountChange={setActiveTunnelCount}
          onClose={() => setTunnelsOpen(false)}
        />
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          backend={activeSession?.backend ?? null}
          onOpenSettings={() => setSettingsOpen(true)}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}

      {dialog === "ssh" ? (
        <SshConnectDialog
          busy={creating}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(input, save, envTag) => void connectSsh(input, save, envTag)}
        />
      ) : null}

      {dialog === "serial" ? (
        <SerialConnectDialog
          busy={creating}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(input) => void openSerial(input)}
        />
      ) : null}
    </div>
  );
}
