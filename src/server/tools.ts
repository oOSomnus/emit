/**
 * The built-in employee tools: files, shell, and skills.
 *
 * These tools are Emit's own, not the Pi coding tools, for one reason: a gated
 * tool has to re-verify its grant at execution time. The harness records a tool
 * intent before running it and does not re-run the approval hook when it
 * resumes that intent after a restart, so the check that survives a crash lives
 * inside `execute`.
 *
 * Every path is canonicalized before it is checked against the allowed roots,
 * so a symlink cannot walk an employee out of its working directory.
 */

import { basename, dirname, join, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { EmployeeRecord, SkillRecord } from "./documents.ts";
import type { EmitRuntime } from "./runtime.ts";
import { AppDoc } from "./documents.ts";
import { findBoundSkill } from "./skills.ts";
import { recordExecution, verifyGrant, type ApprovalRequest, type ToolRisk } from "./approval/state.ts";

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

/** Canonicalize a path, tolerating a target that does not exist yet. */
async function canonicalTarget(
  env: ExecutionEnv,
  context: Context,
  absolute: string,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  let current = absolute;
  let suffix = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const resolved = await env.canonicalPath(current, context);
    if (resolved.ok) {
      return { ok: true, path: suffix.length === 0 ? resolved.value : join(resolved.value, suffix) };
    }
    const parent = dirname(current);
    if (parent === current) return { ok: false, message: `无法解析路径: ${absolute}` };
    suffix = suffix.length === 0 ? basename(current) : join(basename(current), suffix);
    current = parent;
  }
  return { ok: false, message: `路径层级过深: ${absolute}` };
}

/** Resolve a tool path and require it to stay inside one of the allowed roots. */
export async function resolveWithin(
  env: ExecutionEnv,
  context: Context,
  target: string,
  roots: readonly string[],
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const absolute = await env.absolutePath(target, context);
  if (!absolute.ok) return { ok: false, message: `无法解析路径 ${target}: ${absolute.error.message}` };
  const canonical = await canonicalTarget(env, context, absolute.value);
  if (!canonical.ok) return canonical;
  const allowed: string[] = [];
  for (const root of roots) {
    if (root.length === 0) continue;
    const resolved = await canonicalTarget(env, context, root);
    if (resolved.ok) allowed.push(resolved.path);
  }
  const inside = allowed.some((root) => canonical.path === root || canonical.path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
  if (!inside) {
    return {
      ok: false,
      message:
        `路径 ${canonical.path} 超出该员工允许的目录。\n` +
        `允许的目录：${allowed.length > 0 ? allowed.join(", ") : "(未配置工作目录)"}`,
    };
  }
  return { ok: true, path: canonical.path };
}

function allowedRoots(employee: EmployeeRecord, skills: readonly SkillRecord[], forSkill: boolean): string[] {
  const roots = [employee.cwd];
  if (forSkill) for (const skill of skills) roots.push(skill.directory);
  return roots;
}

/**
 * Wrap a gated tool so it verifies its grant immediately before the side
 * effect and records the execution state around it.
 */
export function gatedExecute<T>(
  spec: { runtime: EmitRuntime; employee: EmployeeRecord; toolName: string; kind: "file-write" | "shell" | "mcp" | "other" },
  run: (args: T, api: ToolExecutionApi, context: Context) => Promise<Awaited<ReturnType<ToolRegistration["execute"]>>>,
): (args: T, api: ToolExecutionApi, context: Context) => Promise<Awaited<ReturnType<ToolRegistration["execute"]>>> {
  return async (args, api, context) => {
    const app = await api.snapshot(AppDoc, context);
    if (app === undefined) return errorResult("无法读取 workspace 配置，已阻止执行");
    const agent = await api.agent(context);
    const request: ApprovalRequest = {
      toolTaskId: String(api.taskId),
      employeeId: spec.employee.id,
      employeeName: spec.employee.name,
      toolName: spec.toolName,
      toolKind: spec.kind,
      arguments: args,
      cwd: agent.cwd ?? "",
    };
    const grant = await verifyGrant(spec.runtime, spec.employee, app, request);
    if (!grant.allow) return errorResult(grant.message);
    await recordExecution(spec.runtime, grant.record.id, "running", `${spec.toolName} 开始执行`);
    try {
      const result = await run(args, api, context);
      await recordExecution(
        spec.runtime,
        grant.record.id,
        result.isError === true ? "failed" : "succeeded",
        result.isError === true ? `${spec.toolName} 返回错误` : `${spec.toolName} 已完成`,
      );
      return result;
    } catch (error) {
      await recordExecution(spec.runtime, grant.record.id, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
}

export function buildFileTools(context: ToolContext): ToolRegistration[] {
  const { runtime, employee, skills } = context;

  const readFile = defineTool({
    name: "read_file",
    description:
      "Read a UTF-8 text file inside your working directory or a skill directory. " +
      "Returns the file with 1-based line numbers.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to your working directory, or absolute inside it" }),
      offset: Type.Optional(Type.Number({ description: "First 1-based line to return" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines" })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const env = api.env;
      if (env === undefined) return errorResult("没有可用的执行环境");
      const resolved = await resolveWithin(env, ctx, args.path, allowedRoots(employee, skills, true));
      if (!resolved.ok) return errorResult(resolved.message);
      const read = await env.readTextFile(resolved.path, ctx);
      if (!read.ok) return errorResult(`读取失败 ${resolved.path}: ${read.error.message}`);
      if (read.value.length > MAX_READ_BYTES) {
        return errorResult(
          `文件过大（${read.value.length} 字节，上限 ${MAX_READ_BYTES}）。请先用 run_shell 或分段读取。`,
        );
      }
      const lines = read.value.split("\n");
      const offset = Math.max(1, args.offset ?? 1);
      const limit = Math.max(1, Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((line, index) => `${offset + index}: ${line}`).join("\n");
      const suffix = lines.length > offset - 1 + slice.length ? `\n… 共 ${lines.length} 行` : "";
      return textResult(`${numbered}${suffix}`);
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    description: "Write a UTF-8 text file inside your working directory, creating or replacing it.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to your working directory" }),
      content: Type.String({ description: "Complete file content" }),
    }),
    execute: gatedExecute(
      { runtime, employee, toolName: "write_file", kind: "file-write" },
      async (args, api, ctx) => {
        const env = api.env;
        if (env === undefined) return errorResult("没有可用的执行环境");
        const resolved = await resolveWithin(env, ctx, args.path, allowedRoots(employee, skills, false));
        if (!resolved.ok) return errorResult(resolved.message);
        const parent = dirname(resolved.path);
        const created = await env.createDir(parent, { recursive: true }, ctx);
        if (!created.ok && !created.error.message.includes("exist")) {
          return errorResult(`无法创建目录 ${parent}: ${created.error.message}`);
        }
        const written = await env.writeFile(resolved.path, args.content, ctx);
        if (!written.ok) return errorResult(`写入失败 ${resolved.path}: ${written.error.message}`);
        return textResult(`已写入 ${resolved.path}（${args.content.length} 字符）`);
      },
    ),
  });

  const editFile = defineTool({
    name: "edit_file",
    description:
      "Replace an exact text snippet in a file inside your working directory. " +
      "The old text must appear exactly once unless replaceAll is set.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to your working directory" }),
      oldText: Type.String({ description: "Exact text to replace" }),
      newText: Type.String({ description: "Replacement text" }),
      replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence" })),
    }),
    execute: gatedExecute(
      { runtime, employee, toolName: "edit_file", kind: "file-write" },
      async (args, api, ctx) => {
        const env = api.env;
        if (env === undefined) return errorResult("没有可用的执行环境");
        if (args.oldText.length === 0) return errorResult("oldText 不能为空");
        const resolved = await resolveWithin(env, ctx, args.path, allowedRoots(employee, skills, false));
        if (!resolved.ok) return errorResult(resolved.message);
        const read = await env.readTextFile(resolved.path, ctx);
        if (!read.ok) return errorResult(`读取失败 ${resolved.path}: ${read.error.message}`);
        const occurrences = read.value.split(args.oldText).length - 1;
        if (occurrences === 0) return errorResult("文件中找不到 oldText");
        if (occurrences > 1 && args.replaceAll !== true) {
          return errorResult(`oldText 出现了 ${occurrences} 次；请提供更精确的片段或设置 replaceAll`);
        }
        const updated = args.replaceAll === true ? read.value.split(args.oldText).join(args.newText) : read.value.replace(args.oldText, args.newText);
        const written = await env.writeFile(resolved.path, updated, ctx);
        if (!written.ok) return errorResult(`写入失败 ${resolved.path}: ${written.error.message}`);
        return textResult(`已更新 ${resolved.path}（替换 ${args.replaceAll === true ? occurrences : 1} 处）`);
      },
    ),
  });

  const runShell = defineTool({
    name: "run_shell",
    description:
      "Run a shell command inside your working directory. Output is streamed and truncated; " +
      "a long-running command is stopped at the timeout.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command line" }),
      cwd: Type.Optional(Type.String({ description: "Directory to run in; defaults to your working directory" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
    }),
    execute: gatedExecute(
      { runtime, employee, toolName: "run_shell", kind: "shell" },
      async (args, api, ctx) => {
        const env = api.env;
        if (env === undefined) return errorResult("没有可用的执行环境");
        let cwd = employee.cwd;
        if (args.cwd !== undefined && args.cwd.length > 0) {
          const resolved = await resolveWithin(env, ctx, args.cwd, allowedRoots(employee, skills, false));
          if (!resolved.ok) return errorResult(resolved.message);
          cwd = resolved.path;
        } else if (cwd.length > 0) {
          const resolved = await resolveWithin(env, ctx, cwd, allowedRoots(employee, skills, false));
          if (!resolved.ok) return errorResult(resolved.message);
          cwd = resolved.path;
        }
        const result = await env.exec(
          args.command,
          {
            ...(cwd.length > 0 ? { cwd } : {}),
            timeout: args.timeoutMs !== undefined && args.timeoutMs > 0 ? args.timeoutMs : SHELL_TIMEOUT_MS,
            onOutput: (chunk) => api.output(chunk),
            spill: { afterBytes: SHELL_SPILL_BYTES, afterLines: 2_000 },
          },
          ctx,
        );
        if (!result.ok) {
          return errorResult(`命令失败: ${result.error.message}${result.error.spillPath !== undefined ? `\n完整输出: ${result.error.spillPath}` : ""}`);
        }
        const spill = result.value.spillPath !== undefined ? `\n完整输出已写入 ${result.value.spillPath}` : "";
        if (result.value.exitCode !== 0) {
          return { isError: true, content: [{ type: "text", text: `退出码 ${result.value.exitCode}${spill}` }] };
        }
        return textResult(`退出码 0${spill}`);
      },
    ),
  });

  const loadSkill = defineTool({
    name: "load_skill",
    description: "Read the full SKILL.md of one of your bound skills, by name.",
    parameters: Type.Object({ name: Type.String({ description: "Skill name or id" }) }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const env = api.env;
      if (env === undefined) return errorResult("没有可用的执行环境");
      const skill = findBoundSkill(skills, employee.skillIds, args.name);
      if (skill === undefined) {
        const bound = skills.filter((entry) => employee.skillIds.includes(entry.id));
        return errorResult(
          `没有名为 ${args.name} 的技能。已绑定：${bound.map((entry) => entry.name).join(", ") || "(无)"}`,
        );
      }
      const resolved = await resolveWithin(env, ctx, skill.filePath, [skill.directory]);
      if (!resolved.ok) return errorResult(resolved.message);
      const read = await env.readTextFile(resolved.path, ctx);
      if (!read.ok) return errorResult(`读取失败 ${resolved.path}: ${read.error.message}`);
      const base = `技能目录：${skill.directory}\n配套文件请用相对该目录的路径访问。\n\n`;
      if (read.value.length > MAX_READ_BYTES) {
        return textResult(`${base}${read.value.slice(0, MAX_READ_BYTES)}\n… 已截断`);
      }
      return textResult(`${base}${read.value}`);
    },
  });

  return [readFile, writeFile, editFile, runShell, loadSkill];
}

export { errorResult as toolError, textResult as toolText };
