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

export type SessionKind = "local" | "ssh" | "serial";

export interface LocaleInfo {
  raw: string;
  normalized: string;
  supported: string[];
}

export interface SessionInfo {
  sessionId: string;
  kind: SessionKind;
  label: string;
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

export type SshAuthInput =
  | { method: "password"; password: string }
  | { method: "privateKey"; path: string; passphrase?: string };

export interface SshConnectInput {
  host: string;
  port: number;
  username: string;
  auth: SshAuthInput;
  cols?: number;
  rows?: number;
}

export type SerialStopBits = "one" | "two";
export type SerialParity = "none" | "odd" | "even";
export type SerialFlowControl = "none" | "software" | "hardware";

export interface SerialConnectInput {
  path: string;
  baudRate: number;
  dataBits?: number;
  stopBits?: SerialStopBits;
  parity?: SerialParity;
  flowControl?: SerialFlowControl;
  cols?: number;
  rows?: number;
  logPath?: string;
}

export interface SerialPortDescriptor {
  path: string;
  kind: string;
  vid: number | null;
  pid: number | null;
  manufacturer: string | null;
  product: string | null;
  serialNumber: string | null;
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

export interface AgentRunSummary {
  id: string;
  sessionId: string;
  task: string;
  mode: string;
  model: string;
  status: string;
  commands: number;
  startedAt: number;
  finishedAt: number | null;
}

export interface AgentRunRecord extends AgentRunSummary {
  events: unknown[];
}

export interface KnownHost {
  host: string;
  port: number;
  fingerprint: string;
  firstSeen: number;
}

export interface SavedSession {
  id: string;
  name: string;
  kind: SessionKind;
  payload: Record<string, unknown>;
  secretRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SaveSshSessionInput {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuthInput;
  rememberPassword: boolean;
}

export interface SftpSessionInfo {
  connectionId: string;
  host: string;
  username: string;
  home: string;
}

export interface SftpEntry {
  name: string;
  path: string;
  directory: boolean;
  symlink: boolean;
  size: number | null;
}

/** True when the page runs inside the Tauri WebView rather than a browser. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const ipc = {
  spawnSession(cols: number, rows: number, shell?: string): Promise<SessionInfo> {
    return invoke<SessionInfo>("spawn_session", { request: { cols, rows, shell } });
  },

  connectSsh(input: SshConnectInput): Promise<SessionInfo> {
    return invoke<SessionInfo>("connect_ssh", { request: input });
  },

  openSerial(input: SerialConnectInput): Promise<SessionInfo> {
    return invoke<SessionInfo>("open_serial", { request: input });
  },

  serialPorts(): Promise<SerialPortDescriptor[]> {
    return invoke<SerialPortDescriptor[]>("serial_ports");
  },

  writeSessionBytes(sessionId: string, dataBase64: string): Promise<void> {
    return invoke<void>("write_session_bytes", { sessionId, dataBase64 });
  },

  writeKeystrokes(sessionId: string, data: string): Promise<void> {
    return invoke<void>("write_keystrokes", { sessionId, data });
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

  saveSshSession(input: SaveSshSessionInput): Promise<SavedSession> {
    return invoke<SavedSession>("save_ssh_session", { request: input });
  },

  listSavedSessions(): Promise<SavedSession[]> {
    return invoke<SavedSession[]>("list_saved_sessions");
  },

  deleteSavedSession(id: string): Promise<boolean> {
    return invoke<boolean>("delete_saved_session", { id });
  },

  connectSavedSession(id: string): Promise<SessionInfo> {
    return invoke<SessionInfo>("connect_saved_session", { id });
  },

  listKnownHosts(): Promise<KnownHost[]> {
    return invoke<KnownHost[]>("list_known_hosts");
  },

  forgetHostKey(host: string, port: number): Promise<boolean> {
    return invoke<boolean>("forget_host_key", { host, port });
  },

  listAgentRuns(sessionId?: string, limit?: number): Promise<AgentRunSummary[]> {
    return invoke<AgentRunSummary[]>("list_agent_runs", { sessionId, limit });
  },

  getAgentRun(id: string): Promise<AgentRunRecord | null> {
    return invoke<AgentRunRecord | null>("get_agent_run", { id });
  },

  sftpConnectSaved(id: string): Promise<SftpSessionInfo> {
    return invoke<SftpSessionInfo>("sftp_connect_saved", { id });
  },

  sftpConnect(input: SshConnectInput): Promise<SftpSessionInfo> {
    return invoke<SftpSessionInfo>("sftp_connect", { request: input });
  },

  sftpListDir(connectionId: string, path: string): Promise<SftpEntry[]> {
    return invoke<SftpEntry[]>("sftp_list_dir", { connectionId, path });
  },

  sftpDownload(
    connectionId: string,
    remotePath: string,
    localPath: string,
  ): Promise<number> {
    return invoke<number>("sftp_download", { connectionId, remotePath, localPath });
  },

  sftpUpload(connectionId: string, localPath: string, remotePath: string): Promise<number> {
    return invoke<number>("sftp_upload", { connectionId, localPath, remotePath });
  },

  sftpClose(connectionId: string): Promise<void> {
    return invoke<void>("sftp_close", { connectionId });
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
