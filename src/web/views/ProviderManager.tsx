/**
 * Visual provider and model management.
 *
 * Every provider Pi knows is listed from native metadata; the browser never
 * hard-codes a vendor list. Authentication always runs through Pi's own login
 * flow, bridged to the page as a prompt-and-event session. Custom endpoints add
 * OpenAI/Anthropic-compatible servers Pi does not ship.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api.ts";
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

/** Configurations that still reference a provider's models. */
function providerReferences(state: State, providerId: string): string[] {
  const references: string[] = [];
  const defaultModel = state.app?.defaultExecutionModel;
  if (defaultModel !== null && defaultModel !== undefined && defaultModel.model.providerId === providerId) {
    references.push(`默认模型：${defaultModel.model.modelId}`);
  }
  const approval = state.app?.approval;
  if (approval !== null && approval !== undefined && approval.model.providerId === providerId) {
    references.push(`审批判断模型：${approval.model.modelId}`);
  }
  for (const employee of state.employees) {
    if (employee.executionModel.model.providerId === providerId) {
      references.push(`员工 ${employee.name}：${employee.executionModel.model.modelId}`);
    }
  }
  return references;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

const STATUS_LABELS: Record<AuthSessionDTO["status"], string> = {
  running: "进行中",
  waiting: "等待输入",
  succeeded: "已保存",
  failed: "失败",
  cancelled: "已取消",
};

export function ProviderManager(): ReactNode {
  const { state, refreshModels, setError } = useApp();
  const [search, setSearch] = useState("");
  const [configuredOnly, setConfiguredOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [session, setSession] = useState<AuthSessionDTO | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(
    () => sessionStorage.getItem(SESSION_KEY) ?? undefined,
  );
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState<string | undefined>(undefined);
  const [providerMessage, setProviderMessage] = useState<{ tone: "ok" | "error"; text: string } | undefined>(
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
        setAuthError(message(error));
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
      setAuthError(message(error));
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
      setAuthError(message(error));
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
      setAuthError(message(error));
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
      setProviderMessage({ tone: "ok", text: "已移除保存的凭据" });
    } catch (error) {
      setProviderMessage({ tone: "error", text: message(error) });
    } finally {
      setBusy(false);
    }
  };

  const refreshCatalog = async (providerId: string): Promise<void> => {
    setBusy(true);
    setProviderMessage(undefined);
    try {
      const result = await api.refreshProvider(providerId);
      setProviderMessage({ tone: result.ok ? "ok" : "error", text: result.message });
      await refreshModels();
    } catch (error) {
      setProviderMessage({ tone: "error", text: message(error) });
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
        text: draft.authMode === "key" ? "配置已保存，已保存的 API Key 保持不变" : "配置已保存（无需凭据）",
      });
    } catch (error) {
      setProviderMessage({ tone: "error", text: message(error) });
    } finally {
      setBusy(false);
    }
  };

  const deleteCustom = async (providerId: string): Promise<void> => {
    const references = providerReferences(state, providerId);
    const note =
      references.length > 0
        ? `\n\n以下配置仍引用它，删除后这些模型将不可用（引用不会被改写）：\n${references.join("\n")}`
        : "";
    if (!window.confirm(`确定删除自定义接口 ${providerId}？${note}`)) return;
    setBusy(true);
    setProviderMessage(undefined);
    try {
      await api.setCustomProviders(state.customProviders.filter((provider) => provider.id !== providerId));
      await refreshModels();
      setEditor(undefined);
      setSelectedId(undefined);
    } catch (error) {
      setProviderMessage({ tone: "error", text: message(error) });
    } finally {
      setBusy(false);
    }
  };

  const sessionProvider = session === undefined ? undefined : state.providers.find(
    (provider) => provider.providerId === session.providerId,
  );
  const sessionActive = session !== undefined && (session.status === "running" || session.status === "waiting");

  return (
    <fieldset className="provider-manager">
      <legend>模型 Provider</legend>
      <p className="hint">
        这里列出 Pi 原生的全部 {state.providers.length} 个 Provider。认证只保存在本机数据目录；
        「已配置认证」只表示凭据就绪，不代表连接已验证——用模型旁的「检查连接」实际验证。
      </p>

      <div className="row">
        <input
          type="search"
          value={search}
          placeholder="搜索 Provider…"
          aria-label="搜索 Provider"
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="inline">
          <input
            type="checkbox"
            checked={configuredOnly}
            onChange={(event) => setConfiguredOnly(event.target.checked)}
          />
          只看已配置
        </label>
        <button type="button" onClick={() => setEditor(emptyDraft())}>
          添加自定义接口
        </button>
      </div>

      {sessionActive && sessionProvider !== undefined && sessionProvider.providerId !== selectedProviderId ? (
        <div className="banner warn">
          <span>有进行中的认证会话：{sessionProvider.name}</span>
          <button type="button" onClick={() => setSelectedId(sessionProvider.providerId)}>
            查看
          </button>
        </div>
      ) : null}

      <div className="provider-manager-body">
        <ul className="plain provider-list">
          {listed.map((provider) => (
            <li key={provider.providerId}>
              <button
                type="button"
                className={provider.providerId === selectedProviderId ? "provider-item active" : "provider-item"}
                onClick={() => {
                  setSelectedId(provider.providerId);
                  setProviderMessage(undefined);
                }}
              >
                <span>
                  {provider.name} <code>{provider.providerId}</code>
                </span>
                <span className="tags">
                  {provider.custom ? <Chip tone="info">自定义</Chip> : null}
                  {provider.configured ? (
                    <Chip tone="ok">{provider.authSource ?? "已配置"}</Chip>
                  ) : (
                    <Chip tone="muted">未配置</Chip>
                  )}
                  {provider.storedAuthType !== null ? (
                    <Chip tone="info">{provider.storedAuthType === "oauth" ? "OAuth" : "API Key"}</Chip>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
          {listed.length === 0 ? <li className="hint">没有匹配的 Provider。</li> : null}
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
          <p className="hint">选择左侧的 Provider 查看详情。</p>
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
  message: { tone: "ok" | "error"; text: string } | undefined;
  authError: string | undefined;
  session: AuthSessionDTO | undefined;
  onStart: (type: "api_key" | "oauth") => void;
  onLogout: () => void;
  onRefresh: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRespond: (value: string) => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <section className="editor provider-detail">
      <h3>
        {provider.name} <code>{provider.providerId}</code>
      </h3>
      <p className="hint">
        凭据来源：{provider.configured ? provider.authSource ?? "已配置" : "未配置"} · 已保存认证：
        {provider.storedAuthType === null ? "无" : provider.storedAuthType === "oauth" ? "OAuth" : "API Key"}
      </p>
      {provider.authError !== null ? <p className="error-text">认证检查错误：{provider.authError}</p> : null}

      <div className="row">
        {provider.authMethods
          .filter((method) => method.interactive)
          .map((method) => (
            <button key={method.type} type="button" disabled={busy} onClick={() => onStart(method.type)}>
              {method.type === "oauth"
                ? method.subscription
                  ? `订阅登录：${method.label}`
                  : `登录：${method.label}`
                : `设置 ${method.label}`}
            </button>
          ))}
        {provider.storedAuthType !== null ? (
          <button type="button" className="danger" disabled={busy} onClick={onLogout}>
            移除已保存凭据
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={onRefresh}>
          刷新模型目录
        </button>
        {provider.custom ? (
          <>
            <button type="button" disabled={busy} onClick={onEdit}>
              编辑配置
            </button>
            <button type="button" className="danger" disabled={busy} onClick={onDelete}>
              删除接口
            </button>
          </>
        ) : null}
      </div>

      {providerMessage !== undefined ? (
        <p className={providerMessage.tone === "ok" ? "hint" : "error-text"}>{providerMessage.text}</p>
      ) : null}
      {authError !== undefined ? <p className="error-text">认证交互错误：{authError}</p> : null}

      {session !== undefined ? (
        <AuthSessionPanel session={session} busy={busy} onRespond={onRespond} onCancel={onCancel} />
      ) : null}

      <h4>模型（{models.length}）</h4>
      <ul className="plain">
        {models.map((model) => (
          <li key={`${model.kind}|${model.modelId}`}>
            <code>{model.modelId}</code> {model.name} <Chip tone="muted">{model.kind}</Chip>{" "}
            <span className="hint">上下文 {model.contextWindow}</span>{" "}
            {model.configured ? <Chip tone="ok">可用</Chip> : <Chip tone="muted">当前凭据不可用</Chip>}
          </li>
        ))}
        {models.length === 0 ? <li className="hint">该 Provider 没有可浏览的对话或分类模型。</li> : null}
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
  const [value, setValue] = useState("");
  const promptId = session.prompt?.id;
  useEffect(() => {
    setValue("");
  }, [promptId]);

  const prompt = session.prompt;
  return (
    <div className="auth-session">
      <p className="hint">
        认证状态：{STATUS_LABELS[session.status]}
        {session.message !== null ? ` · ${session.message}` : ""}
      </p>
      {session.events.length > 0 ? (
        <ul className="plain">
          {session.events.map((event, index) => (
            <li key={index}>{renderAuthEvent(event)}</li>
          ))}
        </ul>
      ) : null}
      {prompt !== null ? (
        <div>
          <p className="hint">{prompt.message}</p>
          {prompt.type === "select" ? (
            <div className="row">
              {prompt.options?.map((option) => (
                <button key={option.id} type="button" disabled={busy} onClick={() => onRespond(option.id)}>
                  {option.label}
                  {option.description !== undefined ? <span className="hint"> {option.description}</span> : null}
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
                aria-label={prompt.message}
                onChange={(event) => setValue(event.target.value)}
              />
              <button type="submit" disabled={busy || (prompt.type === "secret" && value.length === 0)}>
                提交
              </button>
            </form>
          )}
        </div>
      ) : null}
      {session.status === "running" || session.status === "waiting" ? (
        <button type="button" className="danger" disabled={busy} onClick={onCancel}>
          取消认证
        </button>
      ) : null}
    </div>
  );
}

function renderAuthEvent(event: AuthEventDTO): ReactNode {
  switch (event.type) {
    case "info":
      return (
        <>
          {event.message}
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
                打开授权页面
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
          设备码 <code>{event.userCode}</code>，在{" "}
          {verificationUrl === undefined ? (
            <code>{event.verificationUri}</code>
          ) : (
            <a className="link" href={verificationUrl} target="_blank" rel="noopener noreferrer">
              {event.verificationUri}
            </a>
          )}{" "}
          输入
          {event.expiresInSeconds !== undefined ? `（${Math.round(event.expiresInSeconds / 60)} 分钟内有效）` : ""}
        </>
      );
    }
    case "progress":
      return <>{event.message}</>;
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
      <h4>{editing ? `编辑自定义接口 ${initial.id}` : "添加自定义接口"}</h4>
      <div className="row">
        <label>
          Provider id
          <input
            value={draft.id}
            readOnly={editing}
            placeholder="例如 my-gateway"
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
          名称
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
          接口协议
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
          需要 API Key
        </label>
        <label className="inline">
          <input
            type="radio"
            checked={draft.authMode === "none"}
            onChange={() => setDraft({ ...draft, authMode: "none" })}
          />
          无需凭据
        </label>
      </div>
      {draft.authMode === "key" ? (
        <label>
          环境变量名（高级，可留默认）
          <input value={draft.apiKeyEnv} onChange={(event) => setDraft({ ...draft, apiKeyEnv: event.target.value })} />
        </label>
      ) : null}

      <fieldset>
        <legend>模型</legend>
        {draft.models.map((model, index) => (
          <div className="row" key={index}>
            <label>
              model id
              <input value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })} />
            </label>
            <label>
              名称
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
              移除
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setDraft({ ...draft, models: [...draft.models, blankModelRow()] })}>
          添加模型
        </button>
      </fieldset>

      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => onSave(draft)}>
          {busy ? "保存中…" : "保存配置"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
