// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc, type KnownHost } from "../lib/ipc";

/** Review and forget pinned SSH host keys. */
export function KnownHosts() {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<KnownHost[]>([]);

  const refresh = useCallback(async () => {
    try {
      setHosts(await ipc.listKnownHosts());
    } catch (cause) {
      console.warn("[ota] could not list known hosts", cause);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="border-t border-[var(--border-subtle)] px-4 py-3.5">
      <h3 className="text-xs font-semibold text-[var(--text-primary)]">
        {t("settings.knownHosts")}
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
        {t("settings.knownHostsHint")}
      </p>

      {hosts.length === 0 ? (
        <p className="mt-2 text-[11px] text-[var(--text-muted)]">{t("settings.noKnownHosts")}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {hosts.map((entry) => (
            <li
              key={`${entry.host}:${entry.port}`}
              className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
            >
              <span className="font-mono text-[11px] text-[var(--text-primary)]">
                {entry.host}:{entry.port}
              </span>
              <span className="truncate font-mono text-[10px] text-[var(--text-muted)]">
                {entry.fingerprint}
              </span>
              <button
                type="button"
                onClick={() => {
                  void ipc
                    .forgetHostKey(entry.host, entry.port)
                    .then(refresh)
                    .catch(console.error);
                }}
                className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] transition hover:opacity-80"
                style={{
                  backgroundColor: "var(--status-danger-soft)",
                  color: "var(--status-danger)",
                }}
              >
                {t("settings.forget")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
