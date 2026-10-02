/**
 * Workspace identity and the employee directory.
 *
 * An employee is a durable record: role, instructions, its own model and
 * effort, its own working directory, and its own skill, MCP, and tool policy.
 * The record is the single source of truth; runtime agents and extensions are
 * rebuilt from it, never the other way around.
 */

import type {
  AppConfigDTO,
  ApprovalEvaluatorConfigDTO,
  ChatSelectionDTO,
  CollaborationLimitsDTO,
  EmployeeDTO,
  EmployeeDraftDTO,
  EmployeeToolPolicyDTO,
} from "../shared/contracts.ts";
import { AppDoc, EmployeeDoc, type AppRecord, type EmployeeRecord } from "./documents.ts";
import { completeText, parseJsonObject } from "./llm.ts";
import type { EmitRuntime } from "./runtime.ts";
import { CLASSIFIER_CRITERIA_VERSION, LLM_CRITERIA_VERSION } from "./approval/evaluators.ts";

/** Local parts that must not be handed to a digital employee. */
const RESERVED_LOCAL_PARTS = [
  "admin",
  "postmaster",
  "noreply",
  "no-reply",
  "root",
  "abuse",
  "mailer-daemon",
  "hostmaster",
  "webmaster",
  "security",
];

/**
 * Local parts may carry any letter or digit.
 *
 * The workspace is a Chinese-language product and addresses never leave the
 * machine, so a name like 小柯 has to survive as an address instead of being
 * stripped down to "employee"; ASCII is not the only alphabet a directory of
 * digital employees is named in.
 */
const ADDRESS_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "workspace";
}

export function workspaceDomain(app: AppRecord): string {
  return `${app.workspaceSlug}.test`;
}

export function toChatSelection(selection: {
  providerId: string;
  modelId: string;
  effort: string;
} | null): ChatSelectionDTO | null {
  if (selection === null || selection.providerId.length === 0 || selection.modelId.length === 0) return null;
  return { model: { providerId: selection.providerId, modelId: selection.modelId }, effort: selection.effort };
}

export function toEmployeeDTO(record: EmployeeRecord): EmployeeDTO {
  return {
    id: record.id,
    name: record.name,
    address: record.address,
    addressSource: record.addressSource,
    role: record.role,
    instructions: record.instructions,
    executionModel: {
      model: { providerId: record.executionModel.providerId, modelId: record.executionModel.modelId },
      effort: record.executionModel.effort,
    },
    cwd: record.cwd,
    skillIds: [...record.skillIds],
    mcpServerIds: [...record.mcpServerIds],
    toolPolicy: {
      allowedTools: [...record.allowedTools],
      trustedReadOnlyTools: [...record.trustedReadOnlyTools],
    },
    enabled: record.enabled,
    configVersion: record.configVersion,
    createdAt: record.createdAt,
  };
}

export async function readApp(runtime: EmitRuntime): Promise<AppRecord> {
  return runtime.readSession(AppDoc);
}

export function toAppDTO(app: AppRecord): AppConfigDTO {
  return {
    onboarded: app.onboarded,
    workspace: { name: app.workspaceName, slug: app.workspaceSlug },
    user: { name: app.userName, address: app.userAddress },
    defaultExecutionModel: toChatSelection(app.defaultExecutionModel),
    approval:
      app.approval.providerId.length === 0 || app.approval.modelId.length === 0
        ? null
        : app.approval.kind === "llm"
          ? {
              kind: "llm",
              model: { providerId: app.approval.providerId, modelId: app.approval.modelId },
              effort: app.approval.effort,
              criteriaVersion: LLM_CRITERIA_VERSION,
            }
          : {
              kind: "classifier",
              model: { providerId: app.approval.providerId, modelId: app.approval.modelId },
              criteriaVersion: CLASSIFIER_CRITERIA_VERSION,
              minApproveProbability: app.approval.minApproveProbability,
              minAuthorizedProbability: app.approval.minAuthorizedProbability,
              requireAuthorized: app.approval.requireAuthorized,
            },
    collaboration: { ...app.collaboration },
    policyVersion: app.policyVersion,
  };
}

export async function listEmployees(runtime: EmitRuntime): Promise<EmployeeRecord[]> {
  const members = await runtime.listFamily(EmployeeDoc, (id) => ({ id }));
  return members.map((member) => member.value).sort((a, b) => a.createdAt - b.createdAt);
}

export async function findEmployee(runtime: EmitRuntime, id: string): Promise<EmployeeRecord | undefined> {
  const members = await runtime.listFamily(EmployeeDoc, (key) => ({ id: key }));
  return members.find((member) => member.key === id)?.value;
}

function defaultToolPolicy(): EmployeeToolPolicyDTO {
  return {
    allowedTools: ["read_file", "write_file", "edit_file", "run_shell", "load_skill"],
    trustedReadOnlyTools: [],
  };
}

function newEmployeeId(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name).replace(/-/g, "") || "employee";
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${base}${counter}`;
    counter += 1;
  }
  return candidate;
}

function normalizeLocalPart(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .slice(0, 64);
}

/** Reserve a unique, valid address; collisions get a deterministic numeric suffix. */
export function allocateAddress(
  desiredLocalPart: string,
  domain: string,
  taken: ReadonlySet<string>,
): string {
  const base = normalizeLocalPart(desiredLocalPart);
  const usable = base.length > 0 && ADDRESS_PATTERN.test(base) && !RESERVED_LOCAL_PARTS.includes(base) ? base : "employee";
  let candidate = usable;
  let counter = 2;
  while (taken.has(`${candidate}@${domain}`)) {
    candidate = `${usable}${counter}`;
    counter += 1;
  }
  return `${candidate}@${domain}`;
}

/**
 * Ask the configured model for a plausible local part. The model only
 * proposes; the server validates and de-duplicates, so an unhelpful answer is
 * harmless and a missing model degrades to a manual address instead of a
 * fabricated one.
 */
export async function suggestLocalPart(
  runtime: EmitRuntime,
  model: { providerId: string; modelId: string; effort: string } | null,
  input: { name: string; role: string; workspaceSlug: string },
): Promise<string | null> {
  if (model === null || model.providerId.length === 0) return null;
  const outcome = await completeText(
    runtime.catalog,
    model,
    {
      system:
        "You propose professional email addresses for a company directory. " +
        "Answer with a single JSON object and nothing else.",
      prompt:
        `Workspace: ${input.workspaceSlug}\n` +
        `Member name: ${input.name}\n` +
        `Role: ${input.role.length > 0 ? input.role : "(unnamed role)"}\n\n` +
        `Propose one short, professional email local part for this member: lowercase letters, digits, dots ` +
        `or hyphens only, no spaces, at most 24 characters, derived from the name, optionally suffixed with the role.\n` +
        `Reply as {"localpart": "..."}.`,
      maxTokens: 200,
    },
  );
  if (!outcome.ok) return null;
  const parsed = parseJsonObject(outcome.text);
  if (typeof parsed !== "object" || parsed === null || !("localpart" in parsed)) return null;
  // `parseJsonObject` returns data derived from model output; `in` narrows to
  // `unknown`, so the value is still checked before use.
  const localpart = parsed.localpart;
  if (typeof localpart !== "string") return null;
  const normalized = normalizeLocalPart(localpart);
  return normalized.length > 0 && ADDRESS_PATTERN.test(normalized) ? normalized : null;
}

export type SetupInput = {
  workspaceName: string;
  userName: string;
  defaultExecutionModel: ChatSelectionDTO | null;
  approval: AppConfigDTO["approval"];
};

/**
 * A rejected input, as opposed to a broken server.
 *
 * The HTTP layer turns these into a 400 with the reason, so a bad model
 * selection reads as "this choice is wrong" rather than a crash.
 */
export class ValidationError extends Error {}

export async function setupWorkspace(runtime: EmitRuntime, input: SetupInput): Promise<AppRecord> {
  const workspaceSlug = slugify(input.workspaceName);
  const app = await runtime.updateSession(AppDoc, (draft) => {
    draft.workspaceName = input.workspaceName;
    draft.workspaceSlug = workspaceSlug;
    draft.userName = input.userName;
    draft.defaultExecutionModel =
      input.defaultExecutionModel === null
        ? null
        : {
            providerId: input.defaultExecutionModel.model.providerId,
            modelId: input.defaultExecutionModel.model.modelId,
            effort: input.defaultExecutionModel.effort,
          };
    if (input.approval !== null) {
      draft.approval = {
        kind: input.approval.kind,
        providerId: input.approval.model.providerId,
        modelId: input.approval.model.modelId,
        effort: input.approval.kind === "llm" ? input.approval.effort : "off",
        criteriaVersion: input.approval.kind === "llm" ? LLM_CRITERIA_VERSION : CLASSIFIER_CRITERIA_VERSION,
        minApproveProbability:
          input.approval.kind === "classifier" ? input.approval.minApproveProbability : 0.99,
        minAuthorizedProbability:
          input.approval.kind === "classifier" ? input.approval.minAuthorizedProbability : 0.99,
        requireAuthorized: input.approval.kind === "classifier" ? input.approval.requireAuthorized : true,
      };
    }
    draft.onboarded = true;
  });
  assertChatSelection(runtime, input.defaultExecutionModel, "默认执行模型");
  assertApproval(runtime, input.approval);
  const domain = workspaceDomain(app);
  const taken = new Set<string>();
  for (const employee of await listEmployees(runtime)) taken.add(employee.address);
  const userLocal = await suggestLocalPart(
    runtime,
    app.defaultExecutionModel,
    { name: app.userName, role: `owner of ${app.workspaceName}`, workspaceSlug: app.workspaceSlug },
  );
  const userAddress = allocateAddress(userLocal ?? slugify(app.userName), domain, taken);
  return runtime.updateSession(AppDoc, (draft) => {
    draft.userAddress = userAddress;
  });
}

export type AppPatch = {
  workspaceName?: string;
  userName?: string;
  defaultExecutionModel?: ChatSelectionDTO | null;
  approval?: AppConfigDTO["approval"];
  collaboration?: CollaborationLimitsDTO;
};

/**
 * Change workspace-level settings.
 *
 * A change to the approval configuration bumps `policyVersion`, which is part
 * of every approval key. Unconsumed grants therefore cannot be spent under a
 * policy their evaluator never saw; they are marked stale on the next read.
 */
export async function updateAppConfig(runtime: EmitRuntime, patch: AppPatch): Promise<AppRecord> {
  const saved = await runtime.updateSession(AppDoc, (draft) => {
    if (patch.workspaceName !== undefined && patch.workspaceName.length > 0) {
      draft.workspaceName = patch.workspaceName;
      draft.workspaceSlug = slugify(patch.workspaceName);
    }
    if (patch.userName !== undefined && patch.userName.length > 0) draft.userName = patch.userName;
    if (patch.defaultExecutionModel !== undefined) {
      draft.defaultExecutionModel =
        patch.defaultExecutionModel === null
          ? null
          : {
              providerId: patch.defaultExecutionModel.model.providerId,
              modelId: patch.defaultExecutionModel.model.modelId,
              effort: patch.defaultExecutionModel.effort,
            };
    }
    if (patch.collaboration !== undefined) {
      draft.collaboration = {
        maxDepth: Math.max(1, Math.floor(patch.collaboration.maxDepth)),
        maxCrossEmployeeWakes: Math.max(1, Math.floor(patch.collaboration.maxCrossEmployeeWakes)),
        maxModelTurns: Math.max(1, Math.floor(patch.collaboration.maxModelTurns)),
      };
    }
    if (patch.approval !== undefined && patch.approval !== null) {
      const approval = patch.approval;
      draft.approval = {
        kind: approval.kind,
        providerId: approval.model.providerId,
        modelId: approval.model.modelId,
        effort: approval.kind === "llm" ? approval.effort : "off",
        criteriaVersion: approval.kind === "llm" ? LLM_CRITERIA_VERSION : CLASSIFIER_CRITERIA_VERSION,
        minApproveProbability: approval.kind === "classifier" ? approval.minApproveProbability : 0.99,
        minAuthorizedProbability: approval.kind === "classifier" ? approval.minAuthorizedProbability : 0.99,
        requireAuthorized: approval.kind === "classifier" ? approval.requireAuthorized : true,
      };
      draft.policyVersion += 1;
    }
  });
  runtime.emit({ type: "app", app: toAppDTO(saved) });
  return saved;
}

export async function createEmployee(runtime: EmitRuntime, draft: EmployeeDraftDTO): Promise<EmployeeRecord> {
  const app = await readApp(runtime);
  const existing = await listEmployees(runtime);
  const takenIds = new Set(existing.map((employee) => employee.id));
  // The user's own address is reserved: a directory where an employee owns the
  // owner's address can no longer route mail by address unambiguously.
  const takenAddresses = new Set([app.userAddress, ...existing.map((employee) => employee.address)]);
  const id = newEmployeeId(draft.name, takenIds);
  const domain = workspaceDomain(app);

  const executionModel =
    draft.executionModel?.model.providerId !== undefined && draft.executionModel.model.providerId.length > 0
      ? {
          providerId: draft.executionModel.model.providerId,
          modelId: draft.executionModel.model.modelId,
          effort: draft.executionModel.effort,
        }
      : (app.defaultExecutionModel ?? { providerId: "", modelId: "", effort: "off" });

  let addressSource: "llm" | "manual" = "manual";
  let desired = slugify(draft.name);
  if (draft.generateAddress !== false) {
    const proposal = await suggestLocalPart(runtime, app.defaultExecutionModel, {
      name: draft.name,
      role: draft.role,
      workspaceSlug: app.workspaceSlug,
    });
    if (proposal !== null) {
      desired = proposal;
      addressSource = "llm";
    }
  }
  assertChatSelection(runtime, { model: executionModel, effort: executionModel.effort }, "员工执行模型");
  const policy = draft.toolPolicy ?? defaultToolPolicy();

  const record: EmployeeRecord = {
    id,
    name: draft.name,
    address: allocateAddress(desired, domain, takenAddresses),
    addressSource,
    role: draft.role,
    instructions: draft.instructions ?? "",
    executionModel,
    cwd: draft.cwd ?? "",
    skillIds: [...(draft.skillIds ?? [])],
    mcpServerIds: [...(draft.mcpServerIds ?? [])],
    allowedTools: [...policy.allowedTools],
    trustedReadOnlyTools: [...policy.trustedReadOnlyTools],
    enabled: true,
    configVersion: 1,
    createdAt: Date.now(),
  };
  const saved = await runtime.updateFamily(EmployeeDoc, id, { id }, (doc) => {
    Object.assign(doc, record);
  });
  runtime.emit({ type: "employee", employee: toEmployeeDTO(saved) });
  return saved;
}

export type EmployeePatch = {
  name?: string;
  role?: string;
  instructions?: string;
  executionModel?: ChatSelectionDTO;
  cwd?: string;
  skillIds?: string[];
  mcpServerIds?: string[];
  toolPolicy?: EmployeeToolPolicyDTO;
  enabled?: boolean;
  address?: string;
  addressSource?: "llm" | "manual";
};

export async function updateEmployee(
  runtime: EmitRuntime,
  id: string,
  patch: EmployeePatch,
): Promise<EmployeeRecord> {
  const current = await findEmployee(runtime, id);
  if (current === undefined) throw new Error(`员工不存在: ${id}`);
  if (patch.address !== undefined) {
    const app = await readApp(runtime);
    const domain = workspaceDomain(app);
    const others = new Set([
      app.userAddress,
      ...(await listEmployees(runtime)).filter((e) => e.id !== id).map((e) => e.address),
    ]);
    const normalized = normalizeLocalPart(patch.address.split("@")[0] ?? patch.address);
    if (normalized.length === 0) throw new ValidationError("邮箱本地部分无效");
    const address = allocateAddress(normalized, domain, others);
    patch = { ...patch, address };
  }
  if (patch.executionModel !== undefined) {
    assertChatSelection(runtime, patch.executionModel, "员工执行模型");
  }
  const saved = await runtime.updateFamily(EmployeeDoc, id, { id }, (doc) => {
    if (patch.name !== undefined) doc.name = patch.name;
    if (patch.role !== undefined) doc.role = patch.role;
    if (patch.instructions !== undefined) doc.instructions = patch.instructions;
    if (patch.executionModel !== undefined) {
      doc.executionModel = {
        providerId: patch.executionModel.model.providerId,
        modelId: patch.executionModel.model.modelId,
        effort: patch.executionModel.effort,
      };
    }
    if (patch.cwd !== undefined) doc.cwd = patch.cwd;
    if (patch.skillIds !== undefined) doc.skillIds = [...patch.skillIds];
    if (patch.mcpServerIds !== undefined) doc.mcpServerIds = [...patch.mcpServerIds];
    if (patch.toolPolicy !== undefined) {
      doc.allowedTools = [...patch.toolPolicy.allowedTools];
      doc.trustedReadOnlyTools = [...patch.toolPolicy.trustedReadOnlyTools];
    }
    if (patch.enabled !== undefined) doc.enabled = patch.enabled;
    if (patch.address !== undefined) doc.address = patch.address;
    if (patch.addressSource !== undefined) doc.addressSource = patch.addressSource;
    doc.configVersion += 1;
  });
  runtime.emit({ type: "employee", employee: toEmployeeDTO(saved) });
  return saved;
}

/** Resolve a recipient written as an address, an id, or a display name. */
export function resolveEmployee(
  employees: readonly EmployeeRecord[],
  token: string,
): EmployeeRecord | undefined {
  const lowered = token.trim().toLowerCase();
  return employees.find(
    (employee) =>
      employee.id.toLowerCase() === lowered ||
      employee.address.toLowerCase() === lowered ||
      employee.name.toLowerCase() === lowered ||
      `@${employee.name.toLowerCase()}` === lowered,
  );
}

/** A stored chat selection in the shape the catalog validates. */
function chatSelection(selection: {
  model: { providerId: string; modelId: string };
  effort: string;
}): { providerId: string; modelId: string; effort: string } {
  return { providerId: selection.model.providerId, modelId: selection.model.modelId, effort: selection.effort };
}

/**
 * Refuse a model the catalog cannot run.
 *
 * This is the write-time half of "an employee only ever holds a usable model";
 * the read half is that a run started with a model that has since disappeared
 * reports the failure instead of quietly using another one.
 */
function assertChatSelection(
  runtime: EmitRuntime,
  selection: ChatSelectionDTO | null,
  label: string,
): void {
  if (selection === null) return;
  const problem = runtime.catalog.chatSelectionProblem(chatSelection(selection));
  if (problem !== undefined) throw new ValidationError(`${label}不可用：${problem}`);
}

function assertApproval(runtime: EmitRuntime, config: ApprovalEvaluatorConfigDTO | null): void {
  if (config === null) return;
  const problem = runtime.catalog.approvalProblem({
    kind: config.kind,
    providerId: config.model.providerId,
    modelId: config.model.modelId,
    effort: config.kind === "llm" ? config.effort : "off",
  });
  if (problem !== undefined) throw new ValidationError(`审批判断模型不可用：${problem}`);
}
