/**
 * The model catalog seam.
 *
 * Emit never branches on vendor names. Every model reference is resolved
 * through the pi-ai collection, which owns provider identity, auth, the model
 * catalog, and the wire protocol. This module adds only what the product needs:
 * a serializable catalog for the settings UI, capability and effort resolution,
 * and an honest per-kind connection check.
 */

import { randomUUID } from "node:crypto";
import {
  getModelType,
  getSupportedThinkingLevels,
  isModelType,
  InMemoryCredentialStore,
  type ClassifierModel,
  type ClassifierApi,
  type CreateModelsOptions,
  type CredentialStore,
  type Model,
  type ModelsRefreshOptions,
  type ModelsRefreshResult,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  CheckResultDTO,
  CustomProviderConfigDTO,
  ModelInfoDTO,
  ModelRefDTO,
  ProviderAuthMethodDTO,
  ProviderStatusDTO,
} from "../shared/contracts.ts";
import { type AppText } from "./messages.ts";
import { modelMessages } from "./messages/models.ts";
import { probeResources } from "./prompts/index.ts";
import { configureBuiltinLogin, createCustomProviders, normalizeCustomProviders } from "./providers.ts";
import { createObservedModels, type LlmCallObserver } from "./llm-calls.ts";

/** Reasoning efforts a model accepts, in ascending order, with `off` first. */
const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export class ModelCatalog {
  readonly models: MutableModels;
  /** Provider ids the native catalog owns; a custom provider may never reuse one. */
  readonly builtinProviderIds: ReadonlySet<string>;
  #credentials: CredentialStore;
  #llmCallObserver: LlmCallObserver | undefined;
  #customIds = new Set<string>();

  constructor(customProviders: readonly CustomProviderConfigDTO[] = [], options?: CreateModelsOptions) {
    this.#credentials = options?.credentials ?? new InMemoryCredentialStore();
    const nativeModels = builtinModels({ ...options, credentials: this.#credentials });
    this.models = createObservedModels(nativeModels, {
      begin: (request) => this.#llmCallObserver?.begin(request),
      accepting: () => {
        const observer = this.#llmCallObserver;
        return observer !== undefined && (observer.accepting?.() ?? true);
      },
      deferredReturned: (handle, response) => {
        this.#llmCallObserver?.deferredReturned(handle, response);
      },
      deferredFailed: (handle, error) => {
        this.#llmCallObserver?.deferredFailed(handle, error);
      },
    });
    this.builtinProviderIds = new Set(nativeModels.getProviders().map((provider) => provider.id));
    // Azure's native login only collects a key; the endpoint parameters are
    // asked for here, before any custom provider is registered.
    configureBuiltinLogin(this.models);
    this.applyCustomProviders(
      createCustomProviders(normalizeCustomProviders(customProviders, this.builtinProviderIds)),
    );
  }
  /** Install or remove the execution-log observer without wrapping the catalog again. */
  setLlmCallObserver(observer: LlmCallObserver | undefined): void {
    this.#llmCallObserver = observer;
  }

  /** Provider identity, native auth methods, and whether pi-ai can resolve auth. */
  async providerStatuses(): Promise<ProviderStatusDTO[]> {
    const custom = new Set(this.#customIds);
    const stored = new Map<string, "api_key" | "oauth">();
    let listError: string | null = null;
    try {
      for (const info of await this.#credentials.list()) stored.set(info.providerId, info.type);
    } catch (error) {
      listError = describeError(error);
    }

    const statuses: ProviderStatusDTO[] = [];
    for (const provider of this.models.getProviders()) {
      let authSource: string | null = null;
      let configured = false;
      let authError = listError;
      try {
        const check = await this.models.checkAuth(provider.id);
        if (check !== undefined) {
          configured = true;
          authSource = check.source ?? check.type;
        }
      } catch (error) {
        // A broken credential store or failed resolution is a real error, not
        // the same thing as "no credential configured".
        authError = describeError(error);
      }
      statuses.push({
        providerId: provider.id,
        name: provider.name,
        authSource,
        configured,
        custom: custom.has(provider.id),
        authMethods: authMethodsOf(provider),
        storedAuthType: stored.get(provider.id) ?? null,
        authError,
      });
    }
    return statuses.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Every chat and classifier model Pi knows, with capability metadata.
   *
   * `configured` is per model, not per provider: a provider can be
   * authenticated while a specific model is not offered for that credential
   * (GitHub Copilot filters by plan). Being unlisted is not a failed
   * connection, so the provider still appears in the management surface.
   */
  async catalog(): Promise<ModelInfoDTO[]> {
    const available = new Set<string>();
    for (const provider of this.models.getProviders()) {
      try {
        for (const model of await this.models.getAllAvailable(provider.id)) {
          available.add(`${getModelType(model)}|${model.id}`);
        }
      } catch {
        // An unresolvable credential leaves this provider's models unlisted.
      }
    }

    const infos: ModelInfoDTO[] = [];
    for (const provider of this.models.getProviders()) {
      for (const model of this.models.getAllModels(provider.id)) {
        if (isModelType(model, "image")) continue;
        const kind = getModelType(model) === "classifier" ? "classifier" : "chat";
        infos.push({
          providerId: provider.id,
          providerName: provider.name,
          modelId: model.id,
          name: model.name,
          kind,
          contextWindow: model.contextWindow,
          efforts: kind === "chat" ? thinkingLevelsFor(model as Model<never>) : [],
          // The Pi chat catalog only lists models that support tool calling.
          toolCalling: kind === "chat",
          configured: available.has(`${kind}|${model.id}`),
        });
      }
    }
    return infos;
  }

  chatModel(ref: ModelRefDTO): Model<never> | undefined {
    const model = this.models.getModel(ref.providerId, ref.modelId);
    return model as Model<never> | undefined;
  }

  classifierModel(ref: ModelRefDTO): ClassifierModel<ClassifierApi> | undefined {
    return this.models.getModelOfType("classifier", ref.providerId, ref.modelId);
  }

  /**
   * Why a chat selection cannot be used as an employee's model, or undefined.
   *
   * The catalog is the authority: an employee executes work with a tool-calling
   * chat model, at an effort that model actually supports. Accepting anything
   * else would only surface later as a failed run.
   */
  chatSelectionProblem(selection: { providerId: string; modelId: string; effort: string }): AppText | undefined {
    if (selection.providerId.length === 0 || selection.modelId.length === 0) {
      return modelMessages.chatSelectionRequired();
    }
    const model = this.models.getModel(selection.providerId, selection.modelId);
    if (model === undefined || getModelType(model) !== "chat") {
      return modelMessages.chatModelUnresolved(selection.providerId, selection.modelId);
    }
    const supported = thinkingLevelsFor(model as Model<never>);
    if (!supported.includes(selection.effort)) {
      return modelMessages.effortUnsupported(model.name, selection.effort, supported);
    }
    return undefined;
  }

  /** Why an approval configuration cannot be used, or undefined when it can. */
  approvalProblem(config: {
    kind: "llm" | "classifier";
    providerId: string;
    modelId: string;
    effort: string;
  }): AppText | undefined {
    if (config.kind === "llm") {
      return this.chatSelectionProblem({
        providerId: config.providerId,
        modelId: config.modelId,
        effort: config.effort,
      });
    }
    if (this.classifierModel({ providerId: config.providerId, modelId: config.modelId }) === undefined) {
      return modelMessages.classifierModelUnresolved(config.providerId, config.modelId);
    }
    return undefined;
  }

  /** Clamp a stored effort to what the model actually supports. */
  resolveEffort(ref: ModelRefDTO, effort: string): string {
    const model = this.chatModel(ref);
    if (model === undefined) return "off";
    const supported = thinkingLevelsFor(model);
    return supported.includes(effort) ? effort : "off";
  }

  /**
   * Real per-kind probe. A chat probe sends one tiny completion; a classifier
   * probe runs one bool question, because a chat request cannot verify a
   * classifier endpoint. A provider's own error message stays raw; only the
   * app-authored wrapping carries a pair.
   */
  async check(ref: ModelRefDTO, kind: "chat" | "classifier"): Promise<CheckResultDTO> {
    if (kind === "classifier") {
      const model = this.classifierModel(ref);
      if (model === undefined) return appCheck(false, modelMessages.classifierModelMissing(ref.providerId, ref.modelId));
      const result = await this.models.classify(model, {
        state: probeResources.classifier.state,
        questions: { reachable: probeResources.classifier.question },
      });
      if (result.stopReason !== "stop") {
        return result.errorMessage === undefined
          ? appCheck(false, modelMessages.classifierRequestEnded(result.stopReason))
          : { ok: false, message: result.errorMessage };
      }
      return appCheck(true, modelMessages.classifierResponded(model.name, result.answers.reachable?.type ?? "unknown"));
    }

    const model = this.chatModel(ref);
    if (model === undefined) return appCheck(false, modelMessages.chatModelMissing(ref.providerId, ref.modelId));
    // Each check is its own one-shot conversation, so it carries a fresh
    // session id; the native OpenCode provider turns it into the required
    // `x-opencode-session` header. A single request's internal retries reuse
    // this same options object, and therefore the same session.
    const message = await this.models.completeSimple(
      model,
      { messages: [{ role: "user", content: probeResources.chat, timestamp: Date.now() }] },
      { maxTokens: 16, sessionId: randomUUID() },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return message.errorMessage === undefined
        ? appCheck(false, modelMessages.requestEnded(message.stopReason))
        : { ok: false, message: message.errorMessage };
    }
    return appCheck(true, modelMessages.chatResponded(model.name, message.stopReason));
  }

  /**
   * Make the catalog match the configured custom providers.
   *
   * This is a replacement, not an addition: a provider removed from the
   * settings must stop resolving, otherwise a deleted model would keep running
   * and a fresh selection would silently succeed against a stale catalog.
   * Providers are built and validated before this call, so nothing here can
   * fail on bad input.
   */
  applyCustomProviders(providers: readonly Provider[]): void {
    const next = new Set(providers.map((provider) => provider.id));
    for (const id of this.#customIds) {
      if (next.has(id)) continue;
      try {
        this.models.deleteProvider(id);
      } catch {
        // Already gone; the catalog is still correct.
      }
    }
    for (const provider of providers) this.models.setProvider(provider);
    this.#customIds = next;
  }

  /** Refresh dynamically listed providers; static catalogs are no-ops. */
  async refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
    return this.models.refresh(options);
  }
}

/** Native auth methods for one provider, in native order. */
function authMethodsOf(provider: Provider): ProviderAuthMethodDTO[] {
  const methods: ProviderAuthMethodDTO[] = [];
  const apiKey = provider.auth.apiKey;
  if (apiKey !== undefined) {
    methods.push({
      type: "api_key",
      label: apiKey.name,
      interactive: apiKey.login !== undefined,
      subscription: false,
    });
  }
  const oauth = provider.auth.oauth;
  if (oauth !== undefined) {
    methods.push({
      type: "oauth",
      label: oauth.loginLabel ?? oauth.name,
      interactive: true,
      subscription: oauth.isSubscription ?? false,
    });
  }
  return methods;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A probe result whose message is an app-authored pair. */
function appCheck(ok: boolean, message: AppText): CheckResultDTO {
  return { ok, message: message.text, messageLocalized: message.localized };
}

/** Supported efforts for a chat model, ordered, `off` first. */
function thinkingLevelsFor(model: Model<never>): string[] {
  if (!model.reasoning) return ["off"];
  const levels = getSupportedThinkingLevels(model);
  return EFFORT_ORDER.filter((level) => levels.includes(level as never));
}
