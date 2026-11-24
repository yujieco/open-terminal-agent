// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ipc,
  isTauri,
  type SerialConnectInput,
  type SerialFlowControl,
  type SerialParity,
  type SerialPortDescriptor,
  type SerialStopBits,
} from "../lib/ipc";

interface SerialConnectDialogProps {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: SerialConnectInput) => void;
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export function SerialConnectDialog({ busy, error, onClose, onSubmit }: SerialConnectDialogProps) {
  const { t } = useTranslation();
  const [ports, setPorts] = useState<SerialPortDescriptor[]>([]);
  const [portError, setPortError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [baudRate, setBaudRate] = useState("115200");
  const [dataBits, setDataBits] = useState("8");
  const [stopBits, setStopBits] = useState<SerialStopBits>("one");
  const [parity, setParity] = useState<SerialParity>("none");
  const [flowControl, setFlowControl] = useState<SerialFlowControl>("none");
  const [logPath, setLogPath] = useState("");

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setPortError(t("serial.desktopOnly"));
      return;
    }
    try {
      const listed = await ipc.serialPorts();
      setPorts(listed);
      setPortError(listed.length === 0 ? t("serial.noPorts") : null);
      setPath((current) => (current.length > 0 ? current : (listed[0]?.path ?? "")));
    } catch (cause) {
      setPortError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const parsedBaud = Number.parseInt(baudRate, 10);
  const ready = path.trim().length > 0 && Number.isFinite(parsedBaud) && parsedBaud > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-[2px]"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("serial.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="space-y-3 px-4 py-3.5">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("serial.port")}
              </span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="text-[10.5px] font-medium transition hover:opacity-80"
                style={{ color: "var(--accent)" }}
              >
                {t("serial.refresh")}
              </button>
            </div>
            <select
              className="ota-input font-mono"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            >
              <option value="">{t("serial.selectPort")}</option>
              {ports.map((port) => (
                <option key={port.path} value={port.path}>
                  {port.path}
                  {port.product ? ` — ${port.product}` : ""}
                </option>
              ))}
            </select>
            {portError ? (
              <p className="mt-1 text-[10.5px]" style={{ color: "var(--accent)" }}>
                {portError}
              </p>
            ) : null}
          </div>

          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("serial.baud")}
              </span>
              <select
                className="ota-input font-mono"
                value={baudRate}
                onChange={(event) => setBaudRate(event.target.value)}
              >
                {BAUD_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}
                  </option>
                ))}
              </select>
            </label>
            <label className="w-24">
              <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("serial.dataBits")}
              </span>
              <select
                className="ota-input font-mono"
                value={dataBits}
                onChange={(event) => setDataBits(event.target.value)}
              >
                {[5, 6, 7, 8].map((bits) => (
                  <option key={bits} value={bits}>
                    {bits}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("serial.stopBits")}
              </span>
              <select
                className="ota-input"
                value={stopBits}
                onChange={(event) => setStopBits(event.target.value as SerialStopBits)}
              >
                <option value="one">1</option>
                <option value="two">2</option>
              </select>
            </label>
            <label className="flex-1">
              <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("serial.parity")}
              </span>
              <select
                className="ota-input"
                value={parity}
                onChange={(event) => setParity(event.target.value as SerialParity)}
              >
                <option value="none">{t("serial.parityNone")}</option>
                <option value="odd">{t("serial.parityOdd")}</option>
                <option value="even">{t("serial.parityEven")}</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
              {t("serial.flowControl")}
            </span>
            <select
              className="ota-input"
              value={flowControl}
              onChange={(event) => setFlowControl(event.target.value as SerialFlowControl)}
            >
              <option value="none">{t("serial.flowNone")}</option>
              <option value="software">{t("serial.flowSoftware")}</option>
              <option value="hardware">{t("serial.flowHardware")}</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
              {t("serial.logPath")}
            </span>
            <input
              className="ota-input font-mono"
              value={logPath}
              placeholder={t("serial.logPlaceholder")}
              onChange={(event) => setLogPath(event.target.value)}
            />
          </label>

          {error ? (
            <p className="text-[11px]" style={{ color: "var(--status-danger)" }}>
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !ready}
            onClick={() =>
              onSubmit({
                path: path.trim(),
                baudRate: parsedBaud,
                dataBits: Number.parseInt(dataBits, 10),
                stopBits,
                parity,
                flowControl,
                logPath: logPath.trim().length > 0 ? logPath.trim() : undefined,
              })
            }
            className="ota-btn-primary rounded-md px-3.5 py-1.5 text-xs"
          >
            {busy ? t("common.connecting") : t("common.connect")}
          </button>
        </footer>
      </div>
    </div>
  );
}
