// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc, isTauri, type ImportedSshHost } from "../lib/ipc";

interface SshConfigImportDialogProps {
  onImported: () => Promise<void> | void;
  onClose: () => void;
}

export function SshConfigImportDialog({ onImported, onClose }: SshConfigImportDialogProps) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<ImportedSshHost[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [groupName, setGroupName] = useState("~/.ssh/config");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setLoading(false);
      return;
    }
    void ipc
      .scanSshConfig()
      .then((found) => {
        setHosts(found);
        const initial: Record<string, boolean> = {};
        for (const item of found) initial[item.alias] = true;
        setSelected(initial);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  const chosen = hosts.filter((item) => selected[item.alias]);

  const handleImport = async () => {
    if (chosen.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      for (const item of chosen) {
        await ipc.saveSshSession({
          name: item.alias,
          host: item.host,
          port: item.port,
          username: item.username,
          auth: {
            method: "privateKey",
            path: item.identityFile ?? "~/.ssh/id_ed25519",
          },
          rememberPassword: false,
          groupName: groupName.trim() || undefined,
        });
      }
      await onImported();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
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
        className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {t("sshImport.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            ×
          </button>
        </header>

        <div className="space-y-3 px-4 py-3.5">
          {loading ? (
            <p className="py-8 text-center text-xs text-[var(--text-muted)]">
              {t("sshImport.scanning")}
            </p>
          ) : hosts.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--border-subtle)] px-3 py-8 text-center text-xs text-[var(--text-muted)]">
              {t("sshImport.empty")}
            </p>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
                  {t("sshImport.targetGroup")}
                </span>
                <input
                  value={groupName}
                  onChange={(event) => setGroupName(event.target.value)}
                  className="ota-input"
                />
              </label>

              <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {hosts.map((host) => (
                  <label
                    key={host.alias}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-xs transition hover:border-[var(--border-strong)]"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(selected[host.alias])}
                      onChange={() =>
                        setSelected((prev) => ({ ...prev, [host.alias]: !prev[host.alias] }))
                      }
                      className="h-3.5 w-3.5 accent-[var(--accent)]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-[var(--text-primary)]">
                        {host.alias}
                      </div>
                      <div className="truncate font-mono text-[10.5px] text-[var(--text-muted)]">
                        {host.username}@{host.host}:{host.port}
                        {host.proxyJump ? ` via ${host.proxyJump}` : ""}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}

          {error ? (
            <p className="text-[11px]" style={{ color: "var(--status-danger)" }}>
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2.5">
          <span className="text-[11px] text-[var(--text-muted)]">
            {t("sshImport.selectedCount", { count: chosen.length })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={importing || chosen.length === 0}
              onClick={() => void handleImport()}
              className="ota-btn-primary rounded-md px-3.5 py-1.5 text-xs disabled:opacity-40"
            >
              {importing ? t("sshImport.importing") : t("sshImport.importAction")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
