// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import type { PaneNode } from "../lib/panes";
import type { SessionView } from "../types";
import { TerminalPane } from "./TerminalPane";

interface PaneTreeProps {
  node: PaneNode;
  sessions: SessionView[];
  activeId: string | null;
  exitedLabel: string;
  onSelect: (sessionId: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onExit: (sessionId: string) => void;
}

/**
 * Renders one pane tree. A leaf is a terminal; a split is a flex container whose
 * children take `ratio` of the axis, with a 1px divider between them.
 */
export function PaneTree({
  node,
  sessions,
  activeId,
  exitedLabel,
  onSelect,
  onResize,
  onExit,
}: PaneTreeProps) {
  if (node.kind === "leaf") {
    const session = sessions.find((entry) => entry.id === node.sessionId);
    if (!session) return null;
    const focused = node.sessionId === activeId;
    return (
      <div
        onMouseDown={() => onSelect(node.sessionId)}
        className={`h-full w-full ${focused ? "ring-1 ring-cyan-500/30 ring-inset" : ""}`}
      >
        <TerminalPane
          backend={session.backend}
          exitedLabel={exitedLabel}
          onResize={(cols, rows) => onResize(session.id, cols, rows)}
          onExit={() => onExit(session.id)}
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
          exitedLabel={exitedLabel}
          onSelect={onSelect}
          onResize={onResize}
          onExit={onExit}
        />
      </div>
      <div className={row ? "w-px bg-slate-800" : "h-px bg-slate-800"} />
      <div
        className="min-h-0 min-w-0 flex-1"
        style={{ flexBasis: `${(1 - node.ratio) * 100}%`, flexGrow: 1, flexShrink: 1 }}
      >
        <PaneTree
          node={node.second}
          sessions={sessions}
          activeId={activeId}
          exitedLabel={exitedLabel}
          onSelect={onSelect}
          onResize={onResize}
          onExit={onExit}
        />
      </div>
    </div>
  );
}
