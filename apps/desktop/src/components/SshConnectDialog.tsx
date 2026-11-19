// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { SshAuthInput, SshConnectInput } from "../lib/ipc";

interface SshConnectDialogProps {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: Omit<SshConnectInput, "cols" | "rows">) => void;
}

type AuthMethod = "password" | "privateKey";

const FIELD =
  "w-full rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500/60";

export function SshConnectDialog({ busy, error, onClose, onSubmit }: SshConnectDialogProps) {
  const { t } = useTranslation();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [method, setMethod] = useState<AuthMethod>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");
  const [passphrase, setPassphrase] = useState("");

  const submit = () => {
    const parsedPort = Number.parseInt(port, 10);
    const auth: SshAuthInput =
      method === "password"
        ? { method: "password", password }
        : {
            method: "privateKey",
            path: keyPath,
            passphrase: passphrase.length > 0 ? passphrase : undefined,
          };
    onSubmit({
      host: host.trim(),
      port: Number.isFinite(parsedPort) ? parsedPort : 22,
      username: username.trim(),
      auth,
    });
  };

  const ready = host.trim().length > 0 && username.trim().length > 0;

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
          <h2 className="text-sm font-medium text-slate-200">{t("ssh.title")}</h2>
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
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-[11px] text-slate-400">{t("ssh.host")}</span>
              <input
                className={FIELD}
                value={host}
                placeholder="10.0.0.12"
                autoFocus
                onChange={(event) => setHost(event.target.value)}
              />
            </label>
            <label className="w-20">
              <span className="text-[11px] text-slate-400">{t("ssh.port")}</span>
              <input
                className={FIELD}
                value={port}
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] text-slate-400">{t("ssh.username")}</span>
            <input
              className={FIELD}
              value={username}
              placeholder="root"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>

          <div>
            <span className="text-[11px] text-slate-400">{t("ssh.auth")}</span>
            <div className="mt-1 flex gap-1">
              {(["password", "privateKey"] as AuthMethod[]).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setMethod(candidate)}
                  className={`flex-1 rounded px-2 py-1 text-[11px] transition ${
                    method === candidate
                      ? "bg-cyan-500/20 text-cyan-100"
                      : "text-slate-400 hover:bg-slate-800/60"
                  }`}
                >
                  {candidate === "password" ? t("ssh.authPassword") : t("ssh.authKey")}
                </button>
              ))}
            </div>
          </div>

          {method === "password" ? (
            <label className="block">
              <span className="text-[11px] text-slate-400">{t("ssh.password")}</span>
              <input
                className={FIELD}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="block">
                <span className="text-[11px] text-slate-400">{t("ssh.keyPath")}</span>
                <input
                  className={FIELD}
                  value={keyPath}
                  onChange={(event) => setKeyPath(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-slate-400">{t("ssh.passphrase")}</span>
                <input
                  className={FIELD}
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
            </>
          )}

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
            onClick={submit}
            className="rounded bg-cyan-500/20 px-3 py-1 text-xs text-cyan-100 transition hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? t("common.connecting") : t("common.connect")}
          </button>
        </footer>
      </div>
    </div>
  );
}
