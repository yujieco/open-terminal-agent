// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc, isTauri, type SshAuthInput, type SshConnectInput } from "../lib/ipc";

interface SshConnectDialogProps {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (
    input: Omit<SshConnectInput, "cols" | "rows">,
    save: { name: string; rememberPassword: boolean } | null,
  ) => void;
}

type AuthMethod = "password" | "privateKey";

export function SshConnectDialog({ busy, error, onClose, onSubmit }: SshConnectDialogProps) {
  const { t } = useTranslation();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [method, setMethod] = useState<AuthMethod>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");
  const [passphrase, setPassphrase] = useState("");
  const [save, setSave] = useState(false);
  const [pendingFingerprint, setPendingFingerprint] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState("");

  const submit = (trustFingerprint?: string) => {
    const parsedPort = Number.parseInt(port, 10);
    const auth: SshAuthInput =
      method === "password"
        ? { method: "password", password }
        : {
            method: "privateKey",
            path: keyPath,
            passphrase: passphrase.length > 0 ? passphrase : undefined,
          };
    onSubmit(
      {
        host: host.trim(),
        port: Number.isFinite(parsedPort) ? parsedPort : 22,
        username: username.trim(),
        auth,
        trustFingerprint,
      },
      save ? { name: sessionName.trim(), rememberPassword: true } : null,
    );
  };

  const ready = host.trim().length > 0 && username.trim().length > 0;

  const target = () => ({
    host: host.trim(),
    port: Number.isFinite(Number.parseInt(port, 10))
      ? Number.parseInt(port, 10)
      : 22,
  });

  /** First contact must be approved by a human, not assumed. */
  const start = async () => {
    if (!isTauri()) {
      submit();
      return;
    }
    const { host: hostName, port: portNumber } = target();
    try {
      const [known, fingerprint] = await Promise.all([
        ipc.listKnownHosts(),
        ipc.probeHostKey(hostName, portNumber),
      ]);
      const pinned = known.some(
        (entry) => entry.host === hostName && entry.port === portNumber,
      );
      if (pinned) {
        submit(fingerprint);
      } else {
        setPendingFingerprint(fingerprint);
      }
    } catch (cause) {
      setPendingFingerprint(null);
      onSubmit(
        {
          host: hostName,
          port: portNumber,
          username: username.trim(),
          auth:
            method === "password"
              ? { method: "password", password }
              : { method: "privateKey", path: keyPath },
        },
        save ? { name: sessionName.trim(), rememberPassword: true } : null,
      );
      console.warn("[ota] host key probe failed, connecting with stored rules", cause);
    }
  };

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
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("ssh.title")}</h2>
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
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("ssh.host")}
              </span>
              <input
                className="ota-input font-mono"
                value={host}
                placeholder="10.0.0.12"
                autoFocus
                onChange={(event) => setHost(event.target.value)}
              />
            </label>
            <label className="w-20">
              <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("ssh.port")}
              </span>
              <input
                className="ota-input font-mono"
                value={port}
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
              {t("ssh.username")}
            </span>
            <input
              className="ota-input font-mono"
              value={username}
              placeholder="root"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>

          <div>
            <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
              {t("ssh.auth")}
            </span>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-1">
              {(["password", "privateKey"] as AuthMethod[]).map((candidate) => {
                const selected = method === candidate;
                return (
                  <button
                    key={candidate}
                    type="button"
                    onClick={() => setMethod(candidate)}
                    className="rounded-md px-2 py-1 text-[11px] font-medium transition"
                    style={{
                      backgroundColor: selected ? "var(--bg-elevated)" : "transparent",
                      color: selected ? "var(--text-primary)" : "var(--text-muted)",
                    }}
                  >
                    {candidate === "password" ? t("ssh.authPassword") : t("ssh.authKey")}
                  </button>
                );
              })}
            </div>
          </div>

          {method === "password" ? (
            <label className="block">
              <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("ssh.password")}
              </span>
              <input
                className="ota-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                  {t("ssh.keyPath")}
                </span>
                <input
                  className="ota-input font-mono"
                  value={keyPath}
                  onChange={(event) => setKeyPath(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                  {t("ssh.passphrase")}
                </span>
                <input
                  className="ota-input"
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
            </>
          )}

          {pendingFingerprint ? (
            <div
              className="rounded-lg border p-3"
              style={{
                borderColor: "var(--accent-border)",
                backgroundColor: "var(--accent-soft)",
              }}
            >
              <p className="text-[11px] font-medium text-[var(--text-primary)]">
                {t("ssh.firstContact")}
              </p>
              <pre className="mt-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1.5 font-mono text-[10px] break-all whitespace-pre-wrap text-[var(--text-primary)]">
                {pendingFingerprint}
              </pre>
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => submit(pendingFingerprint)}
                  className="ota-btn-primary flex-1 rounded-md px-2 py-1.5 text-[11px]"
                >
                  {t("ssh.trustAndConnect")}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingFingerprint(null)}
                  className="flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 py-1.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : null}

          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={save}
              onChange={(event) => setSave(event.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            {t("ssh.remember")}
          </label>

          {save ? (
            <label className="block">
              <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("ssh.sessionName")}
              </span>
              <input
                className="ota-input"
                value={sessionName}
                placeholder={`${username || "user"}@${host || "host"}`}
                onChange={(event) => setSessionName(event.target.value)}
              />
            </label>
          ) : null}

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
            disabled={busy || !ready || pendingFingerprint !== null}
            onClick={() => void start()}
            className="ota-btn-primary rounded-md px-3.5 py-1.5 text-xs"
          >
            {busy ? t("common.connecting") : t("common.connect")}
          </button>
        </footer>
      </div>
    </div>
  );
}
