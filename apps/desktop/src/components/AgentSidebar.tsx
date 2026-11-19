// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

import type { PermissionMode } from "../types";

const MODES: PermissionMode[] = ["ask", "supervised", "autonomous"];

interface AgentSidebarProps {
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
}

/**
 * Placeholder for the agent workbench. The autonomy selector is real and
 * mirrors `term_agent::policy::PermissionMode`; the loop, tool cards and approval
 * prompts attach to this panel once the agent executor lands.
 */
export function AgentSidebar({ mode, onModeChange }: AgentSidebarProps) {
  const { t } = useTranslation();

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-slate-800/80 bg-slate-950/40">
      <header className="border-b border-slate-800/60 px-3 py-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[11px] font-semibold tracking-widest text-slate-400 uppercase">
            {t("agent.title")}
          </h2>
          <span className="text-[10px] text-slate-600">{t("agent.subtitle")}</span>
        </div>
      </header>

      <section className="border-b border-slate-800/60 px-3 py-3">
        <h3 className="text-[10px] tracking-widest text-slate-600 uppercase">
          {t("agent.mode")}
        </h3>
        <div className="mt-2 flex gap-1">
          {MODES.map((candidate) => {
            const active = candidate === mode;
            return (
              <button
                key={candidate}
                type="button"
                onClick={() => onModeChange(candidate)}
                className={`flex-1 rounded px-1.5 py-1 text-[11px] transition ${
                  active
                    ? "bg-cyan-500/20 text-cyan-200"
                    : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                }`}
              >
                {t(`agent.modes.${candidate}`)}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          {t(`agent.modesHint.${mode}`)}
        </p>
      </section>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <p className="text-xs leading-relaxed text-slate-500">{t("agent.empty")}</p>
      </div>

      <footer className="border-t border-slate-800/60 p-3">
        <button
          type="button"
          disabled
          title={t("agent.takeOverHint")}
          className="w-full rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300/70 disabled:cursor-not-allowed"
        >
          {t("agent.takeOver")}
        </button>
        <p className="mt-1.5 text-center text-[10px] text-slate-600">
          {t("agent.takeOverHint")}
        </p>
      </footer>
    </aside>
  );
}
