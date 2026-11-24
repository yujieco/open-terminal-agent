// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";

export interface FriendlyError {
  message: string;
  openSettings: boolean;
}

/**
 * Translates raw backend/provider errors (HTTP status codes, missing keyring
 * entries, unreachable local servers) into natural, actionable human language.
 */
export function formatLlmError(raw: unknown, t: TFunction): FriendlyError {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  const lower = text.toLowerCase();

  if (
    lower.includes("no llm api key") ||
    lower.includes("missing api key") ||
    lower.includes("api key configured") ||
    lower.includes("secretmissing")
  ) {
    return { message: t("agent.errors.missingKey"), openSettings: true };
  }

  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication") ||
    lower.includes("incorrect api key")
  ) {
    return { message: t("agent.errors.invalidKey"), openSettings: true };
  }

  if (lower.includes("402") || lower.includes("insufficient") || lower.includes("quota") || lower.includes("balance")) {
    return { message: t("agent.errors.quota"), openSettings: true };
  }

  if (lower.includes("403") || lower.includes("forbidden")) {
    return { message: t("agent.errors.forbidden"), openSettings: true };
  }

  if (lower.includes("404") || lower.includes("model_not_found") || lower.includes("not found")) {
    return { message: t("agent.errors.modelNotFound"), openSettings: true };
  }

  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { message: t("agent.errors.rateLimited"), openSettings: false };
  }

  if (
    lower.includes("connection refused") ||
    lower.includes("dns") ||
    lower.includes("error sending request") ||
    lower.includes("timed out") ||
    lower.includes("network") ||
    lower.includes("connect")
  ) {
    return { message: t("agent.errors.network"), openSettings: true };
  }

  return {
    message: text.trim().length > 0 ? text : t("agent.errors.unknown"),
    openSettings: false,
  };
}
