/**
 * Persistent provider credentials and custom provider configuration.
 *
 * Provider/credential configuration is read before the harness opens, because
 * the pi-ai model collection must exist before the harness does. It therefore
 * lives in one local file rather than in a durable document:
 *
 *  - `credentials.json` (mode 0600): environment values injected into
 *    `process.env` before pi-ai resolves provider auth, the native Pi
 *    credential store contents (`auth`), the dynamic model catalog cache
 *    (`catalogs`), a stable installation id (`deviceId`), and the custom
 *    OpenAI/Anthropic-compatible endpoints Emit registers at boot.
 *
 * The native credential store is the single source of truth for provider
 * authentication. Pi calls into `EmitCredentialStore` for reads, writes, and
 * OAuth refreshes, so a token rotated by a request is persisted here and never
 * duplicated by Emit. Values are never sent to the browser.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  ModelsStore,
  ModelsStoreEntry,
} from "@earendil-works/pi-ai";
import type { CustomProviderConfigDTO } from "../shared/contracts.ts";

export type CredentialsFile = {
  /** Environment variables injected into the process before pi-ai resolves auth. */
  env: Record<string, string>;
  /** Custom providers registered at boot. */
  providers: CustomProviderConfigDTO[];
  /** Saved native credentials, keyed by provider id. */
  auth: Record<string, Credential>;
  /** Persisted dynamic model catalogs, keyed by provider id. */
  catalogs: Record<string, ModelsStoreEntry>;
  /** Stable installation id, sent to providers that ask for one (OpenAI). */
  deviceId: string;
};

const EMPTY: CredentialsFile = { env: {}, providers: [], auth: {}, catalogs: {}, deviceId: "" };

/** Read the credentials file, tolerating a missing file but not a malformed one. */
export function readCredentials(dataDir: string): CredentialsFile {
  const path = join(dataDir, "credentials.json");
  if (!existsSync(path)) return structuredClone(EMPTY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read credentials file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Credentials file ${path} must be an object`);
  }
  const record = parsed as Partial<CredentialsFile>;
  return {
    env: isStringRecord(record.env) ? record.env : {},
    providers: Array.isArray(record.providers) ? (record.providers as CustomProviderConfigDTO[]) : [],
    auth:
      typeof record.auth === "object" && record.auth !== null && !Array.isArray(record.auth)
        ? (record.auth as Record<string, Credential>)
        : {},
    catalogs:
      typeof record.catalogs === "object" && record.catalogs !== null && !Array.isArray(record.catalogs)
        ? (record.catalogs as Record<string, ModelsStoreEntry>)
        : {},
    deviceId: typeof record.deviceId === "string" ? record.deviceId : "",
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/** Write atomically with owner-only permissions. */
export function writeCredentials(dataDir: string, value: CredentialsFile): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "credentials.json");
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/**
 * Inject stored environment values into `process.env`. Values already present
 * in the environment win, so a shell export always overrides the file.
 */
export function applyCredentialsToEnv(credentials: CredentialsFile): void {
  for (const [name, value] of Object.entries(credentials.env)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

/**
 * Emit's implementation of the native Pi credential store.
 *
 * Every mutation (credential write/delete, model-catalog cache write, custom
 * provider replacement) goes through one file-level promise chain, so a write
 * always sees the latest committed state and the file never interleaves
 * partial updates. In-memory state is only advanced after the file write
 * succeeds, so a failed write never publishes a phantom credential.
 *
 * The data directory is already protected by an exclusive process lock, so
 * this store does not need cross-process locking of its own.
 */
export class EmitCredentialStore implements CredentialStore {
  readonly deviceId: string;
  readonly modelsStore: ModelsStore;
  readonly #dataDir: string;
  #file: CredentialsFile;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(dataDir: string, file: CredentialsFile) {
    this.#dataDir = dataDir;
    this.#file = file;
    this.deviceId = file.deviceId;
    this.modelsStore = {
      read: async (providerId) => this.#readCatalog(providerId),
      write: async (providerId, entry) => this.#writeCatalog(providerId, entry),
      delete: async (providerId) => this.#deleteCatalog(providerId),
    };
  }

  /**
   * Open the store for one data directory.
   *
   * A new installation gets a generated device id persisted before the store
   * is published, so every later call returns the same id.
   */
  static async open(dataDir: string): Promise<EmitCredentialStore> {
    const file = readCredentials(dataDir);
    if (file.deviceId.length === 0) {
      file.deviceId = randomUUID();
      writeCredentials(dataDir, file);
    }
    return new EmitCredentialStore(dataDir, file);
  }

  /** Isolated copy of the committed configuration. */
  configuration(): CredentialsFile {
    return structuredClone(this.#file);
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    const credential = this.#file.auth[providerId];
    return credential === undefined ? undefined : structuredClone(credential);
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.#file.auth).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#enqueue(async () => {
      options?.signal?.throwIfAborted();
      const current = this.#file.auth[providerId];
      const next = await fn(current === undefined ? undefined : structuredClone(current));
      if (next === undefined) {
        return current === undefined ? undefined : structuredClone(current);
      }
      // A queued operation that was cancelled before it started must not write;
      // the check above covers that. Once `fn` has run the caller has begun its
      // mutation, so the write proceeds even if the signal aborts mid-flight.
      this.#commit((file) => {
        file.auth[providerId] = next;
      });
      return structuredClone(next);
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.#enqueue(async () => {
      options?.signal?.throwIfAborted();
      if (!Object.hasOwn(this.#file.auth, providerId)) return;
      this.#commit((file) => {
        delete file.auth[providerId];
      });
    });
  }

  /**
   * Replace the custom provider list atomically.
   *
   * Removed providers lose their saved credential and dynamic catalog cache,
   * otherwise a provider deleted from the settings could keep resolving
   * through a stale credential. A provider switched from keyed to keyless also
   * loses its credential, because the key no longer belongs to any flow.
   */
  async replaceProviders(providers: readonly CustomProviderConfigDTO[]): Promise<void> {
    await this.#enqueue(async () => {
      const next = providers.map((provider) => structuredClone(provider));
      this.#commit((file) => {
        const previous = new Map(file.providers.map((provider) => [provider.id, provider]));
        const nextIds = new Set(next.map((provider) => provider.id));
        for (const [id, provider] of previous) {
          if (!nextIds.has(id)) {
            delete file.auth[id];
            delete file.catalogs[id];
            continue;
          }
          const replacement = next.find((entry) => entry.id === id);
          if (provider.apiKeyEnv.length > 0 && replacement?.apiKeyEnv.length === 0) {
            delete file.auth[id];
          }
        }
        file.providers = next;
      });
    });
  }

  /** Serialize one task behind the file chain; a failure does not block later tasks. */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Apply a change and persist it; memory advances only after the write succeeds. */
  #commit<T>(change: (file: CredentialsFile) => T): T {
    const next = structuredClone(this.#file);
    const result = change(next);
    writeCredentials(this.#dataDir, next);
    this.#file = next;
    return result;
  }

  async #readCatalog(providerId: string): Promise<ModelsStoreEntry | undefined> {
    const entry = this.#file.catalogs[providerId];
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async #writeCatalog(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await this.#enqueue(async () => {
      this.#commit((file) => {
        file.catalogs[providerId] = structuredClone(entry as ModelsStoreEntry);
      });
    });
  }

  async #deleteCatalog(providerId: string): Promise<void> {
    await this.#enqueue(async () => {
      if (!Object.hasOwn(this.#file.catalogs, providerId)) return;
      this.#commit((file) => {
        delete file.catalogs[providerId];
      });
    });
  }
}
