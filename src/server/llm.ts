/**
 * One-shot model calls used for the two things that are not an employee turn:
 * proposing an email address, and evaluating whether a gated tool call should
 * run. Both must be honest about failure — a missing model, a provider error,
 * or unparseable output never becomes a silent approval or a fabricated answer.
 */

import { randomUUID } from "node:crypto";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { ModelCatalog } from "./models.ts";
import type { ModelSelectionRecord } from "./documents.ts";

export type LlmSuccess = {
  ok: true;
  text: string;
  usage: { input: number; output: number; cost: number };
  /** Exact provider-native effort actually requested; useful in audit trails. */
  reasoning: string;
};

export type LlmFailure = { ok: false; message: string };

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
    return { ok: false, message: `未配置对话模型 ${selection.providerId}/${selection.modelId}` };
  }
  const effort = catalog.resolveEffort({ providerId: selection.providerId, modelId: selection.modelId }, selection.effort);
  const messages: Message[] = [{ role: "user", content: request.prompt, timestamp: Date.now() }];
  // A logical request session: a caller with a stable identity (an approval
  // evaluation) passes it in; a standalone one-shot call gets a fresh id.
  const options = {
    maxTokens: request.maxTokens ?? 1024,
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
      return { ok: false, message: message.errorMessage ?? `请求结束于 ${message.stopReason}` };
    }
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
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
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
