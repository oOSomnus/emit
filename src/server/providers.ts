/**
 * Custom OpenAI/Anthropic-compatible endpoints, and the one built-in provider
 * whose native login needs extra connection parameters.
 *
 * The Pi catalog already covers the built-in providers. This module only adds
 * endpoints that Pi does not know: a local Ollama/LM Studio/vLLM server, a
 * company gateway, or any other compatible deployment. Each entry declares its
 * wire protocol explicitly, because "OpenAI-compatible" is a family of
 * protocols and not one protocol.
 */

import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  CUSTOM_PROVIDER_APIS,
  type CustomProviderApi,
  type CustomProviderConfigDTO,
} from "../shared/contracts.ts";
import type { LocalizedText } from "../shared/i18n.ts";
import { AppError, type AppText } from "./messages.ts";
import { providerMessages } from "./messages/providers.ts";
import { ValidationError } from "./workspace.ts";
import type { LocalizedAuthEvent, LocalizedAuthPrompt } from "./provider-auth.ts";

const API_IMPLEMENTATIONS: Record<CustomProviderApi, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
};

const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 8_192;

/** The provider whose native login collects only a key, not its endpoint. */
const AZURE_PROVIDER_ID = "azure-openai-responses";

/**
 * Validate and fully resolve a custom provider submission.
 *
 * The whole submission is rejected when any entry is invalid: silently
 * dropping a bad entry would save a list the user never wrote. `builtinIds`
 * keeps a custom endpoint from shadowing a native provider.
 */
export function normalizeCustomProviders(
  value: unknown,
  builtinIds: ReadonlySet<string>,
): CustomProviderConfigDTO[] {
  if (!Array.isArray(value)) throw new ValidationError(providerMessages.validate.mustBeArray());
  const result: CustomProviderConfigDTO[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const where = `providers[${index}]`;
    const draft = value[index];
    if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
      throw new ValidationError(providerMessages.validate.entryNotObject(where));
    }
    const entry = draft as Record<string, unknown>;

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new ValidationError(providerMessages.validate.idInvalid(where, id));
    }
    if (builtinIds.has(id)) throw new ValidationError(providerMessages.validate.idConflictsBuiltin(where, id));
    if (seenIds.has(id)) throw new ValidationError(providerMessages.validate.idDuplicate(id));
    seenIds.add(id);

    const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw new ValidationError(providerMessages.validate.baseUrlNotUrl(where, baseUrl));
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new ValidationError(providerMessages.validate.baseUrlNotHttp(where, baseUrl));
    }
    if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
      throw new ValidationError(providerMessages.validate.baseUrlNoCredentials(where));
    }

    const api = entry.api;
    if (typeof api !== "string" || !(CUSTOM_PROVIDER_APIS as readonly string[]).includes(api)) {
      throw new ValidationError(providerMessages.validate.apiUnsupported(where, CUSTOM_PROVIDER_APIS));
    }

    const apiKeyEnv = entry.apiKeyEnv === undefined ? "" : entry.apiKeyEnv;
    if (typeof apiKeyEnv !== "string" || (apiKeyEnv !== "" && !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv))) {
      throw new ValidationError(providerMessages.validate.apiKeyEnvInvalid(where));
    }

    const name = typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : id;

    if (!Array.isArray(entry.models) || entry.models.length === 0) {
      throw new ValidationError(providerMessages.validate.modelsAtLeastOne(where));
    }
    const modelIds = new Set<string>();
    const models: CustomProviderConfigDTO["models"] = [];
    for (let modelIndex = 0; modelIndex < entry.models.length; modelIndex += 1) {
      const modelWhere = `${where}.models[${modelIndex}]`;
      const rawModel = entry.models[modelIndex];
      if (typeof rawModel !== "object" || rawModel === null || Array.isArray(rawModel)) {
        throw new ValidationError(providerMessages.validate.modelNotObject(modelWhere));
      }
      const modelDraft = rawModel as Record<string, unknown>;
      const modelId = typeof modelDraft.id === "string" ? modelDraft.id.trim() : "";
      if (modelId.length === 0) throw new ValidationError(providerMessages.validate.modelIdEmpty(modelWhere));
      if (modelId.includes("|")) throw new ValidationError(providerMessages.validate.modelIdNoPipe(modelWhere));
      if (modelIds.has(modelId)) {
        throw new ValidationError(providerMessages.validate.modelIdDuplicate(where, modelId));
      }
      modelIds.add(modelId);

      const contextWindow = modelDraft.contextWindow === undefined ? DEFAULT_CONTEXT_WINDOW : modelDraft.contextWindow;
      if (typeof contextWindow !== "number" || !Number.isInteger(contextWindow) || contextWindow <= 0) {
        throw new ValidationError(providerMessages.validate.contextWindowPositive(modelWhere));
      }
      const maxTokens = modelDraft.maxTokens === undefined ? DEFAULT_MAX_TOKENS : modelDraft.maxTokens;
      if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
        throw new ValidationError(providerMessages.validate.maxTokensPositive(modelWhere));
      }
      const reasoning = modelDraft.reasoning === undefined ? false : modelDraft.reasoning;
      if (typeof reasoning !== "boolean") {
        throw new ValidationError(providerMessages.validate.reasoningBoolean(modelWhere));
      }

      const input = modelDraft.input === undefined ? ["text"] : modelDraft.input;
      if (
        !Array.isArray(input) ||
        input.length === 0 ||
        !input.every((part) => part === "text" || part === "image")
      ) {
        throw new ValidationError(providerMessages.validate.inputTextOrImage(modelWhere));
      }

      const modelName =
        typeof modelDraft.name === "string" && modelDraft.name.trim().length > 0 ? modelDraft.name.trim() : modelId;
      models.push({
        id: modelId,
        name: modelName,
        contextWindow,
        maxTokens,
        reasoning,
        input: input as ("text" | "image")[],
      });
    }

    result.push({ id, name, baseUrl, api: api as CustomProviderApi, apiKeyEnv, models });
  }
  return result;
}

/** Build the Pi providers for a normalized custom list, without publishing them. */
export function createCustomProviders(configs: readonly CustomProviderConfigDTO[]): Provider[] {
  return configs.map((config) => {
    const entries: Model<Api>[] = config.models.map((entry) => ({
      id: entry.id,
      name: entry.name,
      api: config.api,
      provider: config.id,
      baseUrl: config.baseUrl,
      reasoning: entry.reasoning,
      input: entry.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
    }));
    const auth = API_IMPLEMENTATIONS[config.api]();
    // A keyless local server resolves as configured with no key; a keyed
    // endpoint reads its declared environment variable or a stored credential.
    const providerAuth =
      config.apiKeyEnv.length > 0
        ? { apiKey: envApiKeyAuth(config.name, [config.apiKeyEnv]) }
        : { apiKey: { name: config.name, resolve: async () => ({ auth: {} }) } };

    return createProvider({
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      auth: providerAuth,
      models: entries,
      api: { [config.api]: auth },
    });
  });
}

/**
 * Extend the built-in Azure login to also collect its endpoint.
 *
 * The native login asks only for an API key, while the native request
 * implementation separately reads `AZURE_OPENAI_BASE_URL` /
 * `AZURE_OPENAI_RESOURCE_NAME`, an API version, and a deployment map. Without
 * this, a user could save a key that can never resolve an endpoint. The extra
 * answers ride in the same credential's `env`, so `Models.login` still commits
 * the whole thing exactly once.
 */
export function configureBuiltinLogin(models: MutableModels): void {
  const provider = models.getProvider(AZURE_PROVIDER_ID);
  const auth = provider?.auth.apiKey;
  if (auth === undefined || auth.login === undefined) return;
  const nativeLogin = auth.login.bind(auth);

  auth.login = async (interaction) => {
    const credential = await nativeLogin(interaction);
    const env: Record<string, string> = { ...credential.env };

    const mode = await interaction.prompt(
      selectPrompt(providerMessages.azure.endpointModePrompt(), [
        providerMessages.azure.baseUrlOption(),
        providerMessages.azure.resourceNameOption(),
      ]),
    );

    if (mode === "base-url") {
      for (;;) {
        // The prompt reads the same in both languages, so it carries no pair.
        const value = (await interaction.prompt({ type: "text", message: "Azure OpenAI Base URL" })).trim();
        if (isHttpUrl(value)) {
          env.AZURE_OPENAI_BASE_URL = value;
          break;
        }
        interaction.notify(notifyEvent(providerMessages.azure.baseUrlRetry()));
      }
    } else if (mode === "resource-name") {
      for (;;) {
        // The prompt reads the same in both languages, so it carries no pair.
        const value = (await interaction.prompt({ type: "text", message: "Azure OpenAI resource name" })).trim();
        if (value.length > 0) {
          env.AZURE_OPENAI_RESOURCE_NAME = value;
          break;
        }
        interaction.notify(notifyEvent(providerMessages.azure.resourceNameRetry()));
      }
    } else {
      throw new AppError(providerMessages.azure.unknownEndpointMode(mode));
    }

    const apiVersion = (await interaction.prompt(textPrompt(providerMessages.azure.apiVersionPrompt()))).trim();
    if (apiVersion.length > 0) env.AZURE_OPENAI_API_VERSION = apiVersion;

    for (;;) {
      const map = (await interaction.prompt(textPrompt(providerMessages.azure.deploymentMapPrompt()))).trim();
      if (map.length === 0) break;
      if (isDeploymentMap(map)) {
        env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = map;
        break;
      }
      interaction.notify(notifyEvent(providerMessages.azure.deploymentMapRetry()));
    }

    return { ...credential, env };
  };
}

/** Attach an application translation to a select prompt's message and options. */
function selectPrompt(
  message: AppText,
  options: readonly {
    id: string;
    label: string;
    description: string;
    descriptionLocalized: LocalizedText;
  }[],
): LocalizedAuthPrompt {
  return {
    type: "select",
    message: message.text,
    messageLocalized: message.localized,
    options: options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      descriptionLocalized: option.descriptionLocalized,
    })),
  };
}

/** Attach an application translation to a text prompt. */
function textPrompt(message: AppText): LocalizedAuthPrompt {
  return { type: "text", message: message.text, messageLocalized: message.localized };
}

/** Attach an application translation to an info event. */
function notifyEvent(message: AppText): LocalizedAuthEvent {
  return { type: "info", message: message.text, messageLocalized: message.localized };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isDeploymentMap(value: string): boolean {
  return value.split(",").every((entry) => {
    const parts = entry.trim().split("=");
    return parts.length === 2 && (parts[0] ?? "").trim().length > 0 && (parts[1] ?? "").trim().length > 0;
  });
}
