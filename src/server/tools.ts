/**
 * The built-in employee tools: files, shell, and skills.
 *
 * These tools are Emit's own, not the Pi coding tools, for one reason: a gated
 * tool has to re-verify its grant at execution time. The harness records a tool
 * intent before running it and does not re-run the approval hook when it
 * resumes that intent after a restart, so the check that survives a crash lives
 * inside `execute`.
 *
 * File tools canonicalize targets before checking this session's authorized
 * directory roots, so symlink escapes cannot target files outside them.
 */
import { dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { EmployeeRecord, SkillRecord } from "./documents.ts";
import type { EmitRuntime } from "./runtime.ts";
import { AppDoc } from "./documents.ts";
import { findBoundSkill } from "./skills.ts";
import { renderToolResult, toolTextResources } from "./prompts/index.ts";
import { recordExecution, verifyGrant, type ApprovalRequest, type ToolRisk } from "./approval/state.ts";
import {
  readWorkDirectoryScope,
  resolveToolDirectoryScope,
  resolveWithin,
  type ResolvedToolDirectoryScope,
} from "./work-directories.ts";

const MAX_READ_BYTES = 200_000;
const MAX_READ_LINES = 2_000;
const SHELL_TIMEOUT_MS = 120_000;
const SHELL_SPILL_BYTES = 65_536;

/** Tool names the gate knows how to classify. */
export const BUILTIN_TOOL_RISK: Record<string, ToolRisk> = {
  read_file: { risk: "safe" },
  load_skill: { risk: "safe" },
  list_employees: { risk: "safe" },
  write_file: { risk: "gated", kind: "file-write" },
  edit_file: { risk: "gated", kind: "file-write" },
  run_shell: { risk: "gated", kind: "shell" },
  send_message: { risk: "safe" },
  send_mail: { risk: "safe" },
  delegate_task: { risk: "safe" },
};

export type ToolContext = {
  runtime: EmitRuntime;
  employee: EmployeeRecord;
  skills: readonly SkillRecord[];
};

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Wrap a gated tool so it re-resolves this call's session directory scope,
 * verifies its grant immediately before the side effect, and records execution.
 */
export function gatedExecute<T>(
  spec: {
    runtime: EmitRuntime;
    employee: EmployeeRecord;
    toolName: string;
    kind: "file-write" | "shell" | "mcp" | "other";
  },
  run: (
    args: T,
    api: ToolExecutionApi,
    context: Context,
    directory: ResolvedToolDirectoryScope,
  ) => Promise<Awaited<ReturnType<ToolRegistration["execute"]>>>,
): (args: T, api: ToolExecutionApi, context: Context) => Promise<Awaited<ReturnType<ToolRegistration["execute"]>>> {
  return async (args, api, context) => {
    const resolved = await resolveToolDirectoryScope(
      spec.runtime,
      api.conversationId,
      spec.toolName,
      args,
      context,
      api.env,
    );
    if (!resolved.ok) return errorResult(resolved.message);
    const directory: ResolvedToolDirectoryScope = {
      scope: resolved.scope,
      cwd: resolved.cwd,
      targetPaths: resolved.targetPaths,
    };
    const app = await api.snapshot(AppDoc, context);
    if (app === undefined) return errorResult("无法读取 workspace 配置，已阻止执行");
    const request: ApprovalRequest = {
      toolTaskId: String(api.taskId),
      employeeId: spec.employee.id,
      employeeName: spec.employee.name,
      toolName: spec.toolName,
      toolKind: spec.kind,
      arguments: args,
      cwd: directory.cwd,
      directoryRoomId: directory.scope.roomId,
      directoryVersion: directory.scope.version,
      directoryPaths: [...directory.scope.paths],
      targetPaths: [...directory.targetPaths],
    };
    const grant = await verifyGrant(spec.runtime, spec.employee, app, request);
    if (!grant.allow) return errorResult(grant.message);
    try {
      const result = await run(args, api, context, directory);
      await recordExecution(
        spec.runtime,
        grant.record.id,
        result.isError === true ? "failed" : "succeeded",
        result.isError === true ? `${spec.toolName} 返回错误` : `${spec.toolName} 已完成`,
      );
      return result;
    } catch (error) {
      await recordExecution(
        spec.runtime,
        grant.record.id,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  };
}

export function buildFileTools(context: ToolContext): ToolRegistration[] {
  const { runtime, employee, skills } = context;

  const readFile = defineTool({
    name: "read_file",
    description: toolTextResources.read_file.description,
    parameters: Type.Object({
      path: Type.String({ description: toolTextResources.read_file.parameters.path }),
      offset: Type.Optional(Type.Number({ description: toolTextResources.read_file.parameters.offset })),
      limit: Type.Optional(Type.Number({ description: toolTextResources.read_file.parameters.limit })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const env = api.env;
      if (env === undefined) return errorResult("没有可用的执行环境");
      const scope = await readWorkDirectoryScope(runtime, api.conversationId);
      if (!scope.ok) return errorResult(scope.message);
      const resolved = await resolveWithin(
        env,
        ctx,
        args.path,
        [...scope.scope.paths, ...skills.map((skill) => skill.directory)],
        scope.scope.defaultPath,
      );
      if (!resolved.ok) return errorResult(resolved.message);
      const read = await env.readTextFile(resolved.path, ctx);
      if (!read.ok) return errorResult(`读取失败 ${resolved.path}: ${read.error.message}`);
      if (read.value.length > MAX_READ_BYTES) {
        return errorResult(
          renderToolResult("read-too-large", { size: read.value.length, max: MAX_READ_BYTES }),
        );
      }
      const lines = read.value.split("\n");
      const offset = Math.max(1, args.offset ?? 1);
      const limit = Math.max(1, Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((line, index) => `${offset + index}: ${line}`).join("\n");
      const suffix =
        lines.length > offset - 1 + slice.length
          ? `\n${renderToolResult("read-lines-suffix", { total: lines.length })}`
          : "";
      return textResult(`${numbered}${suffix}`);
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    description: toolTextResources.write_file.description,
    parameters: Type.Object({
      path: Type.String({ description: toolTextResources.write_file.parameters.path }),
      content: Type.String({ description: toolTextResources.write_file.parameters.content }),
    }),
    execute: gatedExecute(
      { runtime, employee, toolName: "write_file", kind: "file-write" },
      async (args, api, ctx, directory) => {
        const env = api.env;
        if (env === undefined) return errorResult("没有可用的执行环境");
        const target = directory.targetPaths[0];
        if (target === undefined) return errorResult("没有已验证的写入目标");
        const parent = dirname(target);
        const created = await env.createDir(parent, { recursive: true }, ctx);
        if (!created.ok && !created.error.message.includes("exist")) {
          return errorResult(`无法创建目录 ${parent}: ${created.error.message}`);
        }
        const written = await env.writeFile(target, args.content, ctx);
        if (!written.ok) return errorResult(`写入失败 ${target}: ${written.error.message}`);
        return textResult(renderToolResult("write-ok", { path: target, length: args.content.length }));
      },
    ),
  });

  const editFile = defineTool({
    name: "edit_file",
    description: toolTextResources.edit_file.description,
    parameters: Type.Object({
      path: Type.String({ description: toolTextResources.edit_file.parameters.path }),
      oldText: Type.String({ description: toolTextResources.edit_file.parameters.oldText }),
      newText: Type.String({ description: toolTextResources.edit_file.parameters.newText }),
      replaceAll: Type.Optional(Type.Boolean({ description: toolTextResources.edit_file.parameters.replaceAll })),
    }),
    execute: gatedExecute(
      { runtime, employee, toolName: "edit_file", kind: "file-write" },
      async (args, api, ctx, directory) => {
        const env = api.env;
        if (env === undefined) return errorResult("没有可用的执行环境");
        if (args.oldText.length === 0) return errorResult("oldText 不能为空");
        const target = directory.targetPaths[0];
        if (target === undefined) return errorResult("没有已验证的编辑目标");
        const read = await env.readTextFile(target, ctx);
        if (!read.ok) return errorResult(`读取失败 ${target}: ${read.error.message}`);
        const occurrences = read.value.split(args.oldText).length - 1;
        if (occurrences === 0) return errorResult("文件中找不到 oldText");
        if (occurrences > 1 && args.replaceAll !== true) {
          return errorResult(renderToolResult("edit-ambiguous", { count: occurrences }));
        }
        const updated =
          args.replaceAll === true
            ? read.value.split(args.oldText).join(args.newText)
            : read.value.replace(args.oldText, args.newText);
        const written = await env.writeFile(target, updated, ctx);
        if (!written.ok) return errorResult(`写入失败 ${target}: ${written.error.message}`);
        return textResult(
          renderToolResult("edit-ok", { path: target, count: args.replaceAll === true ? occurrences : 1 }),
        );
      },
    ),
  });

  const runShell = defineTool({
    name: "run_shell",
    description: toolTextResources.run_shell.description,
    parameters: Type.Object({
      command: Type.String({ description: toolTextResources.run_shell.parameters.command }),
      cwd: Type.Optional(Type.String({ description: toolTextResources.run_shell.parameters.cwd })),
      timeoutMs: Type.Optional(Type.Number({ description: toolTextResources.run_shell.parameters.timeoutMs })),
    }),
    execute: gatedExecute(
      { runtime, employee, toolName: "run_shell", kind: "shell" },
      async (args, api, ctx, directory) => {
        const env = api.env;
        if (env === undefined) return errorResult("没有可用的执行环境");
        const result = await env.exec(
          args.command,
          {
            cwd: directory.cwd,
            timeout: args.timeoutMs !== undefined && args.timeoutMs > 0 ? args.timeoutMs : SHELL_TIMEOUT_MS,
            onOutput: (chunk) => api.output(chunk),
            spill: { afterBytes: SHELL_SPILL_BYTES, afterLines: 2_000 },
          },
          ctx,
        );
        if (!result.ok) {
          const spill =
            result.error.spillPath !== undefined
              ? `\n${renderToolResult("shell-failed-spill", { spillPath: result.error.spillPath })}`
              : "";
          return errorResult(
            renderToolResult("shell-failed", { message: result.error.message, spillBlock: spill }),
          );
        }
        const spill =
          result.value.spillPath !== undefined
            ? `\n${renderToolResult("shell-exit-spill", { spillPath: result.value.spillPath })}`
            : "";
        if (result.value.exitCode !== 0) {
          return {
            isError: true,
            content: [
              { type: "text", text: renderToolResult("shell-exit", { exitCode: result.value.exitCode, spillBlock: spill }) },
            ],
          };
        }
        return textResult(renderToolResult("shell-exit", { exitCode: 0, spillBlock: spill }));
      },
    ),
  });

  const loadSkill = defineTool({
    name: "load_skill",
    description: toolTextResources.load_skill.description,
    parameters: Type.Object({ name: Type.String({ description: toolTextResources.load_skill.parameters.name }) }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const env = api.env;
      if (env === undefined) return errorResult("没有可用的执行环境");
      const scope = await readWorkDirectoryScope(runtime, api.conversationId);
      if (!scope.ok) return errorResult(scope.message);
      const skill = findBoundSkill(skills, employee.skillIds, args.name);
      if (skill === undefined) {
        const bound = skills.filter((entry) => employee.skillIds.includes(entry.id));
        return errorResult(
          renderToolResult("skill-missing", {
            name: args.name,
            bound: bound.map((entry) => entry.name).join(", ") || "(无)",
          }),
        );
      }
      const resolved = await resolveWithin(env, ctx, skill.filePath, [skill.directory], skill.directory);
      if (!resolved.ok) return errorResult(resolved.message);
      const read = await env.readTextFile(resolved.path, ctx);
      if (!read.ok) return errorResult(`读取失败 ${resolved.path}: ${read.error.message}`);
      const base = `${renderToolResult("skill-directory", { directory: skill.directory })}\n\n`;
      if (read.value.length > MAX_READ_BYTES) {
        return textResult(`${base}${read.value.slice(0, MAX_READ_BYTES)}\n${renderToolResult("skill-truncated")}`);
      }
      return textResult(`${base}${read.value}`);
    },
  });

  return [readFile, writeFile, editFile, runShell, loadSkill];
}

export { errorResult as toolError, textResult as toolText };
