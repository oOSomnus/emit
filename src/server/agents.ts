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
import { findWorkContext } from "./work-contexts.ts";
import { listEmployees } from "./workspace.ts";
import {
  renderEmployeeContext,
  renderEmployeeIdentity,
  renderSkillSection,
  type EmployeeContextInput,
} from "./prompts/index.ts";
import { BUILTIN_TOOL_RISK, buildFileTools } from "./tools.ts";
import { gateToolCall, type ToolRisk } from "./approval/state.ts";
import type { McpToolBinding, McpToolTrust } from "./mcp.ts";
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
  /** MCP tools already adapted by their own builder, each with its trust fact. */
  mcp: readonly McpToolBinding[];
  /** Extra hooks, such as the delivery and budget hooks of the work layer. */
  hooks: readonly HookRegistration[];
};

/**
 * Decide what may happen to one tool call for one employee.
 *
 * The tool's own risk class is a fact of the tool, not of the arguments, so the
 * gate never has to guess. `allowedTools` is the employee's allow list; an empty
 * list means the collaboration tools only, matching what the editor shows.
 * MCP tools are classified only from the caller's binding: their trust is a
 * human declaration made for a raw reference, never something inferred from a
 * display name.
 */
const COLLABORATION_TOOL_NAMES: Record<string, true> = {
  send_message: true,
  invite_to_channel: true,
  list_work_notes: true,
  read_work_note: true,
  save_work_note: true,
  send_mail: true,
  delegate_task: true,
};

export function classifyTool(
  employee: EmployeeRecord,
  toolName: string,
  mcpTrust: McpToolTrust | undefined,
): ToolRisk | { blocked: string } {
  if (COLLABORATION_TOOL_NAMES[toolName] === true) return { risk: "safe" };

  const builtin = BUILTIN_TOOL_RISK[toolName];
  if (builtin !== undefined) {
    if (!employee.allowedTools.includes(toolName)) {
      return { blocked: `Tool ${toolName} is not in this employee's allowed tool list` };
    }
    return builtin;
  }

  if (mcpTrust !== undefined) {
    return mcpTrust.trustedReadOnly ? { risk: "safe" } : { risk: "gated", kind: "mcp" };
  }

  return { blocked: `Unknown tool ${toolName}; call blocked` };
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
    return renderEmployeeIdentity({
      name: employee.name,
      address: employee.address,
      role: employee.role,
      instructions: employee.instructions,
    });
  });

  const context = section("context", async (promptInput, ctx) => {
    const app = await promptInput.read.snapshot(AppDoc, ctx);
    const binding = await promptInput.read.snapshot(ConversationContextDoc, promptInput.conversationId, ctx);
    const work: EmployeeContextInput["work"] =
      binding === undefined || binding.workId.length === 0
        ? { kind: "none" }
        : binding.roomId.length === 0
          ? { kind: "delegation" }
          : { kind: "room" };
    const directory = await readWorkDirectoryScope(runtime, promptInput.conversationId);
    const appInput =
      app === undefined
        ? null
        : {
            workspaceName: app.workspaceName,
            workspaceSlug: app.workspaceSlug,
            maxDepth: app.collaboration.maxDepth,
            maxCrossEmployeeWakes: app.collaboration.maxCrossEmployeeWakes,
          };
    // The employee index is read per request so invitations, renames, and
    // disabled employees are current on the next turn.
    const employees = await listEmployees(runtime);
    const directoryFor = (memberIds: ReadonlySet<string>): EmployeeContextInput["employeeDirectory"] =>
      employees.map((entry) => ({
        id: entry.id,
        name: entry.name,
        address: entry.address,
        enabled: entry.enabled,
        member: memberIds.has(entry.id),
      }));
    if (!directory.ok) {
      return renderEmployeeContext({
        app: appInput,
        directory: { kind: "error", message: directory.message },
        work,
        workContext: null,
        currentChannel: null,
        employeeDirectory: [],
      });
    }
    const { scope } = directory;
    const workContextRecord = await findWorkContext(runtime, directory.scope.workContextId);
    const workContext =
      workContextRecord === undefined
        ? null
        : {
            id: workContextRecord.id,
            name: workContextRecord.name,
            goal: workContextRecord.goal,
            instructions: workContextRecord.instructions,
            resources: workContextRecord.resources.slice(0, 40).map((resource) => ({
              id: resource.id,
              kind: resource.kind,
              name: resource.name,
              location: resource.location.slice(0, 240),
            })),
            remainingResources: Math.max(0, workContextRecord.resources.length - 40),
            notes: [...workContextRecord.notes]
              .sort((left, right) => right.updatedAt - left.updatedAt)
              .slice(0, 20)
              .map((note) => ({
                id: note.id,
                title: note.title,
                authorId: note.authorId,
                sourceRoomId: note.sourceRoomId,
                sourceEntryId: note.sourceEntryId,
                sourceWorkId: note.sourceWorkId,
              })),
            remainingNotes: Math.max(0, workContextRecord.notes.length - 20),
          };
    const room = await promptInput.read.snapshot(RoomDoc, scope.roomId, ctx);
    // The current channel comes from this conversation's own binding, never
    // from the inherited directory scope: a delegation inherits its parent's
    // scope room but does not itself run in that channel.
    const boundRoom =
      binding !== undefined && binding.roomId.length > 0
        ? binding.roomId === scope.roomId
          ? room
          : await promptInput.read.snapshot(RoomDoc, binding.roomId, ctx)
        : undefined;
    const channelRoom =
      boundRoom !== undefined && boundRoom.kind === "channel" && boundRoom.workContextId === scope.workContextId
        ? boundRoom
        : undefined;
    const currentChannel =
      channelRoom === undefined ? null : { id: channelRoom.id, name: channelRoom.name };
    return renderEmployeeContext({
      app: appInput,
      directory:
        room === undefined
          ? { kind: "missing-room" }
          : {
              kind: "paths",
              roomLabel: room.kind === "mail" ? "mail thread" : room.kind === "dm" ? "direct message" : "channel",
              roomName: room.name,
              directoryVersion: scope.version,
              paths: scope.paths,
              defaultPath: scope.defaultPath,
            },
      work,
      workContext,
      currentChannel,
      employeeDirectory: directoryFor(new Set(channelRoom?.memberIds ?? [])),
    });
  });

  const skillSection = section("skills", () => renderSkillSection(boundSkills, employee.skillIds));
  const mcpBindingByToolName = new Map<string, McpToolBinding>(
    input.tools.mcp.map((binding) => [binding.registration.name, binding]),
  );
  const tools: ToolRegistration[] = [
    ...buildFileTools({ runtime, employee, skills: boundSkills }),
    ...input.tools.collaboration,
    ...input.tools.mcp.map((binding) => binding.registration),
  ];
  const toolDescriptions = new Map<string, string>(
    tools.map((tool): [string, string] => [tool.name, tool.description]),
  );

  const hooks = [
    ...input.tools.hooks,
    hook(ToolTask, {
      async beforeTool(call, api, ctx) {
        const mcpBinding = mcpBindingByToolName.get(call.name);
        const decision = classifyTool(employee, call.name, mcpBinding);
        if ("blocked" in decision) return { block: decision.blocked };
        const needsDirectoryVersionCheck =
          call.name === "read_file" ||
          call.name === "load_skill" ||
          mcpBinding?.trustedReadOnly === true;
        if (needsDirectoryVersionCheck) {
          const directory = await readWorkDirectoryScope(runtime, api.conversationId);
          if (!directory.ok) return { block: directory.message };
        }
        if (decision.risk === "safe") return undefined;
        const toolDescription = toolDescriptions.get(call.name);
        if (toolDescription === undefined) return { block: `Tool description not found for ${call.name}; call blocked` };
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
