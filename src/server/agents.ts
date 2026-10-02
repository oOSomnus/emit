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
import { readWorkDirectoryScope } from "./work-directories.ts";

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
    const directory = await readWorkDirectoryScope(runtime, promptInput.conversationId);
    if (!directory.ok) {
      parts.push(directory.message);
    } else {
      const { scope } = directory;
      const room = await promptInput.read.snapshot(RoomDoc, scope.roomId, ctx);
      if (room === undefined) {
        parts.push("会话工作目录来源不存在，本地文件和 Shell 不可用。");
      } else {
        const label = room.kind === "mail" ? "邮件会话" : room.kind === "dm" ? "私信" : "频道";
        parts.push(`本次工作目录来源于${label}「${room.name}」，目录版本 ${scope.version}。`);
        if (scope.paths.length === 0) {
          parts.push("本会话没有授权本地工作目录；本地文件工具和 Shell 不可用。");
        } else {
          parts.push(`本会话授权的工作目录：${scope.paths.join("、")}`);
          parts.push(`默认执行目录：${scope.defaultPath}`);
        }
      }
    }
    if (binding !== undefined && binding.workId.length > 0 && binding.roomId.length === 0) {
      parts.push("本次工作由其他员工交办，完成后把结果作为你的最终回答返回，交办方会收到它。");
    } else if (binding !== undefined && binding.workId.length > 0) {
      parts.push("本次工作是该会话的一轮对话。");
    }
    return parts.join("\n");
  });

  const skillSection = section("skills", () => renderSkillSection(boundSkills, employee.skillIds));
  const tools: ToolRegistration[] = [
    ...buildFileTools({ runtime, employee, skills: boundSkills }),
    ...input.tools.collaboration,
    ...input.tools.mcp,
  ];
  const toolDescriptions = new Map<string, string>(
    tools.map((tool): [string, string] => [tool.name, tool.description]),
  );

  const hooks = [
    ...input.tools.hooks,
    hook(ToolTask, {
      async beforeTool(call, api, ctx) {
        const decision = classifyTool(employee, call.name);
        if ("blocked" in decision) return { block: decision.blocked };
        const needsDirectoryVersionCheck =
          call.name === "read_file" ||
          call.name === "load_skill" ||
          (call.name.startsWith("mcp__") && decision.risk === "safe");
        if (needsDirectoryVersionCheck) {
          const directory = await readWorkDirectoryScope(runtime, api.conversationId);
          if (!directory.ok) return { block: directory.message };
        }
        if (decision.risk === "safe") return undefined;
        const toolDescription = toolDescriptions.get(call.name);
        if (toolDescription === undefined) return { block: `找不到工具 ${call.name} 的说明，已阻止调用` };
        const gated = await gateToolCall({
          runtime,
          toolTaskId: String(api.taskId),
          conversationId: api.conversationId,
          toolName: call.name,
          toolDescription,
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
