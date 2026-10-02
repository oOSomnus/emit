/**
 * Live progress of running work.
 *
 * The synchronous half of the product is just this: a generation writes an
 * assistant entry with `stopReason: "pending"` while it streams and replaces it
 * as it settles, so watching committed entries gives the browser the same text
 * the model is producing. Nothing here polls and nothing here calls back into
 * the session — the commit listener only folds committed values into memory.
 */

import type { EmitRuntime } from "./runtime.ts";
import type { ToolActivityDTO } from "../shared/contracts.ts";
import { listWorks } from "./work.ts";

const FLUSH_INTERVAL_MS = 120;

export function attachProgress(runtime: EmitRuntime): () => void {
  const bindings = new Map<string, string>();
  const progress = new Map<
    string,
    { text: string; tools: Map<string, ToolActivityDTO>; dirty: boolean; sentText: string; sentTools: number }
  >();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

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
