// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

import type { SessionKind } from "../lib/ipc";
import type { PermissionMode } from "../types";

interface StatusBarProps {
  label: string | null;
  kind: SessionKind | null;
  size: { cols: number; rows: number } | null;
  exited: boolean;
  mode: PermissionMode;
  locale: string;
  sessionCount: number;
  demo: boolean;
  agentRunning: boolean;
}

export function StatusBar({
  label,
  kind,
  size,
  exited,
  mode,
  locale,
  sessionCount,
  demo,
  agentRunning,
}: StatusBarProps) {
  const { t } = useTranslation();

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-slate-800/80 bg-slate-950/70 px-3 font-mono text-[10px] text-slate-500">
      <span className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            label === null ? "bg-slate-600" : exited ? "bg-rose-400" : "bg-emerald-400"
          }`}
        />
        {label ?? "—"}
        {size ? (
          <span className="text-slate-600">
            {size.cols}×{size.rows}
          </span>
        ) : null}
      </span>

      {kind ? (
        <>
          <span className="text-slate-700">|</span>
          <span className="text-slate-500">{t(`sidebar.kinds.${kind}`)}</span>
        </>
      ) : null}

      <span className="text-slate-700">|</span>
      <span className={agentRunning ? "text-cyan-300" : "text-slate-500"}>
        {agentRunning ? t("status.agentControl") : t("status.humanControl")}
      </span>

      <span className="text-slate-700">|</span>
      <span>
        {t("status.mode")}: {t(`agent.modes.${mode}`)}
      </span>

      <span className="text-slate-700">|</span>
      <span>
        {t("status.locale")}: {locale}
      </span>

      <span className="text-slate-700">|</span>
      <span>
        {t("status.sessions")}: {sessionCount}
      </span>

      <span className="ml-auto flex items-center gap-2">
        {demo ? (
          <span className="rounded bg-amber-500/10 px-1 py-0.5 text-amber-300/80">
            {t("status.demo")}
          </span>
        ) : null}
        <span className={exited ? "text-rose-300/80" : "text-emerald-300/70"}>
          {exited ? t("status.exited") : t("status.ready")}
        </span>
      </span>
    </footer>
  );
}
