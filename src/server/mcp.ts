/**
 * MCP servers as employee tools.
 *
 * Emit uses the standalone `@earendil-works/pi-mcp` client, not a second agent
 * runtime: every discovered tool is adapted into a durable tool of its own, so
 * it gets the same checkpoint, cancellation, and approval path as a built-in
 * tool.
 *
 * A server's annotations are a claim by that server, not a guarantee. Emit
 * therefore never auto-trusts a tool because of `readOnlyHint`; a human has to
 * mark a tool as trusted read-only before it skips the approval gate.
 */

import { Type } from "@earendil-works/pi-ai";
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { McpServerDTO, McpServerDraftDTO } from "../shared/contracts.ts";
import { McpDoc, type EmployeeRecord, type McpServerRecord } from "./documents.ts";
import type { EmitRuntime } from "./runtime.ts";
import { slugify } from "./workspace.ts";
import { gatedExecute } from "./tools.ts";

const MCP_NAME_LIMIT = 64;

type LiveConnection = {
  signature: string;
  client: McpClient;
  tools: McpTool[];
};

export function toMcpServerDTO(record: McpServerRecord): McpServerDTO {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    target:
      record.transport === "stdio"
        ? [record.command, ...record.args].filter((part) => part.length > 0).join(" ")
        : record.url,
    enabled: record.enabled,
    description: record.description.length > 0 ? record.description : undefined,
    connection: {
      state: record.connectionState,
      message: record.connectionMessage.length > 0 ? record.connectionMessage : undefined,
      checkedAt: record.checkedAt,
    },
    tools: record.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      readOnly: tool.readOnly,
    })),
  };
}

function configSignature(record: McpServerRecord): string {
  return JSON.stringify([
    record.transport,
    record.command,
    record.args,
    record.env,
    record.cwd,
    record.url,
    record.headers,
  ]);
}

/** Provider-facing tool name; providers cap names at 64 characters. */
export function mcpToolName(serverName: string, toolName: string): string {
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_]/g, "_");
  return `mcp__${sanitize(serverName)}__${sanitize(toolName)}`.slice(0, MCP_NAME_LIMIT);
}

function mcpServerId(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name).replace(/-/g, "") || "server";
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${base}${counter}`;
    counter += 1;
  }
  return candidate;
}

/** Lookup key a human uses when trusting a tool or when an approval names it. */
export function mcpToolReference(serverName: string, toolName: string): string {
  return `${serverName}/${toolName}`;
}

/**
 * Gate one MCP tool.
 *
 * A tool the employee trusts as read-only runs as it is; the trust is a human
 * decision recorded on the employee, never a server's own `readOnlyHint`.
 * Everything else takes the same path as a shell command: the grant is
 * verified in `execute`, and the execution state is recorded around the call.
 */
function gateMcpTool(
  spec: { runtime: EmitRuntime; employee: EmployeeRecord; toolName: string },
  trustedReadOnly: boolean,
  run: (args: never, api: ToolExecutionApi, context: Context) => Promise<Awaited<ReturnType<ToolRegistration["execute"]>>>,
): ToolRegistration["execute"] {
  if (trustedReadOnly) return run as unknown as ToolRegistration["execute"];
  return gatedExecute<never>(
    { runtime: spec.runtime, employee: spec.employee, toolName: spec.toolName, kind: "mcp" },
    run,
  ) as unknown as ToolRegistration["execute"];
}

export class McpManager {
  readonly #runtime: EmitRuntime;
  readonly #connections = new Map<string, LiveConnection>();

  constructor(runtime: EmitRuntime) {
    this.#runtime = runtime;
  }

  async listServers(): Promise<McpServerRecord[]> {
    const members = await this.#runtime.listFamily(McpDoc, (id) => ({ id }));
    return members.map((member) => member.value).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Create or update one server. An existing id is kept, so a configuration
   * change never breaks an employee's binding or a trusted-tool entry.
   */
  async saveServer(draft: McpServerDraftDTO): Promise<McpServerRecord> {
    const existing = await this.listServers();
    const id =
      draft.id !== undefined && existing.some((server) => server.id === draft.id)
        ? draft.id
        : mcpServerId(draft.name, new Set(existing.map((server) => server.id)));
    const saved = await this.#runtime.updateFamily(McpDoc, id, { id }, (doc) => {
      doc.id = id;
      doc.name = draft.name;
      doc.transport = draft.transport;
      doc.command = draft.command ?? "";
      doc.args = [...(draft.args ?? [])];
      doc.env = { ...(draft.env ?? {}) };
      doc.cwd = draft.cwd ?? "";
      doc.url = draft.url ?? "";
      doc.headers = { ...(draft.headers ?? {}) };
      doc.description = draft.description ?? "";
      doc.enabled = draft.enabled ?? true;
      // A changed configuration invalidates the previous connection.
      doc.connectionState = "unknown";
      doc.connectionMessage = "";
      doc.tools = [];
    });
    if (draft.id !== undefined && draft.id !== id) await this.#disconnect(draft.id);
    this.#runtime.emit({ type: "mcp" });
    return saved;
  }

  async removeServer(id: string): Promise<void> {
    await this.#disconnect(id);
    await this.#runtime.harness.commit(async (tx) => {
      await tx.retireDoc(McpDoc, id);
    }, this.#runtime.ctx);
    this.#runtime.emit({ type: "mcp" });
  }

  /** Connect (or reconnect) one server and record its discovered tools. */
  async connect(id: string): Promise<{ ok: boolean; message: string; tools: string[] }> {
    const servers = await this.listServers();
    const record = servers.find((server) => server.id === id);
    if (record === undefined) return { ok: false, message: `MCP server 不存在: ${id}`, tools: [] };

    await this.#disconnect(id);
    const signature = configSignature(record);
    const client = new McpClient({ name: "emit", version: "0.1.0", requestTimeoutMs: 60_000 });
    let lastStderr = "";
    const transport =
      record.transport === "stdio"
        ? new StdioTransport({
            command: record.command,
            args: [...record.args],
            ...(record.cwd.length > 0 ? { cwd: record.cwd } : {}),
            ...(Object.keys(record.env).length > 0 ? { env: record.env } : {}),
            onStderr: (chunk) => {
              lastStderr = `${lastStderr}${chunk}`.slice(-2_000);
            },
          })
        : new StreamableHttpTransport({
            url: record.url,
            ...(Object.keys(record.headers).length > 0 ? { headers: record.headers } : {}),
          });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      this.#connections.set(id, { signature, client, tools });
      await this.#recordConnection(id, "connected", "", tools);
      this.#runtime.emit({ type: "mcp" });
      return { ok: true, message: `已连接，发现 ${tools.length} 个工具`, tools: tools.map((tool) => tool.name) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = lastStderr.length > 0 ? `${detail}\n${lastStderr}` : detail;
      await client.close().catch(() => undefined);
      await this.#recordConnection(id, "error", message, []);
      this.#runtime.emit({ type: "mcp" });
      return { ok: false, message, tools: [] };
    }
  }

  /** Connect every enabled server; returns the failures that matter to the user. */
  async connectEnabled(): Promise<void> {
    const servers = await this.listServers();
    for (const server of servers) {
      if (!server.enabled) continue;
      const result = await this.connect(server.id);
      if (!result.ok) {
        this.#runtime.emit({ type: "notice", text: `MCP server ${server.name} 连接失败：${result.message}` });
      }
    }
  }

  /** Tools offered by the given servers, with the given names trusted read-only. */
  /**
   * Adapt one employee's enabled MCP tools. A tool the employee marks trusted
   * read-only runs directly; every other one passes through the approval gate
   * exactly like a shell command does.
   */
  toolsFor(employee: EmployeeRecord, runtime: EmitRuntime): ToolRegistration[] {
    const tools: ToolRegistration[] = [];
    const used = new Set<string>();
    for (const serverId of employee.mcpServerIds) {
      const connection = this.#connections.get(serverId);
      if (connection === undefined) continue;
      for (const tool of connection.tools) {
        const mapped = mcpToolName(serverId, tool.name);
        if (used.has(mapped)) continue;
        used.add(mapped);
        const trusted = employee.trustedReadOnlyTools.includes(mcpToolReference(serverId, tool.name));
        tools.push(this.#buildTool(serverId, connection.client, tool, mapped, trusted, employee, runtime));
      }
    }
    return tools;
  }

  #buildTool(
    serverId: string,
    client: McpClient,
    tool: McpTool,
    mappedName: string,
    trustedReadOnly: boolean,
    employee: EmployeeRecord,
    runtime: EmitRuntime,
  ): ToolRegistration {
    const schema = tool.inputSchema;
    const properties = typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {};
    return defineTool({
      name: mappedName,
      description: tool.description ?? tool.title ?? tool.name,
      // MCP publishes JSON Schema; its object shape is expressed as an unsafe
      // TypeBox schema so the harness still validates arguments before running.
      parameters: Type.Unsafe({ ...schema, type: "object", properties }),
      // An interrupted MCP call may already have had an effect on the server.
      replay: "unsafe",
      execute: gateMcpTool(
        { runtime, employee, toolName: mappedName },
        trustedReadOnly,
        async (args, api, context) => {
        api.output(`调用 MCP ${serverId}/${tool.name}\n`);
        try {
          const result = await client.callTool(tool.name, args as Record<string, unknown>, {
            ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
            onProgress: (progress) => api.output(`${progress.message ?? progress.progress}\n`),
          });
          return {
            content: toLlmContent(result),
            isError: result.isError === true,
            details: { server: serverId, tool: tool.name, trustedReadOnly },
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          };
        }
        },
      ),
    });
  }

  async #recordConnection(
    id: string,
    state: "connected" | "error",
    message: string,
    tools: readonly McpTool[],
  ): Promise<void> {
    await this.#runtime.updateFamily(McpDoc, id, { id }, (doc) => {
      doc.connectionState = state;
      doc.connectionMessage = message.slice(0, 4_000);
      doc.checkedAt = Date.now();
      doc.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.title ?? "",
        readOnly: tool.annotations?.readOnlyHint === true,
      }));
    });
  }

  async #disconnect(id: string): Promise<void> {
    const connection = this.#connections.get(id);
    if (connection === undefined) return;
    this.#connections.delete(id);
    await connection.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const ids = [...this.#connections.keys()];
    for (const id of ids) await this.#disconnect(id);
  }
}
