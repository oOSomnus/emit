/**
 * Bridges native Pi login flows onto the Emit HTTP surface.
 *
 * Pi owns every provider's login: API keys, OAuth device codes, callback
 * servers, cloud profiles, and the extra prompts some providers need. This
 * module does not reimplement any of it. It runs `Models.login`, exposes each
 * native prompt and event to the browser as a serializable session, and feeds
 * the answer back. Cancellation, commit timing, and credential persistence stay
 * exactly as Pi defines them.
 */

import { randomUUID } from "node:crypto";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Models,
  ModelsRefreshResult,
} from "@earendil-works/pi-ai";
import type {
  AuthEventDTO,
  AuthPromptDTO,
  AuthSessionDTO,
  AuthSessionStatusDTO,
} from "../shared/contracts.ts";
import type { LocalizedText } from "../shared/i18n.ts";
import { AppError, fromError, type AppText } from "./messages.ts";
import { authMessages } from "./messages/auth.ts";

/** A select option that may carry app-authored translations beside its fields. */
export type LocalizedAuthOption = {
  id: string;
  label: string;
  description?: string;
  labelLocalized?: LocalizedText;
  descriptionLocalized?: LocalizedText;
};

/**
 * A native login prompt widened with app-authored translations.
 *
 * Application login flows (the built-in Azure endpoint questions) build
 * prompts of this type; native provider prompts arrive without the optional
 * fields and are copied exactly as they are. The SDK type is untouched.
 */
export type LocalizedAuthPrompt =
  | (Extract<AuthPrompt, { type: "text" | "secret" | "manual_code" }> & { messageLocalized?: LocalizedText })
  | (Omit<Extract<AuthPrompt, { type: "select" }>, "options"> & {
      messageLocalized?: LocalizedText;
      options: readonly LocalizedAuthOption[];
    });

/** A native login event widened with an app-authored message translation. */
export type LocalizedAuthEvent = AuthEvent & { messageLocalized?: LocalizedText };

const MAX_EVENTS = 32;
/** A login left open for half an hour is abandoned, not still in progress. */
const SESSION_TTL_MS = 30 * 60_000;
/** A finished session stays readable briefly so the UI can show its outcome. */
const TERMINAL_TTL_MS = 5 * 60_000;

/** An auth error carrying the HTTP status the API must answer with. */
export class ProviderAuthError extends AppError {
  readonly status: number;
  constructor(status: number, message: AppText) {
    super(message);
    this.status = status;
  }
}

type PendingPrompt = {
  id: string;
  type: AuthPrompt["type"];
  message: string;
  /** Present when the prompt text is application-authored. */
  messageLocalized?: LocalizedText;
  placeholder: string | undefined;
  options:
    | {
        id: string;
        label: string;
        description?: string;
        labelLocalized?: LocalizedText;
        descriptionLocalized?: LocalizedText;
      }[]
    | undefined;
  optionIds: string[] | undefined;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
  release: () => void;
};

type Session = {
  id: string;
  providerId: string;
  authType: AuthType;
  status: AuthSessionStatusDTO;
  prompt: PendingPrompt | null;
  events: AuthEventDTO[];
  message: string | null;
  /** Present when the terminal message is application-authored. */
  messageLocalized?: LocalizedText;
  controller: AbortController;
  task: Promise<void>;
  expiry: NodeJS.Timeout;
  discard: NodeJS.Timeout | undefined;
};

export class ProviderAuthSessions {
  readonly #models: Models;
  readonly #getDeviceId: () => string;
  readonly #refresh: (providerId: string, signal: AbortSignal) => Promise<ModelsRefreshResult>;
  readonly #sessions = new Map<string, Session>();
  #closed = false;

  constructor(
    models: Models,
    getDeviceId: () => string,
    refresh: (providerId: string, signal: AbortSignal) => Promise<ModelsRefreshResult>,
  ) {
    this.#models = models;
    this.#getDeviceId = getDeviceId;
    this.#refresh = refresh;
  }

  /** Begin one native login. Only a single login may be in flight at a time. */
  start(providerId: string, type: AuthType): AuthSessionDTO {
    if (this.#closed) throw new ProviderAuthError(500, authMessages.serverClosing());
    const provider = this.#models.getProvider(providerId);
    if (provider === undefined) throw new ProviderAuthError(404, authMessages.providerMissing(providerId));
    const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
    if (method?.login === undefined) {
      throw new ProviderAuthError(400, authMessages.loginUnsupported(provider.name, type));
    }
    if (this.#activeSession() !== undefined) {
      throw new ProviderAuthError(409, authMessages.sessionActive());
    }

    const id = randomUUID();
    const controller = new AbortController();
    const session: Session = {
      id,
      providerId,
      authType: type,
      status: "running",
      prompt: null,
      events: [],
      message: null,
      controller,
      task: Promise.resolve(),
      expiry: setTimeout(() => void this.cancel(id).catch(() => undefined), SESSION_TTL_MS),
      discard: undefined,
    };
    this.#sessions.set(id, session);
    session.task = this.#run(session);
    return this.#snapshot(session);
  }

  get(sessionId: string): AuthSessionDTO {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new ProviderAuthError(404, authMessages.sessionMissing());
    return this.#snapshot(session);
  }

  /** Answer the current prompt. Rejects a stale prompt rather than guessing. */
  respond(sessionId: string, promptId: string, value: string): AuthSessionDTO {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new ProviderAuthError(404, authMessages.sessionMissing());
    const pending = session.prompt;
    if (pending === null || pending.id !== promptId) {
      throw new ProviderAuthError(409, authMessages.promptStale());
    }
    if (typeof value !== "string") throw new ProviderAuthError(400, authMessages.answerNotString());
    if (pending.type === "select" && (pending.optionIds === undefined || !pending.optionIds.includes(value))) {
      throw new ProviderAuthError(400, authMessages.optionInvalid());
    }
    if (pending.type === "secret" && value.length === 0) {
      throw new ProviderAuthError(400, authMessages.secretEmpty());
    }
    pending.release();
    session.prompt = null;
    session.status = "running";
    pending.resolve(value);
    return this.#snapshot(session);
  }

  /**
   * Request cancellation and wait for the login to actually settle.
   *
   * Pi may already have started committing a credential when cancellation
   * arrives; in that case the flow still succeeds and the snapshot reports it
   * truthfully, because the credential really was saved.
   */
  async cancel(sessionId: string): Promise<AuthSessionDTO> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new ProviderAuthError(404, authMessages.sessionMissing());
    session.controller.abort(new AppError(authMessages.cancelled()));
    await session.task.catch(() => undefined);
    return this.#snapshot(session);
  }

  /** Cancel and wait for any in-flight login for one provider. */
  async cancelProvider(providerId: string): Promise<void> {
    const active = [...this.#sessions.values()].filter(
      (session) => session.providerId === providerId && isActive(session),
    );
    await Promise.all(active.map((session) => this.cancel(session.id).catch(() => undefined)));
  }

  /** Cancel every login and release its timers; used on shutdown. */
  async close(): Promise<void> {
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) session.controller.abort(new AppError(authMessages.serverClosing()));
    await Promise.all(sessions.map((session) => session.task.catch(() => undefined)));
    for (const session of sessions) {
      clearTimeout(session.expiry);
      clearTimeout(session.discard);
    }
    this.#sessions.clear();
  }

  #activeSession(): Session | undefined {
    return [...this.#sessions.values()].find(isActive);
  }

  async #run(session: Session): Promise<void> {
    const interaction: AuthInteraction = {
      signal: session.controller.signal,
      prompt: (prompt: LocalizedAuthPrompt) => this.#prompt(session, prompt),
      notify: (event: LocalizedAuthEvent) => this.#notify(session, event),
    };
    try {
      await this.#models.login(session.providerId, session.authType, interaction, {
        getDeviceId: this.#getDeviceId,
      });
      this.#settle(session, "succeeded", await this.#refreshNote(session));
    } catch (error) {
      if (session.controller.signal.aborted) this.#settle(session, "cancelled", null);
      else this.#settle(session, "failed", fromError(error));
    }
  }

  async #refreshNote(session: Session): Promise<AppText | null> {
    try {
      const result = await this.#refresh(session.providerId, session.controller.signal);
      if (result.errors.size === 0) return null;
      return authMessages.refreshFailed([...result.errors.values()].map(describeError));
    } catch (error) {
      if (session.controller.signal.aborted) return null;
      return authMessages.refreshFailed([describeError(error)]);
    }
  }

  #prompt(session: Session, prompt: LocalizedAuthPrompt): Promise<string> {
    if (session.controller.signal.aborted || !isActive(session)) {
      return Promise.reject(session.controller.signal.reason ?? new AppError(authMessages.sessionEnded()));
    }
    const id = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    // A native flow can cancel its own prompt when an out-of-band event wins
    // the race (a URL callback beats the manual-code prompt). That is not a
    // session failure: the prompt is withdrawn and the flow continues.
    const onAbort = () => {
      if (session.prompt?.id !== id) return;
      session.prompt = null;
      session.status = "running";
      reject(prompt.signal?.reason ?? new AppError(authMessages.promptCancelledByNativeFlow()));
    };
    prompt.signal?.addEventListener("abort", onAbort, { once: true });
    session.prompt = {
      id,
      type: prompt.type,
      message: prompt.message,
      ...(prompt.messageLocalized !== undefined ? { messageLocalized: prompt.messageLocalized } : {}),
      placeholder: prompt.type === "select" ? undefined : prompt.placeholder,
      options:
        prompt.type === "select"
          ? prompt.options.map((option) => ({
              id: option.id,
              label: option.label,
              ...(option.description !== undefined ? { description: option.description } : {}),
              ...(option.labelLocalized !== undefined ? { labelLocalized: option.labelLocalized } : {}),
              ...(option.descriptionLocalized !== undefined
                ? { descriptionLocalized: option.descriptionLocalized }
                : {}),
            }))
          : undefined,
      optionIds: prompt.type === "select" ? prompt.options.map((option) => option.id) : undefined,
      resolve,
      reject,
      release: () => prompt.signal?.removeEventListener("abort", onAbort),
    };
    session.status = "waiting";
    return promise;
  }

  #notify(session: Session, event: LocalizedAuthEvent): void {
    session.events = [...session.events, toEventDTO(event)].slice(-MAX_EVENTS);
  }

  #settle(session: Session, status: AuthSessionStatusDTO, message: AppText | null): void {
    const pending = session.prompt;
    if (pending !== null) {
      session.prompt = null;
      pending.release();
      pending.reject(new AppError(authMessages.flowEnded()));
    }
    session.status = status;
    session.message = message?.text ?? null;
    session.messageLocalized = message?.localized;
    clearTimeout(session.expiry);
    if (session.discard === undefined) {
      session.discard = setTimeout(() => {
        this.#sessions.delete(session.id);
      }, TERMINAL_TTL_MS);
    }
  }

  #snapshot(session: Session): AuthSessionDTO {
    return {
      id: session.id,
      providerId: session.providerId,
      authType: session.authType,
      status: session.status,
      prompt: session.prompt === null ? null : promptToDTO(session.prompt),
      events: [...session.events],
      message: session.message,
      ...(session.messageLocalized !== undefined ? { messageLocalized: session.messageLocalized } : {}),
    };
  }
}

function isActive(session: Session): boolean {
  return session.status === "running" || session.status === "waiting";
}

function promptToDTO(prompt: PendingPrompt): AuthPromptDTO {
  return {
    id: prompt.id,
    type: prompt.type,
    message: prompt.message,
    ...(prompt.messageLocalized !== undefined ? { messageLocalized: prompt.messageLocalized } : {}),
    ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
    ...(prompt.options !== undefined ? { options: prompt.options } : {}),
  };
}

function toEventDTO(event: LocalizedAuthEvent): AuthEventDTO {
  switch (event.type) {
    case "info":
      return {
        type: "info",
        message: event.message,
        ...(event.messageLocalized !== undefined ? { messageLocalized: event.messageLocalized } : {}),
        ...(event.links !== undefined
          ? { links: event.links.map((link) => ({ url: link.url, ...(link.label !== undefined ? { label: link.label } : {}) })) }
          : {}),
      };
    case "auth_url":
      return {
        type: "auth_url",
        url: event.url,
        ...(event.instructions !== undefined ? { instructions: event.instructions } : {}),
      };
    case "device_code":
      return {
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.intervalSeconds !== undefined ? { intervalSeconds: event.intervalSeconds } : {}),
        ...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
      };
    case "progress":
      return {
        type: "progress",
        message: event.message,
        ...(event.messageLocalized !== undefined ? { messageLocalized: event.messageLocalized } : {}),
      };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
