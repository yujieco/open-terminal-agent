// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import type { SessionView } from "../types";
import { TerminalPane } from "./TerminalPane";

interface TerminalWorkspaceProps {
  sessions: SessionView[];
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
  activeId,
  exitedLabel,
  emptyLabel,
  closeLabel,
  onSelect,
  onClose,
  onResize,
  onExit,
}: TerminalWorkspaceProps) {
  if (sessions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-500">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-slate-800/80 bg-slate-950/30 px-1">
        {sessions.map((session) => {
          const active = session.id === activeId;
          return (
            <div
              key={session.id}
              className={`group flex items-center gap-1 rounded-t px-2.5 transition ${
                active
                  ? "bg-slate-900 text-slate-100"
                  : "text-slate-500 hover:bg-slate-900/40 hover:text-slate-300"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                title={session.title}
                className="flex items-center gap-2 py-2 text-xs"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    session.exited ? "bg-rose-400" : "bg-emerald-400"
                  }`}
                />
                <span className="font-mono">{session.label}</span>
              </button>
              <button
                type="button"
                aria-label={closeLabel}
                onClick={() => onClose(session.id)}
                className="rounded p-0.5 text-slate-600 opacity-0 transition group-hover:opacity-100 hover:bg-slate-800 hover:text-slate-200"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="relative min-h-0 flex-1">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`absolute inset-0 ${
              session.id === activeId ? "block" : "hidden"
            }`}
          >
            <TerminalPane
              backend={session.backend}
              exitedLabel={exitedLabel}
              onResize={(cols, rows) => onResize(session.id, cols, rows)}
              onExit={() => onExit(session.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
