// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

/**
 * Session backends.
 *
 * A backend is what a terminal pane talks to. Inside Tauri it forwards to a Rust
 * transport (PTY, SSH or serial) over IPC; in a plain browser it runs a tiny echo
 * shell so the UI can be reviewed with `npm run dev` alone. Both satisfy the same
 * interface, so the pane never branches on the host.
 */

import {
  ipc,
  isTauri,
  onTerminalExit,
  onTerminalOutput,
  type SerialConnectInput,
  type SerialFlowControl,
  type SerialParity,
  type SerialStopBits,
  type SessionInfo,
  type SessionKind,
  type SshAuthInput,
} from "./ipc";

export interface TerminalBackend {
  readonly sessionId: string;
  readonly kind: SessionKind;
  readonly label: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onOutput(listener: (text: string) => void): () => void;
  onExit(listener: () => void): () => void;
  dispose(): void;
}

export interface LocalSessionSpec {
  kind: "local";
  cols: number;
  rows: number;
  shell?: string;
}

export interface SshSessionSpec {
  kind: "ssh";
  cols: number;
  rows: number;
  host: string;
  port: number;
  username: string;
  auth: SshAuthInput;
}

export interface SerialSessionSpec {
  kind: "serial";
  cols: number;
  rows: number;
  path: string;
  baudRate: number;
  dataBits?: number;
  stopBits?: SerialStopBits;
  parity?: SerialParity;
  flowControl?: SerialFlowControl;
  logPath?: string;
}

export type SessionSpec = LocalSessionSpec | SshSessionSpec | SerialSessionSpec;

export async function createTerminalBackend(spec: SessionSpec): Promise<TerminalBackend> {
  if (!isTauri()) {
    return createDemoBackend(spec.cols, spec.rows);
  }

  const info = await spawnSession(spec);
  return terminalBackendFor(info);
}

async function spawnSession(spec: SessionSpec): Promise<SessionInfo> {
  switch (spec.kind) {
    case "local":
      return ipc.spawnSession(spec.cols, spec.rows, spec.shell);
    case "ssh":
      return ipc.connectSsh({
        host: spec.host,
        port: spec.port,
        username: spec.username,
        auth: spec.auth,
        cols: spec.cols,
        rows: spec.rows,
      });
    case "serial": {
      const request: SerialConnectInput = {
        path: spec.path,
        baudRate: spec.baudRate,
        dataBits: spec.dataBits,
        stopBits: spec.stopBits,
        parity: spec.parity,
        flowControl: spec.flowControl,
        cols: spec.cols,
        rows: spec.rows,
        logPath: spec.logPath,
      };
      return ipc.openSerial(request);
    }
  }
}

export function terminalBackendFor(info: SessionInfo): TerminalBackend {
  const outputListeners = new Set<(text: string) => void>();
  const exitListeners = new Set<() => void>();
  // A single streaming decoder keeps multi-byte UTF-8 glyphs intact even when a
  // character is split across two batched frames.
  const decoder = new TextDecoder("utf-8");

  let unlistenOutput: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let disposed = false;

  void onTerminalOutput((payload) => {
    if (payload.sessionId !== info.sessionId) return;
    const text = decoder.decode(decodeBase64(payload.dataBase64), { stream: true });
    if (text.length > 0) {
      for (const listener of outputListeners) listener(text);
    }
  }).then((stop) => {
    if (disposed) stop();
    else unlistenOutput = stop;
  });

  void onTerminalExit((payload) => {
    if (payload.sessionId !== info.sessionId) return;
    for (const listener of exitListeners) listener();
  }).then((stop) => {
    if (disposed) stop();
    else unlistenExit = stop;
  });

  return {
    sessionId: info.sessionId,
    kind: info.kind,
    label: info.label,
    write(data) {
      void ipc.writeSession(info.sessionId, data).catch(console.error);
    },
    resize(cols, rows) {
      void ipc.resizeSession(info.sessionId, cols, rows).catch(console.error);
    },
    onOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    dispose() {
      disposed = true;
      outputListeners.clear();
      exitListeners.clear();
      unlistenOutput?.();
      unlistenExit?.();
      void ipc.closeSession(info.sessionId).catch(console.error);
    },
  };
}

function createDemoBackend(cols: number, rows: number): TerminalBackend {
  const outputListeners = new Set<(text: string) => void>();
  const exitListeners = new Set<() => void>();
  const prompt = "\r\n\x1b[38;5;51mota\x1b[0m \x1b[38;5;245mdemo\x1b[0m $ ";
  let line = "";

  const emit = (text: string) => {
    for (const listener of outputListeners) listener(text);
  };

  const banner =
    `\x1b[38;5;51mOpen Terminal Agent\x1b[0m — browser demo shell (${cols}×${rows}).\r\n` +
    "No transport is attached: SSH, serial and local PTY sessions need the desktop app.\r\n" +
    "Try `help`, `date` or `clear`.";

  let booted = false;
  const boot = () => {
    if (booted) return;
    booted = true;
    emit(banner + prompt);
  };

  const run = (command: string) => {
    const trimmed = command.trim();
    if (trimmed === "help") {
      emit(
        "\r\n  help    show this list\r\n  date    print a timestamp\r\n  clear   clear the screen",
      );
    } else if (trimmed === "date") {
      emit(`\r\n${new Date().toISOString()}`);
    } else if (trimmed === "clear") {
      emit("\x1b[2J\x1b[H");
    } else if (trimmed.length > 0) {
      emit(`\r\n\x1b[38;5;203mota: command not found:\x1b[0m ${trimmed}`);
    }
  };

  return {
    sessionId: "demo-0001",
    kind: "local",
    label: "demo-shell",
    write(data) {
      boot();
      for (const char of data) {
        if (char === "\r") {
          emit("\r\n");
          run(line);
          line = "";
          emit(prompt);
        } else if (char === "\u0003") {
          emit("^C");
          line = "";
          emit(prompt);
        } else if (char === "\u007f") {
          if (line.length > 0) {
            line = line.slice(0, -1);
            emit("\b \b");
          }
        } else {
          line += char;
          emit(char);
        }
      }
    },
    resize() {
      // The demo shell has no grid to resize.
    },
    onOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    dispose() {
      outputListeners.clear();
      for (const listener of exitListeners) listener();
      exitListeners.clear();
    },
  };
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
