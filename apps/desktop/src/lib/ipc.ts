// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin, typed wrapper over the Tauri command surface.
 *
 * Every payload mirrors a `#[tauri::command]` under
 * `apps/desktop/src-tauri/src/commands/`; keeping the names in one place makes
 * a rename a compile error instead of a runtime surprise.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

export type SessionKind = "local" | "ssh" | "serial";

/** Per-session stream event delivered over a dedicated Tauri v2 IPC Channel. */
export type TerminalStreamEvent =
  | {
      event: "output";
      data: {
        sequence: number;
        dataBase64: string;
        bytes: number;
      };
    }
  | {
      event: "exited";
    };

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
  /** Fingerprint the user approved on first contact. */
  trustFingerprint?: string;
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

export interface CommandSnippet {
  id: string;
  alias: string;
  command: string;
  category: string;
  description: string;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SaveSnippetInput {
  id?: string;
  alias: string;
  command: string;
  category?: string;
  description?: string;
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

export type EnvTag = "prod" | "staging" | "dev";

export interface SaveSshSessionInput {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuthInput;
  rememberPassword: boolean;
  envTag?: EnvTag;
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
  permissions?: number | null;
  modified?: number | null;
}

export interface SftpProgressEvent {
  connectionId: string;
  kind: "upload" | "download";
  name: string;
  transferred: number;
  total: number | null;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  canAutoInstall: boolean;
  releaseUrl: string;
  releaseName: string;
  notes: string;
  publishedAt: string | null;
}

export type LogExportFormat = "log" | "txt" | "md" | "html" | "json";

export interface ExportLogResult {
  path: string;
  bytes: number;
  lines: number;
}

export interface SessionProbeStatus {
  rttMs: number | null;
  quality: "good" | "fair" | "poor" | "offline";
}

export type TunnelKind = "local" | "remote" | "dynamic";

export interface TunnelStats {
  activeConnections: number;
  totalConnections: number;
  bytesTx: number;
  bytesRx: number;
}

export interface TunnelView {
  id: string;
  name: string;
  sessionId: string;
  sessionName: string;
  sshTarget: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  activePort: number;
  targetHost: string;
  targetPort: number;
  running: boolean;
  stats: TunnelStats;
}

export interface SaveTunnelInput {
  id?: string;
  name: string;
  sessionId: string;
  kind: TunnelKind;
  bindHost?: string;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
}

export type UpdateDownloadEvent =
  | { event: "started"; contentLength: number | null }
  | { event: "progress"; downloaded: number; total: number | null }
  | { event: "installing" }
  | { event: "restarting" };

/** True when the page runs inside the Tauri WebView rather than a browser. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const ipc = {
  spawnSession(
    cols: number,
    rows: number,
    onEvent: Channel<TerminalStreamEvent>,
    shell?: string,
  ): Promise<SessionInfo> {
    return invoke<SessionInfo>("spawn_session", {
      request: { cols, rows, shell },
      onEvent,
    });
  },

  connectSsh(
    input: SshConnectInput,
    onEvent: Channel<TerminalStreamEvent>,
  ): Promise<SessionInfo> {
    return invoke<SessionInfo>("connect_ssh", { request: input, onEvent });
  },

  openSerial(
    input: SerialConnectInput,
    onEvent: Channel<TerminalStreamEvent>,
  ): Promise<SessionInfo> {
    return invoke<SessionInfo>("open_serial", { request: input, onEvent });
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

  probeSessionLatency(sessionId: string): Promise<SessionProbeStatus> {
    return invoke<SessionProbeStatus>("probe_session_latency", { sessionId });
  },

  systemLocale(): Promise<LocaleInfo> {
    return invoke<LocaleInfo>("system_locale");
  },

  shellProfiles(): Promise<ShellProfile[]> {
    return invoke<ShellProfile[]>("shell_profiles");
  },

  listSnippets(): Promise<CommandSnippet[]> {
    return invoke<CommandSnippet[]>("list_snippets");
  },

  saveSnippet(input: SaveSnippetInput): Promise<CommandSnippet> {
    return invoke<CommandSnippet>("save_snippet", { request: input });
  },

  deleteSnippet(id: string): Promise<boolean> {
    return invoke<boolean>("delete_snippet", { id });
  },

  bumpSnippetUsage(id: string): Promise<void> {
    return invoke<void>("bump_snippet_usage", { id });
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

  connectSavedSession(
    id: string,
    onEvent: Channel<TerminalStreamEvent>,
  ): Promise<SessionInfo> {
    return invoke<SessionInfo>("connect_saved_session", { id, onEvent });
  },

  probeHostKey(host: string, port: number): Promise<string> {
    return invoke<string>("probe_ssh_host_key", { host, port });
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

  sftpUploadBytes(
    connectionId: string,
    remotePath: string,
    dataBase64: string,
  ): Promise<number> {
    return invoke<number>("sftp_upload_bytes", { connectionId, remotePath, dataBase64 });
  },

  sftpMkdir(connectionId: string, path: string): Promise<void> {
    return invoke<void>("sftp_mkdir", { connectionId, path });
  },

  sftpDelete(connectionId: string, path: string, isDir: boolean): Promise<void> {
    return invoke<void>("sftp_delete", { connectionId, path, isDir });
  },

  sftpRename(connectionId: string, oldPath: string, newPath: string): Promise<void> {
    return invoke<void>("sftp_rename", { connectionId, oldPath, newPath });
  },

  sftpReadText(connectionId: string, remotePath: string): Promise<string> {
    return invoke<string>("sftp_read_text", { connectionId, remotePath });
  },

  sftpWriteText(connectionId: string, remotePath: string, content: string): Promise<number> {
    return invoke<number>("sftp_write_text", { connectionId, remotePath, content });
  },

  sftpClose(connectionId: string): Promise<void> {
    return invoke<void>("sftp_close", { connectionId });
  },

  checkForUpdates(): Promise<UpdateInfo> {
    return invoke<UpdateInfo>("check_for_updates");
  },

  installAndRelaunchUpdate(onEvent: (event: UpdateDownloadEvent) => void): Promise<void> {
    const channel = new Channel<UpdateDownloadEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("install_and_relaunch_update", { onEvent: channel });
  },

  openExternalUrl(url: string): Promise<void> {
    return invoke<void>("open_external_url", { url });
  },

  defaultExportDir(): Promise<string> {
    return invoke<string>("default_export_dir");
  },

  exportSessionLog(request: {
    sessionId: string;
    label: string;
    format: LogExportFormat;
    path?: string;
    lines?: string[];
  }): Promise<ExportLogResult> {
    return invoke<ExportLogResult>("export_session_log", { request });
  },

  revealInFolder(path: string): Promise<void> {
    return invoke<void>("reveal_in_folder", { path });
  },

  listTunnels(): Promise<TunnelView[]> {
    return invoke<TunnelView[]>("list_tunnels");
  },

  saveTunnel(input: SaveTunnelInput): Promise<TunnelView> {
    return invoke<TunnelView>("save_tunnel", { request: input });
  },

  deleteTunnel(id: string): Promise<boolean> {
    return invoke<boolean>("delete_tunnel", { id });
  },

  startTunnel(id: string): Promise<TunnelView> {
    return invoke<TunnelView>("start_tunnel", { id });
  },

  stopTunnel(id: string): Promise<TunnelView> {
    return invoke<TunnelView>("stop_tunnel", { id });
  },
};
