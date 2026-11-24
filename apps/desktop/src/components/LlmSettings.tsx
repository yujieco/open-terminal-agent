// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentIpc, type LlmStatus, type LocalModel } from "../lib/agent";

interface Preset {
  provider: string;
  baseUrl: string;
  models: string[];
}

/** Cloud presets plus local servers that the discovery probe found. */
const PRESETS: Preset[] = [
  {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-flash", "deepseek-v4-pro"],
  },
  { provider: "ollama", baseUrl: "http://localhost:11434/v1", models: [] },
  { provider: "lmstudio", baseUrl: "http://localhost:1234/v1", models: [] },
];

export function LlmSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [provider, setProvider] = useState("deepseek");
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [model, setModel] = useState(PRESETS[0].models[0]);
  const [apiKey, setApiKey] = useState("");
  const [local, setLocal] = useState<LocalModel[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const current = await agentIpc.status();
      setStatus(current);
      setProvider(current.provider);
      setBaseUrl(current.baseUrl);
      setModel(current.model);
    } catch (cause) {
      console.warn("[ota] llm status unavailable", cause);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void agentIpc
      .discover()
      .then(setLocal)
      .catch(() => setLocal([]));
  }, [refresh]);

  const preset = PRESETS.find((entry) => entry.provider === provider);
  const localForProvider = local
    .filter((entry) => entry.provider === provider)
    .map((entry) => entry.id);
  const models = preset && preset.models.length > 0 ? preset.models : localForProvider;

  const pick = (next: string) => {
    setProvider(next);
    setNote(null);
    const found = PRESETS.find((entry) => entry.provider === next);
    if (found) setBaseUrl(found.baseUrl);
    const options =
      found && found.models.length > 0
        ? found.models
        : local.filter((entry) => entry.provider === next).map((entry) => entry.id);
    setModel(options[0] ?? "");
  };

  return (
    <section className="border-t border-[var(--border-subtle)] px-4 py-3.5">
      <h3 className="text-xs font-semibold text-[var(--text-primary)]">{t("settings.model")}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
        {t("settings.modelHint")}
      </p>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
            {t("settings.provider")}
          </span>
          <select
            className="ota-input"
            value={provider}
            onChange={(event) => pick(event.target.value)}
          >
            {PRESETS.map((entry) => (
              <option key={entry.provider} value={entry.provider}>
                {entry.provider}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
            {t("settings.modelId")}
          </span>
          {models.length > 0 ? (
            <select
              className="ota-input"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="ota-input"
              value={model}
              placeholder={t("settings.noLocal")}
              onChange={(event) => setModel(event.target.value)}
            />
          )}
        </label>
      </div>

      <label className="mt-2.5 block">
        <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
          {t("settings.baseUrl")}
        </span>
        <input
          className="ota-input font-mono"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>

      <label className="mt-2.5 block">
        <span className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase">
          {t("settings.apiKey")}
          {status?.configured ? ` · ${t("settings.keyStored")}` : ""}
        </span>
        <input
          className="ota-input font-mono"
          type="password"
          value={apiKey}
          placeholder="sk-..."
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            void agentIpc
              .saveConfig({ provider, baseUrl, model, apiKey: apiKey.trim() || undefined })
              .then(async () => {
                setApiKey("");
                setNote(t("settings.saved"));
                await refresh();
              })
              .catch((cause) => setNote(String(cause)));
          }}
          className="ota-btn-primary rounded-md px-3 py-1.5 text-[11px]"
        >
          {t("settings.save")}
        </button>
        <button
          type="button"
          onClick={() => {
            void agentIpc
              .discover()
              .then((found) => {
                setLocal(found);
                setNote(found.length === 0 ? t("settings.noneDiscovered") : t("settings.discovered"));
              })
              .catch((cause) => setNote(String(cause)));
          }}
          className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[11px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          {t("settings.discover")}
        </button>
        {note ? (
          <span className="font-mono text-[10px]" style={{ color: "var(--status-ok)" }}>
            {note}
          </span>
        ) : null}
      </div>
    </section>
  );
}
