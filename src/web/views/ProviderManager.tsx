/**
 * Visual provider and model management.
 *
 * Every provider Pi knows is listed from native metadata; the browser never
 * hard-codes a vendor list. Authentication always runs through Pi's own login
 * flow, bridged to the page as a prompt-and-event session. Custom endpoints add
 * OpenAI/Anthropic-compatible servers Pi does not ship.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { errorDisplay, type DisplayText } from "../../shared/i18n.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { uiText } from "../messages.ts";
import type { ProvidersMessages } from "../messages/providers.ts";
import { useApp, type State } from "../state.tsx";
import { Chip } from "./ui.tsx";
import type {
  AuthEventDTO,
  AuthSessionDTO,
  CustomProviderApi,
  CustomProviderConfigDTO,
  ProviderStatusDTO,
} from "../../shared/contracts.ts";

const SESSION_KEY = "emit.provider-auth-session";

type ModelRow = {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  inputText: boolean;
  inputImage: boolean;
};

type CustomDraft = {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  authMode: "none" | "key";
  apiKeyEnv: string;
  models: ModelRow[];
};

function blankModelRow(): ModelRow {
  return {
    id: "",
    name: "",
    contextWindow: "32768",
    maxTokens: "8192",
    reasoning: false,
    inputText: true,
    inputImage: false,
  };
}

function emptyDraft(): CustomDraft {
  return {
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    authMode: "key",
    apiKeyEnv: "",
    models: [blankModelRow()],
  };
}

function draftFrom(config: CustomProviderConfigDTO): CustomDraft {
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    api: config.api,
    authMode: config.apiKeyEnv.length > 0 ? "key" : "none",
    apiKeyEnv: config.apiKeyEnv,
    models: config.models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: String(model.contextWindow),
      maxTokens: String(model.maxTokens),
      reasoning: model.reasoning,
      inputText: model.input.includes("text"),
      inputImage: model.input.includes("image"),
    })),
  };
}

/** The default environment variable name for a keyed custom provider. */
function defaultKeyEnv(id: string): string {
  return `EMIT_PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function draftToConfig(draft: CustomDraft): CustomProviderConfigDTO {
  const id = draft.id.trim();
  return {
    id,
    name: draft.name.trim().length > 0 ? draft.name.trim() : id,
    baseUrl: draft.baseUrl.trim(),
    api: draft.api,
    apiKeyEnv: draft.authMode === "key" ? draft.apiKeyEnv.trim() : "",
    models: draft.models.map((model) => {
      const modelId = model.id.trim();
      const input: ("text" | "image")[] = [];
      if (model.inputText) input.push("text");
      if (model.inputImage) input.push("image");
      return {
        id: modelId,
        name: model.name.trim().length > 0 ? model.name.trim() : modelId,
        contextWindow: Number(model.contextWindow),
        maxTokens: Number(model.maxTokens),
        reasoning: model.reasoning,
        input,
      };
    }),
  };
}

/** Configurations that still reference a provider's models, as display labels. */
function providerReferences(state: State, providerId: string, messages: ProvidersMessages): string[] {
  const references: string[] = [];
  const defaultModel = state.app?.defaultExecutionModel;
  if (defaultModel !== null && defaultModel !== undefined && defaultModel.model.providerId === providerId) {
    references.push(messages.referenceDefaultModel(defaultModel.model.modelId));
  }
  const approval = state.app?.approval;
  if (approval !== null && approval !== undefined && approval.model.providerId === providerId) {
    references.push(messages.referenceApprovalModel(approval.model.modelId));
  }
  for (const employee of state.employees) {
    if (employee.executionModel.model.providerId === providerId) {
      references.push(messages.referenceEmployee(employee.name, employee.executionModel.model.modelId));
    }
  }
  return references;
}

function safeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function ProviderManager(): ReactNode {
  const { state, refreshModels } = useApp();
  const { messages } = useI18n();
  const [search, setSearch] = useState("");
  const [configuredOnly, setConfiguredOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [session, setSession] = useState<AuthSessionDTO | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(
    () => sessionStorage.getItem(SESSION_KEY) ?? undefined,
  );
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState<DisplayText | undefined>(undefined);
  const [providerMessage, setProviderMessage] = useState<{ tone: "ok" | "error"; text: DisplayText } | undefined>(
    undefined,
  );
  const [editor, setEditor] = useState<CustomDraft | undefined>(undefined);

  const term = search.trim().toLowerCase();
  const listed = state.providers.filter((provider) => {
    if (configuredOnly && !provider.configured) return false;
    if (term.length === 0) return true;
    return `${provider.name} ${provider.providerId}`.toLowerCase().includes(term);
  });

  const selected =
    state.providers.find((provider) => provider.providerId === selectedId) ?? listed[0] ?? undefined;
  const selectedProviderId = selected?.providerId;
  const selectedHidden =
    selected !== undefined && !listed.some((provider) => provider.providerId === selected.providerId);
  const selectedConfig = state.customProviders.find((config) => config.id === selectedProviderId);
  const providerModels = useMemo(
    () => state.models.filter((model) => model.providerId === selectedProviderId),
    [state.models, selectedProviderId],
  );

  // Poll the open session while it can still change; stop the moment it cannot.
  useEffect(() => {
    if (sessionId === undefined) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const next = await api.authSession(sessionId);
        if (cancelled) return;
        setSession(next);
        if (next.status !== "running" && next.status !== "waiting") {
          setSessionId(undefined);
          sessionStorage.removeItem(SESSION_KEY);
          void refreshModels().catch(() => undefined);
          return;
        }
        timer = setTimeout(tick, 500);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof Error && "status" in error && error.status === 404) {
          setSessionId(undefined);
          sessionStorage.removeItem(SESSION_KEY);
          setSession(undefined);
          return;
        }
        setAuthError(errorDisplay(error));
        timer = setTimeout(tick, 1500);
      }
    };
    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, refreshModels]);

  const startAuth = async (providerId: string, type: "api_key" | "oauth"): Promise<void> => {
    setBusy(true);
    setAuthError(undefined);
    setProviderMessage(undefined);
    try {
      const started = await api.startAuthSession(providerId, type);
      setSession(started);
      setSessionId(started.id);
      sessionStorage.setItem(SESSION_KEY, started.id);
      setSelectedId(providerId);
    } catch (error) {
      setAuthError(errorDisplay(error));
    } finally {
      setBusy(false);
    }
  };

  const respond = async (value: string): Promise<void> => {
    if (session === undefined || session.prompt === null) return;
    setBusy(true);
    setAuthError(undefined);
    try {
      setSession(await api.respondAuthSession(session.id, session.prompt.id, value));
    } catch (error) {
      setAuthError(errorDisplay(error));
    } finally {
      setBusy(false);
    }
  };

  const cancelAuth = async (): Promise<void> => {
    if (session === undefined) return;
    setBusy(true);
    try {
      setSession(await api.cancelAuthSession(session.id));
    } catch (error) {
      setAuthError(errorDisplay(error));
    } finally {
      setSessionId(undefined);
      sessionStorage.removeItem(SESSION_KEY);
      setBusy(false);
      void refreshModels().catch(() => undefined);
    }
  };

  const removeCredential = async (providerId: string): Promise<void> => {
    setBusy(true);
    setProviderMessage(undefined);
    try {
      await api.deleteProviderCredential(providerId);
      await refreshModels();
      setProviderMessage({ tone: "ok", text: uiText((m) => m.providers.credentialRemoved) });
    } catch (error) {
      setProviderMessage({ tone: "error", text: errorDisplay(error) });
    } finally {
      setBusy(false);
    }
  };

  const refreshCatalog = async (providerId: string): Promise<void> => {
    setBusy(true);
    setProviderMessage(undefined);
    try {
      const result = await api.refreshProvider(providerId);
      setProviderMessage({ tone: result.ok ? "ok" : "error", text: result.messageLocalized ?? result.message });
      await refreshModels();
    } catch (error) {
      setProviderMessage({ tone: "error", text: errorDisplay(error) });
    } finally {
      setBusy(false);
    }
  };

  const saveCustom = async (draft: CustomDraft): Promise<void> => {
    setBusy(true);
    setProviderMessage(undefined);
    try {
      const config = draftToConfig(draft);
      const next = [...state.customProviders.filter((provider) => provider.id !== config.id), config];
      await api.setCustomProviders(next);
      await refreshModels();
      setEditor(undefined);
      setSelectedId(config.id);
      // An existing saved key is left alone: the user replaces it explicitly
      // through the provider's auth button, not by editing the configuration.
      const stored = state.providers.find((provider) => provider.providerId === config.id)?.storedAuthType ?? null;
      if (draft.authMode === "key" && stored === null) {
        await startAuth(config.id, "api_key");
        return;
      }
      setProviderMessage({
        tone: "ok",
        text: uiText((m) => (draft.authMode === "key" ? m.providers.savedKeepKey : m.providers.savedNoCredential)),
      });
    } catch (error) {
      setProviderMessage({ tone: "error", text: errorDisplay(error) });
    } finally {
      setBusy(false);
    }
  };

  const deleteCustom = async (providerId: string): Promise<void> => {
    const references = providerReferences(state, providerId, messages.providers);
    const note = references.length > 0 ? messages.providers.deleteReferencesNote(references) : "";
    if (!window.confirm(messages.providers.deleteConfirm(providerId) + note)) return;
    setBusy(true);
    setProviderMessage(undefined);
    try {
      await api.setCustomProviders(state.customProviders.filter((provider) => provider.id !== providerId));
      await refreshModels();
      setEditor(undefined);
      setSelectedId(undefined);
    } catch (error) {
      setProviderMessage({ tone: "error", text: errorDisplay(error) });
    } finally {
      setBusy(false);
    }
  };

  const sessionProvider = session === undefined ? undefined : state.providers.find(
    (provider) => provider.providerId === session.providerId,
  );
  const sessionActive = session !== undefined && (session.status === "running" || session.status === "waiting");

  // The list row and the narrow-pane picker share one selection path.
  const selectProvider = (providerId: string): void => {
    setSelectedId(providerId);
    setProviderMessage(undefined);
  };

  return (
    <fieldset className="provider-manager">
      <legend>
        {messages.providers.legend} · {state.providers.length}
      </legend>

      {/* The container query needs a plain block wrapper: fieldset does not
          resolve as a query container. */}
      <div className="provider-manager-inner">
      <div className="row provider-toolbar">
        <input
          type="search"
          value={search}
          placeholder={messages.providers.searchPlaceholder}
          aria-label={messages.providers.search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="inline">
          <input
            type="checkbox"
            checked={configuredOnly}
            onChange={(event) => setConfiguredOnly(event.target.checked)}
          />
          {messages.providers.configuredOnly}
        </label>
        <button type="button" onClick={() => setEditor(emptyDraft())}>
          {messages.providers.addCustom}
        </button>
      </div>

      <details>
        <summary>{messages.providers.authHelp}</summary>
        <p className="hint">{messages.providers.intro(state.providers.length)}</p>
      </details>

      {sessionActive && sessionProvider !== undefined && sessionProvider.providerId !== selectedProviderId ? (
        <div className="banner warn">
          <span>{messages.providers.activeSession(sessionProvider.name)}</span>
          <button type="button" onClick={() => setSelectedId(sessionProvider.providerId)}>
            {messages.providers.view}
          </button>
        </div>
      ) : null}

      <label className="provider-picker">
        {messages.providers.pickerLabel}
        <select
          aria-label={messages.providers.pickerLabel}
          value={selectedProviderId ?? ""}
          disabled={listed.length === 0}
          onChange={(event) => selectProvider(event.target.value)}
        >
          {listed.map((provider) => (
            <option key={provider.providerId} value={provider.providerId}>
              {provider.name}
            </option>
          ))}
          {selectedHidden && selected !== undefined ? (
            <option value={selected.providerId} disabled>
              {selected.name}
            </option>
          ) : null}
          {selected === undefined ? (
            <option value="" disabled>
              {messages.providers.noMatch}
            </option>
          ) : null}
        </select>
      </label>

      <div className="provider-manager-body">
        <ul className="plain provider-list">
          {listed.map((provider) => (
            <li key={provider.providerId}>
              <button
                type="button"
                data-provider-id={provider.providerId}
                className={provider.providerId === selectedProviderId ? "provider-item active" : "provider-item"}
                onClick={() => selectProvider(provider.providerId)}
              >
                <span className="provider-item-copy">
                  <strong>{provider.name}</strong>
                  <code>{provider.providerId}</code>
                </span>
                <span className="provider-item-meta">
                  {provider.custom ? <Chip tone="info">{messages.providers.chipCustom}</Chip> : null}
                  {provider.configured ? (
                    <Chip tone="ok">{provider.authSource ?? messages.providers.authSourceConfigured}</Chip>
                  ) : (
                    <Chip tone="muted">{messages.providers.notConfigured}</Chip>
                  )}
                  {provider.storedAuthType !== null ? (
                    <Chip tone="info">{provider.storedAuthType === "oauth" ? "OAuth" : "API Key"}</Chip>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
          {listed.length === 0 ? <li className="hint">{messages.providers.noMatch}</li> : null}
        </ul>

        {selected !== undefined ? (
          <ProviderDetail
            provider={selected}
            models={providerModels}
            busy={busy}
            message={providerMessage}
            authError={authError}
            session={session !== undefined && session.providerId === selected.providerId ? session : undefined}
            onStart={(type) => void startAuth(selected.providerId, type)}
            onLogout={() => void removeCredential(selected.providerId)}
            onRefresh={() => void refreshCatalog(selected.providerId)}
            onEdit={() => {
              if (selectedConfig !== undefined) setEditor(draftFrom(selectedConfig));
            }}
            onDelete={() => void deleteCustom(selected.providerId)}
            onRespond={(value) => void respond(value)}
            onCancel={() => void cancelAuth()}
          />
        ) : (
          <p className="hint">{messages.providers.selectHint}</p>
        )}
      </div>

      {editor !== undefined ? (
        <CustomEditor
          key={editor.id.length > 0 ? editor.id : "new"}
          initial={editor}
          busy={busy}
          onCancel={() => setEditor(undefined)}
          onSave={(draft) => void saveCustom(draft)}
        />
      ) : null}
      </div>
    </fieldset>
  );
}

function ProviderDetail({
  provider,
  models,
  busy,
  message: providerMessage,
  authError,
  session,
  onStart,
  onLogout,
  onRefresh,
  onEdit,
  onDelete,
  onRespond,
  onCancel,
}: {
  provider: ProviderStatusDTO;
  models: State["models"];
  busy: boolean;
  message: { tone: "ok" | "error"; text: DisplayText } | undefined;
  authError: DisplayText | undefined;
  session: AuthSessionDTO | undefined;
  onStart: (type: "api_key" | "oauth") => void;
  onLogout: () => void;
  onRefresh: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRespond: (value: string) => void;
  onCancel: () => void;
}): ReactNode {
  const { messages, text } = useI18n();
  return (
    <section className="editor provider-detail">
      <h3>
        {provider.name} <code>{provider.providerId}</code>
      </h3>
      <p className="hint">
        {messages.providers.credentialSource(
          provider.configured
            ? provider.authSource ?? messages.providers.authSourceConfigured
            : messages.providers.notConfigured,
        )}{" "}
        · {messages.providers.storedAuth(
          provider.storedAuthType === null
            ? messages.common.none
            : provider.storedAuthType === "oauth"
              ? "OAuth"
              : "API Key",
        )}
      </p>
      {provider.authError !== null ? (
        <p className="error-text">{messages.providers.authCheckError(provider.authError)}</p>
      ) : null}

      <div className="row">
        {provider.authMethods
          .filter((method) => method.interactive)
          .map((method) => (
            <button key={method.type} type="button" disabled={busy} onClick={() => onStart(method.type)}>
              {method.type === "oauth"
                ? method.subscription
                  ? messages.providers.loginSubscription(method.label)
                  : messages.providers.login(method.label)
                : messages.providers.setupKey(method.label)}
            </button>
          ))}
        {provider.storedAuthType !== null ? (
          <button type="button" className="danger" disabled={busy} onClick={onLogout}>
            {messages.providers.removeCredential}
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={onRefresh}>
          {messages.providers.refreshCatalog}
        </button>
        {provider.custom ? (
          <>
            <button type="button" disabled={busy} onClick={onEdit}>
              {messages.providers.editConfig}
            </button>
            <button type="button" className="danger" disabled={busy} onClick={onDelete}>
              {messages.providers.deleteProvider}
            </button>
          </>
        ) : null}
      </div>

      {providerMessage !== undefined ? (
        <p className={providerMessage.tone === "ok" ? "hint" : "error-text"}>{text(providerMessage.text)}</p>
      ) : null}
      {authError !== undefined ? (
        <p className="error-text">{messages.providers.authInteractionError(text(authError))}</p>
      ) : null}

      {session !== undefined ? (
        <AuthSessionPanel session={session} busy={busy} onRespond={onRespond} onCancel={onCancel} />
      ) : null}

      <h4>{messages.providers.modelsHeading(models.length)}</h4>
      <ul className="plain">
        {models.map((model) => (
          <li key={`${model.kind}|${model.modelId}`}>
            <code>{model.modelId}</code> {model.name} <Chip tone="muted">{model.kind}</Chip>{" "}
            <span className="hint">{messages.providers.contextHint(model.contextWindow)}</span>{" "}
            {model.configured ? (
              <Chip tone="ok">{messages.providers.modelAvailable}</Chip>
            ) : (
              <Chip tone="muted">{messages.providers.modelCredentialUnavailable}</Chip>
            )}
          </li>
        ))}
        {models.length === 0 ? <li className="hint">{messages.providers.noModels}</li> : null}
      </ul>
    </section>
  );
}

function AuthSessionPanel({
  session,
  busy,
  onRespond,
  onCancel,
}: {
  session: AuthSessionDTO;
  busy: boolean;
  onRespond: (value: string) => void;
  onCancel: () => void;
}): ReactNode {
  const { messages, text } = useI18n();
  const [value, setValue] = useState("");
  const promptId = session.prompt?.id;
  useEffect(() => {
    setValue("");
  }, [promptId]);

  const prompt = session.prompt;
  return (
    <div className="auth-session">
      <p className="hint">
        {messages.providers.authStatus(messages.providers.status[session.status])}
        {session.message !== null ? ` · ${text(session.messageLocalized ?? session.message)}` : ""}
      </p>
      {session.events.length > 0 ? (
        <ul className="plain">
          {session.events.map((event, index) => (
            <li key={index}>{renderAuthEvent(event, messages.providers, text)}</li>
          ))}
        </ul>
      ) : null}
      {prompt !== null ? (
        <div>
          <p className="hint">{text(prompt.messageLocalized ?? prompt.message)}</p>
          {prompt.type === "select" ? (
            <div className="row">
              {prompt.options?.map((option) => (
                <button key={option.id} type="button" disabled={busy} onClick={() => onRespond(option.id)}>
                  {text(option.labelLocalized ?? option.label)}
                  {option.description !== undefined ? (
                    <span className="hint"> {text(option.descriptionLocalized ?? option.description)}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : (
            <form
              className="row"
              onSubmit={(event) => {
                event.preventDefault();
                onRespond(value);
              }}
            >
              <input
                type={prompt.type === "secret" ? "password" : "text"}
                value={value}
                placeholder={prompt.placeholder ?? ""}
                aria-label={text(prompt.messageLocalized ?? prompt.message)}
                onChange={(event) => setValue(event.target.value)}
              />
              <button type="submit" disabled={busy || (prompt.type === "secret" && value.length === 0)}>
                {messages.providers.submit}
              </button>
            </form>
          )}
        </div>
      ) : null}
      {session.status === "running" || session.status === "waiting" ? (
        <button type="button" className="danger" disabled={busy} onClick={onCancel}>
          {messages.providers.cancelAuth}
        </button>
      ) : null}
    </div>
  );
}

function renderAuthEvent(
  event: AuthEventDTO,
  providers: ProvidersMessages,
  text: (value: DisplayText) => string,
): ReactNode {
  switch (event.type) {
    case "info":
      return (
        <>
          {text(event.messageLocalized ?? event.message)}
          {event.links?.map((link) => {
            const url = safeUrl(link.url);
            return url === undefined ? null : (
              <a key={`${link.url}-${link.label ?? ""}`} className="link" href={url} target="_blank" rel="noopener noreferrer">
                {link.label ?? link.url}
              </a>
            );
          })}
        </>
      );
    case "auth_url": {
      const url = safeUrl(event.url);
      return (
        <>
          {event.instructions !== undefined ? `${event.instructions} ` : ""}
          {url === undefined ? (
            <code>{event.url}</code>
          ) : (
            <>
              <a className="link" href={url} target="_blank" rel="noopener noreferrer">
                {providers.openAuthPage}
              </a>{" "}
              <code>{url}</code>
            </>
          )}
        </>
      );
    }
    case "device_code": {
      const verificationUrl = safeUrl(event.verificationUri);
      return (
        <>
          {providers.deviceCode} <code>{event.userCode}</code>
          {providers.deviceCodeAt}
          {verificationUrl === undefined ? (
            <code>{event.verificationUri}</code>
          ) : (
            <a className="link" href={verificationUrl} target="_blank" rel="noopener noreferrer">
              {event.verificationUri}
            </a>
          )}
          {providers.deviceCodeEnter}
          {event.expiresInSeconds !== undefined
            ? providers.deviceCodeExpiry(Math.round(event.expiresInSeconds / 60))
            : ""}
        </>
      );
    }
    case "progress":
      return <>{text(event.messageLocalized ?? event.message)}</>;
  }
}

function CustomEditor({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: CustomDraft;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: CustomDraft) => void;
}): ReactNode {
  const { messages } = useI18n();
  const [draft, setDraft] = useState<CustomDraft>(initial);
  const editing = initial.id.length > 0;

  const updateModel = (index: number, patch: Partial<ModelRow>): void => {
    setDraft({
      ...draft,
      models: draft.models.map((model, position) => (position === index ? { ...model, ...patch } : model)),
    });
  };

  return (
    <div className="editor">
      <h4>{editing ? messages.providers.editCustomTitle(initial.id) : messages.providers.addCustom}</h4>
      <div className="row">
        <label>
          Provider id
          <input
            value={draft.id}
            readOnly={editing}
            placeholder={messages.providers.idPlaceholder}
            onChange={(event) => {
              const id = event.target.value;
              setDraft({
                ...draft,
                id,
                apiKeyEnv:
                  draft.authMode === "key" && (draft.apiKeyEnv.length === 0 || draft.apiKeyEnv === defaultKeyEnv(draft.id))
                    ? defaultKeyEnv(id)
                    : draft.apiKeyEnv,
              });
            }}
          />
        </label>
        <label>
          {messages.providers.nameLabel}
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
      </div>
      <label>
        Base URL
        <input
          value={draft.baseUrl}
          placeholder="https://gateway.example.com/v1"
          onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
        />
      </label>
      <div className="row">
        <label>
          {messages.providers.apiLabel}
          <select
            value={draft.api}
            onChange={(event) => setDraft({ ...draft, api: event.target.value as CustomProviderApi })}
          >
            <option value="openai-completions">openai-completions</option>
            <option value="openai-responses">openai-responses</option>
            <option value="anthropic-messages">anthropic-messages</option>
          </select>
        </label>
        <label className="inline">
          <input
            type="radio"
            checked={draft.authMode === "key"}
            onChange={() =>
              setDraft({
                ...draft,
                authMode: "key",
                apiKeyEnv: draft.apiKeyEnv.length > 0 ? draft.apiKeyEnv : defaultKeyEnv(draft.id),
              })
            }
          />
          {messages.providers.authModeKey}
        </label>
        <label className="inline">
          <input
            type="radio"
            checked={draft.authMode === "none"}
            onChange={() => setDraft({ ...draft, authMode: "none" })}
          />
          {messages.providers.authModeNone}
        </label>
      </div>
      {draft.authMode === "key" ? (
        <label>
          {messages.providers.apiKeyEnvLabel}
          <input value={draft.apiKeyEnv} onChange={(event) => setDraft({ ...draft, apiKeyEnv: event.target.value })} />
        </label>
      ) : null}

      <fieldset>
        <legend>{messages.providers.modelsLegend}</legend>
        {draft.models.map((model, index) => (
          <div className="row" key={index}>
            <label>
              model id
              <input value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })} />
            </label>
            <label>
              {messages.providers.nameLabel}
              <input value={model.name} onChange={(event) => updateModel(index, { name: event.target.value })} />
            </label>
            <label>
              contextWindow
              <input
                type="number"
                value={model.contextWindow}
                onChange={(event) => updateModel(index, { contextWindow: event.target.value })}
              />
            </label>
            <label>
              maxTokens
              <input
                type="number"
                value={model.maxTokens}
                onChange={(event) => updateModel(index, { maxTokens: event.target.value })}
              />
            </label>
            <label className="inline">
              <input
                type="checkbox"
                checked={model.reasoning}
                onChange={(event) => updateModel(index, { reasoning: event.target.checked })}
              />
              reasoning
            </label>
            <label className="inline">
              <input
                type="checkbox"
                checked={model.inputText}
                onChange={(event) => updateModel(index, { inputText: event.target.checked })}
              />
              text
            </label>
            <label className="inline">
              <input
                type="checkbox"
                checked={model.inputImage}
                onChange={(event) => updateModel(index, { inputImage: event.target.checked })}
              />
              image
            </label>
            <button
              type="button"
              className="danger"
              disabled={draft.models.length <= 1}
              onClick={() => setDraft({ ...draft, models: draft.models.filter((_, position) => position !== index) })}
            >
              {messages.common.remove}
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setDraft({ ...draft, models: [...draft.models, blankModelRow()] })}>
          {messages.providers.addModel}
        </button>
      </fieldset>

      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => onSave(draft)}>
          {busy ? messages.common.saving : messages.providers.saveConfig}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {messages.common.cancel}
        </button>
      </div>
    </div>
  );
}
