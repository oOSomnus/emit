import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_KEY_ENV } from "./emit-fixture.ts";
import { startEmitProcess, type EmitProcessFixture } from "./process-fixture.ts";
import { startProviderProcess } from "./provider-process.ts";
import { seedTestWorkspace } from "./workspace-fixture.ts";

export async function createE2eFixture() {
  const root = mkdtempSync(join(tmpdir(), "emit-e2e-"));
  let provider: Awaited<ReturnType<typeof startProviderProcess>> | undefined;
  let emit: EmitProcessFixture | undefined;
  try {
    provider = await startProviderProcess(root);
    emit = await startEmitProcess({ root, dataDir: join(root, "data"),
      imports: ["test/fixtures/opencode-local-fetch.mjs"],
      env: { [FAKE_KEY_ENV]: "local-fixture-key", EMIT_TEST_ALLOWED_ORIGINS: JSON.stringify([provider.url]), OPENCODE_FAKE_URL: `${provider.url}/zen/go` },
    });
    const instance = emit;
    const fake = provider;
    const workspace = await seedTestWorkspace({ url: instance.url, providerBaseUrl: fake.baseUrl, root });
    let closing: Promise<void> | undefined;
    return {
      root, workRoot: join(root, "work"), outsideRoot: join(root, "outside"), provider: fake, emit: instance, workspace,
      async request<T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
        const response = await fetch(new URL(path, instance.url), { method,
          ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
        return { status: response.status, body: await response.json() as T };
      },
      close(): Promise<void> {
        closing ??= (async () => {
          try { await instance.stop(); }
          finally { try { await fake.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
        })();
        return closing;
      },
    };
  } catch (error) {
    try { await emit?.stop(); }
    finally { try { await provider?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
    throw error;
  }
}
export type E2eFixture = Awaited<ReturnType<typeof createE2eFixture>>;
