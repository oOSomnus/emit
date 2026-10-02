/**
 * Process entry point.
 *
 * One process owns the data directory, the SQLite storage, and the harness.
 * Startup order matters: the runtime takes the lock and resumes interrupted
 * runs first, then work left behind by an unclean shutdown is reconciled
 * against what actually resumed, and only then does the HTTP server accept
 * requests.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EmitRuntime } from "./runtime.ts";
import { McpManager } from "./mcp.ts";
import { installAllExtensions, reconcileWorks } from "./work.ts";
import { buildServer } from "./api.ts";
import { invalidateStaleGrants } from "./approval/state.ts";
import { attachProgress } from "./progress.ts";
import { readApp } from "./workspace.ts";

type Options = {
  dataDir: string;
  host: string;
  port: number;
  webRoot: string;
};

function parseOptions(argv: readonly string[]): Options {
  let dataDir = process.env.EMIT_DATA_DIR ?? join(homedir(), ".emit");
  let host = process.env.EMIT_HOST ?? "127.0.0.1";
  let port = Number(process.env.EMIT_PORT ?? 8787);
  let webRoot = resolve(import.meta.dirname, "../../dist/web");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--data-dir" && next !== undefined) {
      dataDir = next;
      index += 1;
    } else if (arg === "--host" && next !== undefined) {
      host = next;
      index += 1;
    } else if (arg === "--port" && next !== undefined) {
      port = Number(next);
      index += 1;
    } else if (arg === "--web-root" && next !== undefined) {
      webRoot = resolve(next);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "emit · 本地数字员工协作工作台",
          "",
          "用法: emit [选项]",
          "  --data-dir <目录>   数据目录（默认 ~/.emit）",
          "  --host <地址>       监听地址（默认 127.0.0.1）",
          "  --port <端口>       监听端口（默认 8787）",
          "  --web-root <目录>   前端构建产物目录（默认 dist/web）",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(port) || port <= 0) port = 8787;
  return { dataDir, host, port, webRoot };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const runtime = await EmitRuntime.open({
    dataDir: options.dataDir,
    host: options.host,
    port: options.port,
  });

  const app = await readApp(runtime);
  await invalidateStaleGrants(runtime, app.policyVersion);

  // Order matters: the employee extensions have to be installed before
  // scheduling resumes, because a resumed run resolves its tools immediately,
  // and MCP tools only exist once their servers are connected.
  const mcp = new McpManager(runtime);
  await mcp.connectEnabled().catch((error: unknown) => {
    process.stdout.write(`MCP 连接失败: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  const installed = await installAllExtensions(runtime, mcp);
  process.stdout.write(`已加载 ${installed} 位数字员工。\n`);

  runtime.emit({ type: "notice", text: "正在恢复上次未完成的工作…" });
  runtime.resume();
  const interrupted = await reconcileWorks(runtime);
  if (interrupted > 0) {
    process.stdout.write(`已标记 ${interrupted} 项未能恢复的工作。\n`);
  }

  const detachProgress = attachProgress(runtime);

  const server = await buildServer({ runtime, mcp, webRoot: options.webRoot });
  await server.listen({ host: options.host, port: options.port });
  const address = `http://${options.host}:${options.port}`;
  process.stdout.write(`Emit 已启动：${address}\n数据目录：${runtime.dataDir}\n`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`收到 ${signal}，正在关闭…\n`);
    try {
      detachProgress();
      await server.close();
      await mcp.closeAll();
      await runtime.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await main().catch((error: unknown) => {
  process.stderr.write(`启动失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
