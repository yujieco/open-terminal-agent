// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import type { TerminalBackend } from "../lib/backend";

/**
 * Same stack as the CSS theme token, spelled out because xterm needs a real
 * string: CJK wide glyphs (2 cells) and Cyrillic (1 cell) must line up.
 */
const MONO_FONT_STACK =
  '"JetBrains Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Menlo", "Consolas", monospace';

const TERMINAL_THEME = {
  background: "#0b1220",
  foreground: "#e2e8f0",
  cursor: "#22d3ee",
  cursorAccent: "#0b1220",
  selectionBackground: "#1d4ed880",
  black: "#0f172a",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e2e8f0",
  brightBlack: "#475569",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

interface TerminalPaneProps {
  backend: TerminalBackend;
  exitedLabel: string;
  onResize: (cols: number, rows: number) => void;
  onExit: () => void;
}

export function TerminalPane({ backend, exitedLabel, onResize, onExit }: TerminalPaneProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hexMode, setHexMode] = useState(false);
  const [hexLog, setHexLog] = useState<string[]>([]);
  const [hexInput, setHexInput] = useState("");
  const [hexError, setHexError] = useState<string | null>(null);
  const onResizeRef = useRef(onResize);
  const onExitRef = useRef(onExit);
  const exitedLabelRef = useRef(exitedLabel);

  useEffect(() => {
    onResizeRef.current = onResize;
    onExitRef.current = onExit;
    exitedLabelRef.current = exitedLabel;
  }, [onResize, onExit, exitedLabel]);

  useEffect(() => {
    if (backend.kind !== "serial") return;
    return backend.onRawOutput((bytes) => {
      const line = toHexLine(bytes);
      setHexLog((previous) => {
        const next = [...previous, line];
        return next.length > 400 ? next.slice(next.length - 400) : next;
      });
    });
  }, [backend]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: MONO_FONT_STACK,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5_000,
      allowProposedApi: true,
      theme: TERMINAL_THEME,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    // WebGL is a large win on macOS/Windows, but WebKitGTK on Linux can fail to
    // create a context. Falling back to the built-in DOM renderer keeps the
    // terminal usable instead of blank.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch (cause) {
      webgl = null;
      console.warn("[ota] WebGL renderer unavailable, using the DOM renderer", cause);
    }

    const dataSubscription = term.onData((data) => backend.write(data));
    const stopOutput = backend.onOutput((data) => term.write(data));
    const stopExit = backend.onExit(() => {
      term.write(`\r\n\x1b[38;5;245m[${exitedLabelRef.current}]\x1b[0m\r\n`);
      onExitRef.current();
    });

    let disposed = false;
    const applySize = () => {
      if (disposed) return;
      // Hidden tabs report a zero-size box; resizing the PTY to 1x1 would make
      // the shell reflow to garbage, so skip until the tab is visible again.
      if (container.clientWidth < 24 || container.clientHeight < 24) return;
      try {
        fitAddon.fit();
      } catch (cause) {
        console.warn("[ota] terminal fit failed", cause);
        return;
      }
      backend.resize(term.cols, term.rows);
      onResizeRef.current(term.cols, term.rows);
    };

    const observer = new ResizeObserver(applySize);
    observer.observe(container);
    const frame = requestAnimationFrame(applySize);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      dataSubscription.dispose();
      stopOutput();
      stopExit();
      webgl?.dispose();
      term.dispose();
    };
  }, [backend]);

  const sendHex = () => {
    const bytes = parseHexInput(hexInput);
    if (!bytes) {
      setHexError(t("terminal.hexInvalid"));
      return;
    }
    setHexError(null);
    backend.writeBytes(bytes);
    setHexInput("");
  };

  return (
    <div className="relative h-full w-full">
      {backend.kind === "serial" ? (
        <button
          type="button"
          onClick={() => setHexMode((mode) => !mode)}
          className="absolute top-1 right-3 z-10 rounded border border-slate-700 bg-slate-900/90 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200"
        >
          {hexMode ? t("terminal.utf8Mode") : t("terminal.hexMode")}
        </button>
      ) : null}

      <div
        ref={containerRef}
        className={`h-full w-full px-2 py-1.5 ${hexMode ? "hidden" : ""}`}
      />

      {hexMode ? (
        <div className="flex h-full flex-col px-2 py-1.5">
          <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed">
            {hexLog.length === 0 ? (
              <p className="text-slate-600">{t("terminal.hexEmpty")}</p>
            ) : (
              hexLog.map((line, index) => (
                <div key={index} className="whitespace-pre text-slate-300">
                  {line}
                </div>
              ))
            )}
          </div>
          <div className="mt-1 flex items-center gap-1 border-t border-slate-800/60 pt-1">
            <input
              value={hexInput}
              onChange={(event) => setHexInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") sendHex();
              }}
              placeholder={t("terminal.hexPlaceholder")}
              className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950/70 px-2 py-1 font-mono text-[11px] text-slate-100 outline-none focus:border-cyan-500/60"
            />
            <button
              type="button"
              onClick={sendHex}
              className="rounded bg-cyan-500/15 px-2 py-1 text-[11px] text-cyan-100 hover:bg-cyan-500/25"
            >
              {t("terminal.hexSend")}
            </button>
          </div>
          {hexError ? <p className="mt-1 text-[10px] text-rose-300">{hexError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function toHexLine(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
  const ascii = Array.from(bytes)
    .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."))
    .join("");
  return `${hex}  |${ascii}|`;
}

function parseHexInput(input: string): Uint8Array | null {
  const cleaned = input.replace(/0x/gi, "").replace(/[\s,]/g, "");
  if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned)) {
    return null;
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(cleaned.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
