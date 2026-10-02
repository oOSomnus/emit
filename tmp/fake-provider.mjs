/**
 * A fake OpenAI-completions provider for the smoke run.
 *
 * It answers three ways, chosen from the request itself so no state is needed:
 * - the approval gate's system prompt gets the JSON verdict the gate parses;
 * - an employee request that already carries a tool result gets a final answer;
 * - a fresh employee request gets one tool call, read or write depending on the
 *   user's wording.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_PORT ?? 8899);

function readBody(request) {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => resolve(data));
  });
}

const APPROVAL_OK = {
  recommendation: "approve",
  risk: "low",
  rationale: "具体参数是低风险只读操作",
  readOnly: true,
  userAuthorization: "unknown",
};
const APPROVAL_REVIEW = {
  recommendation: "review",
  risk: "medium",
  rationale: "具体参数的副作用或敏感性需要人工确认",
  readOnly: false,
  userAuthorization: "unknown",
};

function approvalDetails(messages) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const prompt =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : lastUser?.content?.map?.((part) => part.text ?? "").join(" ") ?? "";
  const tool = /^Tool: .+ \(([^)]+)\)$/m.exec(prompt)?.[1] ?? "";
  const argsLine = /Normalized arguments(?: \(untrusted evidence\))?:\n([^\n]*)/.exec(prompt)?.[1] ?? "";
  let args = {};
  try {
    args = JSON.parse(argsLine);
  } catch {
    // Malformed or truncated arguments are uncertain, never an approval.
  }
  return { tool, args };
}

function currentRequest(prompt) {
  const match =
    /(?:现在请你处理这条消息|现在请你回复这封邮件|另一位员工把这件事交办给你)：\n([\s\S]*)$/.exec(prompt);
  return match?.[1] ?? prompt;
}

function decide(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = JSON.stringify(messages);
  if (text.includes("approval gate")) {
    const { tool, args } = approvalDetails(messages);
    const verdict =
      tool === "shell" && (args.command === "cat notes.txt" || args.command === "ls")
        ? APPROVAL_OK
        : APPROVAL_REVIEW;
    return { content: JSON.stringify(verdict), toolCalls: [] };
  }

  // The user's own words decide what to do, not the whole prompt: tool
  // descriptions and employee instructions live in the prompt too and would
  // otherwise match by accident.
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const ask =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : lastUser?.content?.map?.((part) => part.text ?? "").join(" ") ?? "";
  const request = currentRequest(ask);
  const hasToolResult = messages.some((message) => message.role === "tool" || message.role === "toolResult");
  if (hasToolResult) {
    // A refusal is echoed back so the run can show what the model was told.
    if (text.includes("不在该员工的允许工具列表")) {
      return { content: "被阻止：这个工具不在我的允许列表里。", toolCalls: [] };
    }
    if (text.includes("会形成循环")) {
      return { content: "交办被阻止：会形成循环。", toolCalls: [] };
    }
    if (text.includes("跨员工唤醒上限")) {
      return { content: "交办被阻止：跨员工唤醒上限。", toolCalls: [] };
    }
    if (text.includes("交办层数会超过上限")) {
      return { content: "交办被阻止：超过交办层数上限。", toolCalls: [] };
    }
    if (text.includes("SMOKE-SKILL-BODY")) {
      return { content: "已按技能完成：SMOKE-SKILL-BODY", toolCalls: [] };
    }
    if (text.includes("已把任务交办给") || text.includes("的交办结果")) {
      return { content: "链上已完成：我交办的活有结果了。", toolCalls: [] };
    }
    return { content: "已完成：我读了工作目录里的文件并写下了结果。", toolCalls: [] };
  }

  // A delegation chain is driven by the employee's own instructions, which the
  // request carries in its system prompt.
  const delegating = /交办->\s*([^"\\\n]+)/.exec(text);
  if (delegating !== null) {
    const target = delegating[1].trim();
    return {
      content: "",
      toolCalls: [
        {
          id: "call_delegate_1",
          name: "delegate_task",
          arguments: JSON.stringify({ employee: target, task: "继续把任务往下交" }),
        },
      ],
    };
  }
  if (request.includes("技能")) {
    return {
      content: "",
      toolCalls: [{ id: "call_skill_1", name: "load_skill", arguments: JSON.stringify({ name: "smoke-review" }) }],
    };
  }
  if (request.includes("MCP")) {
    const path = request.includes("密钥") ? ".env" : request.includes("不确定") ? "" : "notes.txt";
    return {
      content: "",
      toolCalls: [
        {
          id: "call_mcp_1",
          name: "mcp__fixture__echo_notes",
          arguments: JSON.stringify({ path }),
        },
      ],
    };
  }
  if (request.includes("run_shell")) {
    const command = request.includes("ls") ? "ls" : "cat notes.txt";
    return {
      content: "",
      toolCalls: [
        {
          id: "call_shell_1",
          name: "run_shell",
          arguments: JSON.stringify({ command }),
        },
      ],
    };
  }
  if (request.includes("写")) {
    return {
      content: "",
      toolCalls: [
        {
          id: "call_write_1",
          name: "write_file",
          arguments: JSON.stringify({ path: "result.txt", content: "来自员工的问候\n" }),
        },
      ],
    };
  }
  return {
    content: "",
    toolCalls: [
      {
        id: "call_read_1",
        name: "read_file",
        arguments: JSON.stringify({ path: "notes.txt" }),
      },
    ],
  };
}

function chunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const MISSING_SESSION_BODY = {
  type: "MissingSessionID",
  message:
    "Request is missing x-opencode-session and cannot be routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it",
};

/** OpenCode Go requests observed in this run: `{ model, sessionId }`, never auth material. */
const goSessions = [];

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/_opencode_sessions") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(goSessions));
    return;
  }
  if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
    response.writeHead(404).end("not found");
    return;
  }
  const body = JSON.parse((await readBody(request)) || "{}");
  // OpenCode Go requires a per-conversation session header; emulate its refusal
  // so a missing one is a hard failure rather than a fake success.
  if (request.url.startsWith("/zen/go/")) {
    const header = request.headers["x-opencode-session"];
    const session = typeof header === "string" ? header : "";
    if (session.length === 0) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify(MISSING_SESSION_BODY));
      return;
    }
    goSessions.push({ model: body.model ?? null, sessionId: session });
  }
  const { content, toolCalls } = decide(body);
  const model = body.model ?? "fake-chat";
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model };
  const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };

  if (body.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: content.length > 0 ? content : null,
              ...(toolCalls.length > 0
                ? {
                    tool_calls: toolCalls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : {}),
            },
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage,
      }),
    );
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
  if (content.length > 0) {
    response.write(chunk({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] }));
  }
  if (toolCalls.length > 0) {
    response.write(
      chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: toolCalls.map((call, index) => ({
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            },
            finish_reason: null,
          },
        ],
      }),
    );
  }
  response.write(
    chunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
      usage,
    }),
  );
  response.write("data: [DONE]\n\n");
  response.end();
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`fake provider listening on ${PORT}\n`);
});
