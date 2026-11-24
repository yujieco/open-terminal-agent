// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc, isTauri, type ExportLogResult, type LogExportFormat } from "../lib/ipc";

interface ExportLogDialogProps {
  sessionId: string;
  label: string;
  lines?: string[];
  onClose: () => void;
}

const FORMATS: { id: LogExportFormat; ext: string; titleKey: string; descKey: string }[] = [
  { id: "log", ext: ".log", titleKey: "exportLog.formats.log", descKey: "exportLog.formats.logDesc" },
  { id: "md", ext: ".md", titleKey: "exportLog.formats.md", descKey: "exportLog.formats.mdDesc" },
  { id: "html", ext: ".html", titleKey: "exportLog.formats.html", descKey: "exportLog.formats.htmlDesc" },
  { id: "json", ext: ".json", titleKey: "exportLog.formats.json", descKey: "exportLog.formats.jsonDesc" },
  { id: "txt", ext: ".txt", titleKey: "exportLog.formats.txt", descKey: "exportLog.formats.txtDesc" },
];

function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 48) : "terminal";
}

function makeTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function browserFormatContent(label: string, format: LogExportFormat, lines: string[]): string {
  const now = new Date().toISOString();
  if (format === "log" || format === "txt") {
    return `${lines.join("\n")}\n`;
  }
  if (format === "md") {
    return `# Terminal Session Log: ${label}\n\n- **Exported at:** ${now}\n- **Lines:** ${lines.length}\n\n\`\`\`text\n${lines.join("\n")}\n\`\`\`\n`;
  }
  if (format === "json") {
    return `${JSON.stringify({ session: label, exportedAt: now, lineCount: lines.length, lines }, null, 2)}\n`;
  }
  const escape = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(label)}</title><style>body{margin:0;padding:28px;background:#0e0f12;color:#eceef2;font-family:-apple-system,sans-serif}pre{padding:18px;border-radius:10px;background:#14161c;font-family:monospace;white-space:pre-wrap}</style></head><body><h1>${escape(label)}</h1><pre>${escape(lines.join("\n"))}</pre></body></html>`;
}

export function ExportLogDialog({ sessionId, label, lines, onClose }: ExportLogDialogProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<LogExportFormat>("log");
  const [dir, setDir] = useState("");
  const [fileStem, setFileStem] = useState(() => `${sanitizeName(label)}-${makeTimestamp()}`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportLogResult | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!isTauri()) return;
    void ipc
      .defaultExportDir()
      .then((resolved) => setDir(resolved))
      .catch(console.warn);
  }, []);

  const targetPath = useMemo(() => {
    const stem = fileStem.trim() || "terminal";
    const filename = stem.endsWith(`.${format}`) ? stem : `${stem}.${format}`;
    if (!dir) return filename;
    const sep = dir.includes("\\") ? "\\" : "/";
    return dir.endsWith(sep) ? `${dir}${filename}` : `${dir}${sep}${filename}`;
  }, [dir, fileStem, format]);

  const handleExport = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!isTauri()) {
        const content = browserFormatContent(label, format, lines ?? []);
        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = targetPath;
        anchor.click();
        URL.revokeObjectURL(url);
        setResult({ path: targetPath, bytes: content.length, lines: (lines ?? []).length });
        return;
      }

      const saved = await ipc.exportSessionLog({
        sessionId,
        label,
        format,
        path: targetPath,
        lines,
      });
      setResult(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
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
        className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-2xl backdrop-blur-xl"
        style={{
          backgroundColor: "color-mix(in srgb, var(--bg-surface) 92%, transparent)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              {t("exportLog.title")}
            </h2>
            <p className="mt-0.5 font-mono text-[10.5px] text-[var(--text-muted)]">{label}</p>
          </div>
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

        <div className="space-y-3.5 px-4 py-3.5">
          <div>
            <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
              {t("exportLog.formatLabel")}
            </label>
            <div className="mt-1.5 grid grid-cols-1 gap-1.5">
              {FORMATS.map((item) => {
                const selected = item.id === format;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setFormat(item.id);
                      setResult(null);
                    }}
                    className="flex items-center justify-between rounded-lg border px-3 py-2 text-left transition active:scale-[0.99]"
                    style={{
                      borderColor: selected ? "var(--accent-border)" : "var(--border-subtle)",
                      backgroundColor: selected ? "var(--accent-soft)" : "var(--bg-canvas)",
                    }}
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[var(--text-primary)]">
                        {t(item.titleKey)}
                      </div>
                      <div className="text-[10.5px] text-[var(--text-muted)]">
                        {t(item.descKey)}
                      </div>
                    </div>
                    <span
                      className="ml-2 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium"
                      style={{
                        backgroundColor: selected ? "var(--accent)" : "var(--bg-elevated)",
                        color: selected ? "var(--accent-fg)" : "var(--text-secondary)",
                      }}
                    >
                      {item.ext}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                {t("exportLog.filenameLabel")}
              </label>
              <input
                type="text"
                value={fileStem}
                onChange={(event) => {
                  setFileStem(event.target.value);
                  setResult(null);
                }}
                className="ota-input mt-1 font-mono"
              />
            </div>

            {isTauri() ? (
              <div>
                <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                  {t("exportLog.folderLabel")}
                </label>
                <input
                  type="text"
                  value={dir}
                  onChange={(event) => {
                    setDir(event.target.value);
                    setResult(null);
                  }}
                  className="ota-input mt-1 font-mono"
                />
              </div>
            ) : null}
          </div>

          {result ? (
            <div
              className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed"
              style={{
                borderColor: "var(--status-ok)",
                backgroundColor: "var(--status-ok-soft)",
                color: "var(--text-primary)",
              }}
            >
              <div className="font-medium" style={{ color: "var(--status-ok)" }}>
                {t("exportLog.success", { lines: result.lines })}
              </div>
              <div className="mt-0.5 break-all font-mono text-[10px] text-[var(--text-secondary)]">
                {result.path}
              </div>
            </div>
          ) : null}

          {error ? (
            <div
              className="rounded-lg border px-3 py-2 text-[11px]"
              style={{
                borderColor: "var(--status-danger)",
                backgroundColor: "var(--status-danger-soft)",
                color: "var(--status-danger)",
              }}
            >
              {error}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-chrome)] px-4 py-2.5">
          <button type="button" onClick={onClose} className="ota-ctrl">
            {t("common.close")}
          </button>
          {result && isTauri() ? (
            <button
              type="button"
              onClick={() => void ipc.revealInFolder(result.path).catch(console.warn)}
              className="ota-ctrl-primary"
            >
              {t("exportLog.reveal")}
            </button>
          ) : (
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleExport()}
              className="ota-ctrl-primary"
            >
              {saving ? t("exportLog.exporting") : t("exportLog.exportButton")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
