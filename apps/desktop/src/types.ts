// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import type { SessionSpec, TerminalBackend } from "./lib/backend";
import type { PaneNode } from "./lib/panes";
import type { EnvTag, SessionKind } from "./lib/ipc";

/** Autonomy level mirrored from `term_agent::policy::PermissionMode`. */
export type PermissionMode = "ask" | "supervised" | "autonomous";

/** One terminal tab as the workbench renders it. */
export interface SessionView {
  id: string;
  kind: SessionKind;
  backend: TerminalBackend;
  label: string;
  title: string;
  envTag?: EnvTag;
  savedId?: string;
  reconnectSpec?: SessionSpec;
  exited: boolean;
  size: { cols: number; rows: number };
}

/** One tab: a pane tree plus the focus it owns. */
export interface TabView {
  id: string;
  panes: PaneNode;
  activeSessionId: string | null;
}
