// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import type { ResolvedTheme } from "../hooks/useTheme";
import type { TerminalBackend } from "../lib/backend";
import { detectTerminalError, type DetectedTerminalError } from "../lib/errorDetector";
import { ipc, isTauri, type EnvTag } from "../lib/ipc";
import { ProdInputTracker, type DangerousCommandMatch } from "../lib/prodGuard";
import {
  buildClickMoveSequence,
  buildSelectionDeleteSequence,
  clientPointToBufferCell,
  extractTerminalLines,
} from "../lib/terminalEditing";
import {
  applyKeywordHighlights,
  compileHighlightRules,
  type HighlightRule,
} from "../lib/terminalHighlighter";
import {
  resolveTerminalTheme,
  type TerminalAppearanceConfig,
} from "../lib/terminalThemes";
import { CommandBlocksPanel, type CommandBlock } from "./CommandBlocksPanel";
import { ProdGuardDialog } from "./ProdGuardDialog";
import { SerialProToolbar } from "./SerialProToolbar";

/**
 * Same stack as the CSS theme token, spelled out because xterm needs a real
 * string: CJK wide glyphs (2 cells) and Cyrillic (1 cell) must line up.
 */
const MONO_FONT_STACK =
  '"JetBrains Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Menlo", "Consolas", monospace';

interface TerminalPaneProps {
  backend: TerminalBackend;
  sessionLabel: string;
  envTag?: EnvTag;
  focused: boolean;
  broadcastTargets?: TerminalBackend[];
  broadcastHasProd?: boolean;
  theme: ResolvedTheme;
  terminalConfig: TerminalAppearanceConfig;
  highlightEnabled: boolean;
  highlightRules: HighlightRule[];
  searchSignal: number;
  blocksSignal: number;
  exitedLabel: string;
  onResize: (cols: number, rows: number) => void;
  onExit: () => void;
  onFavoriteCommand: (command: string) => void;
  onExportLog: (lines: string[]) => void;
  onDiagnoseError: (prompt: string) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  selection: string;
}

interface PendingGuardState {
  match: DangerousCommandMatch;
  payload: string;
}

export function TerminalPane({
  backend,
  sessionLabel,
  envTag,
  focused,
  broadcastTargets,
  broadcastHasProd = false,
  theme,
  terminalConfig,
  highlightEnabled,
  highlightRules,
  searchSignal,
  blocksSignal,
  exitedLabel,
  onResize,
  onExit,
  onFavoriteCommand,
  onExportLog,
  onDiagnoseError,
}: TerminalPaneProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const prodTrackerRef = useRef<ProdInputTracker>(new ProdInputTracker());

  const [hexMode, setHexMode] = useState(false);
  const [hexLog, setHexLog] = useState<string[]>([]);
  const [hexInput, setHexInput] = useState("");
  const [hexError, setHexError] = useState<string | null>(null);
  const [serialTimestamps, setSerialTimestamps] = useState(false);
  const [serialAutoScroll, setSerialAutoScroll] = useState(true);
  const [rxBytes, setRxBytes] = useState(0);
  const [txBytes, setTxBytes] = useState(0);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  // #7 Warp-style OSC 133 command blocks
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [blocks, setBlocks] = useState<CommandBlock[]>([]);
  const activeBlockRef = useRef<{
    id: number;
    commandLine: number;
    outputStartLine: number;
    startedAt: number;
  } | null>(null);
  const blockSeqRef = useRef(1);
  const serialTimestampsRef = useRef(serialTimestamps);
  const serialAutoScrollRef = useRef(serialAutoScroll);
  const lastBlocksSignalRef = useRef(0);

  // #2 Terminal in-pane search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchCount, setSearchCount] = useState<{ index: number; count: number } | null>(null);

  // #9 Floating instant error-triage pill state
  const [detectedError, setDetectedError] = useState<DetectedTerminalError | null>(null);

  // #10 Production destructive guardrail modal state
  const [pendingGuard, setPendingGuard] = useState<PendingGuardState | null>(null);

  const onResizeRef = useRef(onResize);
  const onExitRef = useRef(onExit);
  const exitedLabelRef = useRef(exitedLabel);
  const envTagRef = useRef(envTag);
  const broadcastTargetsRef = useRef(broadcastTargets);
  const broadcastHasProdRef = useRef(broadcastHasProd);
  const resolvedPalette = resolveTerminalTheme(terminalConfig, theme);
  const configRef = useRef({ terminalConfig, resolvedPalette });

  const compiledHighlights = useMemo(
    () => (highlightEnabled ? compileHighlightRules(highlightRules) : []),
    [highlightEnabled, highlightRules],
  );
  const highlightsRef = useRef(compiledHighlights);

  useEffect(() => {
    highlightsRef.current = compiledHighlights;
  }, [compiledHighlights]);

  useEffect(() => {
    onResizeRef.current = onResize;
    onExitRef.current = onExit;
    exitedLabelRef.current = exitedLabel;
    envTagRef.current = envTag;
    broadcastTargetsRef.current = broadcastTargets;
    broadcastHasProdRef.current = broadcastHasProd;
    serialTimestampsRef.current = serialTimestamps;
    serialAutoScrollRef.current = serialAutoScroll;
  }, [
    onResize,
    onExit,
    exitedLabel,
    envTag,
    broadcastTargets,
    broadcastHasProd,
    serialTimestamps,
    serialAutoScroll,
  ]);

  useEffect(() => {
    if (blocksSignal > 0 && blocksSignal !== lastBlocksSignalRef.current && focused) {
      lastBlocksSignalRef.current = blocksSignal;
      setBlocksOpen((open) => !open);
    }
  }, [blocksSignal, focused]);

  // Open search bar whenever parent workspace increments searchSignal on focused pane.
  useEffect(() => {
    if (searchSignal > 0 && focused) {
      setSearchOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }
  }, [focused, searchSignal]);

  // Cmd/Ctrl+F opens in-terminal search when this pane is focused.
  useEffect(() => {
    if (!focused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused]);

  // Run live search whenever query or flags change.
  const runSearch = useCallback(
    (direction: "next" | "prev") => {
      const addon = searchAddonRef.current;
      if (!addon) return;
      if (!searchQuery) {
        addon.clearDecorations();
        setSearchCount(null);
        return;
      }
      const options = {
        caseSensitive: searchCase,
        regex: searchRegex,
        decorations: {
          matchOverviewRuler: "#f59e0b",
          activeMatchColorOverviewRuler: "#ea580c",
          matchBackground: "#f59e0b44",
          activeMatchBackground: "#ea580caa",
        },
      };
      if (direction === "prev") {
        addon.findPrevious(searchQuery, options);
      } else {
        addon.findNext(searchQuery, options);
      }
    },
    [searchCase, searchQuery, searchRegex],
  );

  useEffect(() => {
    if (!searchOpen) {
      searchAddonRef.current?.clearDecorations();
      setSearchCount(null);
      return;
    }
    runSearch("next");
  }, [runSearch, searchOpen]);

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
      setRxBytes((prev) => prev + bytes.length);
      const prefix = serialTimestampsRef.current ? `[${formatClockMs()}] ` : "";
      const line = `${prefix}${toHexLine(bytes)}`;
      setHexLog((previous) => {
        const next = [...previous, line];
        return next.length > 400 ? next.slice(next.length - 400) : next;
      });
    });
  }, [backend]);

  const writeToTargets = useCallback(
    (data: string) => {
      if (backend.kind === "serial") {
        setTxBytes((prev) => prev + new TextEncoder().encode(data).length);
      }
      const targets = broadcastTargetsRef.current;
      if (targets && targets.length > 0) {
        for (const target of targets) {
          target.write(data);
        }
      } else {
        backend.write(data);
      }
    },
    [backend],
  );

  const sendWithGuard = useCallback(
    (data: string) => {
      const guarded =
        envTagRef.current === "prod" ||
        (Boolean(broadcastTargetsRef.current?.length) && broadcastHasProdRef.current);
      if (guarded) {
        const result = prodTrackerRef.current.inspect(data);
        if (result.blocked) {
          setPendingGuard({ match: result.blocked, payload: result.pendingPayload });
          return;
        }
      }
      writeToTargets(data);
    },
    [writeToTargets],
  );
  const sendWithGuardRef = useRef(sendWithGuard);
  useEffect(() => {
    sendWithGuardRef.current = sendWithGuard;
  }, [sendWithGuard]);

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

    const searchAddon = new SearchAddon();
    searchAddonRef.current = searchAddon;
    term.loadAddon(searchAddon);
    const searchResultsDisposable = searchAddon.onDidChangeResults((event) => {
      if (event.resultCount === 0) {
        setSearchCount({ index: 0, count: 0 });
      } else {
        setSearchCount({ index: event.resultIndex + 1, count: event.resultCount });
      }
    });

    const webLinksAddon = new WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey || !term.hasSelection()) {
        if (isTauri()) {
          void ipc.openExternalUrl(uri).catch(console.warn);
        } else {
          window.open(uri, "_blank", "noopener,noreferrer");
        }
      }
    });
    term.loadAddon(webLinksAddon);

    term.open(container);

    // Subtle left-gutter accent marker on every OSC 133;A prompt line plus
    // Warp-style structured Command Block capture on A/B/C/D transitions.
    const oscDisposable = term.parser.registerOscHandler(133, (data) => {
      const absLine = term.buffer.active.baseY + term.buffer.active.cursorY;
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
      } else if (data === "B" || data.startsWith("B;")) {
        activeBlockRef.current = {
          id: blockSeqRef.current++,
          commandLine: absLine,
          outputStartLine: absLine + 1,
          startedAt: Date.now(),
        };
      } else if (data === "C" || data.startsWith("C;")) {
        if (!activeBlockRef.current) {
          activeBlockRef.current = {
            id: blockSeqRef.current++,
            commandLine: absLine,
            outputStartLine: absLine + 1,
            startedAt: Date.now(),
          };
        } else {
          activeBlockRef.current.outputStartLine = absLine + 1;
          activeBlockRef.current.startedAt = Date.now();
        }
      } else if (data.startsWith("D;") || data === "D") {
        const code = data.startsWith("D;")
          ? Number.parseInt(data.slice(2).split(";")[0] ?? "0", 10)
          : 0;
        const pending = activeBlockRef.current;
        activeBlockRef.current = null;
        if (pending) {
          const buf = term.buffer.active;
          const cmdRaw = buf.getLine(pending.commandLine)?.translateToString(true) ?? "";
          // Strip common shell prompt prefix (`$ `, `% `, `# `, `❯ `, `> `)
          const cleanedCmd = cmdRaw.replace(/^.*?(?:[%$#❯>]\s+)/, "").trim() || cmdRaw.trim();
          const outLines: string[] = [];
          const endLine = Math.min(absLine, buf.length - 1);
          for (let lineIdx = pending.outputStartLine; lineIdx < endLine; lineIdx += 1) {
            const text = buf.getLine(lineIdx)?.translateToString(true) ?? "";
            outLines.push(text);
          }
          const outputText = outLines.join("\n").trimEnd();
          if (cleanedCmd.length > 0 || outputText.length > 0) {
            const finished: CommandBlock = {
              id: pending.id,
              command: cleanedCmd,
              output: outputText,
              exitCode: Number.isFinite(code) ? code : 0,
              startedAt: pending.startedAt,
              durationMs: Math.max(0, Date.now() - pending.startedAt),
              bufferLine: pending.commandLine,
            };
            setBlocks((prev) => {
              const next = [...prev, finished];
              return next.length > 80 ? next.slice(next.length - 80) : next;
            });
          }
        }
        if (Number.isFinite(code) && code > 0 && code !== 130) {
          setDetectedError({
            id: Date.now(),
            summary: `Exit ${code}`,
            sampleLine: `Command exited with code ${code}`,
            exitCode: code,
            timestamp: Date.now(),
          });
        } else if (code === 0) {
          setDetectedError(null);
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

    const dataSubscription = term.onData((data) => sendWithGuardRef.current(data));
    const stopOutput = backend.onOutput((data) => {
      const hit = detectTerminalError(data);
      if (hit) {
        setDetectedError(hit);
      }
      let chunk =
        highlightsRef.current.length > 0
          ? applyKeywordHighlights(data, highlightsRef.current)
          : data;
      if (backend.kind === "serial" && serialTimestampsRef.current) {
        const stamp = `\x1b[90m[${formatClockMs()}]\x1b[0m `;
        chunk = chunk.replace(/\r?\n/g, (nl) => `${nl}${stamp}`);
      }
      const savedViewportY = term.buffer.active.viewportY;
      term.write(chunk, () => {
        if (backend.kind === "serial" && !serialAutoScrollRef.current) {
          term.scrollToLine(savedViewportY);
        }
      });
    });
    const stopExit = backend.onExit(() => {
      term.write(`\r\n\x1b[38;5;244m[${exitedLabelRef.current}]\x1b[0m\r\n`);
      onExitRef.current();
    });

    // Editor-grade selection deletion & type-to-replace on the active shell prompt line.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing || event.key === "Process") {
        return true;
      }
      // Let Cmd/Ctrl+F bubble up to open the in-terminal search bar.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        return false;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return true;
      }
      if (!term.hasSelection()) {
        return true;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        const seq = buildSelectionDeleteSequence(term);
        if (seq) {
          event.preventDefault();
          term.clearSelection();
          backend.write(seq);
          return false;
        }
        return true;
      }

      // Directly typing a printable character replaces the active-line selection.
      if (event.key.length === 1) {
        const seq = buildSelectionDeleteSequence(term);
        if (seq) {
          event.preventDefault();
          term.clearSelection();
          backend.write(seq + event.key);
          return false;
        }
      }

      return true;
    });

    // Click anywhere on the active command line to reposition the shell cursor.
    let pointerDown: { x: number; y: number } | null = null;
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
        pointerDown = null;
        return;
      }
      pointerDown = { x: event.clientX, y: event.clientY };
    };
    const onMouseUp = (event: MouseEvent) => {
      if (!pointerDown || event.button !== 0 || event.detail !== 1) {
        pointerDown = null;
        return;
      }
      const dist = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
      pointerDown = null;
      if (dist >= 4 || term.hasSelection()) return;

      const cell = clientPointToBufferCell(term, container, event.clientX, event.clientY);
      if (!cell) return;
      const moveSeq = buildClickMoveSequence(term, cell.row, cell.col);
      if (moveSeq) {
        backend.write(moveSeq);
      }
    };
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("mouseup", onMouseUp);

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
      searchAddonRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("mouseup", onMouseUp);
      searchResultsDisposable.dispose();
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
    const x = Math.min(event.clientX, window.innerWidth - 220);
    const y = Math.min(event.clientY, window.innerHeight - 230);
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
        sendWithGuard(text);
      }
    } catch (cause) {
      console.warn("[ota] clipboard read failed", cause);
    }
    setMenu(null);
  };

  const triggerDiagnoseLatestError = () => {
    const recent = terminalRef.current
      ? extractTerminalLines(terminalRef.current).slice(-35).join("\n")
      : detectedError?.sampleLine ?? "";
    const summary = detectedError?.summary ?? "error";
    setDetectedError(null);
    onDiagnoseError(
      t("triage.agentPrompt", {
        summary,
        snippet: recent,
      }),
    );
  };

  return (
    <div
      className="relative flex h-full w-full flex-col transition-colors duration-150"
      style={{ backgroundColor: resolvedPalette.background }}
      onContextMenu={handleContextMenu}
    >
      {/* #8 Serial Pro debug toolbar */}
      {backend.kind === "serial" ? (
        <SerialProToolbar
          hexMode={hexMode}
          timestamps={serialTimestamps}
          autoScroll={serialAutoScroll}
          rxBytes={rxBytes}
          txBytes={txBytes}
          onToggleHex={() => setHexMode((mode) => !mode)}
          onToggleTimestamps={() => setSerialTimestamps((prev) => !prev)}
          onToggleAutoScroll={() => setSerialAutoScroll((prev) => !prev)}
          onResetCounters={() => {
            setRxBytes(0);
            setTxBytes(0);
          }}
          onSendText={(text) => writeToTargets(text)}
          onSendHex={(rawHex) => {
            const bytes = parseHexInput(rawHex);
            if (!bytes) return false;
            setTxBytes((prev) => prev + bytes.length);
            backend.writeBytes(bytes);
            return true;
          }}
        />
      ) : null}

      <div className="relative min-h-0 flex-1">
      {/* #2 Floating terminal search bar (Cmd/Ctrl+F) */}
      {searchOpen && !hexMode ? (
        <div
          onMouseDown={(event) => event.stopPropagation()}
          className="absolute top-2.5 right-3 z-20 flex items-center gap-1 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 py-1 shadow-xl"
        >
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runSearch(event.shiftKey ? "prev" : "next");
              } else if (event.key === "Escape") {
                event.preventDefault();
                setSearchOpen(false);
                terminalRef.current?.focus();
              }
            }}
            placeholder={t("terminal.search.placeholder")}
            className="h-6 w-44 bg-transparent font-mono text-xs text-[var(--text-primary)] outline-none placeholder:font-sans placeholder:text-[var(--text-muted)]"
          />
          {searchCount ? (
            <span className="ota-tabular px-1 font-mono text-[10.5px] text-[var(--text-muted)]">
              {searchCount.count === 0
                ? t("terminal.search.noMatches")
                : `${searchCount.index}/${searchCount.count}`}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setSearchCase((prev) => !prev)}
            title={t("terminal.search.caseSensitive")}
            className="inline-flex h-6 items-center rounded px-1.5 font-mono text-[11px] transition"
            style={{
              backgroundColor: searchCase ? "var(--accent-soft)" : "transparent",
              color: searchCase ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            Aa
          </button>
          <button
            type="button"
            onClick={() => setSearchRegex((prev) => !prev)}
            title={t("terminal.search.regex")}
            className="inline-flex h-6 items-center rounded px-1.5 font-mono text-[11px] transition"
            style={{
              backgroundColor: searchRegex ? "var(--accent-soft)" : "transparent",
              color: searchRegex ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            .*
          </button>
          <button
            type="button"
            onClick={() => runSearch("prev")}
            title={t("terminal.search.previous")}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => runSearch("next")}
            title={t("terminal.search.next")}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              terminalRef.current?.focus();
            }}
            aria-label={t("common.close")}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            ×
          </button>
        </div>
      ) : null}

      <div
        ref={containerRef}
        className={`h-full w-full px-3.5 py-2 ${hexMode ? "hidden" : ""}`}
      />

      {/* #7 Warp-style Command Blocks drawer */}
      {blocksOpen && !hexMode ? (
        <CommandBlocksPanel
          blocks={blocks}
          onJumpToLine={(line) => {
            terminalRef.current?.scrollToLine(Math.max(0, line));
            terminalRef.current?.focus();
          }}
          onRerun={(command) => {
            sendWithGuard(`${command}\r`);
            terminalRef.current?.focus();
          }}
          onFavorite={onFavoriteCommand}
          onClose={() => setBlocksOpen(false)}
        />
      ) : null}

      {/* #9 Floating Error-Line Instant AI Triage pill */}
      {detectedError && !hexMode ? (
        <div
          onMouseDown={(event) => event.stopPropagation()}
          className="absolute right-3.5 bottom-3 z-20 flex max-w-md items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)] py-1 pr-1.5 pl-3 shadow-xl backdrop-blur-md"
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: "var(--status-danger)" }}
          />
          <span className="truncate text-[11.5px] font-medium text-[var(--text-primary)]">
            {detectedError.summary}
          </span>
          <button
            type="button"
            onClick={triggerDiagnoseLatestError}
            className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-90"
            style={{ backgroundColor: "var(--accent)" }}
          >
            {t("triage.diagnoseNow")}
          </button>
          <button
            type="button"
            onClick={() => setDetectedError(null)}
            aria-label={t("common.close")}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            ×
          </button>
        </div>
      ) : null}

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

      {/* #10 Production destructive guardrail modal */}
      {pendingGuard ? (
        <ProdGuardDialog
          sessionLabel={sessionLabel}
          match={pendingGuard.match}
          onCancel={(clearLine) => {
            setPendingGuard(null);
            prodTrackerRef.current.reset();
            if (clearLine) {
              writeToTargets("\x15");
            }
            terminalRef.current?.focus();
          }}
          onProceed={() => {
            const payload = pendingGuard.payload;
            setPendingGuard(null);
            prodTrackerRef.current.reset();
            writeToTargets(payload);
            terminalRef.current?.focus();
          }}
        />
      ) : null}

      {/* Localized terminal right-click context menu */}
      {menu ? (
        <div
          onMouseDown={(event) => event.stopPropagation()}
          className="fixed z-50 w-52 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            disabled={!menu.selection}
            onClick={() => {
              const snippet = menu.selection;
              setMenu(null);
              if (snippet) {
                onDiagnoseError(t("triage.explainSelectionPrompt", { snippet }));
              }
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: menu.selection ? "var(--accent)" : "var(--text-muted)" }}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 2.2v2M8 11.8v2M2.2 8h2M11.8 8h2M4.1 4.1l1.4 1.4M10.5 10.5l1.4 1.4M11.9 4.1l-1.4 1.4M5.5 10.5l-1.4 1.4" strokeLinecap="round" />
            </svg>
            <span className="truncate font-medium">{t("triage.explainSelection")}</span>
          </button>

          <button
            type="button"
            disabled={!menu.selection}
            onClick={() => {
              const cmd = menu.selection;
              setMenu(null);
              if (cmd) onFavoriteCommand(cmd);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 2.2l1.75 3.55 3.92.57-2.83 2.76.67 3.9L8 11.14 4.49 12.98l.67-3.9-2.83-2.76 3.92-.57L8 2.2z" strokeLinejoin="round" />
            </svg>
            <span className="truncate">{t("snippets.saveSelection")}</span>
          </button>

          <div className="my-1 border-t border-[var(--border-subtle)]" />

          <button
            type="button"
            onClick={() => {
              setMenu(null);
              setSearchOpen(true);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="7" cy="7" r="4.2" />
              <path d="M10.5 10.5L14 14" strokeLinecap="round" />
            </svg>
            <span>{t("terminal.search.menuItem")}</span>
          </button>

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
              const lines = terminalRef.current ? extractTerminalLines(terminalRef.current) : [];
              setMenu(null);
              onExportLog(lines);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--bg-hover)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2.5v7.5M5.2 7.2L8 10l2.8-2.8M3 12.5h10" />
            </svg>
            <span>{t("exportLog.menuItem")}</span>
          </button>

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
    </div>
  );
}

function formatClockMs(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
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
