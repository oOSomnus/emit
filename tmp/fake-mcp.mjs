/**
 * An MCP server over stdio, for the smoke run.
 *
 * Emit talks to MCP servers through `@earendil-works/pi-mcp`; this fixture
 * speaks that protocol so the connection, discovery, gating, and call paths are
 * exercised without depending on somebody else's server being installed. It
 * implements only what the client uses: initialize, tools/list, tools/call.
 */

import { createInterface } from "node:readline";

/** The client's own version is echoed back, which the spec allows. */
const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "echo_notes",
    title: "Echo notes",
    description: "Return a line from the fixture's notes file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path to read" } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "shout",
    description: "Uppercase the given message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
];

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

function error(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const text = line.trim();
  if (text.length === 0) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = message;
  // A notification carries no id and gets no answer.
  const notification = id === undefined || id === null;
  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fixture-mcp", version: "1.0.0" },
      });
      return;
    case "notifications/initialized":
      return;
    case "ping":
      if (!notification) result(id, {});
      return;
    case "tools/list":
      result(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "echo_notes") {
        result(id, {
          content: [{ type: "text", text: `来自 MCP fixture 的笔记：${args.path ?? "（未给路径）"}` }],
          isError: false,
        });
        return;
      }
      if (name === "shout") {
        result(id, {
          content: [{ type: "text", text: String(args.message ?? "").toUpperCase() }],
          isError: false,
        });
        return;
      }
      // An unknown tool is reported as a tool error, not a protocol error.
      result(id, { content: [{ type: "text", text: `未知工具 ${String(name)}` }], isError: true });
      return;
    }
    default:
      if (!notification) error(id, -32601, `Method not found: ${String(method)}`);
  }
});

lines.on("close", () => process.exit(0));
