/**
 * One-shot model calls used for the two things that are not an employee turn:
 * proposing an email address, and evaluating whether a gated tool call should
 * run. Both must be honest about failure — a missing model, a provider error,
 * or unparseable output never becomes a silent approval or a fabricated answer.
 */

import { randomUUID } from "node:crypto";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { LocalizedText } from "../shared/i18n.ts";
import { fromError } from "./messages.ts";
import { modelMessages } from "./messages/models.ts";
import type { ModelCatalog } from "./models.ts";
import type { ModelSelectionRecord } from "./documents.ts";

export type LlmSuccess = {
  ok: true;
  text: string;
  usage: { input: number; output: number; cost: number };
  /** Exact provider-native effort actually requested; useful in audit trails. */
  reasoning: string;
};

export type LlmFailure = {
  ok: false;
  /**
   * Configuration: the selected model does not resolve. Provider: the request
   * failed in transport or at the provider. Invalid-output: the provider
   * answered, but without a complete, usable final answer.
   */
  reason: "configuration" | "provider" | "invalid-output";
  message: string;
  messageLocalized?: LocalizedText;
};

export type LlmOutcome = LlmSuccess | LlmFailure;

/** Strip a fenced code block, then parse the outermost JSON object. */
export function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

export async function completeText(
  catalog: ModelCatalog,
  selection: ModelSelectionRecord,
  request: { system?: string; prompt: string; maxTokens?: number; signal?: AbortSignal; sessionId?: string },
): Promise<LlmOutcome> {
  const model = catalog.chatModel({ providerId: selection.providerId, modelId: selection.modelId });
  if (model === undefined) {
    const missing = modelMessages.chatModelNotConfigured(selection.providerId, selection.modelId);
    return { ok: false, reason: "configuration", message: missing.text, messageLocalized: missing.localized };
  }
  const effort = catalog.resolveEffort({ providerId: selection.providerId, modelId: selection.modelId }, selection.effort);
  const messages: Message[] = [{ role: "user", content: request.prompt, timestamp: Date.now() }];
  // A logical request session: a caller with a stable identity (an approval
  // evaluation) passes it in; a standalone one-shot call gets a fresh id.
  const maxTokens = request.maxTokens ?? 1024;
  const options = {
    maxTokens,
    sessionId: request.sessionId ?? randomUUID(),
    ...(effort !== "off" ? { reasoning: effort as "minimal" | "low" | "medium" | "high" } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  };
  try {
    const message = await catalog.models.completeSimple(
      model as Model<never>,
      request.system !== undefined && request.system.length > 0
        ? { systemPrompt: request.system, messages }
        : { messages },
      options,
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      if (message.errorMessage !== undefined) return { ok: false, reason: "provider", message: message.errorMessage };
      const ended = modelMessages.requestEnded(message.stopReason);
      return { ok: false, reason: "provider", message: ended.text, messageLocalized: ended.localized };
    }
    // Only a clean stop is a complete response. A truncated or otherwise
    // unfinished response is never used as a final answer, even if its partial
    // body happens to parse.
    if (message.stopReason !== "stop") {
      const incomplete = modelMessages.requestIncomplete(message.stopReason, maxTokens, message.usage.output);
      return {
        ok: false,
        reason: "invalid-output",
        message: incomplete.text,
        messageLocalized: incomplete.localized,
      };
    }
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    if (text.length === 0) {
      const empty = modelMessages.requestEmptyOutput(message.stopReason, effort, message.usage.output);
      return { ok: false, reason: "invalid-output", message: empty.text, messageLocalized: empty.localized };
    }
    return {
      ok: true,
      text,
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        cost: message.usage.cost.total,
      },
      reasoning: effort,
    };
  } catch (error) {
    const wrapped = fromError(error);
    return { ok: false, reason: "provider", message: wrapped.text, messageLocalized: wrapped.localized };
  }
}
