// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface CommandBlock {
  id: number;
  command: string;
  output: string;
  exitCode: number | null;
  startedAt: number;
  durationMs: number | null;
  bufferLine: number;
}

interface CommandBlocksPanelProps {
  blocks: CommandBlock[];
  onJumpToLine: (line: number) => void;
  onRerun: (command: string) => void;
  onFavorite: (command: string) => void;
  onClose: () => void;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "…";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export function CommandBlocksPanel({
  blocks,
  onJumpToLine,
  onRerun,
  onFavorite,
  onClose,
}: CommandBlocksPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      window.setTimeout(() => setCopiedId((curr) => (curr === key ? null : curr)), 1200);
    } catch {
      // Ignore clipboard failures.
    }
  };

  return (
    <div
      onMouseDown={(event) => event.stopPropagation()}
      className="absolute top-2 right-3 bottom-3 z-30 flex w-[26rem] max-w-[85%] flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            {t("blocks.title")}
          </span>
          <span className="ota-tabular rounded bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
            {blocks.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {blocks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--border-subtle)] px-3 py-8 text-center text-xs text-[var(--text-muted)]">
            {t("blocks.empty")}
          </p>
        ) : (
          [...blocks].reverse().map((block) => {
            const ok = block.exitCode === null || block.exitCode === 0;
            const isOpen = Boolean(expanded[block.id]);
            const lines = block.output.split("\n");
            const preview =
              isOpen || lines.length <= 4 ? block.output : `${lines.slice(0, 4).join("\n")}\n…`;

            return (
              <div
                key={block.id}
                className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]"
              >
                <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        block.exitCode === null
                          ? "var(--accent)"
                          : ok
                            ? "var(--status-ok)"
                            : "var(--status-danger)",
                    }}
                  />
                  <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium text-[var(--text-primary)]">
                    {block.command || t("blocks.unnamedCommand")}
                  </code>
                  {block.exitCode !== null && block.exitCode !== 0 ? (
                    <span
                      className="ota-tabular shrink-0 rounded px-1 py-0.5 font-mono text-[9.5px] font-semibold"
                      style={{
                        backgroundColor: "rgba(239, 68, 68, 0.14)",
                        color: "var(--status-danger)",
                      }}
                    >
                      {block.exitCode}
                    </span>
                  ) : null}
                  <span className="ota-tabular shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
                    {formatDuration(block.durationMs)}
                  </span>
                </div>

                {block.output.trim().length > 0 ? (
                  <pre className="max-h-48 overflow-auto bg-[var(--bg-canvas)] px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]">
                    {preview}
                  </pre>
                ) : null}

                <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 text-[10.5px]">
                  <button
                    type="button"
                    onClick={() => onJumpToLine(block.bufferLine)}
                    className="rounded px-1.5 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  >
                    {t("blocks.jump")}
                  </button>
                  {block.output.trim().length > 0 ? (
                    <button
                      type="button"
                      onClick={() => void copyText(`out-${block.id}`, block.output)}
                      className="rounded px-1.5 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      {copiedId === `out-${block.id}` ? t("blocks.copied") : t("blocks.copyOutput")}
                    </button>
                  ) : null}
                  {block.command ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onRerun(block.command)}
                        className="rounded px-1.5 py-0.5 font-medium hover:bg-[var(--bg-hover)]"
                        style={{ color: "var(--accent)" }}
                      >
                        {t("blocks.rerun")}
                      </button>
                      <button
                        type="button"
                        onClick={() => onFavorite(block.command)}
                        className="rounded px-1.5 py-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        ★
                      </button>
                    </>
                  ) : null}
                  {lines.length > 4 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => ({ ...prev, [block.id]: !prev[block.id] }))
                      }
                      className="ml-auto rounded px-1.5 py-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      {isOpen ? t("blocks.collapse") : t("blocks.expand", { count: lines.length })}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
