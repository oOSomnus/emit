/**
 * One employee as one agent.
 *
 * An employee is not a row in a table that a generic runner consults; it is a
 * Pi Durable extension built from that employee's record. The extension carries
 * the identity and skill prompt sections, the toolset the employee may call,
 * and the hooks that make the approval gate real for that employee alone.
 *
 * A conversation is created per work item and given exactly this extension, so
 * two employees never share a toolset, a prompt, or an approval history.
 */

import {
  defineExtension,
  hook,
  section,
  ToolTask,
  type Extension,
  type HookRegistration,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { EmitRuntime } from "./runtime.ts";
import { AppDoc, ConversationContextDoc, RoomDoc, type EmployeeRecord, type SkillRecord } from "./documents.ts";
import { renderSkillSection } from "./skills.ts";
import { BUILTIN_TOOL_RISK, buildFileTools } from "./tools.ts";
import { gateToolCall, type ToolRisk } from "./approval/state.ts";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Map a stored effort string onto the model thinking level union. */
export function toThinkingLevel(effort: string): ModelThinkingLevel {
  const found = THINKING_LEVELS.find((level) => level === effort);
  return found ?? "off";
}

export type EmployeeTools = {
  /** Extra tools the employee may call, such as the collaboration set. */
  collaboration: readonly ToolRegistration[];
  /** MCP tools already adapted by their own builder. */
  mcp: readonly ToolRegistration[];
  /** Extra hooks, such as the delivery and budget hooks of the work layer. */
  hooks: readonly HookRegistration[];
};

/**
 * Decide what may happen to one tool call for one employee.
 *
 * The tool's own risk class is a fact of the tool, not of the arguments, so the
 * gate never has to guess. `allowedTools` is the employee's allow list; an empty
 * list means the collaboration tools only, matching what the editor shows.
 */
export function classifyTool(employee: EmployeeRecord, toolName: string): ToolRisk | { blocked: string } {
  const collaborationNames = new Set(["send_message", "send_mail", "delegate_task"]);
  if (collaborationNames.has(toolName)) return { risk: "safe" };

  const builtin = BUILTIN_TOOL_RISK[toolName];
  if (builtin !== undefined) {
    if (!employee.allowedTools.includes(toolName)) {
      return { blocked: `工具 ${toolName} 不在该员工的允许工具列表中` };
    }
    return builtin;
  }

  // Anything else is an MCP tool, named `mcp__<server>__<tool>`.
  if (toolName.startsWith("mcp__")) {
    const reference = mcpReferenceFor(employee, toolName);
    if (reference !== undefined && employee.trustedReadOnlyTools.includes(reference)) return { risk: "safe" };
    return { risk: "gated", kind: "mcp" };
  }

  return { blocked: `未知工具 ${toolName}，已阻止调用` };
}

/**
 * Recover the `server/tool` reference from a mapped tool name. The mapping
 * sanitizes both halves, so a match is made against the employee's servers.
 */
function mcpReferenceFor(employee: EmployeeRecord, mappedName: string): string | undefined {
  const parts = mappedName.split("__");
  if (parts.length < 3) return undefined;
  const server = parts[1] ?? "";
  const tool = parts.slice(2).join("__");
  for (const serverId of employee.mcpServerIds) {
    if (serverId === server || serverId.replace(/[^A-Za-z0-9_]/g, "_") === server) {
      return `${serverId}/${tool}`;
    }
  }
  return undefined;
}

export type EmployeeAgentInput = {
  runtime: EmitRuntime;
  employee: EmployeeRecord;
  skills: readonly SkillRecord[];
  tools: EmployeeTools;
};

/**
 * Build the extension for one employee.
 *
 * The gate lives in `beforeTool`, which runs before the harness records a tool
 * intent. If the process dies while an approval is pending, the intent was
 * never written, so recovery re-runs the hook, finds the same approval under
 * the same deterministic key, and proceeds with the human's answer.
 */
export function buildEmployeeExtension(input: EmployeeAgentInput): Extension {
  const { runtime, employee, skills } = input;
  const boundSkills = skills.filter((skill) => employee.skillIds.includes(skill.id));

  const identity = section("employee", () => {
    return [
      `你的名字是 ${employee.name}（邮箱 ${employee.address}）。`,
      `你的角色：${employee.role}`,
      employee.instructions.length > 0 ? `\n工作准则：\n${employee.instructions}` : "",
      "",
      "你是在 Emit 里工作的数字员工。你可以收发站内消息与邮件，也可以把任务交办给其他员工。",
      "回答要直接、具体，直接给出结论或产物，不要复述这些设定。",
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  });

  const context = section("context", async (promptInput, ctx) => {
    const app = await promptInput.read.snapshot(AppDoc, ctx);
    const binding = await promptInput.read.snapshot(ConversationContextDoc, promptInput.conversationId, ctx);
    const parts: string[] = [];
    if (app !== undefined) {
      parts.push(`工作区：${app.workspaceName}（${app.workspaceSlug}）。`);
      parts.push(
        `协作上限：最多 ${app.collaboration.maxDepth} 层交办，最多 ${app.collaboration.maxCrossEmployeeWakes} 次跨员工唤醒。`,
      );
    }
    parts.push(employee.cwd.length > 0 ? `工作目录：${employee.cwd}` : "你没有配置工作目录，无法读写文件。");
    if (binding !== undefined && binding.workId.length > 0) {
      if (binding.roomId.length > 0) {
        const room = await promptInput.read.snapshot(RoomDoc, binding.roomId, ctx);
        if (room !== undefined) {
          const label = room.kind === "mail" ? "邮件会话" : room.kind === "dm" ? "私信" : "频道";
          parts.push(`本次工作来自${label}「${room.name}」，这是该会话的一轮对话。`);
        }
      } else {
        parts.push("本次工作由其他员工交办，完成后把结果作为你的最终回答返回，交办方会收到它。");
      }
    }
    return parts.join("\n");
  });

  const skillSection = section("skills", () => renderSkillSection(skills, employee.skillIds));

  const tools: ToolRegistration[] = [
    ...buildFileTools({ runtime, employee, skills }),
    ...input.tools.collaboration,
    ...input.tools.mcp,
  ];

  const hooks = [
    ...input.tools.hooks,
    hook(ToolTask, {
      async beforeTool(call, api, ctx) {
        const decision = classifyTool(employee, call.name);
        if ("blocked" in decision) return { block: decision.blocked };
        if (decision.risk === "safe") return undefined;
        const gated = await gateToolCall({
          runtime,
          toolTaskId: String(api.taskId),
          conversationId: api.conversationId,
          toolName: call.name,
          toolKind: decision.kind,
          arguments: call.arguments,
          signal: ctx.abortSignal,
        });
        if (!gated.allow) return { block: gated.message };
        return undefined;
      },
    }),
  ];

  return defineExtension({
    name: `employee:${employee.id}`,
    tools,
    sections: [identity, context, skillSection].filter((entry) => entry !== undefined),
    hooks,
  });
}
