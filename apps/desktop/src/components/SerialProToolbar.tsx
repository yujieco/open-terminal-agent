// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface SerialMacro {
  id: string;
  label: string;
  payload: string;
  hex: boolean;
}

const MACROS_KEY = "ota.serial.macros.v1";

const DEFAULT_MACROS: SerialMacro[] = [
  { id: "at", label: "AT", payload: "AT\r\n", hex: false },
  { id: "ati", label: "ATI", payload: "ATI\r\n", hex: false },
  { id: "help", label: "help", payload: "help\r\n", hex: false },
  { id: "ctrlc", label: "Ctrl+C", payload: "03", hex: true },
];

function loadMacros(): SerialMacro[] {
  try {
    const raw = window.localStorage.getItem(MACROS_KEY);
    if (!raw) return DEFAULT_MACROS;
    const parsed = JSON.parse(raw) as SerialMacro[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_MACROS;
  } catch {
    return DEFAULT_MACROS;
  }
}

function saveMacros(macros: SerialMacro[]): void {
  try {
    window.localStorage.setItem(MACROS_KEY, JSON.stringify(macros));
  } catch {
    // Ignore storage errors.
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

interface SerialProToolbarProps {
  hexMode: boolean;
  timestamps: boolean;
  autoScroll: boolean;
  rxBytes: number;
  txBytes: number;
  onToggleHex: () => void;
  onToggleTimestamps: () => void;
  onToggleAutoScroll: () => void;
  onResetCounters: () => void;
  onSendText: (text: string) => void;
  onSendHex: (hex: string) => boolean;
}

export function SerialProToolbar({
  hexMode,
  timestamps,
  autoScroll,
  rxBytes,
  txBytes,
  onToggleHex,
  onToggleTimestamps,
  onToggleAutoScroll,
  onResetCounters,
  onSendText,
  onSendHex,
}: SerialProToolbarProps) {
  const { t } = useTranslation();
  const [macros, setMacros] = useState<SerialMacro[]>(() => loadMacros());
  const [addingMacro, setAddingMacro] = useState(false);
  const [macroLabel, setMacroLabel] = useState("");
  const [macroPayload, setMacroPayload] = useState("");
  const [macroHex, setMacroHex] = useState(false);

  // Timed repeat sender
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [repeatPayload, setRepeatPayload] = useState("AT");
  const [repeatHex, setRepeatHex] = useState(false);
  const [repeatMs, setRepeatMs] = useState("1000");
  const [repeating, setRepeating] = useState(false);
  const sendRef = useRef({ onSendText, onSendHex, repeatPayload, repeatHex });

  useEffect(() => {
    sendRef.current = { onSendText, onSendHex, repeatPayload, repeatHex };
  }, [onSendText, onSendHex, repeatPayload, repeatHex]);

  useEffect(() => {
    if (!repeating) return;
    const ms = Math.max(100, Number.parseInt(repeatMs, 10) || 1000);
    const fire = () => {
      const { onSendText: txText, onSendHex: txHex, repeatPayload: p, repeatHex: isHex } = sendRef.current;
      if (isHex) {
        txHex(p);
      } else {
        txText(`${p}\r\n`);
      }
    };
    fire();
    const timer = window.setInterval(fire, ms);
    return () => window.clearInterval(timer);
  }, [repeating, repeatMs]);

  const runMacro = (macro: SerialMacro) => {
    if (macro.hex) {
      onSendHex(macro.payload);
    } else {
      onSendText(macro.payload);
    }
  };

  const addMacro = () => {
    const label = macroLabel.trim();
    const payload = macroPayload;
    if (!label || !payload) return;
    const next: SerialMacro[] = [
      ...macros,
      {
        id: `m-${Date.now()}`,
        label,
        payload: macroHex ? payload : payload.endsWith("\n") ? payload : `${payload}\r\n`,
        hex: macroHex,
      },
    ];
    setMacros(next);
    saveMacros(next);
    setMacroLabel("");
    setMacroPayload("");
    setAddingMacro(false);
  };

  const removeMacro = (id: string) => {
    const next = macros.filter((m) => m.id !== id);
    setMacros(next);
    saveMacros(next);
  };

  return (
    <div
      onMouseDown={(event) => event.stopPropagation()}
      className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-3 py-1.5 text-[11px]"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleHex}
          className="inline-flex h-6 items-center rounded border px-2 font-mono text-[10.5px] font-medium transition"
          style={{
            borderColor: hexMode ? "var(--accent-border)" : "var(--border-subtle)",
            backgroundColor: hexMode ? "var(--accent-soft)" : "var(--bg-surface)",
            color: hexMode ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          {hexMode ? t("terminal.utf8Mode") : t("terminal.hexMode")}
        </button>

        <button
          type="button"
          onClick={onToggleTimestamps}
          className="inline-flex h-6 items-center rounded border px-2 text-[10.5px] font-medium transition"
          style={{
            borderColor: timestamps ? "var(--accent-border)" : "var(--border-subtle)",
            backgroundColor: timestamps ? "var(--accent-soft)" : "var(--bg-surface)",
            color: timestamps ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          {t("serialPro.timestamps")}
        </button>

        <button
          type="button"
          onClick={onToggleAutoScroll}
          className="inline-flex h-6 items-center rounded border px-2 text-[10.5px] font-medium transition"
          style={{
            borderColor: !autoScroll ? "var(--status-warn)" : "var(--border-subtle)",
            backgroundColor: !autoScroll ? "rgba(245, 158, 11, 0.14)" : "var(--bg-surface)",
            color: !autoScroll ? "var(--status-warn)" : "var(--text-secondary)",
          }}
        >
          {autoScroll ? t("serialPro.autoScrollOn") : t("serialPro.autoScrollPaused")}
        </button>

        <button
          type="button"
          onClick={() => setRepeatOpen((open) => !open)}
          className="inline-flex h-6 items-center rounded border px-2 text-[10.5px] font-medium transition"
          style={{
            borderColor: repeating ? "var(--accent-border)" : "var(--border-subtle)",
            backgroundColor: repeating ? "var(--accent-soft)" : "var(--bg-surface)",
            color: repeating ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          {repeating ? t("serialPro.repeating") : t("serialPro.timedSend")}
        </button>

        <div className="mx-1 h-3.5 w-px bg-[var(--border-subtle)]" />

        {/* Quick macro pills */}
        {macros.map((macro) => (
          <span
            key={macro.id}
            className="group inline-flex h-6 items-center overflow-hidden rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
          >
            <button
              type="button"
              onClick={() => runMacro(macro)}
              className="px-2 font-mono text-[10.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            >
              {macro.label}
            </button>
            {macro.id.startsWith("m-") ? (
              <button
                type="button"
                onClick={() => removeMacro(macro.id)}
                className="px-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--status-danger)]"
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setAddingMacro((open) => !open)}
          title={t("serialPro.addMacro")}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-dashed border-[var(--border-strong)] text-xs text-[var(--text-muted)] hover:text-[var(--accent)]"
        >
          +
        </button>

        {/* Live RX/TX byte counters */}
        <button
          type="button"
          onClick={onResetCounters}
          title={t("serialPro.resetCounters")}
          className="ota-tabular ml-auto font-mono text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          RX {formatBytes(rxBytes)} · TX {formatBytes(txBytes)}
        </button>
      </div>

      {repeatOpen ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-[var(--border-subtle)] pt-1.5">
          <input
            value={repeatPayload}
            onChange={(event) => setRepeatPayload(event.target.value)}
            placeholder={repeatHex ? "AA 55 01 0D" : "AT"}
            className="ota-input !h-6 min-w-[10rem] flex-1 font-mono !text-[11px]"
          />
          <label className="flex items-center gap-1 text-[10.5px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={repeatHex}
              onChange={(event) => setRepeatHex(event.target.checked)}
              className="h-3 w-3 accent-[var(--accent)]"
            />
            HEX
          </label>
          <input
            value={repeatMs}
            onChange={(event) => setRepeatMs(event.target.value)}
            className="ota-input !h-6 !w-20 font-mono !text-[11px]"
          />
          <span className="text-[10px] text-[var(--text-muted)]">ms</span>
          <button
            type="button"
            onClick={() => setRepeating((r) => !r)}
            className="h-6 rounded px-2.5 text-[10.5px] font-medium text-white"
            style={{
              backgroundColor: repeating ? "var(--status-danger)" : "var(--accent)",
            }}
          >
            {repeating ? t("serialPro.stopRepeat") : t("serialPro.startRepeat")}
          </button>
        </div>
      ) : null}

      {addingMacro ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-[var(--border-subtle)] pt-1.5">
          <input
            value={macroLabel}
            onChange={(event) => setMacroLabel(event.target.value)}
            placeholder={t("serialPro.macroName")}
            className="ota-input !h-6 !w-24 !text-[11px]"
          />
          <input
            value={macroPayload}
            onChange={(event) => setMacroPayload(event.target.value)}
            placeholder={macroHex ? "01 03 00 00 00 02 C4 0B" : "AT+GMR"}
            className="ota-input !h-6 flex-1 font-mono !text-[11px]"
          />
          <label className="flex items-center gap-1 text-[10.5px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={macroHex}
              onChange={(event) => setMacroHex(event.target.checked)}
              className="h-3 w-3 accent-[var(--accent)]"
            />
            HEX
          </label>
          <button
            type="button"
            onClick={addMacro}
            className="h-6 rounded px-2.5 text-[10.5px] font-medium text-white"
            style={{ backgroundColor: "var(--accent)" }}
          >
            {t("common.save")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
