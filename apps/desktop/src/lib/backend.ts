// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

/**
 * Session backends.
 *
 * Inside Tauri each session owns a dedicated Tauri v2 IPC Channel so batched
 * terminal frames flow point-to-point without global broadcast overhead or
 * startup listener races. In a plain browser a tiny echo shell lets the UI be
 * reviewed with `npm run dev` alone.
 */

import { Channel } from "@tauri-apps/api/core";

import {
  ipc,
  isTauri,
  type SerialConnectInput,
  type SerialFlowControl,
  type SerialParity,
  type SerialStopBits,
  type SessionInfo,
  type SessionKind,
  type SshAuthInput,
  type TerminalStreamEvent,
} from "./ipc";

export interface TerminalBackend {
  readonly sessionId: string;
  readonly kind: SessionKind;
  readonly label: string;
  write(data: string): void;
  /** Sends raw bytes, used by the serial HEX composer. */
  writeBytes(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  onOutput(listener: (text: string) => void): () => void;
  /** Raw bytes before UTF-8 decoding, used by the serial HEX view. */
  onRawOutput(listener: (bytes: Uint8Array) => void): () => void;
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
  trustFingerprint?: string;
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

interface StreamHub {
  channel: Channel<TerminalStreamEvent>;
  attach(info: SessionInfo): TerminalBackend;
}

/** Creates a point-to-point channel hub before spawning so early bytes buffer cleanly. */
function createStreamHub(): StreamHub {
  const outputListeners = new Set<(text: string) => void>();
  const rawListeners = new Set<(bytes: Uint8Array) => void>();
  const exitListeners = new Set<() => void>();
  const decoder = new TextDecoder("utf-8");

  const earlyText: string[] = [];
  const earlyRaw: Uint8Array[] = [];
  let earlyExited = false;
  let disposed = false;

  const channel = new Channel<TerminalStreamEvent>((message) => {
    if (disposed) return;
    if (message.event === "exited") {
      if (exitListeners.size === 0) {
        earlyExited = true;
      } else {
        for (const listener of exitListeners) listener();
      }
      return;
    }

    const bytes = decodeBase64(message.data.dataBase64);
    if (rawListeners.size === 0) {
      earlyRaw.push(bytes);
      if (earlyRaw.length > 64) earlyRaw.shift();
    } else {
      for (const listener of rawListeners) listener(bytes);
    }

    const text = decoder.decode(bytes, { stream: true });
    if (text.length > 0) {
      if (outputListeners.size === 0) {
        earlyText.push(text);
        if (earlyText.length > 128) earlyText.shift();
      } else {
        for (const listener of outputListeners) listener(text);
      }
    }
  });

  return {
    channel,
    attach(info: SessionInfo): TerminalBackend {
      return {
        sessionId: info.sessionId,
        kind: info.kind,
        label: info.label,
        write(data) {
          void ipc.writeKeystrokes(info.sessionId, data).catch(console.error);
        },
        writeBytes(data) {
          void ipc
            .writeSessionBytes(info.sessionId, encodeBase64(data))
            .catch(console.error);
        },
        resize(cols, rows) {
          void ipc.resizeSession(info.sessionId, cols, rows).catch(console.error);
        },
        onOutput(listener) {
          outputListeners.add(listener);
          if (earlyText.length > 0) {
            const buffered = earlyText.splice(0, earlyText.length);
            for (const chunk of buffered) listener(chunk);
          }
          return () => outputListeners.delete(listener);
        },
        onRawOutput(listener) {
          rawListeners.add(listener);
          if (earlyRaw.length > 0) {
            const buffered = earlyRaw.splice(0, earlyRaw.length);
            for (const chunk of buffered) listener(chunk);
          }
          return () => rawListeners.delete(listener);
        },
        onExit(listener) {
          exitListeners.add(listener);
          if (earlyExited) {
            earlyExited = false;
            listener();
          }
          return () => exitListeners.delete(listener);
        },
        dispose() {
          disposed = true;
          outputListeners.clear();
          rawListeners.clear();
          exitListeners.clear();
          earlyText.length = 0;
          earlyRaw.length = 0;
          void ipc.closeSession(info.sessionId).catch(console.error);
        },
      };
    },
  };
}

export async function createTerminalBackend(spec: SessionSpec): Promise<TerminalBackend> {
  if (!isTauri()) {
    return createDemoBackend(spec.cols, spec.rows);
  }

  const hub = createStreamHub();
  const info = await spawnSession(spec, hub.channel);
  return hub.attach(info);
}

export async function connectSavedTerminalBackend(id: string): Promise<TerminalBackend> {
  const hub = createStreamHub();
  const info = await ipc.connectSavedSession(id, hub.channel);
  return hub.attach(info);
}

async function spawnSession(
  spec: SessionSpec,
  channel: Channel<TerminalStreamEvent>,
): Promise<SessionInfo> {
  switch (spec.kind) {
    case "local":
      return ipc.spawnSession(spec.cols, spec.rows, channel, spec.shell);
    case "ssh":
      return ipc.connectSsh(
        {
          host: spec.host,
          port: spec.port,
          username: spec.username,
          auth: spec.auth,
          cols: spec.cols,
          rows: spec.rows,
          trustFingerprint: spec.trustFingerprint,
        },
        channel,
      );
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
      return ipc.openSerial(request, channel);
    }
  }
}

let demoCounter = 1;

function createDemoBackend(cols: number, rows: number): TerminalBackend {
  const sessionId = `demo-${String(demoCounter++).padStart(4, "0")}`;
  const outputListeners = new Set<(text: string) => void>();
  const exitListeners = new Set<() => void>();
  const prompt = "\r\n\x1b[38;5;208mota\x1b[0m \x1b[38;5;244mdemo\x1b[0m $ ";
  let line = "";

  const emit = (text: string) => {
    for (const listener of outputListeners) listener(text);
  };

  const banner =
    `\x1b[38;5;208mOpen Terminal Agent\x1b[0m — browser demo shell (${cols}×${rows}).\r\n` +
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
    sessionId,
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
    writeBytes(data) {
      this.write(new TextDecoder().decode(data));
    },
    resize() {
      // The demo shell has no grid to resize.
    },
    onOutput(listener) {
      outputListeners.add(listener);
      if (!booted) {
        queueMicrotask(boot);
      }
      return () => outputListeners.delete(listener);
    },
    onRawOutput() {
      return () => {};
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

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
