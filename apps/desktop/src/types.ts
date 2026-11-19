// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import type { TerminalBackend } from "./lib/backend";

/** Autonomy level mirrored from `term_agent::policy::PermissionMode`. */
export type PermissionMode = "ask" | "supervised" | "autonomous";

/** One terminal tab as the workbench renders it. */
export interface SessionView {
  id: string;
  backend: TerminalBackend;
  shell: string;
  title: string;
  exited: boolean;
  size: { cols: number; rows: number };
}
