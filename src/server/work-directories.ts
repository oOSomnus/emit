import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  ConversationContextDoc,
  RoomDoc,
  WorkDoc,
  type WorkDirectoryScopeRecord,
} from "./documents.ts";
import type { EmitRuntime } from "./runtime.ts";

export type WorkDirectoryScopeResult =
  | { ok: true; scope: WorkDirectoryScopeRecord }
  | { ok: false; message: string };

export type ResolvedToolDirectoryScope = {
  scope: WorkDirectoryScopeRecord;
  cwd: string;
  targetPaths: string[];
};

export type ToolDirectoryScopeResult =
  | ({ ok: true } & ResolvedToolDirectoryScope)
  | { ok: false; message: string };

function validDirectories(value: unknown): value is { paths: string[]; defaultPath: string; version: number } {
  if (typeof value !== "object" || value === null) return false;
  const directories = value as Record<string, unknown>;
  return (
    Number.isInteger(directories.version) &&
    Array.isArray(directories.paths) &&
    directories.paths.every((path) => typeof path === "string") &&
    typeof directories.defaultPath === "string"
  );
}


/** Resolve and verify the immutable room-directory snapshot bound to one work conversation. */
export async function readWorkDirectoryScope(
  runtime: EmitRuntime,
  conversationId: number,
): Promise<WorkDirectoryScopeResult> {
  const binding = await runtime.readConversationDoc(ConversationContextDoc, conversationId);
  if (binding === undefined || binding.workId.length === 0) {
    return { ok: false, message: "该会话没有绑定工作上下文，已阻止本地目录工具" };
  }
  const work = await runtime.readFamily(WorkDoc, binding.workId, { id: binding.workId });
  if (work === undefined || work.conversationId !== conversationId || work.roomId !== binding.roomId) {
    return { ok: false, message: "该会话没有有效工作记录，已阻止本地目录工具" };
  }
  const candidate: unknown = work.directoryScope;
  if (!validDirectories(candidate) || typeof (candidate as WorkDirectoryScopeRecord).roomId !== "string") {
    return { ok: false, message: "该会话缺少目录配置，请重新创建会话" };
  }
  const scope = candidate as WorkDirectoryScopeRecord;
  if (
    scope.roomId.length === 0 ||
    (work.roomId.length > 0 && scope.roomId !== work.roomId) ||
    scope.version < 1 ||
    (scope.paths.length === 0 ? scope.defaultPath !== "" : !scope.paths.includes(scope.defaultPath))
  ) {
    return { ok: false, message: "该会话缺少目录配置，请重新创建会话" };
  }
  const room = await runtime.readFamily(RoomDoc, scope.roomId, { id: scope.roomId });
  if (room === undefined || !validDirectories(room.directories)) {
    return { ok: false, message: "该会话缺少目录配置，请重新创建会话" };
  }
  if (
    room.directories.version !== scope.version ||
    room.directories.defaultPath !== scope.defaultPath ||
    !(
      room.directories.paths.length === scope.paths.length &&
      room.directories.paths.every((path, index) => path === scope.paths[index])
    )
  ) {
    return { ok: false, message: "会话工作目录已变更，请停止并重新发送任务" };
  }
  for (const path of scope.paths) {
    try {
      const canonical = await realpath(path);
      const info = await stat(canonical);
      if (canonical !== path || !info.isDirectory()) {
        return { ok: false, message: "会话工作目录已变更，请停止并重新发送任务" };
      }
    } catch {
      return { ok: false, message: "会话工作目录已变更，请停止并重新发送任务" };
    }
  }
  return {
    ok: true,
    scope: {
      roomId: scope.roomId,
      version: scope.version,
      paths: [...scope.paths],
      defaultPath: scope.defaultPath,
    },
  };
}

/** Canonicalize a target, including paths below a not-yet-created parent. */
export async function canonicalTarget(
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
    if (parent === current) return { ok: false, message: `无法解析路径：${absolute}` };
    suffix = suffix.length === 0 ? basename(current) : join(basename(current), suffix);
    current = parent;
  }
  return { ok: false, message: `路径层级过深：${absolute}` };
}

/** Resolve a path against an explicit base and confine it to canonical roots. */
export async function resolveWithin(
  env: ExecutionEnv,
  context: Context,
  target: string,
  roots: readonly string[],
  baseDirectory: string,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  if (target.length === 0) return { ok: false, message: "路径不能为空" };
  if (!isAbsolute(target) && baseDirectory.length === 0) {
    return { ok: false, message: `没有默认工作目录，不能解析相对路径：${target}` };
  }
  const absolute = isAbsolute(target) ? target : resolve(baseDirectory, target);
  const canonical = await canonicalTarget(env, context, absolute);
  if (!canonical.ok) return canonical;
  const allowed: string[] = [];
  for (const root of roots) {
    if (root.length === 0) continue;
    const resolved = await canonicalTarget(env, context, root);
    if (resolved.ok) allowed.push(resolved.path);
  }
  const inside = allowed.some(
    (root) => canonical.path === root || canonical.path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
  );
  if (!inside) {
    return {
      ok: false,
      message:
        `路径 ${canonical.path} 超出该会话允许的目录。\n` +
        `允许的目录：${allowed.length > 0 ? allowed.join(", ") : "(未配置工作目录)"}`,
    };
  }
  return { ok: true, path: canonical.path };
}

function isArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the directory binding and canonical paths for the exact tool action. */
export async function resolveToolDirectoryScope(
  runtime: EmitRuntime,
  conversationId: number,
  toolName: string,
  args: unknown,
  context: Context,
  env?: ExecutionEnv,
): Promise<ToolDirectoryScopeResult> {
  const binding = await readWorkDirectoryScope(runtime, conversationId);
  if (!binding.ok) return binding;
  const { scope } = binding;
  const executionEnv = env ?? new NodeExecutionEnv({ cwd: scope.defaultPath || process.cwd() });
  const values = isArguments(args) ? args : {};

  if (toolName === "write_file" || toolName === "edit_file") {
    if (typeof values.path !== "string" || values.path.length === 0) {
      return { ok: false, message: `${toolName} 缺少有效的 path 参数` };
    }
    const resolved = await resolveWithin(executionEnv, context, values.path, scope.paths, scope.defaultPath);
    if (!resolved.ok) return resolved;
    return { ok: true, scope, cwd: scope.defaultPath, targetPaths: [resolved.path] };
  }

  if (toolName === "run_shell") {
    if (values.cwd !== undefined && typeof values.cwd !== "string") {
      return { ok: false, message: "run_shell 的 cwd 必须是路径字符串" };
    }
    const requested = typeof values.cwd === "string" && values.cwd.length > 0 ? values.cwd : scope.defaultPath;
    if (requested.length === 0) {
      return { ok: false, message: "该会话没有默认工作目录，无法执行本地 Shell" };
    }
    const resolved = await resolveWithin(executionEnv, context, requested, scope.paths, scope.defaultPath);
    if (!resolved.ok) return resolved;
    return { ok: true, scope, cwd: resolved.path, targetPaths: [] };
  }

  return { ok: true, scope, cwd: scope.defaultPath, targetPaths: [] };
}
