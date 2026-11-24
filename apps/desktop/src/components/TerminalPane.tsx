// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import type { ResolvedTheme } from "../hooks/useTheme";
import type { TerminalBackend } from "../lib/backend";
import {
  resolveTerminalTheme,
  type TerminalAppearanceConfig,
} from "../lib/terminalThemes";

/**
 * Same stack as the CSS theme token, spelled out because xterm needs a real
 * string: CJK wide glyphs (2 cells) and Cyrillic (1 cell) must line up.
 */
const MONO_FONT_STACK =
  '"JetBrains Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Menlo", "Consolas", monospace';

interface TerminalPaneProps {
  backend: TerminalBackend;
  theme: ResolvedTheme;
  terminalConfig: TerminalAppearanceConfig;
  exitedLabel: string;
  onResize: (cols: number, rows: number) => void;
  onExit: () => void;
  onFavoriteCommand: (command: string) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  selection: string;
}

export function TerminalPane({
  backend,
  theme,
  terminalConfig,
  exitedLabel,
  onResize,
  onExit,
  onFavoriteCommand,
}: TerminalPaneProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [hexMode, setHexMode] = useState(false);
  const [hexLog, setHexLog] = useState<string[]>([]);
  const [hexInput, setHexInput] = useState("");
  const [hexError, setHexError] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const onResizeRef = useRef(onResize);
  const onExitRef = useRef(onExit);
  const exitedLabelRef = useRef(exitedLabel);
  const resolvedPalette = resolveTerminalTheme(terminalConfig, theme);
  const configRef = useRef({ terminalConfig, resolvedPalette });

  useEffect(() => {
    onResizeRef.current = onResize;
    onExitRef.current = onExit;
    exitedLabelRef.current = exitedLabel;
  }, [onResize, onExit, exitedLabel]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  useEffect(() => {
    configRef.current = { terminalConfig, resolvedPalette };
    const term = terminalRef.current;
    if (!term) return;
    term.options.theme = resolvedPalette;
    term.options.cursorStyle = terminalConfig.cursorStyle;
    const metricsChanged =
      term.options.fontSize !== terminalConfig.fontSize ||
      term.options.lineHeight !== terminalConfig.lineHeight;
    if (metricsChanged) {
      term.options.fontSize = terminalConfig.fontSize;
      term.options.lineHeight = terminalConfig.lineHeight;
      try {
        fitAddonRef.current?.fit();
        backend.resize(term.cols, term.rows);
        onResizeRef.current(term.cols, term.rows);
      } catch {
        // Ignore fit attempts while tab is hidden.
      }
    }
    term.refresh(0, Math.max(0, term.rows - 1));
  }, [backend, resolvedPalette, terminalConfig]);

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

    const { terminalConfig: initialConfig, resolvedPalette: initialPalette } = configRef.current;

    const term = new Terminal({
      fontFamily: MONO_FONT_STACK,
      fontSize: initialConfig.fontSize,
      lineHeight: initialConfig.lineHeight,
      cursorStyle: initialConfig.cursorStyle,
      cursorBlink: true,
      scrollback: 5_000,
      allowProposedApi: true,
      theme: initialPalette,
    });
    terminalRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(container);

    // Subtle left-gutter accent marker on every OSC 133;A prompt line so
    // commands are immediately scannable in long output without adding clutter.
    const oscDisposable = term.parser.registerOscHandler(133, (data) => {
      if (data === "A" || data.startsWith("A;")) {
        try {
          const marker = term.registerMarker(0);
          if (marker) {
            const decoration = term.registerDecoration({
              marker,
              x: 0,
              width: 1,
              height: 1,
            });
            decoration?.onRender((element) => {
              element.classList.add("ota-prompt-gutter");
            });
          }
        } catch {
          // Ignore decoration errors if terminal is disposing.
        }
      }
      return true;
    });

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
      term.write(`\r\n\x1b[38;5;244m[${exitedLabelRef.current}]\x1b[0m\r\n`);
      onExitRef.current();
    });

    let disposed = false;
    const applySize = () => {
      if (disposed) return;
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
      terminalRef.current = null;
      fitAddonRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      oscDisposable.dispose();
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

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const selected = terminalRef.current?.getSelection().trim() ?? "";
    const x = Math.min(event.clientX, window.innerWidth - 210);
    const y = Math.min(event.clientY, window.innerHeight - 170);
    setMenu({ x: Math.max(8, x), y: Math.max(8, y), selection: selected });
  };

  const copySelection = async () => {
    if (!menu?.selection) return;
    try {
      await navigator.clipboard.writeText(menu.selection);
    } catch (cause) {
      console.warn("[ota] clipboard write failed", cause);
    }
    setMenu(null);
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        backend.write(text);
      }
    } catch (cause) {
      console.warn("[ota] clipboard read failed", cause);
    }
    setMenu(null);
  };

  return (
    <div
      className="relative h-full w-full transition-colors duration-150"
      style={{ backgroundColor: resolvedPalette.background }}
      onContextMenu={handleContextMenu}
    >
      {backend.kind === "serial" ? (
        <button
          type="button"
          onClick={() => setHexMode((mode) => !mode)}
          className="absolute top-2 right-3 z-10 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono text-[10px] font-medium text-[var(--text-secondary)] transition hover:border-[var(--accent-border)] hover:text-[var(--accent)]"
        >
          {hexMode ? t("terminal.utf8Mode") : t("terminal.hexMode")}
        </button>
      ) : null}

      <div
        ref={containerRef}
        className={`h-full w-full px-3.5 py-2 ${hexMode ? "hidden" : ""}`}
      />

      {hexMode ? (
        <div className="flex h-full flex-col bg-[var(--bg-canvas)] px-3 py-2">
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
            {hexLog.length === 0 ? (
              <span className="text-[var(--text-muted)]">{t("terminal.hexEmpty")}</span>
            ) : (
              hexLog.map((line, index) => <div key={index}>{line}</div>)
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              value={hexInput}
              onChange={(event) => setHexInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") sendHex();
              }}
              placeholder={t("terminal.hexPlaceholder")}
              className="ota-input flex-1 font-mono"
            />
            <button
              type="button"
              onClick={sendHex}
              className="ota-btn-primary rounded-md px-3 py-1.5 text-xs"
            >
              {t("terminal.hexSend")}
            </button>
          </div>
          {hexError ? (
            <p className="mt-1 text-[11px] text-[var(--status-danger)]">{hexError}</p>
          ) : null}
        </div>
      ) : null}

      {/* Localized terminal right-click context menu */}
      {menu ? (
        <div
          onMouseDown={(event) => event.stopPropagation()}
          className="fixed z-50 w-48 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            disabled={!menu.selection}
            onClick={() => {
              const cmd = menu.selection;
              setMenu(null);
              if (cmd) onFavoriteCommand(cmd);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: menu.selection ? "var(--accent)" : "var(--text-muted)" }}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 2.2l1.75 3.55 3.92.57-2.83 2.76.67 3.9L8 11.14 4.49 12.98l.67-3.9-2.83-2.76 3.92-.57L8 2.2z" strokeLinejoin="round" />
            </svg>
            <span className="truncate font-medium">{t("snippets.saveSelection")}</span>
          </button>

          <div className="my-1 border-t border-[var(--border-subtle)]" />

          <button
            type="button"
            disabled={!menu.selection}
            onClick={() => void copySelection()}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="5" y="5" width="8" height="8" rx="1.2" />
              <path d="M11 5V3.5A1.2 1.2 0 009.8 2.3H3.5A1.2 1.2 0 002.3 3.5v6.3A1.2 1.2 0 003.5 11H5" />
            </svg>
            <span>{t("terminal.menu.copy")}</span>
          </button>

          <button
            type="button"
            onClick={() => void pasteClipboard()}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M5.5 3H4a1.2 1.2 0 00-1.2 1.2v8.6A1.2 1.2 0 004 14h8a1.2 1.2 0 001.2-1.2V4.2A1.2 1.2 0 0012 3h-1.5" />
              <rect x="5.5" y="1.8" width="5" height="2.4" rx="0.8" />
            </svg>
            <span>{t("terminal.menu.paste")}</span>
          </button>

          <div className="my-1 border-t border-[var(--border-subtle)]" />

          <button
            type="button"
            onClick={() => {
              terminalRef.current?.clear();
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.6 8h4.8l.6-8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{t("terminal.menu.clear")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function toHexLine(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(
    " ",
  );
  const ascii = Array.from(bytes, (byte) =>
    byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".",
  ).join("");
  return `${hex}  |${ascii}|`;
}

function parseHexInput(raw: string): Uint8Array | null {
  const cleaned = raw.replace(/0x/gi, "").replace(/[\s,_-]+/g, "");
  if (cleaned.length === 0 || cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
    return null;
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(cleaned.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
