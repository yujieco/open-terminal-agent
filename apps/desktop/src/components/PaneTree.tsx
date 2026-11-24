// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import type { ResolvedTheme } from "../hooks/useTheme";
import type { PaneNode } from "../lib/panes";
import type { TerminalAppearanceConfig } from "../lib/terminalThemes";
import type { SessionView } from "../types";
import { TerminalPane } from "./TerminalPane";

interface PaneTreeProps {
  node: PaneNode;
  sessions: SessionView[];
  activeId: string | null;
  theme: ResolvedTheme;
  terminalConfig: TerminalAppearanceConfig;
  isSplit?: boolean;
  exitedLabel: string;
  onSelect: (sessionId: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onExit: (sessionId: string) => void;
  onFavoriteCommand: (command: string) => void;
}

/**
 * Renders one pane tree. A leaf is a terminal; a split is a flex container whose
 * children take `ratio` of the axis, with a crisp hairline divider between them.
 */
export function PaneTree({
  node,
  sessions,
  activeId,
  theme,
  terminalConfig,
  isSplit = false,
  exitedLabel,
  onSelect,
  onResize,
  onExit,
  onFavoriteCommand,
}: PaneTreeProps) {
  if (node.kind === "leaf") {
    const session = sessions.find((entry) => entry.id === node.sessionId);
    if (!session) return null;
    const focused = node.sessionId === activeId;
    return (
      <div
        onMouseDown={() => onSelect(node.sessionId)}
        className={`h-full w-full transition-shadow ${
          isSplit && focused ? "ring-1 ring-[var(--accent-border)] ring-inset" : ""
        }`}
      >
        <TerminalPane
          backend={session.backend}
          theme={theme}
          terminalConfig={terminalConfig}
          exitedLabel={exitedLabel}
          onResize={(cols, rows) => onResize(session.id, cols, rows)}
          onExit={() => onExit(session.id)}
          onFavoriteCommand={onFavoriteCommand}
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
          theme={theme}
          terminalConfig={terminalConfig}
          isSplit
          exitedLabel={exitedLabel}
          onSelect={onSelect}
          onResize={onResize}
          onExit={onExit}
          onFavoriteCommand={onFavoriteCommand}
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
          theme={theme}
          terminalConfig={terminalConfig}
          isSplit
          exitedLabel={exitedLabel}
          onSelect={onSelect}
          onResize={onResize}
          onExit={onExit}
          onFavoriteCommand={onFavoriteCommand}
        />
      </div>
    </div>
  );
}
