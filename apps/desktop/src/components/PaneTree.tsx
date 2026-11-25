// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import type { ResolvedTheme } from "../hooks/useTheme";
import type { PaneNode } from "../lib/panes";
import type { HighlightRule } from "../lib/terminalHighlighter";
import type { TerminalAppearanceConfig } from "../lib/terminalThemes";
import type { SessionView } from "../types";
import { TerminalPane } from "./TerminalPane";

interface PaneTreeProps {
  node: PaneNode;
  sessions: SessionView[];
  activeId: string | null;
  broadcastEnabled?: boolean;
  broadcastSessionIds?: string[];
  theme: ResolvedTheme;
  terminalConfig: TerminalAppearanceConfig;
  highlightEnabled: boolean;
  highlightRules: HighlightRule[];
  searchSignal: number;
  blocksSignal: number;
  isSplit?: boolean;
  exitedLabel: string;
  onSelect: (sessionId: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onExit: (sessionId: string) => void;
  onFavoriteCommand: (command: string) => void;
  onExportLog: (sessionId: string, label: string, lines?: string[]) => void;
  onDiagnoseError: (sessionId: string, prompt: string) => void;
}

/**
 * Renders one pane tree. A leaf is a terminal; a split is a flex container whose
 * children take `ratio` of the axis, with a crisp hairline divider between them.
 */
export function PaneTree({
  node,
  sessions,
  activeId,
  broadcastEnabled = false,
  broadcastSessionIds,
  theme,
  terminalConfig,
  highlightEnabled,
  highlightRules,
  searchSignal,
  blocksSignal,
  isSplit = false,
  exitedLabel,
  onSelect,
  onResize,
  onExit,
  onFavoriteCommand,
  onExportLog,
  onDiagnoseError,
}: PaneTreeProps) {
  if (node.kind === "leaf") {
    const session = sessions.find((entry) => entry.id === node.sessionId);
    if (!session) return null;
    const focused = node.sessionId === activeId;
    const broadcastSessions =
      broadcastEnabled && broadcastSessionIds && broadcastSessionIds.length > 1
        ? sessions.filter((s) => broadcastSessionIds.includes(s.id) && !s.exited)
        : undefined;
    const broadcastTargets = broadcastSessions?.map((s) => s.backend);
    const broadcastHasProd = Boolean(broadcastSessions?.some((s) => s.envTag === "prod"));
    return (
      <div
        onMouseDown={() => onSelect(node.sessionId)}
        className={`relative h-full w-full transition-shadow ${
          broadcastEnabled && isSplit
            ? "ring-1 ring-[var(--status-warn)] ring-inset"
            : isSplit && focused
              ? "ring-1 ring-[var(--accent-border)] ring-inset"
              : ""
        }`}
      >
        <TerminalPane
          backend={session.backend}
          sessionLabel={session.label}
          envTag={session.envTag}
          focused={focused}
          broadcastTargets={broadcastTargets}
          broadcastHasProd={broadcastHasProd}
          theme={theme}
          terminalConfig={terminalConfig}
          highlightEnabled={highlightEnabled}
          highlightRules={highlightRules}
          searchSignal={focused ? searchSignal : 0}
          blocksSignal={focused ? blocksSignal : 0}
          exitedLabel={exitedLabel}
          onResize={(cols, rows) => onResize(session.id, cols, rows)}
          onExit={() => onExit(session.id)}
          onFavoriteCommand={onFavoriteCommand}
          onExportLog={(lines) => onExportLog(session.id, session.label, lines)}
          onDiagnoseError={(prompt) => onDiagnoseError(session.id, prompt)}
        />
      </div>
    );
  }

  const row = node.direction === "row";
  return (
    <div className={`flex h-full w-full ${row ? "flex-row" : "flex-col"}`}>
      <div
        className="min-h-0 min-w-0"
        style={{ flexBasis: `${node.ratio * 100}%`, flexGrow: 0, flexShrink: 1 }}
      >
        <PaneTree
          node={node.first}
          sessions={sessions}
          activeId={activeId}
          broadcastEnabled={broadcastEnabled}
          broadcastSessionIds={broadcastSessionIds}
          theme={theme}
          terminalConfig={terminalConfig}
          highlightEnabled={highlightEnabled}
          highlightRules={highlightRules}
          searchSignal={searchSignal}
          blocksSignal={blocksSignal}
          isSplit
          exitedLabel={exitedLabel}
          onSelect={onSelect}
          onResize={onResize}
          onExit={onExit}
          onFavoriteCommand={onFavoriteCommand}
          onExportLog={onExportLog}
          onDiagnoseError={onDiagnoseError}
        />
      </div>
      <div className={row ? "w-px bg-[var(--border-subtle)]" : "h-px bg-[var(--border-subtle)]"} />
      <div
        className="min-h-0 min-w-0 flex-1"
        style={{ flexBasis: `${(1 - node.ratio) * 100}%`, flexGrow: 1, flexShrink: 1 }}
      >
        <PaneTree
          node={node.second}
          sessions={sessions}
          activeId={activeId}
          broadcastEnabled={broadcastEnabled}
          broadcastSessionIds={broadcastSessionIds}
          theme={theme}
          terminalConfig={terminalConfig}
          highlightEnabled={highlightEnabled}
          highlightRules={highlightRules}
          searchSignal={searchSignal}
          blocksSignal={blocksSignal}
          isSplit
          exitedLabel={exitedLabel}
          onSelect={onSelect}
          onResize={onResize}
          onExit={onExit}
          onFavoriteCommand={onFavoriteCommand}
          onExportLog={onExportLog}
          onDiagnoseError={onDiagnoseError}
        />
      </div>
    </div>
  );
}
