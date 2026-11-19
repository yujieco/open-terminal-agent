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

const FIELD =
  "w-full rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500/60";

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-lg border border-slate-800 bg-slate-900/95 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
          <h2 className="text-sm font-medium text-slate-200">{t("serial.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded px-2 py-0.5 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200"
          >
            ×
          </button>
        </header>

        <div className="space-y-2.5 px-4 py-3">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400">{t("serial.port")}</span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="text-[10px] text-cyan-300/80 hover:text-cyan-200"
              >
                {t("serial.refresh")}
              </button>
            </div>
            <select
              className={FIELD}
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
              <p className="mt-1 text-[10px] text-amber-300/80">{portError}</p>
            ) : null}
          </div>

          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-[11px] text-slate-400">{t("serial.baud")}</span>
              <select
                className={FIELD}
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
              <span className="text-[11px] text-slate-400">{t("serial.dataBits")}</span>
              <select
                className={FIELD}
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
              <span className="text-[11px] text-slate-400">{t("serial.stopBits")}</span>
              <select
                className={FIELD}
                value={stopBits}
                onChange={(event) => setStopBits(event.target.value as SerialStopBits)}
              >
                <option value="one">1</option>
                <option value="two">2</option>
              </select>
            </label>
            <label className="flex-1">
              <span className="text-[11px] text-slate-400">{t("serial.parity")}</span>
              <select
                className={FIELD}
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
            <span className="text-[11px] text-slate-400">{t("serial.flowControl")}</span>
            <select
              className={FIELD}
              value={flowControl}
              onChange={(event) => setFlowControl(event.target.value as SerialFlowControl)}
            >
              <option value="none">{t("serial.flowNone")}</option>
              <option value="software">{t("serial.flowSoftware")}</option>
              <option value="hardware">{t("serial.flowHardware")}</option>
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] text-slate-400">{t("serial.logPath")}</span>
            <input
              className={FIELD}
              value={logPath}
              placeholder={t("serial.logPlaceholder")}
              onChange={(event) => setLogPath(event.target.value)}
            />
          </label>

          {error ? <p className="text-[11px] text-rose-300">{error}</p> : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-800 px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
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
            className="rounded bg-cyan-500/20 px-3 py-1 text-xs text-cyan-100 transition hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? t("common.connecting") : t("common.connect")}
          </button>
        </footer>
      </div>
    </div>
  );
}
