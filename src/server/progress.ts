/**
 * Live progress of running work.
 *
 * Two committed sources carry the same text: the conversation's live document
 * (`pi.live`) holds the throttled partial of the in-flight response, and each
 * settled assistant message becomes a conversation entry. Both are folded into
 * one in-memory state per work, so the browser sees the model's text while it
 * is produced and keeps the settled answer afterwards. Nothing here polls and
 * nothing here calls back into the session — the commit listener only folds
 * committed values into memory.
 */

import type { EmitRuntime } from "./runtime.ts";
import type { ToolActivityDTO } from "../shared/contracts.ts";
import { listWorks } from "./work.ts";

const FLUSH_INTERVAL_MS = 120;

type ProgressState = {
  text: string;
  tools: Map<string, ToolActivityDTO>;
  dirty: boolean;
  sentText: string;
  sentTools: number;
};

type LiveToolSlot = { callId: string; name: string; status: ToolActivityDTO["status"]; output?: string };

/** Assistant text of a committed partial message; malformed values yield no text. */
function partialText(message: unknown): string {
  if (typeof message !== "object" || message === null || !("content" in message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    if (!("type" in part) || part.type !== "text") continue;
    if ("text" in part && typeof part.text === "string" && part.text.length > 0) parts.push(part.text);
  }
  return parts.join("\n");
}

/** The running tool round of a committed live state; malformed values yield no slots. */
function liveToolSlots(live: unknown): LiveToolSlot[] {
  if (typeof live !== "object" || live === null || !("tools" in live)) return [];
  const tools = live.tools;
  if (!Array.isArray(tools)) return [];
  const slots: LiveToolSlot[] = [];
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    if (!("callId" in tool) || typeof tool.callId !== "string") continue;
    if (!("name" in tool) || typeof tool.name !== "string") continue;
    if (!("status" in tool) || (tool.status !== "pending" && tool.status !== "running" && tool.status !== "done")) {
      continue;
    }
    const output = "output" in tool && typeof tool.output === "string" ? tool.output : undefined;
    slots.push(
      output === undefined
        ? { callId: tool.callId, name: tool.name, status: tool.status }
        : { callId: tool.callId, name: tool.name, status: tool.status, output },
    );
  }
  return slots;
}

export function attachProgress(runtime: EmitRuntime): () => void {
  const bindings = new Map<string, string>();
  const progress = new Map<string, ProgressState>();
  let flushTimer: NodeJS.Timeout | undefined;

  const flush = () => {
    flushTimer = undefined;
    for (const [workId, state] of progress) {
      if (!state.dirty) continue;
      state.dirty = false;
      state.sentText = state.text;
      state.sentTools = state.tools.size;
      runtime.emit({
        type: "work-progress",
        workId,
        progressText: state.text,
        tools: [...state.tools.values()],
      });
    }
  };

  const schedule = () => {
    if (flushTimer === undefined) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  };

  // Seed the conversation-to-work map, then keep it current from its own
  // document writes, so the listener never needs a session read.
  void listWorks(runtime).then((works) => {
    for (const work of works) {
      if (work.conversationId !== 0) bindings.set(String(work.conversationId), work.id);
    }
  });

  const unsubscribe = runtime.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type === "document") {
        if (change.record.kind === "emit.conversation-context" && change.value !== null) {
          const value = change.value as { workId?: string };
          if (typeof value.workId === "string" && value.workId.length > 0 && change.conversationId !== undefined) {
            // The binding document is conversation-scoped, so its owner is the
            // conversation the progress belongs to.
            bindings.set(String(change.conversationId), value.workId);
          }
        }
        if (change.record.kind === "pi.live" && change.value !== null && change.conversationId !== undefined) {
          const workId = bindings.get(String(change.conversationId));
          if (workId !== undefined) {
            let state = progress.get(workId);
            if (state === undefined) {
              state = { text: "", tools: new Map(), dirty: false, sentText: "", sentTools: 0 };
              progress.set(workId, state);
            }
            const live = change.value;
            const generation = typeof live === "object" && live !== null && "generation" in live ? live.generation : undefined;
            const message =
              typeof generation === "object" && generation !== null && "message" in generation
                ? generation.message
                : undefined;
            const text = partialText(message);
            if (text.length > 0) state.text = text;
            for (const slot of liveToolSlots(live)) {
              const output = slot.output ?? state.tools.get(slot.callId)?.output;
              state.tools.set(
                slot.callId,
                output === undefined
                  ? { callId: slot.callId, name: slot.name, status: slot.status }
                  : { callId: slot.callId, name: slot.name, status: slot.status, output },
              );
            }
            state.dirty = true;
            schedule();
          }
        }
        continue;
      }
      if (change.type !== "entry") continue;
      const conversationId = String(change.value.conversationId);
      const workId = bindings.get(conversationId);
      if (workId === undefined) continue;
      const messages = change.value.model;
      if (messages === undefined) continue;
      let state = progress.get(workId);
      if (state === undefined) {
        state = { text: "", tools: new Map(), dirty: false, sentText: "", sentTools: 0 };
        progress.set(workId, state);
      }
      for (const message of messages) {
        if (message.role === "assistant") {
          const text = message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .filter((part) => part.length > 0)
            .join("\n");
          if (text.length > 0) state.text = text;
          for (const part of message.content) {
            if (part.type !== "toolCall") continue;
            if (!state.tools.has(part.id)) {
              state.tools.set(part.id, { callId: part.id, name: part.name, status: "pending" });
            }
          }
        } else if (message.role === "toolResult") {
          state.tools.set(message.toolCallId, {
            callId: message.toolCallId,
            name: message.toolName,
            status: "done",
            output: message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("\n")
              .slice(0, 2_000),
          });
        }
      }
      state.dirty = true;
      schedule();
    }
  });

  return () => {
    unsubscribe();
    clearTimeout(flushTimer);
    bindings.clear();
    progress.clear();
  };
}
