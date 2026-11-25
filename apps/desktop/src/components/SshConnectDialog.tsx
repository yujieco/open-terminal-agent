// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ipc,
  isTauri,
  type EnvTag,
  type SavedSession,
  type SaveSshSessionInput,
  type SshAuthInput,
  type SshConnectInput,
  type SshJumpInput,
} from "../lib/ipc";

interface SshConnectDialogProps {
  busy: boolean;
  error: string | null;
  editing?: SavedSession | null;
  onClose: () => void;
  onSubmit: (
    input: Omit<SshConnectInput, "cols" | "rows">,
    save: {
      id?: string;
      name: string;
      rememberPassword: boolean;
      envTag?: EnvTag;
      groupName?: string;
    } | null,
    envTag?: EnvTag,
  ) => void;
  onSaveOnly?: (input: SaveSshSessionInput) => Promise<void> | void;
}

type AuthMethod = "password" | "privateKey";

function readPayloadStr(payload: Record<string, unknown> | undefined, key: string): string {
  const val = payload?.[key];
  return typeof val === "string" ? val : "";
}

export function SshConnectDialog({
  busy,
  error,
  editing,
  onClose,
  onSubmit,
  onSaveOnly,
}: SshConnectDialogProps) {
  const { t } = useTranslation();
  const payload = editing?.payload;
  const authObj = (payload?.auth as Record<string, unknown> | undefined) ?? undefined;
  const jumpObj = (payload?.jump as Record<string, unknown> | undefined) ?? undefined;
  const jumpAuthObj = (jumpObj?.auth as Record<string, unknown> | undefined) ?? undefined;

  const initialEnv = readPayloadStr(payload, "envTag");
  const parsedEnv: EnvTag | undefined =
    initialEnv === "prod" || initialEnv === "staging" || initialEnv === "dev"
      ? initialEnv
      : undefined;

  const [host, setHost] = useState(() => readPayloadStr(payload, "host"));
  const [port, setPort] = useState(() =>
    typeof payload?.port === "number" ? String(payload.port) : "22",
  );
  const [username, setUsername] = useState(() => readPayloadStr(payload, "username"));
  const [method, setMethod] = useState<AuthMethod>(() =>
    authObj?.method === "privateKey" ? "privateKey" : "password",
  );
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState(() =>
    typeof authObj?.path === "string" && authObj.path.length > 0
      ? authObj.path
      : "~/.ssh/id_ed25519",
  );
  const [passphrase, setPassphrase] = useState("");
  const [save, setSave] = useState(() => Boolean(editing));
  const [envTag, setEnvTag] = useState<EnvTag | undefined>(parsedEnv);
  const [groupName, setGroupName] = useState(() => readPayloadStr(payload, "groupName"));
  const [pendingFingerprint, setPendingFingerprint] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState(() => editing?.name ?? "");

  // Optional ProxyJump / Bastion host
  const [useJump, setUseJump] = useState(() => Boolean(jumpObj?.host));
  const [jumpHost, setJumpHost] = useState(() =>
    typeof jumpObj?.host === "string" ? jumpObj.host : "",
  );
  const [jumpPort, setJumpPort] = useState(() =>
    typeof jumpObj?.port === "number" ? String(jumpObj.port) : "22",
  );
  const [jumpUser, setJumpUser] = useState(() =>
    typeof jumpObj?.username === "string" ? jumpObj.username : "",
  );
  const [jumpMethod, setJumpMethod] = useState<AuthMethod>(() =>
    jumpAuthObj?.method === "password" ? "password" : "privateKey",
  );
  const [jumpPassword, setJumpPassword] = useState("");
  const [jumpKeyPath, setJumpKeyPath] = useState(() =>
    typeof jumpAuthObj?.path === "string" && jumpAuthObj.path.length > 0
      ? jumpAuthObj.path
      : "~/.ssh/id_ed25519",
  );

  const buildJump = (): SshJumpInput | undefined => {
    if (!useJump || !jumpHost.trim() || !jumpUser.trim()) return undefined;
    const parsedJumpPort = Number.parseInt(jumpPort, 10);
    return {
      host: jumpHost.trim(),
      port: Number.isFinite(parsedJumpPort) ? parsedJumpPort : 22,
      username: jumpUser.trim(),
      auth:
        jumpMethod === "password"
          ? { method: "password", password: jumpPassword }
          : { method: "privateKey", path: jumpKeyPath },
    };
  };

  const buildAuth = (): SshAuthInput =>
    method === "password"
      ? { method: "password", password }
      : {
          method: "privateKey",
          path: keyPath,
          passphrase: passphrase.length > 0 ? passphrase : undefined,
        };

  const submit = (trustFingerprint?: string) => {
    const parsedPort = Number.parseInt(port, 10);
    const jump = buildJump();
    onSubmit(
      {
        host: host.trim(),
        port: Number.isFinite(parsedPort) ? parsedPort : 22,
        username: username.trim(),
        auth: buildAuth(),
        trustFingerprint,
        jump,
      },
      save
        ? {
            id: editing?.id,
            name: sessionName.trim(),
            rememberPassword: true,
            envTag,
            groupName: groupName.trim() || undefined,
          }
        : null,
      envTag,
    );
  };

  const saveEditOnly = async () => {
    if (!editing || !onSaveOnly) return;
    const parsedPort = Number.parseInt(port, 10);
    await onSaveOnly({
      id: editing.id,
      name: sessionName.trim() || `${username.trim()}@${host.trim()}`,
      host: host.trim(),
      port: Number.isFinite(parsedPort) ? parsedPort : 22,
      username: username.trim(),
      auth: buildAuth(),
      rememberPassword: true,
      envTag,
      groupName: groupName.trim() || undefined,
      jump: buildJump(),
    });
    onClose();
  };

  const ready = host.trim().length > 0 && username.trim().length > 0;

  const target = () => ({
    host: host.trim(),
    port: Number.isFinite(Number.parseInt(port, 10)) ? Number.parseInt(port, 10) : 22,
  });

  /** First contact must be approved by a human, not assumed. */
  const start = async () => {
    if (!isTauri() || useJump) {
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
      submit();
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
        className="flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {editing ? t("ssh.editTitle") : t("ssh.title")}
          </h2>
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

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
          <div className="grid grid-cols-3 gap-2">
            <label className="col-span-2 block">
              <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("ssh.host")}
              </span>
              <input
                className="ota-input font-mono"
                value={host}
                placeholder="10.0.0.10"
                onChange={(event) => setHost(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                {t("ssh.port")}
              </span>
              <input
                className="ota-input font-mono"
                value={port}
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

          <div className="ota-segmented grid-cols-2">
            {(["password", "privateKey"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                data-active={method === candidate}
                onClick={() => setMethod(candidate)}
                className="ota-segment"
              >
                {t(`ssh.${candidate}`)}
              </button>
            ))}
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
                placeholder={editing ? t("ssh.keepExistingPassword") : ""}
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

          {/* Optional ProxyJump / Bastion host */}
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-2.5">
            <label className="flex cursor-pointer items-center justify-between text-xs font-medium text-[var(--text-primary)]">
              <span>{t("ssh.jumpTitle")}</span>
              <input
                type="checkbox"
                checked={useJump}
                onChange={(event) => setUseJump(event.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
            </label>
            {useJump ? (
              <div className="mt-2.5 space-y-2 border-t border-[var(--border-subtle)] pt-2.5">
                <div className="grid grid-cols-3 gap-2">
                  <input
                    className="ota-input col-span-2 font-mono"
                    value={jumpHost}
                    placeholder={t("ssh.jumpHostPlaceholder")}
                    onChange={(event) => setJumpHost(event.target.value)}
                  />
                  <input
                    className="ota-input font-mono"
                    value={jumpPort}
                    placeholder="22"
                    onChange={(event) => setJumpPort(event.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className="ota-input font-mono"
                    value={jumpUser}
                    placeholder={t("ssh.username")}
                    onChange={(event) => setJumpUser(event.target.value)}
                  />
                  <select
                    className="ota-input"
                    value={jumpMethod}
                    onChange={(event) => setJumpMethod(event.target.value as AuthMethod)}
                  >
                    <option value="privateKey">{t("ssh.privateKey")}</option>
                    <option value="password">{t("ssh.password")}</option>
                  </select>
                </div>
                {jumpMethod === "password" ? (
                  <input
                    className="ota-input"
                    type="password"
                    value={jumpPassword}
                    placeholder={t("ssh.password")}
                    onChange={(event) => setJumpPassword(event.target.value)}
                  />
                ) : (
                  <input
                    className="ota-input font-mono"
                    value={jumpKeyPath}
                    placeholder="~/.ssh/id_ed25519"
                    onChange={(event) => setJumpKeyPath(event.target.value)}
                  />
                )}
              </div>
            ) : null}
          </div>

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

          <div>
            <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
              {t("prodGuard.envLabel")}
            </span>
            <div className="grid grid-cols-4 gap-1">
              {(
                [
                  { id: undefined, label: t("prodGuard.envNormal") },
                  { id: "dev" as EnvTag, label: t("prodGuard.envDev") },
                  { id: "staging" as EnvTag, label: t("prodGuard.envStaging") },
                  { id: "prod" as EnvTag, label: t("prodGuard.envProd") },
                ] as const
              ).map((item) => {
                const active = envTag === item.id;
                const isProd = item.id === "prod";
                return (
                  <button
                    key={item.id ?? "normal"}
                    type="button"
                    onClick={() => setEnvTag(item.id)}
                    className="h-7 rounded-md border text-[11px] font-medium transition"
                    style={{
                      borderColor: active
                        ? isProd
                          ? "var(--status-danger)"
                          : "var(--accent-border)"
                        : "var(--border-subtle)",
                      backgroundColor: active
                        ? isProd
                          ? "rgba(239, 68, 68, 0.14)"
                          : "var(--accent-soft)"
                        : "var(--bg-elevated)",
                      color: active
                        ? isProd
                          ? "var(--status-danger)"
                          : "var(--accent)"
                        : "var(--text-secondary)",
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>

          {!editing ? (
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={save}
                onChange={(event) => setSave(event.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              {t("ssh.remember")}
            </label>
          ) : null}

          {save ? (
            <div className="grid grid-cols-2 gap-2">
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
              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                  {t("ssh.groupName")}
                </span>
                <input
                  className="ota-input"
                  value={groupName}
                  placeholder={t("ssh.groupPlaceholder")}
                  onChange={(event) => setGroupName(event.target.value)}
                />
              </label>
            </div>
          ) : null}

          {error ? (
            <p className="text-[11px]" style={{ color: "var(--status-danger)" }}>
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {t("common.cancel")}
          </button>
          {editing && onSaveOnly ? (
            <button
              type="button"
              disabled={busy || !ready}
              onClick={() => void saveEditOnly()}
              className="ota-btn-primary rounded-md px-3.5 py-1.5 text-xs"
            >
              {t("common.save")}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !ready || pendingFingerprint !== null}
              onClick={() => void start()}
              className="ota-btn-primary rounded-md px-3.5 py-1.5 text-xs"
            >
              {busy ? t("common.connecting") : t("common.connect")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
