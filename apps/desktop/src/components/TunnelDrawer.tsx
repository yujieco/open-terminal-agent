// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ipc,
  isTauri,
  type SavedSession,
  type TunnelKind,
  type TunnelView,
} from "../lib/ipc";

interface TunnelDrawerProps {
  saved: SavedSession[];
  onOpenSsh: () => void;
  onActiveCountChange: (count: number) => void;
  onClose: () => void;
}

const KINDS: TunnelKind[] = ["local", "remote", "dynamic"];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function copyEndpoint(tunnel: TunnelView): string {
  if (tunnel.kind === "dynamic") {
    return `socks5://${tunnel.bindHost}:${tunnel.activePort}`;
  }
  return `${tunnel.bindHost}:${tunnel.activePort}`;
}

export function TunnelDrawer({
  saved,
  onOpenSsh,
  onActiveCountChange,
  onClose,
}: TunnelDrawerProps) {
  const { t } = useTranslation();
  const sshSessions = saved.filter((entry) => entry.kind === "ssh");

  const [tunnels, setTunnels] = useState<TunnelView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  // Rule editor form state
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [sessionId, setSessionId] = useState(() => sshSessions[0]?.id ?? "");
  const [kind, setKind] = useState<TunnelKind>("local");
  const [bindHost, setBindHost] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState("13306");
  const [targetHost, setTargetHost] = useState("127.0.0.1");
  const [targetPort, setTargetPort] = useState("3306");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!sessionId && sshSessions.length > 0) {
      setSessionId(sshSessions[0].id);
    }
  }, [sessionId, sshSessions]);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const list = await ipc.listTunnels();
      setTunnels(list);
      onActiveCountChange(list.filter((item) => item.running).length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onActiveCountChange]);

  useEffect(() => {
    void refresh();
    if (!isTauri()) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const openNewForm = () => {
    setEditingId(undefined);
    setName("");
    setSessionId(sshSessions[0]?.id ?? "");
    setKind("local");
    setBindHost("127.0.0.1");
    setBindPort("13306");
    setTargetHost("127.0.0.1");
    setTargetPort("3306");
    setError(null);
    setFormOpen(true);
  };

  const openEditForm = (tunnel: TunnelView) => {
    setEditingId(tunnel.id);
    setName(tunnel.name);
    setSessionId(tunnel.sessionId);
    setKind(tunnel.kind);
    setBindHost(tunnel.bindHost);
    setBindPort(String(tunnel.bindPort));
    setTargetHost(tunnel.targetHost || "127.0.0.1");
    setTargetPort(tunnel.targetPort > 0 ? String(tunnel.targetPort) : "");
    setError(null);
    setFormOpen(true);
  };

  const switchKind = (next: TunnelKind) => {
    setKind(next);
    if (next === "dynamic" && (bindPort === "13306" || bindPort === "8080")) {
      setBindPort("1080");
    } else if (next === "local" && bindPort === "1080") {
      setBindPort("13306");
      setTargetPort("3306");
    } else if (next === "remote" && (bindPort === "13306" || bindPort === "1080")) {
      setBindPort("8080");
      setTargetPort("3000");
    }
  };

  const submitForm = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const parsedBindPort = Number.parseInt(bindPort, 10);
    if (!Number.isInteger(parsedBindPort) || parsedBindPort < 0 || parsedBindPort > 65535) {
      setError(t("tunnels.invalidPort"));
      return;
    }

    let parsedTargetPort = 0;
    if (kind !== "dynamic") {
      parsedTargetPort = Number.parseInt(targetPort, 10);
      if (!Number.isInteger(parsedTargetPort) || parsedTargetPort < 1 || parsedTargetPort > 65535) {
        setError(t("tunnels.invalidPort"));
        return;
      }
    }

    if (!sessionId) {
      setError(t("tunnels.noSshHint"));
      return;
    }

    setSaving(true);
    try {
      await ipc.saveTunnel({
        id: editingId,
        name: name.trim() || `${kind.toUpperCase()} :${parsedBindPort}`,
        sessionId,
        kind,
        bindHost: bindHost.trim() || "127.0.0.1",
        bindPort: parsedBindPort,
        targetHost: kind === "dynamic" ? "" : targetHost.trim() || "127.0.0.1",
        targetPort: parsedTargetPort,
      });
      setFormOpen(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const toggleTunnel = async (tunnel: TunnelView) => {
    setBusyId(tunnel.id);
    setError(null);
    try {
      if (tunnel.running) {
        await ipc.stopTunnel(tunnel.id);
      } else {
        await ipc.startTunnel(tunnel.id);
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const removeTunnel = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await ipc.deleteTunnel(id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopy = async (tunnel: TunnelView) => {
    try {
      await navigator.clipboard.writeText(copyEndpoint(tunnel));
      setCopiedId(tunnel.id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === tunnel.id ? null : current));
      }, 1500);
    } catch {
      // Ignore clipboard failure.
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
      style={{ backgroundColor: "var(--overlay)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-2xl backdrop-blur-xl"
        style={{
          backgroundColor: "color-mix(in srgb, var(--bg-surface) 94%, transparent)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
              {t("tunnels.title")}
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              {t("tunnels.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {sshSessions.length > 0 && !formOpen ? (
              <button type="button" onClick={openNewForm} className="ota-ctrl-primary">
                {t("tunnels.newRule")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {error ? (
            <div
              className="rounded-lg border px-3 py-2 text-[12px] leading-relaxed"
              style={{
                borderColor: "var(--status-danger)",
                backgroundColor: "var(--status-danger-soft)",
                color: "var(--status-danger)",
              }}
            >
              {error}
            </div>
          ) : null}

          {sshSessions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--bg-canvas)] p-5 text-center">
              <p className="text-[12.5px] font-medium text-[var(--text-primary)]">
                {t("tunnels.noSshTitle")}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                {t("tunnels.noSshHint")}
              </p>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSsh();
                }}
                className="ota-ctrl-primary mt-3"
              >
                {t("tunnels.addSshFirst")}
              </button>
            </div>
          ) : null}

          {/* Create / Edit tunnel rule form */}
          {formOpen && sshSessions.length > 0 ? (
            <form
              onSubmit={(event) => void submitForm(event)}
              className="space-y-3 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-canvas)] p-3.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                  {editingId ? t("tunnels.editRule") : t("tunnels.newRule")}
                </span>
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  {t("common.cancel")}
                </button>
              </div>

              <div className="ota-segmented w-full grid-cols-3">
                {KINDS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    data-active={kind === item}
                    onClick={() => switchKind(item)}
                    className="ota-segment"
                  >
                    {t(`tunnels.kinds.${item}`)}
                  </button>
                ))}
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
                {t(`tunnels.kindHints.${kind}`)}
              </p>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div>
                  <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                    {t("tunnels.ruleName")}
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("tunnels.ruleNamePlaceholder")}
                    className="ota-input mt-1"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                    {t("tunnels.sshServer")}
                  </label>
                  <select
                    value={sessionId}
                    onChange={(event) => setSessionId(event.target.value)}
                    className="ota-input mt-1"
                  >
                    {sshSessions.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div className="col-span-2">
                  <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                    {kind === "remote" ? t("tunnels.remoteBindHost") : t("tunnels.localBindHost")}
                  </label>
                  <input
                    type="text"
                    value={bindHost}
                    onChange={(event) => setBindHost(event.target.value)}
                    placeholder="127.0.0.1"
                    className="ota-input mt-1 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                    {kind === "remote" ? t("tunnels.remoteBindPort") : t("tunnels.localBindPort")}
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={65535}
                    value={bindPort}
                    onChange={(event) => setBindPort(event.target.value)}
                    className="ota-input mt-1 font-mono"
                  />
                </div>
              </div>

              {kind !== "dynamic" ? (
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="col-span-2">
                    <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                      {kind === "remote" ? t("tunnels.localTargetHost") : t("tunnels.remoteTargetHost")}
                    </label>
                    <input
                      type="text"
                      value={targetHost}
                      onChange={(event) => setTargetHost(event.target.value)}
                      placeholder="127.0.0.1"
                      className="ota-input mt-1 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                      {kind === "remote" ? t("tunnels.localTargetPort") : t("tunnels.remoteTargetPort")}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={targetPort}
                      onChange={(event) => setTargetPort(event.target.value)}
                      className="ota-input mt-1 font-mono"
                    />
                  </div>
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="ota-ctrl"
                >
                  {t("common.cancel")}
                </button>
                <button type="submit" disabled={saving} className="ota-ctrl-primary">
                  {saving ? t("tunnels.saving") : t("tunnels.saveRule")}
                </button>
              </div>
            </form>
          ) : null}

          {/* Saved rules list */}
          {tunnels.length === 0 && sshSessions.length > 0 && !formOpen ? (
            <div className="rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-4 py-6 text-center">
              <p className="text-[12.5px] text-[var(--text-muted)]">{t("tunnels.empty")}</p>
            </div>
          ) : null}

          {tunnels.length > 0 ? (
            <ul className="space-y-2.5">
              {tunnels.map((tunnel) => {
                const isBusy = busyId === tunnel.id;
                const mappingText =
                  tunnel.kind === "local"
                    ? `${tunnel.bindHost}:${tunnel.activePort} → [SSH] → ${tunnel.targetHost}:${tunnel.targetPort}`
                    : tunnel.kind === "remote"
                      ? `[SSH] ${tunnel.bindHost}:${tunnel.activePort} → ${tunnel.targetHost}:${tunnel.targetPort}`
                      : `socks5://${tunnel.bindHost}:${tunnel.activePort} → [SSH]`;

                return (
                  <li
                    key={tunnel.id}
                    className="rounded-lg border bg-[var(--bg-canvas)] p-3 transition"
                    style={{
                      borderColor: tunnel.running ? "var(--status-ok)" : "var(--border-subtle)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{
                          backgroundColor: tunnel.running
                            ? "var(--status-ok)"
                            : "var(--text-muted)",
                        }}
                      />
                      <span className="truncate text-[12.5px] font-semibold text-[var(--text-primary)]">
                        {tunnel.name}
                      </span>
                      <span className="shrink-0 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
                        {t(`tunnels.badges.${tunnel.kind}`)}
                      </span>
                      <span className="ml-auto truncate text-[11px] text-[var(--text-muted)]">
                        {tunnel.sessionName}
                      </span>
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--text-primary)]">
                      <span className="truncate">{mappingText}</span>
                      {tunnel.kind !== "remote" ? (
                        <button
                          type="button"
                          onClick={() => void handleCopy(tunnel)}
                          className="shrink-0 rounded px-1.5 py-0.5 font-sans text-[11px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                          {copiedId === tunnel.id ? t("tunnels.copied") : t("tunnels.copyAddr")}
                        </button>
                      ) : null}
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {tunnel.running ? (
                        <span className="ota-tabular text-[11px] text-[var(--text-secondary)]">
                          {t("tunnels.liveStats", {
                            active: tunnel.stats.activeConnections,
                            tx: formatBytes(tunnel.stats.bytesTx),
                            rx: formatBytes(tunnel.stats.bytesRx),
                          })}
                        </span>
                      ) : (
                        <span className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                          {tunnel.sshTarget}
                        </span>
                      )}

                      <div className="ml-auto flex items-center gap-1.5">
                        {!tunnel.running ? (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => openEditForm(tunnel)}
                            className="ota-ctrl"
                          >
                            {t("tunnels.edit")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void removeTunnel(tunnel.id)}
                          className="ota-ctrl hover:!border-[var(--status-danger)] hover:!text-[var(--status-danger)]"
                        >
                          {t("common.delete")}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void toggleTunnel(tunnel)}
                          className={tunnel.running ? "ota-ctrl-danger" : "ota-ctrl-primary"}
                        >
                          {isBusy
                            ? t("tunnels.working")
                            : tunnel.running
                              ? t("tunnels.stop")
                              : t("tunnels.start")}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
