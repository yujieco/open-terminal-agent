// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { PaneTree } from "./PaneTree";
import type { SessionView, TabView } from "../types";

interface TerminalWorkspaceProps {
  sessions: SessionView[];
  tabs: TabView[];
  activeId: string | null;
  exitedLabel: string;
  emptyLabel: string;
  closeLabel: string;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onExit: (sessionId: string) => void;
}

export function TerminalWorkspace({
  sessions,
  tabs,
  activeId,
  exitedLabel,
  emptyLabel,
  closeLabel,
  onSelect,
  onClose,
  onResize,
  onExit,
}: TerminalWorkspaceProps) {
  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-500">
        {emptyLabel}
      </div>
    );
  }

  const activeTab =
    tabs.find((tab) => tab.activeSessionId === activeId) ?? tabs[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-slate-800/80 bg-slate-950/30 px-1">
        {tabs.map((tab) => {
          const sessionsInTab = collectSessions(tab, sessions);
          const active = tab === activeTab;
          const lead = sessionsInTab[0];
          return (
            <div
              key={tab.id}
              className={`group flex items-center gap-1 rounded-t px-2.5 transition ${
                active
                  ? "bg-slate-900 text-slate-100"
                  : "text-slate-500 hover:bg-slate-900/40 hover:text-slate-300"
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  if (tab.activeSessionId) onSelect(tab.activeSessionId);
                }}
                title={lead?.title}
                className="flex items-center gap-2 py-2 text-xs"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    lead?.exited ? "bg-rose-400" : "bg-emerald-400"
                  }`}
                />
                <span className="font-mono">{lead?.label ?? "terminal"}</span>
                {sessionsInTab.length > 1 ? (
                  <span className="rounded bg-slate-800/80 px-1 text-[9px] text-slate-400">
                    ×{sessionsInTab.length}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                aria-label={closeLabel}
                onClick={() => {
                  for (const session of sessionsInTab) onClose(session.id);
                }}
                className="rounded p-0.5 text-slate-600 opacity-0 transition group-hover:opacity-100 hover:bg-slate-800 hover:text-slate-200"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 ${tab === activeTab ? "block" : "hidden"}`}
          >
            <PaneTree
              node={tab.panes}
              sessions={sessions}
              activeId={activeId}
              exitedLabel={exitedLabel}
              onSelect={onSelect}
              onResize={onResize}
              onExit={onExit}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Sessions of one tab, in visual order. */
function collectSessions(tab: TabView, sessions: SessionView[]): SessionView[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const ordered: SessionView[] = [];
  const walk = (node: TabView["panes"]): void => {
    if (node.kind === "leaf") {
      const session = byId.get(node.sessionId);
      if (session) ordered.push(session);
      return;
    }
    walk(node.first);
    walk(node.second);
  };
  walk(tab.panes);
  return ordered;
}
