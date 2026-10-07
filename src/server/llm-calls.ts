import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  contentText,
  getCurrentSystemMessage,
  getCurrentTools,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type ClassifierApi,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierResult,
  type Context,
  type DeferredHandle,
  type ImageContent,
  type Message,
  type Model,
  type ModelsClassifierOptions,
  type ModelsSimpleStreamOptions,
  type MutableModels,
  type SystemMessage,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import type {
  LlmCallDetailDTO,
  LlmCallInputDTO,
  LlmCallKind,
  LlmCallPageDTO,
  LlmCallResponseDTO,
  LlmCallStatus,
  LlmCallSummaryDTO,
  LlmContentDTO,
  LlmJsonDTO,
  LlmMessageDTO,
  LlmToolDTO,
} from "../shared/contracts.ts";
import { REDACTION_MARKER, redactApprovalText, redactJsonValue } from "./approval/evaluators.ts";
import { AppError } from "./app-text.ts";
import {
  ApprovalDoc,
  ConversationContextDoc,
  EmployeeDoc,
  LlmCallDoc,
  LlmCallPayloadDoc,
  WorkLlmCallIndexDoc,
  WorkDoc,
  type LlmCallPayloadRecord,
  type LlmCallRecord,
} from "./documents.ts";
import { llmCallMessages } from "./messages/llm-calls.ts";
import { renderApprovalUser } from "./prompts/index.ts";
import type { EmitRuntime } from "./runtime.ts";
import { findWork } from "./work-queue.ts";

type ContentPart = TextContent | ImageContent | ThinkingContent | ToolCall;

export interface LlmCallOwner {
  workId: string;
  employeeId: string;
  conversationId?: number;
  approvalId?: string;
  kind: LlmCallKind;
}

type ObservedLlmRequestBase =
  | {
      method: "streamSimple";
      model: Model<Api>;
      input: Context;
      options?: ModelsSimpleStreamOptions;
      owner?: LlmCallOwner;
    }
  | {
      method: "completeSimple";
      model: Model<Api>;
      input: Context;
      options?: ModelsSimpleStreamOptions;
      owner?: LlmCallOwner;
    }
  | {
      method: "classify";
      model: ClassifierModel<ClassifierApi>;
      input: ClassifierContext;
      options?: ModelsClassifierOptions;
      owner?: LlmCallOwner;
    };

export type ObservedLlmRequest = ObservedLlmRequestBase;

export interface LlmCallReceipt {
  returned(response: AssistantMessage | ClassifierResult, source?: "request" | "poll"): void;
  failed(error: unknown, source?: "request" | "poll"): void;
  /** Called before returned() when a response starts a deferred request. */
  deferred?(handle: DeferredHandle): void;
}

export interface LlmCallObserver {
  begin(request: ObservedLlmRequest): LlmCallReceipt | undefined;
  /** False while capture is disabled; the adapter then leaves Promises untouched. */
  accepting?(): boolean;
  deferredReturned(handle: DeferredHandle, response: AssistantMessage): void;
  deferredFailed(handle: DeferredHandle, error: unknown): void;
}

export type LlmCallOmittedDTO = LlmCallDetailDTO["omitted"][number];

export type LlmCallInputSnapshot = {
  input: LlmCallInputDTO;
  inputBytes: number;
  messageCount: number;
  toolCount: number;
  omitted: LlmCallOmittedDTO[];
};

export type LlmCallResponseSnapshot = {
  response: LlmCallResponseDTO;
  outputBytes?: number;
  omitted: LlmCallOmittedDTO[];
};

export type LlmCallRequestMetadata = {
  model: { providerId: string; modelId: string };
  sessionId?: number;
  reasoning?: string;
  maxTokens?: number;
};

const callOwnerStorage = new AsyncLocalStorage<LlmCallOwner>();

/** Run model calls in this async scope with an explicit approval owner. */
export function withLlmCallOwner<T>(owner: LlmCallOwner, run: () => T): T {
  return callOwnerStorage.run(owner, run);
}

/** Read only model-selection and request-budget facts safe for call metadata. */
export function llmCallRequestMetadata(request: ObservedLlmRequest): LlmCallRequestMetadata {
  const sessionId = conversationSessionId(request);
  const metadata: LlmCallRequestMetadata = {
    model: { providerId: request.model.provider, modelId: request.model.id },
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  if (request.method !== "classify") {
    if (request.options?.reasoning !== undefined) metadata.reasoning = request.options.reasoning;
    if (request.options?.maxTokens !== undefined) metadata.maxTokens = request.options.maxTokens;
  }
  return metadata;
}

/** pi-durable's installed adapter carries numeric conversation ids as decimal strings. */
function conversationSessionId(request: ObservedLlmRequest): number | undefined {
  const options: unknown = request.options;
  if (typeof options !== "object" || options === null || !("sessionId" in options)) return undefined;
  const value = options.sessionId;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Freeze the SDK input into redacted, categorized DTOs without changing it. */
export function captureLlmCallInput(request: ObservedLlmRequest): LlmCallInputSnapshot {
  const omitted: LlmCallOmittedDTO[] = [];
  if (request.method === "classify") {
    return {
      input: {
        systemUpdates: [],
        messages: [],
        tools: [],
        classifier: {
          state: redactedJsonTree(request.input.state),
          questions: redactedJsonTree(request.input.questions),
        },
      },
      inputBytes: jsonByteLength(request.input),
      messageCount: 0,
      toolCount: 0,
      omitted,
    };
  }

  const transcript = normalizeContext(request.input);
  const currentSystem = getCurrentSystemMessage(transcript.messages);
  const currentTools = getCurrentTools(transcript.messages);
  const systemMessages = transcript.messages.flatMap((message, position) =>
    message.role === "system" ? [{ message, position }] : [],
  );
  for (const { message, position } of systemMessages) {
    collectSystemSignatureOmissions(message, position, omitted);
  }

  const system = currentSystem === undefined
    ? undefined
    : {
        content: redactApprovalText(contentText(currentSystem.content)),
        sections: Object.entries(currentSystem.sections ?? {}).flatMap(([key, text]) =>
          text === null
            ? []
            : [{ key: redactApprovalText(key), text: redactApprovalText(text) }],
        ),
      };
  const systemUpdates = systemMessages.map(({ message, position }) => ({
    position,
    ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
    content: redactApprovalText(contentText(message.content)),
    sections: Object.entries(message.sections ?? {}).map(([key, text]) => ({
      key: redactApprovalText(key),
      text: text === null ? null : redactApprovalText(text),
    })),
    toolsAdded: (message.toolsAdded ?? []).map((tool) => captureTool(tool)),
    toolsRemoved: (message.toolsRemoved ?? []).map((tool) => redactApprovalText(tool.name)),
  }));
  const messages = transcript.messages.flatMap((message, position) => {
    if (message.role === "system") return [];
    const base: LlmMessageDTO = {
      position,
      role: message.role,
      ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
      content: captureMessageContent(message, request, position, omitted),
    };
    if (message.role === "toolResult") {
      base.toolName = redactApprovalText(message.toolName);
      base.toolCallId = redactApprovalText(message.toolCallId);
      base.isError = message.isError;
    }
    return [base];
  });
  const input: LlmCallInputDTO = {
    ...(system !== undefined ? { system } : {}),
    systemUpdates,
    messages,
    tools: currentTools.map((tool) => captureTool(tool)),
  };
  return {
    input,
    inputBytes: jsonByteLength(request.input),
    messageCount: messages.length,
    toolCount: input.tools.length,
    omitted,
  };
}

/** Capture a real SDK response; deferred handle data and opaque signatures are excluded. */
export function captureLlmCallResponse(
  response: AssistantMessage | ClassifierResult,
  source: "request" | "poll" = "request",
): LlmCallResponseSnapshot {
  const omitted: LlmCallOmittedDTO[] = [];
  const base: LlmCallResponseDTO = {
    receivedAt: Date.now(),
    source,
    type: "response",
    stopReason: response.stopReason,
    content: [],
  };
  if (isAssistantMessage(response)) {
    if (response.deferred?.data !== undefined) {
      omitted.push({
        side: "output",
        path: "deferred.data",
        kind: "deferred-data",
        characters: jsonCharacterLength(response.deferred.data),
      });
    }
    base.content = captureContentParts(response.content, "output", `responses.${source}.content`, omitted);
    if (response.errorMessage !== undefined) base.errorMessage = redactApprovalText(response.errorMessage);
    if (response.diagnostics !== undefined) base.diagnostics = redactedJsonTree(response.diagnostics);
    base.metadata = responseMetadata(response);
    const usage = captureUsage(response.usage);
    if (usage !== undefined) base.usage = usage;
  } else {
    base.answers = redactedJsonTree(response.answers);
    if (response.errorMessage !== undefined) base.errorMessage = redactApprovalText(response.errorMessage);
    base.metadata = responseMetadata(response);
    if (response.usage !== undefined) {
      const usage = captureUsage(response.usage);
      if (usage !== undefined) base.usage = usage;
    }
  }
  return { response: base, outputBytes: jsonByteLength(response), omitted };
}

/** Capture an SDK throw/rejection as an exception stage, never as a response. */
export function captureLlmCallException(
  error: unknown,
  source: "request" | "poll" = "request",
): LlmCallResponseSnapshot {
  return {
    response: {
      receivedAt: Date.now(),
      source,
      type: "exception",
      content: [],
      errorMessage: redactApprovalText(errorText(error)),
    },
    omitted: [],
  };
}

/** Derive status from the actual provider stop reason without changing its meaning. */
export function llmCallStatusForResponse(response: AssistantMessage | ClassifierResult): LlmCallStatus {
  switch (response.stopReason) {
    case "error":
      return "failed";
    case "aborted":
      return "aborted";
    case "deferred":
      return "deferred";
    default:
      return "returned";
  }
}

/**
 * Wrap the mutable SDK collection once. All native methods keep the real
 * collection as their receiver; completeSimple therefore uses its raw
 * streamSimple internally and produces one observation, not two.
 */
export function createObservedModels(models: MutableModels, observer: LlmCallObserver): MutableModels {
  type NativeMethod = (...args: never[]) => unknown;
  const boundMethods = new Map<PropertyKey, { source: NativeMethod; bound: NativeMethod }>();

  const streamSimple = (...args: Parameters<MutableModels["streamSimple"]>): AssistantMessageEventStream => {
    const [model, input, options] = args;
    const receipt = beginObservedRequest(observer, { method: "streamSimple", model, input, options });
    let stream: AssistantMessageEventStream;
    try {
      stream = Reflect.apply(models.streamSimple, models, args) as AssistantMessageEventStream;
    } catch (error) {
      notifyFailed(receipt, error, "request");
      throw error;
    }
    if (receipt !== undefined) {
      try {
        observePromise(stream.result(), (response) => notifyReturned(receipt, response, "request"), (error) => {
          notifyFailed(receipt, error, "request");
        });
      } catch {
        // Accessing the observer-only final result must never affect the stream.
      }
    }
    return stream;
  };

  const completeSimple = (...args: Parameters<MutableModels["completeSimple"]>): Promise<AssistantMessage> => {
    const [model, input, options] = args;
    const receipt = beginObservedRequest(observer, { method: "completeSimple", model, input, options });
    let promise: Promise<AssistantMessage>;
    try {
      promise = Reflect.apply(models.completeSimple, models, args) as Promise<AssistantMessage>;
    } catch (error) {
      notifyFailed(receipt, error, "request");
      throw error;
    }
    if (receipt !== undefined) {
      observePromise(promise, (response) => notifyReturned(receipt, response, "request"), (error) => {
        notifyFailed(receipt, error, "request");
      });
    }
    return promise;
  };

  const classify = (...args: Parameters<MutableModels["classify"]>): Promise<ClassifierResult> => {
    const [model, input, options] = args;
    const receipt = beginObservedRequest(observer, { method: "classify", model, input, options });
    let promise: Promise<ClassifierResult>;
    try {
      promise = Reflect.apply(models.classify, models, args) as Promise<ClassifierResult>;
    } catch (error) {
      notifyFailed(receipt, error, "request");
      throw error;
    }
    if (receipt !== undefined) {
      observePromise(promise, (response) => notifyReturned(receipt, response, "request"), (error) => {
        notifyFailed(receipt, error, "request");
      });
    }
    return promise;
  };

  const fetchDeferred = (...args: Parameters<MutableModels["fetchDeferred"]>): Promise<AssistantMessage> => {
    const [, handle] = args;
    const observePoll = observerIsAccepting(observer);
    let promise: Promise<AssistantMessage>;
    try {
      promise = Reflect.apply(models.fetchDeferred, models, args) as Promise<AssistantMessage>;
    } catch (error) {
      if (observePoll) swallowObserver(() => observer.deferredFailed(handle, error));
      throw error;
    }
    if (observePoll) {
      observePromise(
        promise,
        (response) => swallowObserver(() => observer.deferredReturned(handle, response)),
        (error) => swallowObserver(() => observer.deferredFailed(handle, error)),
      );
    }
    return promise;
  };

  const wrappers = { streamSimple, completeSimple, classify, fetchDeferred };
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple") return wrappers.streamSimple;
      if (property === "completeSimple") return wrappers.completeSimple;
      if (property === "classify") return wrappers.classify;
      if (property === "fetchDeferred") return wrappers.fetchDeferred;
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function" || property === "constructor") return value;
      const cached = boundMethods.get(property);
      if (cached?.source === value) return cached.bound;
      const method = value as NativeMethod;
      const bound = method.bind(target);
      boundMethods.set(property, { source: method, bound });
      return bound;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}

function beginObservedRequest(
  observer: LlmCallObserver,
  request: ObservedLlmRequest,
): LlmCallReceipt | undefined {
  try {
    if (!observerIsAccepting(observer)) return undefined;
    const owner = callOwnerStorage.getStore();
    if (owner === undefined && conversationSessionId(request) === undefined) return undefined;
    return observer.begin(owner === undefined ? request : { ...request, owner });
  } catch {
    return undefined;
  }
}
function observerIsAccepting(observer: LlmCallObserver): boolean {
  try {
    return observer.accepting?.() ?? true;
  } catch {
    return false;
  }
}
function swallowObserver(callback: () => unknown): void {
  try {
    const result = callback();
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Recording is best-effort and must not change model behavior.
  }
}

function notifyReturned(
  receipt: LlmCallReceipt | undefined,
  response: AssistantMessage | ClassifierResult,
  source: "request" | "poll",
): void {
  if (receipt === undefined) return;
  if (isAssistantMessage(response) && response.stopReason === "deferred") {
    const handle = response.deferred;
    if (handle !== undefined) swallowObserver(() => receipt.deferred?.(handle));
  }
  swallowObserver(() => receipt.returned(response, source));
}

function notifyFailed(receipt: LlmCallReceipt | undefined, error: unknown, source: "request" | "poll"): void {
  if (receipt === undefined) return;
  swallowObserver(() => receipt.failed(error, source));
}


function observePromise<T>(
  promise: Promise<T>,
  onReturned: (value: T) => void,
  onFailed: (error: unknown) => void,
): void {
  try {
    const observation = Promise.resolve(promise).then(
      (value) => swallowObserver(() => onReturned(value)),
      (error: unknown) => swallowObserver(() => onFailed(error)),
    );
    void observation.catch(() => undefined);
  } catch {
    // The original Promise is returned unchanged by the caller.
  }
}


function captureMessageContent(
  message: Exclude<Message, SystemMessage>,
  request: ObservedLlmRequest,
  position: number,
  omitted: LlmCallOmittedDTO[],
): LlmContentDTO[] {
  const basePath = `messages[${position}].content`;
  if (message.role === "user" && typeof message.content === "string") {
    return [captureText(message.content, request, message.role)];
  }
  return captureContentParts(message.content, "input", basePath, omitted, request, message.role);
}

function captureContentParts(
  parts: string | readonly ContentPart[],
  side: "input" | "output",
  path: string,
  omitted: LlmCallOmittedDTO[],
  request?: ObservedLlmRequest,
  role?: "user" | "assistant" | "toolResult",
): LlmContentDTO[] {
  if (typeof parts === "string") return [captureText(parts, request, role)];
  const content: LlmContentDTO[] = [];
  parts.forEach((part, index) => {
    const partPath = `${path}[${index}]`;
    switch (part.type) {
      case "text":
        if (typeof part.textSignature === "string") {
          omitted.push({
            side,
            path: `${partPath}.textSignature`,
            kind: "opaque-signature",
            characters: part.textSignature.length,
          });
        }
        content.push(captureText(part.text, request, role));
        break;
      case "thinking":
        if (typeof part.thinkingSignature === "string") {
          omitted.push({
            side,
            path: `${partPath}.thinkingSignature`,
            kind: "opaque-signature",
            characters: part.thinkingSignature.length,
          });
        }
        content.push({
          type: "thinking",
          text: redactApprovalText(part.thinking),
          ...(part.redacted === true ? { redacted: true } : {}),
        });
        break;
      case "toolCall":
        if (typeof part.thoughtSignature === "string") {
          omitted.push({
            side,
            path: `${partPath}.thoughtSignature`,
            kind: "opaque-signature",
            characters: part.thoughtSignature.length,
          });
        }
        content.push({
          type: "toolCall",
          id: redactApprovalText(part.id),
          name: redactApprovalText(part.name),
          arguments: redactedJsonTree(part.arguments),
        });
        break;
      case "image": {
        const characters = part.data.length;
        omitted.push({ side, path: `${partPath}.data`, kind: "image", characters });
        content.push({
          type: "image",
          mimeType: redactApprovalText(part.mimeType),
          omitted: true,
          characters,
        });
        break;
      }
    }
  });
  return content;
}

function captureText(
  text: string,
  request: ObservedLlmRequest | undefined,
  role: "user" | "assistant" | "toolResult" | undefined,
): LlmContentDTO {
  const parsed = parseStructuredText(text, request, role);
  return {
    type: "text",
    text: redactApprovalText(text),
    ...(parsed.found ? { structured: redactedJsonTree(parsed.value) } : {}),
  };
}

function parseStructuredText(
  text: string,
  request: ObservedLlmRequest | undefined,
  role: "user" | "assistant" | "toolResult" | undefined,
): { found: true; value: unknown } | { found: false } {
  if (request?.owner?.kind === "approval-llm" && role === "user") {
    const prefix = renderApprovalUser("");
    if (!text.startsWith(prefix)) return { found: false };
    return parseCompleteJson(text.slice(prefix.length));
  }
  const complete = parseCompleteJson(text);
  if (complete.found) return complete;
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text.trim());
  return fenced === null ? { found: false } : parseCompleteJson(fenced[1] ?? "");
}

function parseCompleteJson(text: string): { found: true; value: unknown } | { found: false } {
  try {
    return { found: true, value: JSON.parse(text) as unknown };
  } catch {
    return { found: false };
  }
}

function captureTool(tool: Tool): LlmToolDTO {
  return {
    name: redactApprovalText(tool.name),
    description: redactApprovalText(tool.description),
    parameters: redactedJsonTree(tool.parameters),
    ...(tool.constrainedSampling !== undefined
      ? { constrainedSampling: redactedJsonTree(tool.constrainedSampling) }
      : {}),
  };
}

function collectSystemSignatureOmissions(
  message: SystemMessage,
  position: number,
  omitted: LlmCallOmittedDTO[],
): void {
  if (typeof message.content === "string") return;
  message.content.forEach((part, index) => {
    if (typeof part.textSignature === "string") {
      omitted.push({
        side: "input",
        path: `systemUpdates[${position}].content[${index}].textSignature`,
        kind: "opaque-signature",
        characters: part.textSignature.length,
      });
    }
  });
}

function responseMetadata(response: AssistantMessage | ClassifierResult): LlmJsonDTO {
  const metadata: Record<string, unknown> = {
    api: response.api,
    provider: response.provider,
    model: response.model,
    timestamp: response.timestamp,
  };
  if ("responseModel" in response && response.responseModel !== undefined) {
    metadata.responseModel = response.responseModel;
  }
  if ("providerThinkingLevel" in response && response.providerThinkingLevel !== undefined) {
    metadata.providerThinkingLevel = response.providerThinkingLevel;
  }
  if ("thinkingLevel" in response && response.thinkingLevel !== undefined) {
    metadata.thinkingLevel = response.thinkingLevel;
  }
  if ("responseId" in response && response.responseId !== undefined) metadata.responseId = response.responseId;
  if ("rawStopReason" in response && response.rawStopReason !== undefined) {
    metadata.rawStopReason = response.rawStopReason;
  }
  if ("endTurn" in response && response.endTurn !== undefined) metadata.endTurn = response.endTurn;
  return redactedJsonTree(metadata);
}

function captureUsage(usage: Usage | undefined): LlmCallResponseDTO["usage"] {
  if (usage === undefined) return undefined;
  const required = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
  if (!required.every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
  const cost = usage.cost;
  const costValues = cost === undefined ? [] : [cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total];
  const hasCompleteCost = costValues.length === 5 && costValues.every((value) => typeof value === "number" && Number.isFinite(value));
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    ...(typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning) ? { reasoning: usage.reasoning } : {}),
    ...(hasCompleteCost
      ? {
          cost: {
            input: cost.input,
            output: cost.output,
            cacheRead: cost.cacheRead,
            cacheWrite: cost.cacheWrite,
            total: cost.total,
          },
        }
      : {}),
  };
}

function redactedJsonTree(value: unknown): LlmJsonDTO {
  const redacted = redactJsonValue(value);
  let jsonValue = redacted;
  try {
    const encoded = JSON.stringify(redacted);
    jsonValue = encoded === undefined ? null : (JSON.parse(encoded) as unknown);
  } catch {
    // Unknown non-JSON SDK extension values are represented as null below.
  }
  return toLlmJsonTree(jsonValue);
}

function toLlmJsonTree(value: unknown): LlmJsonDTO {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { type: "scalar", value };
  }
  if (Array.isArray(value)) return { type: "array", items: value.map(toLlmJsonTree) };
  if (typeof value === "object") {
    return {
      type: "object",
      entries: Object.entries(value).map(([key, entry]) => ({ key, value: toLlmJsonTree(entry) })),
    };
  }
  return { type: "scalar", value: null };
}

function jsonCharacterLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function jsonByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return 0;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") return message;
  }
  try {
    return String(error);
  } catch {
    return REDACTION_MARKER;
  }
}

function isAssistantMessage(response: AssistantMessage | ClassifierResult): response is AssistantMessage {
  return "content" in response;
}

export interface LlmCallRecorder {
  observer: LlmCallObserver;
  initialize(): Promise<void>;
  stop(): void;
  flush(): Promise<void>;
  health(): LlmCallPageDTO["captureHealth"];
}

export class LlmCallCursorError extends AppError {
  constructor() {
    super(llmCallMessages.invalidCursor);
  }
}

export class LlmCallCorruptError extends AppError {
  constructor() {
    super(llmCallMessages.corruptRecord);
  }
}

const LLM_CALL_PAGE_SIZE = 50;
const GENERIC_RECORDING_ERROR = "LLM call capture was incomplete.";

/** Read only indexed summaries for one work, newest sequence first. */
export async function readWorkLlmCalls(
  runtime: EmitRuntime,
  workId: string,
  cursor?: string,
): Promise<LlmCallPageDTO | undefined> {
  if ((await findWork(runtime, workId)) === undefined) return undefined;
  const beforeSequence = decodeLlmCallCursor(cursor);
  const index = await runtime.readFamily(WorkLlmCallIndexDoc, workId, { workId });
  if (index === undefined) {
    return { items: [], captureHealth: runtime.llmCallCaptureHealth() };
  }
  if (index.workId !== workId) throw new LlmCallCorruptError();
  if (!Array.isArray(index.calls)) throw new LlmCallCorruptError();

  const calls = index.calls;
  let end = calls.length;
  if (beforeSequence !== undefined) {
    let lower = 0;
    let upper = calls.length;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      const entry = calls[middle];
      if (entry === undefined || entry === null || typeof entry !== "object" || !Number.isSafeInteger(entry.sequence)) {
        throw new LlmCallCorruptError();
      }
      if (entry.sequence < beforeSequence) lower = middle + 1;
      else upper = middle;
    }
    end = lower;
  }
  const start = Math.max(0, end - LLM_CALL_PAGE_SIZE);
  const page = calls.slice(start, end).reverse();
  const items: LlmCallSummaryDTO[] = [];
  for (const entry of page) {
    if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || !Number.isSafeInteger(entry.sequence)) {
      throw new LlmCallCorruptError();
    }
    const header = await runtime.readFamily(LlmCallDoc, entry.id, { id: entry.id });
    if (
      header === undefined ||
      header.id !== entry.id ||
      header.workId !== workId ||
      header.sequence !== entry.sequence
    ) {
      throw new LlmCallCorruptError();
    }
    items.push(summaryWithoutDeferredKey(header));
  }
  const nextSequence = start > 0 ? calls[start]?.sequence : undefined;
  return {
    items,
    ...(nextSequence !== undefined
      ? { nextCursor: Buffer.from(JSON.stringify({ beforeSequence: nextSequence }), "utf8").toString("base64url") }
      : {}),
    captureHealth: runtime.llmCallCaptureHealth(),
  };
}

/** Read one work-scoped header and its required redacted payload. */
export async function readWorkLlmCall(
  runtime: EmitRuntime,
  workId: string,
  callId: string,
): Promise<LlmCallDetailDTO | undefined> {
  if ((await findWork(runtime, workId)) === undefined) return undefined;
  const header = await runtime.readFamily(LlmCallDoc, callId, { id: callId });
  if (header === undefined) return undefined;
  if (header.id !== callId) throw new LlmCallCorruptError();
  if (header.workId !== workId) return undefined;
  const payload = await runtime.readFamily(LlmCallPayloadDoc, callId, { id: callId });
  if (payload === undefined || payload.id !== callId) throw new LlmCallCorruptError();
  return { ...summaryWithoutDeferredKey(header), ...payload };
}

export function createLlmCallRecorder(runtime: EmitRuntime): LlmCallRecorder {
  type Association = {
    workId: string;
    employeeId: string;
    conversationId: number;
    approvalId?: string;
    kind: LlmCallKind;
  };
  type CallState = {
    id: string;
    startedAt: number;
    method: ObservedLlmRequest["method"];
    metadata: LlmCallRequestMetadata;
    input?: LlmCallInputSnapshot;
    owner?: LlmCallOwner;
    deferredKey?: string;
    persisted: boolean;
  };

  let accepting = true;
  let failedCount = 0;
  let failureNoticeSent = false;
  let initialization: Promise<void> | undefined;
  let finalizationQueued = false;
  let tail: Promise<void> = Promise.resolve();
  const nextSequenceByWork = new Map<string, number>();
  const deferredCallIds = new Map<string, Set<string>>();
  const liveCalls = new Map<string, CallState>();
  const activeCalls = new Map<string, CallState>();
  const recordingErrorQueued = new Set<string>();

  function emitCaptureFailure(): void {
    if (failureNoticeSent) return;
    failureNoticeSent = true;
    const message = llmCallMessages.captureFailure;
    runtime.emit({
      type: "notice",
      text: message.text,
      textLocalized: message.localized ?? { en: message.text, "zh-CN": message.text },
    });
  }

  function enqueue(operation: () => Promise<void> | void, callId?: string): void {
    const next = tail.then(async () => {
      try {
        await operation();
      } catch {
        reportFailure(callId);
      }
    });
    tail = next;
  }

  function reportFailure(callId?: string): void {
    failedCount += 1;
    emitCaptureFailure();
    if (callId === undefined || recordingErrorQueued.has(callId)) return;
    recordingErrorQueued.add(callId);
    enqueue(() => persistRecordingError(callId));
  }

  async function drain(): Promise<void> {
    for (;;) {
      const pending = tail;
      await pending;
      if (pending === tail) return;
    }
  }

  function addDeferredCall(key: string, callId: string): void {
    let ids = deferredCallIds.get(key);
    if (ids === undefined) {
      ids = new Set<string>();
      deferredCallIds.set(key, ids);
    }
    ids.add(callId);
  }

  function removeDeferredCall(key: string | undefined, callId: string): void {
    if (key === undefined) return;
    const ids = deferredCallIds.get(key);
    if (ids === undefined) return;
    ids.delete(callId);
    if (ids.size === 0) deferredCallIds.delete(key);
  }
  function reportDeferredFailure(key?: string): void {
    const ids = key === undefined ? undefined : deferredCallIds.get(key);
    if (ids === undefined || ids.size === 0) {
      reportFailure();
      return;
    }
    for (const callId of ids) reportFailure(callId);
  }

  function observeBegin(request: ObservedLlmRequest): LlmCallReceipt | undefined {
    if (!accepting) return undefined;
    const startedAt = Date.now();
    let owner: LlmCallOwner | undefined;
    let metadata: LlmCallRequestMetadata;
    try {
      owner = request.owner === undefined ? undefined : { ...request.owner };
      metadata = llmCallRequestMetadata(request);
    } catch {
      reportFailure();
      return undefined;
    }
    if (owner === undefined && (metadata.sessionId === undefined || request.method === "classify")) {
      return undefined;
    }
    let input: LlmCallInputSnapshot;
    try {
      input = captureLlmCallInput(request);
    } catch {
      reportFailure();
      return undefined;
    }
    const state: CallState = {
      id: randomUUID(),
      startedAt,
      method: request.method,
      metadata,
      input,
      ...(owner !== undefined ? { owner } : {}),
      persisted: false,
    };
    enqueue(async () => {
      const inputSnapshot = state.input;
      try {
        const association = await resolveAssociation(state);
        if (association === undefined || inputSnapshot === undefined) return;
        const sequence = (nextSequenceByWork.get(association.workId) ?? 0) + 1;
        const header = initialLlmCallHeader(state, association, sequence, inputSnapshot);
        await runtime.harness.commit(async (tx) => {
          const headerDoc = await tx.doc(LlmCallDoc, state.id, { id: state.id });
          const payloadDoc = await tx.doc(LlmCallPayloadDoc, state.id, { id: state.id });
          const index = await tx.doc(WorkLlmCallIndexDoc, association.workId, { workId: association.workId });
          index.workId = association.workId;
          index.calls.push({ id: state.id, sequence });
          Object.assign(headerDoc, header);
          payloadDoc.id = state.id;
          payloadDoc.input = inputSnapshot.input;
          payloadDoc.responses = [];
          payloadDoc.omitted = inputSnapshot.omitted;
        }, runtime.ctx);
        state.persisted = true;
        nextSequenceByWork.set(association.workId, sequence);
        liveCalls.set(state.id, state);
        activeCalls.set(state.id, state);
        runtime.emit({ type: "llm-call", workId: header.workId, callId: header.id, revision: header.revision });
      } finally {
        state.input = undefined;
      }
    }, state.id);

    const receipt: LlmCallReceipt = {
      returned: (response, source = "request") => {
        if (!accepting) return;
        try {
          const snapshot = captureLlmCallResponse(response, source);
          enqueue(async () => {
            await persistStage(state.id, snapshot, state);
          }, state.id);
        } catch {
          reportFailure(state.id);
        }
      },
      failed: (error, source = "request") => {
        if (!accepting) return;
        try {
          const snapshot = captureLlmCallException(error, source);
          enqueue(async () => {
            await persistStage(state.id, snapshot, state);
          }, state.id);
        } catch {
          reportFailure(state.id);
        }
      },
      deferred: (handle) => {
        if (!accepting) return;
        try {
          const key = deferredKey(handle);
          state.deferredKey = key;
          enqueue(() => {
            if (state.persisted) addDeferredCall(key, state.id);
          }, state.id);
        } catch {
          reportFailure(state.id);
        }
      },
    };
    return receipt;
  }

  const observer: LlmCallObserver = {
    begin: observeBegin,
    accepting: () => accepting,
    deferredReturned: (handle, response) => {
      if (!accepting) return;
      let key: string;
      try {
        key = deferredKey(handle);
      } catch {
        reportDeferredFailure();
        return;
      }
      let snapshot: LlmCallResponseSnapshot;
      try {
        snapshot = captureLlmCallResponse(response, "poll");
      } catch {
        reportDeferredFailure(key);
        return;
      }
      enqueue(async () => {
        const ids = [...(deferredCallIds.get(key) ?? [])];
        if (ids.length === 0) {
          reportFailure();
          return;
        }
        let matched = 0;
        let failed = false;
        for (const id of ids) {
          try {
            if (await persistStage(id, snapshot, liveCalls.get(id), key)) matched += 1;
            else removeDeferredCall(key, id);
          } catch {
            failed = true;
            reportFailure(id);
          }
        }
        if (matched === 0 && !failed) reportFailure();
      });
    },
    deferredFailed: (handle, error) => {
      if (!accepting) return;
      let key: string;
      try {
        key = deferredKey(handle);
      } catch {
        reportDeferredFailure();
        return;
      }
      let snapshot: LlmCallResponseSnapshot;
      try {
        snapshot = captureLlmCallException(error, "poll");
      } catch {
        reportDeferredFailure(key);
        return;
      }
      enqueue(async () => {
        const ids = [...(deferredCallIds.get(key) ?? [])];
        if (ids.length === 0) {
          reportFailure();
          return;
        }
        let matched = 0;
        let failed = false;
        for (const id of ids) {
          try {
            if (await persistStage(id, snapshot, liveCalls.get(id), key)) matched += 1;
            else removeDeferredCall(key, id);
          } catch {
            failed = true;
            reportFailure(id);
          }
        }
        if (matched === 0 && !failed) reportFailure();
      });
    },
  };

  async function resolveAssociation(state: CallState): Promise<Association | undefined> {
    const owner = state.owner;
    let workId: string;
    let employeeId: string;
    let conversationId: number;
    let kind: LlmCallKind;
    let approvalId: string | undefined;
    if (owner !== undefined) {
      const approvalKind = owner.kind === "approval-llm" || owner.kind === "approval-classifier";
      if (
        !approvalKind ||
        owner.approvalId === undefined ||
        owner.conversationId === undefined ||
        !Number.isSafeInteger(owner.conversationId) ||
        owner.conversationId <= 0 ||
        (state.metadata.sessionId !== undefined && state.metadata.sessionId !== owner.conversationId) ||
        (owner.kind === "approval-llm" && state.method !== "completeSimple") ||
        (owner.kind === "approval-classifier" && state.method !== "classify")
      ) {
        return undefined;
      }
      workId = owner.workId;
      employeeId = owner.employeeId;
      conversationId = owner.conversationId;
      kind = owner.kind;
      approvalId = owner.approvalId;
    } else {
      if (state.method === "classify" || state.metadata.sessionId === undefined) return undefined;
      workId = "";
      employeeId = "";
      conversationId = state.metadata.sessionId;
      kind = state.method === "streamSimple" ? "employee" : "compaction";
      if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return undefined;
    }

    const conversation = await runtime.readConversationDoc(ConversationContextDoc, conversationId);
    if (conversation === undefined) return undefined;
    const durableConversation = await runtime.harness.conversation(conversationId as ConversationId, runtime.ctx);
    if (durableConversation === undefined) return undefined;
    if (owner === undefined) {
      workId = conversation.workId;
      employeeId = conversation.employeeId;
    } else if (conversation.workId !== workId || conversation.employeeId !== employeeId) {
      return undefined;
    }
    if (workId.length === 0 || employeeId.length === 0) return undefined;

    const [work, employee] = await Promise.all([
      runtime.readFamily(WorkDoc, workId, { id: workId }),
      runtime.readFamily(EmployeeDoc, employeeId, { id: employeeId }),
    ]);
    if (
      work === undefined ||
      work.id !== workId ||
      work.employeeId !== employeeId ||
      work.conversationId !== conversationId ||
      employee === undefined ||
      employee.id !== employeeId
    ) {
      return undefined;
    }
    if (owner !== undefined) {
      const approval = await runtime.readFamily(ApprovalDoc, approvalId ?? "", { id: approvalId ?? "" });
      if (
        approval === undefined ||
        approval.id !== approvalId ||
        approval.workId !== workId ||
        approval.employeeId !== employeeId
      ) {
        return undefined;
      }
    }
    return {
      workId,
      employeeId,
      conversationId,
      ...(approvalId !== undefined ? { approvalId } : {}),
      kind,
    };
  }

  async function persistStage(
    callId: string,
    snapshot: LlmCallResponseSnapshot,
    state?: CallState,
    expectedDeferredKey?: string,
  ): Promise<boolean> {
    if (state !== undefined && !state.persisted) return false;
    const current = await runtime.readFamily(LlmCallDoc, callId, { id: callId });
    if (current === undefined) {
      if (expectedDeferredKey !== undefined) return false;
      throw new LlmCallCorruptError();
    }
    if (current.id !== callId) throw new LlmCallCorruptError();
    if (
      expectedDeferredKey !== undefined &&
      (current.status !== "deferred" || current.deferredKey !== expectedDeferredKey)
    ) {
      return false;
    }
    const nextStatus = statusForCapturedStage(snapshot.response);
    await mutateExistingCall(callId, (header, payload) => {
      payload.responses.push(snapshot.response);
      payload.omitted.push(...snapshot.omitted);
      if (state?.deferredKey !== undefined) header.deferredKey = state.deferredKey;
      header.status = nextStatus;
      if (snapshot.response.stopReason !== undefined) header.stopReason = snapshot.response.stopReason;
      else delete header.stopReason;
      if (nextStatus === "deferred") delete header.endedAt;
      else header.endedAt = snapshot.response.receivedAt;
      if (snapshot.outputBytes !== undefined) header.outputBytes = snapshot.outputBytes;
      if (snapshot.response.type === "response") {
        delete header.usage;
        if (snapshot.response.usage !== undefined) header.usage = snapshot.response.usage;
      }
    });
    if (nextStatus === "deferred") {
      if (state !== undefined) liveCalls.set(callId, state);
      activeCalls.delete(callId);
    } else {
      activeCalls.delete(callId);
      liveCalls.delete(callId);
      removeDeferredCall(current.deferredKey, callId);
    }
    return true;
  }

  async function mutateExistingCall(
    callId: string,
    mutate: (header: LlmCallRecord, payload: LlmCallPayloadRecord) => void,
  ): Promise<void> {
    const [existingHeader, existingPayload] = await Promise.all([
      runtime.readFamily(LlmCallDoc, callId, { id: callId }),
      runtime.readFamily(LlmCallPayloadDoc, callId, { id: callId }),
    ]);
    if (
      existingHeader === undefined ||
      existingHeader.id !== callId ||
      existingPayload === undefined ||
      existingPayload.id !== callId
    ) {
      throw new LlmCallCorruptError();
    }
    const event = await runtime.harness.commit(async (tx) => {
      const header = await tx.doc(LlmCallDoc, callId, { id: callId });
      const payload = await tx.doc(LlmCallPayloadDoc, callId, { id: callId });
      mutate(header as LlmCallRecord, payload as LlmCallPayloadRecord);
      header.revision += 1;
      return { workId: header.workId, callId: header.id, revision: header.revision };
    }, runtime.ctx);
    runtime.emit({ type: "llm-call", ...event });
  }

  async function persistRecordingError(callId: string): Promise<void> {
    const payload = await runtime.readFamily(LlmCallPayloadDoc, callId, { id: callId });
    if (payload === undefined || payload.recordingError === GENERIC_RECORDING_ERROR) return;
    await mutateExistingCall(callId, (_header, currentPayload) => {
      currentPayload.recordingError = GENERIC_RECORDING_ERROR;
    });
  }

  async function interruptRunningCalls(): Promise<void> {
    for (const callId of activeCalls.keys()) {
      try {
        const current = await runtime.readFamily(LlmCallDoc, callId, { id: callId });
        if (current === undefined || current.status !== "running") {
          activeCalls.delete(callId);
          continue;
        }
        await mutateExistingCall(callId, (header) => {
          if (header.status !== "running") return;
          header.status = "interrupted";
          delete header.stopReason;
          delete header.endedAt;
        });
        activeCalls.delete(callId);
        liveCalls.delete(callId);
      } catch {
        reportFailure(callId);
      }
    }
  }

  async function recover(): Promise<void> {
    const records = await runtime.listFamily(LlmCallDoc, (id) => ({ id }));
    const running: LlmCallRecord[] = [];
    const callsByWork = new Map<string, { id: string; sequence: number }[]>();
    for (const { key, value } of records) {
      if (value.id !== key) {
        reportFailure();
        continue;
      }
      if (Number.isSafeInteger(value.sequence) && value.sequence > 0) {
        const calls = callsByWork.get(value.workId) ?? [];
        calls.push({ id: value.id, sequence: value.sequence });
        callsByWork.set(value.workId, calls);
      }
      if (Number.isSafeInteger(value.sequence) && value.sequence > (nextSequenceByWork.get(value.workId) ?? 0)) {
        nextSequenceByWork.set(value.workId, value.sequence);
      }
      if (value.status === "deferred" && value.deferredKey !== undefined) {
        addDeferredCall(value.deferredKey, value.id);
      }
      if (value.status !== "running") continue;
      const payload = await runtime.readFamily(LlmCallPayloadDoc, value.id, { id: value.id });
      if (payload === undefined || payload.id !== value.id) {
        reportFailure();
        continue;
      }
      running.push(value);
    }
    for (const [workId, calls] of callsByWork) {
      calls.sort((left, right) => left.sequence - right.sequence);
      const existing = await runtime.readFamily(WorkLlmCallIndexDoc, workId, { workId });
      const consistent =
        existing !== undefined &&
        existing.workId === workId &&
        Array.isArray(existing.calls) &&
        existing.calls.length === calls.length &&
        existing.calls.every((entry, index) => {
          const expected = calls[index];
          return entry !== null && typeof entry === "object" && entry.id === expected?.id && entry.sequence === expected?.sequence;
        });
      if (consistent) continue;
      await runtime.updateFamily(WorkLlmCallIndexDoc, workId, { workId }, (draft) => {
        draft.workId = workId;
        draft.calls = calls;
      });
    }
    if (running.length === 0) return;
    const events = await runtime.harness.commit(async (tx) => {
      const changed: { workId: string; callId: string; revision: number }[] = [];
      for (const record of running) {
        const header = await tx.doc(LlmCallDoc, record.id, { id: record.id });
        const payload = await tx.doc(LlmCallPayloadDoc, record.id, { id: record.id });
        if (header.id !== record.id || header.status !== "running" || payload.id !== record.id) continue;
        header.status = "interrupted";
        delete header.stopReason;
        delete header.endedAt;
        header.revision += 1;
        changed.push({ workId: header.workId, callId: header.id, revision: header.revision });
      }
      return changed;
    }, runtime.ctx);
    for (const event of events) runtime.emit({ type: "llm-call", ...event });
  }

  function initialize(): Promise<void> {
    initialization ??= recover();
    return initialization;
  }

  function stop(): void {
    accepting = false;
  }

  async function flush(): Promise<void> {
    if (!accepting && !finalizationQueued) {
      finalizationQueued = true;
      enqueue(interruptRunningCalls);
    }
    await drain();
  }

  function health(): LlmCallPageDTO["captureHealth"] {
    return { failedCount, accepting };
  }

  return { observer, initialize, stop, flush, health };
}

function initialLlmCallHeader(
  state: {
    id: string;
    startedAt: number;
    metadata: LlmCallRequestMetadata;
  },
  association: {
    workId: string;
    employeeId: string;
    conversationId: number;
    approvalId?: string;
    kind: LlmCallKind;
  },
  sequence: number,
  input: LlmCallInputSnapshot,
): LlmCallRecord {
  return {
    id: state.id,
    workId: association.workId,
    sequence,
    revision: 1,
    kind: association.kind,
    employeeId: association.employeeId,
    conversationId: association.conversationId,
    ...(association.approvalId !== undefined ? { approvalId: association.approvalId } : {}),
    model: state.metadata.model,
    startedAt: state.startedAt,
    status: "running",
    reasoning: state.metadata.reasoning ?? "",
    ...(state.metadata.maxTokens !== undefined ? { maxTokens: state.metadata.maxTokens } : {}),
    inputBytes: input.inputBytes,
    messageCount: input.messageCount,
    toolCount: input.toolCount,
    redactionApplied: true,
    captureBoundary: "models-sdk",
  };
}

function statusForCapturedStage(response: LlmCallResponseDTO): LlmCallStatus {
  if (response.type === "exception") return "failed";
  switch (response.stopReason) {
    case "error":
      return "failed";
    case "aborted":
      return "aborted";
    case "deferred":
      return "deferred";
    default:
      return "returned";
  }
}

function deferredKey(handle: DeferredHandle): string {
  return createHash("sha256")
    .update(JSON.stringify([handle.provider, handle.modelId, handle.api, handle.id]))
    .digest("hex");
}

function decodeLlmCallCursor(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new LlmCallCursorError();
  let decoded: string;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new LlmCallCursorError();
    decoded = bytes.toString("utf8");
  } catch {
    throw new LlmCallCursorError();
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new LlmCallCursorError();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("beforeSequence" in value)
  ) {
    throw new LlmCallCursorError();
  }
  const beforeSequence = value.beforeSequence;
  if (typeof beforeSequence !== "number" || !Number.isSafeInteger(beforeSequence) || beforeSequence <= 0) {
    throw new LlmCallCursorError();
  }
  return beforeSequence;
}

function summaryWithoutDeferredKey(record: LlmCallRecord): LlmCallSummaryDTO {
  const summary = { ...record };
  delete summary.deferredKey;
  return summary;
}
