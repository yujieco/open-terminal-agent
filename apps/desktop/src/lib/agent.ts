// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

/** Types and listeners for the agent event stream. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invoke } from "@tauri-apps/api/core";

import type { SessionInfo } from "./ipc";

export const AGENT_EVENT = "agent://event";
export const AGENT_APPROVAL = "agent://approval";
export const AGENT_INTERRUPTED = "agent://interrupted";

/** One runtime event, mirroring `term_agent::AgentEvent`. */
export type AgentEvent =
  | { type: "runStarted"; task: string; mode: string; model: string }
  | { type: "thinking"; delta: string }
  | { type: "message"; delta: string }
  | {
      type: "toolRequested";
      step: number;
      call_id: string;
      tool: string;
      command: string | null;
      risk: string | null;
    }
  | { type: "toolApproved"; call_id: string }
  | { type: "toolDenied"; call_id: string; command: string }
  | {
      type: "toolFinished";
      step: number;
      call_id: string;
      exit_code: number | null;
      output: string;
      timed_out: boolean;
      duration_ms: number;
    }
  | { type: "screenRead"; call_id: string; lines: number }
  | { type: "signalSent"; call_id: string; signal: string }
  | { type: "runFinished"; steps: number; reason: string }
  | { type: "failed"; message: string };

export interface AgentEventPayload {
  sessionId: string;
  event: AgentEvent;
}

export interface InterruptedPayload {
  sessionId: string;
}

export interface ApprovalPayload {
  sessionId: string;
  callId: string;
  command: string;
  risk: string;
}

export interface LlmConfigInput {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface LocalModel {
  provider: "ollama" | "lmstudio";
  id: string;
}

export interface LlmStatus {
  configured: boolean;
  provider: string;
  model: string;
  baseUrl: string;
}

export interface AgentRunInput {
  sessionId: string;
  task: string;
  mode?: string;
  stepApproval?: boolean;
}

export const agentIpc = {
  status(): Promise<LlmStatus> {
    return invoke<LlmStatus>("llm_status");
  },

  saveKey(apiKey: string): Promise<void> {
    return invoke<void>("save_llm_key", { apiKey });
  },

  saveConfig(input: LlmConfigInput): Promise<void> {
    return invoke<void>("save_llm_config", { ...input });
  },

  discover(): Promise<LocalModel[]> {
    return invoke<LocalModel[]>("discover_models");
  },

  run(input: AgentRunInput): Promise<void> {
    return invoke<void>("agent_run", { request: input });
  },

  cancel(sessionId: string): Promise<void> {
    return invoke<void>("agent_cancel", { sessionId });
  },

  approve(callId: string, approved: boolean): Promise<void> {
    return invoke<void>("agent_approve", { callId, approved });
  },

  runs(sessionId?: string, limit = 20) {
    return invoke<import("./ipc").AgentRunSummary[]>("list_agent_runs", { sessionId, limit });
  },

  runDetail(id: string) {
    return invoke<import("./ipc").AgentRunRecord | null>("get_agent_run", { id });
  },
};

export function onAgentEvent(
  handler: (payload: AgentEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<AgentEventPayload>(AGENT_EVENT, (event) => handler(event.payload));
}

export function onAgentInterrupted(
  handler: (payload: InterruptedPayload) => void,
): Promise<UnlistenFn> {
  return listen<InterruptedPayload>(AGENT_INTERRUPTED, (event) => handler(event.payload));
}

export function onAgentApproval(
  handler: (payload: ApprovalPayload) => void,
): Promise<UnlistenFn> {
  return listen<ApprovalPayload>(AGENT_APPROVAL, (event) => handler(event.payload));
}

export type { SessionInfo };
