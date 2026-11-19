// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin, typed wrapper over the Tauri command surface.
 *
 * Every payload mirrors a `#[tauri::command]` in
 * `apps/desktop/src-tauri/src/commands.rs`; keeping the names in one place makes
 * a rename a compile error instead of a runtime surprise.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const TERMINAL_OUTPUT_EVENT = "terminal://output";
export const TERMINAL_EXIT_EVENT = "terminal://exit";

export interface LocaleInfo {
  raw: string;
  normalized: string;
  supported: string[];
}

export interface SessionInfo {
  sessionId: string;
  shell: string;
  cols: number;
  rows: number;
}

export interface OutputPayload {
  sessionId: string;
  sequence: number;
  dataBase64: string;
  bytes: number;
}

export interface ExitPayload {
  sessionId: string;
}

export interface ShellProfile {
  label: string;
  command: string;
  default: boolean;
}

export interface CursorPosition {
  row: number;
  col: number;
}

export interface ScreenSnapshot {
  cols: number;
  rows: number;
  cursor: CursorPosition;
  text: string;
  lines: string[];
  scrollback: string[];
  scrollbackLen: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}

export interface AgentCapabilities {
  defaultMode: "ask" | "supervised" | "autonomous";
  tools: ToolSpec[];
  loopPhases: string[];
}

/** True when the page runs inside the Tauri WebView rather than a browser. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const ipc = {
  spawnSession(cols: number, rows: number, shell?: string): Promise<SessionInfo> {
    return invoke<SessionInfo>("spawn_session", { request: { cols, rows, shell } });
  },

  writeSession(sessionId: string, data: string): Promise<void> {
    return invoke<void>("write_session", { sessionId, data });
  },

  resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    return invoke<void>("resize_session", { sessionId, cols, rows });
  },

  closeSession(sessionId: string): Promise<void> {
    return invoke<void>("close_session", { sessionId });
  },

  listSessions(): Promise<SessionInfo[]> {
    return invoke<SessionInfo[]>("list_sessions");
  },

  screenSnapshot(sessionId: string): Promise<ScreenSnapshot> {
    return invoke<ScreenSnapshot>("screen_snapshot", { sessionId });
  },

  systemLocale(): Promise<LocaleInfo> {
    return invoke<LocaleInfo>("system_locale");
  },

  shellProfiles(): Promise<ShellProfile[]> {
    return invoke<ShellProfile[]>("shell_profiles");
  },

  agentCapabilities(): Promise<AgentCapabilities> {
    return invoke<AgentCapabilities>("agent_capabilities");
  },
};

export function onTerminalOutput(
  handler: (payload: OutputPayload) => void,
): Promise<UnlistenFn> {
  return listen<OutputPayload>(TERMINAL_OUTPUT_EVENT, (event) => handler(event.payload));
}

export function onTerminalExit(handler: (payload: ExitPayload) => void): Promise<UnlistenFn> {
  return listen<ExitPayload>(TERMINAL_EXIT_EVENT, (event) => handler(event.payload));
}
