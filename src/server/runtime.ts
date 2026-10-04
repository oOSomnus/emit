/**
 * Process lifecycle for Emit: one data directory, one SQLite storage, one
 * harness, one in-process event bus.
 *
 * Emit is a single-user local application, and Pi Durable gives one process
 * exclusive ownership of a storage. A lock file therefore guards the data
 * directory so a second server refuses to start instead of corrupting or
 * fighting over the same database.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Draft } from "@earendil-works/chord/delta";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  Harness,
  createRegistry,
  type ConversationDocToken,
  type ConversationId,
  type Cursor,
  type JsonObject,
  type Registry,
  type SessionDocFamilyToken,
  type SessionDocToken,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import lockfile from "proper-lockfile";
import type { CustomProviderConfigDTO, ServerEvent } from "../shared/contracts.ts";
import { ModelCatalog } from "./models.ts";
import { createCustomProviders, normalizeCustomProviders } from "./providers.ts";
import { ProviderAuthSessions } from "./provider-auth.ts";
import { applyCredentialsToEnv, EmitCredentialStore, type CredentialsFile } from "./credentials.ts";

export type EmitRuntimeOptions = {
  dataDir: string;
};

export class EmitRuntime {
  readonly dataDir: string;
  readonly ctx: Context = BACKGROUND_CONTEXT;
  readonly catalog: ModelCatalog;
  readonly credentialStore: EmitCredentialStore;
  readonly providerAuth: ProviderAuthSessions;
  readonly registry: Registry;
  readonly harness: Harness;
  readonly storage: Storage;
  readonly storagePath: string;

  #releaseLock: () => Promise<void>;
  #listeners = new Set<(event: ServerEvent) => void>();
  #closed = false;

  private constructor(init: {
    dataDir: string;
    catalog: ModelCatalog;
    credentialStore: EmitCredentialStore;
    providerAuth: ProviderAuthSessions;
    registry: Registry;
    harness: Harness;
    storage: Storage;
    storagePath: string;
    releaseLock: () => Promise<void>;
  }) {
    this.dataDir = init.dataDir;
    this.catalog = init.catalog;
    this.credentialStore = init.credentialStore;
    this.providerAuth = init.providerAuth;
    this.registry = init.registry;
    this.harness = init.harness;
    this.storage = init.storage;
    this.storagePath = init.storagePath;
    this.#releaseLock = init.releaseLock;
  }

  /** The committed configuration, read fresh so a token refresh is never masked. */
  get credentials(): CredentialsFile {
    return this.credentialStore.configuration();
  }

  static async open(options: EmitRuntimeOptions): Promise<EmitRuntime> {
    const { dataDir } = options;
    mkdirSync(dataDir, { recursive: true });

    // The lock file must exist before proper-lockfile can lock it.
    const lockPath = join(dataDir, "emit.lock");
    mkdirSync(lockPath, { recursive: true });
    let releaseLock: () => Promise<void>;
    try {
      releaseLock = await lockfile.lock(lockPath, {
        // A killed process leaves its lock behind. It is refreshed every five
        // seconds while the owner lives, so a lock older than fifteen seconds
        // is stale and the retry loop below takes it over; a live second
        // process keeps refreshing and is reported instead.
        stale: 15_000,
        update: 5_000,
        realpath: false,
        retries: { retries: 24, factor: 1, minTimeout: 800, maxTimeout: 800 },
      });
    } catch (error) {
      throw new Error(
        `数据目录已被另一个 Emit 进程占用（${lockPath}）。请先停止它；如果确认没有其他 Emit 在运行` +
          `（例如上次是被强制结束的），删除该目录后重试。${error instanceof Error ? ` (${error.message})` : ""}`,
      );
    }

    const credentialStore = await EmitCredentialStore.open(dataDir);
    const configuration = credentialStore.configuration();
    applyCredentialsToEnv(configuration);
    const catalog = new ModelCatalog(configuration.providers, {
      credentials: credentialStore,
      modelsStore: credentialStore.modelsStore,
    });
    // Restore any persisted dynamic catalog before the harness can resolve a
    // model, without reaching the network during startup.
    await catalog.refresh({ allowNetwork: false });
    const providerAuth = new ProviderAuthSessions(
      catalog.models,
      () => credentialStore.deviceId,
      (providerId, signal) => catalog.refresh({ allowNetwork: true, providers: [providerId], signal }),
    );

    const storagePath = join(dataDir, "emit.sqlite");
    const storage = await openNodeSqliteStorage(storagePath);
    const registry = createRegistry();
    const harness = await Harness.open(
      storage,
      {
        models: catalog.models,
        registry,
        // Conversations select their extensions explicitly; a conversation
        // with no selection must not inherit every installed extension.
        settings: { extensions: [] },
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd !== undefined && cwd.length > 0 ? cwd : process.cwd() }),
      },
      BACKGROUND_CONTEXT,
    );
    return new EmitRuntime({
      dataDir,
      catalog,
      credentialStore,
      providerAuth,
      registry,
      harness,
      storage,
      storagePath,
      releaseLock,
    });
  }

  /**
   * Enable task scheduling. Called after the application has installed the
   * extensions that already-existing conversations select by name, because a
   * resumed run resolves its tools before it can make any progress.
   */
  resume(): void {
    this.harness.resume();
  }

  /** Replace the custom provider list, in the file and on the live collection. */
  async storeCustomProviders(providers: unknown): Promise<CredentialsFile> {
    // Validate and build before writing anything: a rejected submission must
    // leave both the file and the live collection untouched.
    const normalized = normalizeCustomProviders(providers, this.catalog.builtinProviderIds);
    const prepared = createCustomProviders(normalized);

    // A provider that is disappearing, or whose auth method changes, must not
    // have a login still in flight: a late commit could write a credential for
    // a provider that no longer exists, or one that no longer uses a key.
    const previous = new Map(this.credentials.providers.map((provider) => [provider.id, provider]));
    const affected = new Set<string>();
    for (const [id, provider] of previous) {
      const replacement = normalized.find((entry) => entry.id === id);
      if (replacement === undefined || (provider.apiKeyEnv.length > 0 && replacement.apiKeyEnv.length === 0)) {
        affected.add(id);
      }
    }
    for (const id of affected) await this.providerAuth.cancelProvider(id);

    await this.credentialStore.replaceProviders(normalized);
    this.catalog.applyCustomProviders(prepared);
    return this.credentials;
  }

  /** The committed custom provider list. */
  customProviders(): CustomProviderConfigDTO[] {
    return this.credentials.providers;
  }

  /** Subscribe to server-pushed events; returns the unsubscribe handle. */
  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken SSE client must not break the mutation that emitted the event.
      }
    }
  }

  /** Read one session-scoped singleton document. */
  async readSession<T extends JsonObject>(token: SessionDocToken<T>): Promise<T> {
    const value = await this.harness.snapshot(token, this.ctx);
    // snapshot resolves the definition's `initial()` for an absent document.
    return (value ?? (token.definition.initial() as T)) as T;
  }

  /** Mutate one session-scoped singleton document atomically. */
  async updateSession<T extends JsonObject>(
    token: SessionDocToken<T>,
    change: (draft: Draft<T>) => void,
  ): Promise<T> {
    return (await this.harness.commit(async (tx: Tx) => {
      const draft = await tx.doc(token);
      change(draft);
      return snapshotJson(draft) as T;
    }, this.ctx)) as T;
  }

  /** Read one session-scoped family member. */
  async readFamily<T extends JsonObject, I extends JsonValue>(
    token: SessionDocFamilyToken<T, I>,
    key: string,
    seed: I,
  ): Promise<T | undefined> {
    const value = await this.harness.snapshot(token, key, this.ctx);
    return (value ?? undefined) as T | undefined;
  }

  /** Mutate or create one session-scoped family member atomically. */
  async updateFamily<T extends JsonObject, I extends JsonValue>(
    token: SessionDocFamilyToken<T, I>,
    key: string,
    seed: I,
    change: (draft: Draft<T>) => void,
  ): Promise<T> {
    return (await this.harness.commit(async (tx: Tx) => {
      const draft = await tx.doc(token, key, seed);
      change(draft);
      return snapshotJson(draft) as T;
    }, this.ctx)) as T;
  }

  /** Read one conversation-scoped document. */
  async readConversationDoc<T extends JsonObject>(
    token: ConversationDocToken<T>,
    conversationId: number,
  ): Promise<T | undefined> {
    const value = await this.harness.snapshot(token, conversationId as ConversationId, this.ctx);
    return (value ?? undefined) as T | undefined;
  }

  /**
   * Every live member of one session-scoped family, in creation order.
   *
   * Pi Durable exposes document scanning on the storage, not on the session, so
   * Emit keeps the storage handle it opened. Values are materialized at the
   * current point, which is exactly what an index would have provided: a
   * record missing a required field of its definition is skipped.
   */
  async listFamily<T extends JsonObject, I extends JsonValue>(
    token: SessionDocFamilyToken<T, I>,
    seed: (key: string) => I,
  ): Promise<{ key: string; value: T }[]> {
    const records: { key: string; value: T }[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await this.storage.scanDocuments(
        { scope: { kind: "session" }, at: "current", kind: token.definition.kind },
        200,
        cursor,
        this.ctx,
      );
      for (const record of page.items) {
        if (record.key === undefined) continue;
        const stored = await this.storage.document(record.id, "current", this.ctx);
        if (stored === undefined) continue;
        const value = materialize<T>(stored.value, seed(record.key));
        if (value !== undefined) records.push({ key: record.key, value });
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return records;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      // A login owned by the harness's model collection must finish before the
      // store it writes to goes away.
      await this.providerAuth.close();
      await this.harness.close(this.ctx);
    } finally {
      await this.#releaseLock().catch(() => undefined);
    }
  }
}

/**
 * Deep copy of one document draft.
 *
 * A chord draft is a live handle with non-cloneable internals, so
 * `structuredClone` throws on it. Documents are JSON by contract, so a JSON
 * round trip is the exact copy the callers want.
 */
function snapshotJson<T extends JsonObject>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Validate a materialized stored value against a family definition's initial shape. */
function materialize<T extends JsonObject>(value: JsonObject, empty: JsonValue): T | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof empty !== "object" || empty === null) return value as T;
  for (const field of Object.keys(empty)) {
    if (!(field in value)) return undefined;
  }
  return value as T;
}
