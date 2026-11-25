// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Runbook, RunbookStep, SaveRunbookInput } from "../lib/ipc";

interface RunbooksPanelProps {
  runbooks: Runbook[];
  hasSession: boolean;
  onSave: (input: SaveRunbookInput) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onRunCommand: (command: string, execute: boolean) => void;
  onBumpUsage: (id: string) => void;
}

/** Extracts unique `{{varName}}` placeholders across all steps. */
export function extractVariables(steps: RunbookStep[]): string[] {
  const seen = new Set<string>();
  const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  for (const step of steps) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(step.command)) !== null) {
      if (match[1]) seen.add(match[1]);
    }
  }
  return Array.from(seen);
}

function interpolate(command: string, values: Record<string, string>): string {
  return command.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
    const val = values[key];
    return val !== undefined && val.length > 0 ? val : `{{${key}}}`;
  });
}

export function RunbooksPanel({
  runbooks,
  hasSession,
  onSave,
  onDelete,
  onRunCommand,
  onBumpUsage,
}: RunbooksPanelProps) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{
    id?: string;
    name: string;
    description: string;
    stepsText: string;
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const active = useMemo(
    () => runbooks.find((item) => item.id === activeId) ?? null,
    [activeId, runbooks],
  );

  const saveDraft = async () => {
    if (!editing) return;
    const steps: RunbookStep[] = editing.stepsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((command) => ({ command, note: "" }));
    if (!editing.name.trim() || steps.length === 0) return;
    await onSave({
      id: editing.id,
      name: editing.name.trim(),
      description: editing.description.trim(),
      steps,
      variables: extractVariables(steps),
    });
    setEditing(null);
  };

  const exportJson = async (rb: Runbook) => {
    const payload = JSON.stringify(
      {
        name: rb.name,
        description: rb.description,
        steps: rb.steps,
        variables: rb.variables,
      },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      // Ignore clipboard failures.
    }
  };

  const importFromClipboard = async () => {
    setImportError(null);
    try {
      const raw = await navigator.clipboard.readText();
      const parsed = JSON.parse(raw) as Partial<SaveRunbookInput>;
      if (!parsed.name || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        setImportError(t("runbooks.invalidJson"));
        return;
      }
      const steps: RunbookStep[] = parsed.steps
        .filter((s) => s && typeof s.command === "string" && s.command.trim().length > 0)
        .map((s) => ({ command: s.command.trim(), note: s.note ?? "" }));
      await onSave({
        name: parsed.name,
        description: parsed.description ?? "",
        steps,
        variables: extractVariables(steps),
      });
    } catch {
      setImportError(t("runbooks.invalidJson"));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-1.5 border-b border-[var(--border-subtle)] px-3 py-2">
        <span className="text-[11px] font-medium text-[var(--text-muted)]">
          {t("runbooks.zeroTokenBadge")}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void importFromClipboard()}
            title={t("runbooks.importHint")}
            className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            {t("sshImport.shortButton")}
          </button>
          <button
            type="button"
            onClick={() =>
              setEditing({ name: "", description: "", stepsText: "" })
            }
            className="rounded px-2 py-0.5 text-[10.5px] font-medium text-white"
            style={{ backgroundColor: "var(--accent)" }}
          >
            + {t("runbooks.new")}
          </button>
        </div>
      </div>

      {importError ? (
        <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[11px] text-[var(--status-danger)]">
          {importError}
        </div>
      ) : null}

      {editing ? (
        <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
          <input
            autoFocus
            value={editing.name}
            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            placeholder={t("runbooks.namePlaceholder")}
            className="ota-input"
          />
          <input
            value={editing.description}
            onChange={(event) => setEditing({ ...editing, description: event.target.value })}
            placeholder={t("runbooks.descPlaceholder")}
            className="ota-input"
          />
          <div>
            <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
              {t("runbooks.stepsHint")}
            </span>
            <textarea
              rows={7}
              value={editing.stepsText}
              onChange={(event) => setEditing({ ...editing, stepsText: event.target.value })}
              placeholder={"sudo nginx -t\nsudo systemctl reload {{service}}"}
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-canvas)] p-2.5 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-border)]"
            />
          </div>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-md px-2.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void saveDraft()}
              className="ota-btn-primary rounded-md px-3 py-1 text-xs"
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      ) : active ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setActiveId(null)}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              ← {t("runbooks.back")}
            </button>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void exportJson(active)}
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                {t("runbooks.copyJson")}
              </button>
              <button
                type="button"
                onClick={() =>
                  setEditing({
                    id: active.id,
                    name: active.name,
                    description: active.description,
                    stepsText: active.steps.map((s) => s.command).join("\n"),
                  })
                }
                className="text-[11px] text-[var(--accent)] hover:underline"
              >
                {t("sftp.edit")}
              </button>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">{active.name}</h3>
            {active.description ? (
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{active.description}</p>
            ) : null}
          </div>

          {active.variables.length > 0 ? (
            <div className="space-y-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-2.5">
              <span className="block text-[10px] font-semibold text-[var(--text-muted)] uppercase">
                {t("runbooks.variables")}
              </span>
              {active.variables.map((variable) => (
                <label key={variable} className="flex items-center gap-2 text-xs">
                  <span className="w-20 shrink-0 truncate font-mono text-[11px] text-[var(--accent)]">
                    {`{{${variable}}}`}
                  </span>
                  <input
                    value={varValues[variable] ?? ""}
                    onChange={(event) =>
                      setVarValues((prev) => ({ ...prev, [variable]: event.target.value }))
                    }
                    className="ota-input !h-7 flex-1 font-mono !text-[11.5px]"
                  />
                </label>
              ))}
            </div>
          ) : null}

          <ol className="space-y-2">
            {active.steps.map((step, idx) => {
              const resolved = interpolate(step.command, varValues);
              return (
                <li
                  key={idx}
                  className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-mono text-[10px] text-[var(--text-muted)]">
                      #{idx + 1}
                    </span>
                    <code className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-[var(--text-primary)]">
                      {resolved}
                    </code>
                  </div>
                  <div className="mt-2 flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      disabled={!hasSession}
                      onClick={() => onRunCommand(resolved, false)}
                      className="rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                    >
                      {t("runbooks.pasteStep")}
                    </button>
                    <button
                      type="button"
                      disabled={!hasSession}
                      onClick={() => {
                        onRunCommand(resolved, true);
                        onBumpUsage(active.id);
                      }}
                      className="rounded px-2 py-0.5 text-[10.5px] font-medium text-white disabled:opacity-40"
                      style={{ backgroundColor: "var(--accent)" }}
                    >
                      {t("runbooks.runStep")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>

          <button
            type="button"
            disabled={!hasSession}
            onClick={() => {
              const joined = active.steps
                .map((s) => interpolate(s.command, varValues))
                .join(" && ");
              onRunCommand(joined, true);
              onBumpUsage(active.id);
            }}
            className="ota-btn-primary w-full rounded-lg py-2 text-xs disabled:opacity-40"
          >
            {t("runbooks.runAll", { count: active.steps.length })}
          </button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {runbooks.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--border-subtle)] px-3 py-8 text-center text-xs leading-relaxed text-[var(--text-muted)]">
              {t("runbooks.empty")}
            </p>
          ) : (
            <ul className="space-y-2">
              {runbooks.map((rb) => (
                <li
                  key={rb.id}
                  className="group rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 transition hover:border-[var(--border-strong)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveId(rb.id);
                        setVarValues({});
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-xs font-semibold text-[var(--text-primary)]">
                        {rb.name}
                      </div>
                      {rb.description ? (
                        <div className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                          {rb.description}
                        </div>
                      ) : null}
                      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-[var(--text-muted)]">
                        <span>{t("runbooks.stepCount", { count: rb.steps.length })}</span>
                        <span>·</span>
                        <span>{t("runbooks.runCount", { count: rb.runCount })}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(rb.id)}
                      aria-label={t("common.delete")}
                      className="text-xs text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--status-danger)]"
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
