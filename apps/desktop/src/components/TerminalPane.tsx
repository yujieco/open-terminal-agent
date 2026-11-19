// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onResizeRef = useRef(onResize);
  const onExitRef = useRef(onExit);
  const exitedLabelRef = useRef(exitedLabel);

  useEffect(() => {
    onResizeRef.current = onResize;
    onExitRef.current = onExit;
    exitedLabelRef.current = exitedLabel;
  }, [onResize, onExit, exitedLabel]);

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

  return <div ref={containerRef} className="h-full w-full px-2 py-1.5" />;
}
