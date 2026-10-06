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
import type { ConversationId, Cursor, EntryRecord, Tx } from "@earendil-works/pi-durable";
import {
  AppDoc,
  EmployeeDoc,
  MailFlagDoc,
  RoomDoc,
  RoomMessageEntry,
  type AppRecord,
  type EmployeeRecord,
  type MessageAddressOverride,
  type MessageAddressOverrides,
} from "./documents.ts";
import { completeText, parseJsonObject } from "./llm.ts";
import { AppError } from "./messages.ts";
import { workspaceMessages, type ExecutionModelScope } from "./messages/workspace.ts";
import { renderAddressSystem, renderAddressUser } from "./prompts/index.ts";
import type { EmitRuntime } from "./runtime.ts";
import { CLASSIFIER_CRITERIA_VERSION, LLM_CRITERIA_VERSION } from "./approval/evaluators.ts";

/** The one internal address domain: every identity is `localpart@emit`. */
export const INTERNAL_ADDRESS_DOMAIN = "emit";

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
 * The workspace addresses never leave the machine, so a name in any script —
 * not just ASCII — has to survive as an address instead of being stripped
 * down to "employee"; ASCII is not the only alphabet a directory of digital
 * employees is named in.
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
  input: { name: string; role: string },
): Promise<string | null> {
  if (model === null || model.providerId.length === 0) return null;
  const outcome = await completeText(
    runtime.catalog,
    model,
    {
      system: renderAddressSystem(),
      prompt: renderAddressUser({
        name: input.name,
        role: input.role,
      }),
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
export class ValidationError extends AppError {}

export async function setupWorkspace(runtime: EmitRuntime, input: SetupInput): Promise<AppRecord> {
  if (input.approval === null) throw new ValidationError(workspaceMessages.approvalJudgeRequired);
  assertChatSelection(runtime, input.defaultExecutionModel, "default");
  assertApproval(runtime, input.approval);
  const approval = input.approval;
  const app = await runtime.updateSession(AppDoc, (draft) => {
    draft.userName = input.userName;
    draft.defaultExecutionModel =
      input.defaultExecutionModel === null
        ? null
        : {
            providerId: input.defaultExecutionModel.model.providerId,
            modelId: input.defaultExecutionModel.model.modelId,
            effort: input.defaultExecutionModel.effort,
          };
    draft.approval = {
      kind: approval.kind,
      providerId: approval.model.providerId,
      modelId: approval.model.modelId,
      effort: approval.kind === "llm" ? approval.effort : "off",
      criteriaVersion: approval.kind === "llm" ? LLM_CRITERIA_VERSION : CLASSIFIER_CRITERIA_VERSION,
    };
    draft.onboarded = true;
  });
  const taken = new Set<string>();
  for (const employee of await listEmployees(runtime)) taken.add(employee.address);
  const userLocal = await suggestLocalPart(runtime, app.defaultExecutionModel, {
    name: app.userName,
    role: "workspace owner",
  });
  const userAddress = allocateAddress(userLocal ?? slugify(app.userName), INTERNAL_ADDRESS_DOMAIN, taken);
  return runtime.updateSession(AppDoc, (draft) => {
    draft.userAddress = userAddress;
  });
}

export type AppPatch = {
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
  const approval = patch.approval;
  if (approval === null) throw new ValidationError(workspaceMessages.approvalJudgeEmpty);
  if (approval !== undefined) assertApproval(runtime, approval);
  const saved = await runtime.updateSession(AppDoc, (draft) => {
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
    if (approval !== undefined) {
      draft.approval = {
        kind: approval.kind,
        providerId: approval.model.providerId,
        modelId: approval.model.modelId,
        effort: approval.kind === "llm" ? approval.effort : "off",
        criteriaVersion: approval.kind === "llm" ? LLM_CRITERIA_VERSION : CLASSIFIER_CRITERIA_VERSION,
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
    });
    if (proposal !== null) {
      desired = proposal;
      addressSource = "llm";
    }
  }
  assertChatSelection(runtime, { model: executionModel, effort: executionModel.effort }, "employee");
  const policy = draft.toolPolicy ?? defaultToolPolicy();

  const record: EmployeeRecord = {
    id,
    name: draft.name,
    address: allocateAddress(desired, INTERNAL_ADDRESS_DOMAIN, takenAddresses),
    addressSource,
    role: draft.role,
    instructions: draft.instructions ?? "",
    executionModel,
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
  if (current === undefined) throw new AppError(workspaceMessages.employeeNotFound(id));
  if (patch.address !== undefined) {
    const app = await readApp(runtime);
    const others = new Set([
      app.userAddress,
      ...(await listEmployees(runtime)).filter((e) => e.id !== id).map((e) => e.address),
    ]);
    const normalized = normalizeLocalPart(patch.address.split("@")[0] ?? patch.address);
    if (normalized.length === 0) throw new ValidationError(workspaceMessages.employeeLocalPartInvalid);
    const address = allocateAddress(normalized, INTERNAL_ADDRESS_DOMAIN, others);
    patch = { ...patch, address };
  }
  if (patch.executionModel !== undefined) {
    assertChatSelection(runtime, patch.executionModel, "employee");
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

/** The identity a retired address belonged to, while a migration rewrites it. */
type LegacyIdentity = { kind: "user" } | { kind: "employee"; id: string };

/**
 * One shared instance per identity: every lookup returns a registered object,
 * so identities compare by reference.
 */
const LEGACY_USER_IDENTITY: LegacyIdentity = { kind: "user" };

/**
 * Rewrite a historical To/CC target onto the new internal address.
 *
 * A target with no name is how a typed external address is stored, so it is
 * kept as written even when it happens to equal a retired internal address.
 * Employee candidates are limited to the envelope's own wake set; a target
 * that matches several identities that the envelope cannot disambiguate stops
 * the migration instead of guessing.
 */
function migrateMailTarget(
  target: { name: string; address: string },
  legacyIdentities: ReadonlyMap<string, readonly LegacyIdentity[]>,
  allowedEmployees: ReadonlySet<string>,
  migratedAddresses: ReadonlyMap<LegacyIdentity, string>,
  entryId: string,
): { name: string; address: string } {
  if (target.name.length === 0 || target.address.length === 0) return target;
  const identities = legacyIdentities.get(target.address);
  if (identities === undefined) return target;
  const candidates = identities.filter(
    (identity) => identity.kind === "user" || allowedEmployees.has(identity.id),
  );
  if (candidates.length === 0) return target;
  if (candidates.length > 1) {
    throw new Error(`Internal address migration is ambiguous for mail entry ${entryId}.`);
  }
  const replacement = migratedAddresses.get(candidates[0]!) ?? "";
  return replacement.length === 0 ? target : { ...target, address: replacement };
}

/**
 * One-time rewrite of every internal address onto the single internal domain.
 *
 * Workspaces created before the domain change hold `<slug>.test` addresses in
 * the app record, the employee directory, and every message already written.
 * The records are rewritten in one commit: the user's address, the employees'
 * addresses in creation order, and one address-override document per historical
 * message whose stored headers actually change. Message entries themselves are
 * immutable and are never rewritten; readers project the overrides instead.
 *
 * The function makes no model calls and changes no employee identity, model,
 * configuration version, approval version, or work binding. A destination is
 * only replaced when the stored address is one the message history itself
 * attributed to a known identity, so a real external address that merely looks
 * internal is left alone.
 */
export async function migrateInternalAddresses(runtime: EmitRuntime): Promise<void> {
  const app = await readApp(runtime);
  if (app.addressFormatVersion === 2) return;
  const employees = await listEmployees(runtime);
  const employeeIdentities = new Map<string, LegacyIdentity>(
    employees.map((employee) => [employee.id, { kind: "employee", id: employee.id }]),
  );

  // New addresses first: the user keeps the local part of its stored address,
  // then employees follow in creation order, and collisions take the same
  // deterministic numeric suffixes a live allocation would produce.
  const orderedEmployees = [...employees].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const taken = new Set<string>();
  const migratedAddresses = new Map<LegacyIdentity, string>();
  const storedAddresses: Array<[LegacyIdentity, string]> = [
    [LEGACY_USER_IDENTITY, app.userAddress],
    ...orderedEmployees.map((employee): [LegacyIdentity, string] => [
      employeeIdentities.get(employee.id)!,
      employee.address,
    ]),
  ];
  for (const [identity, address] of storedAddresses) {
    // An unfinished setup has no address to migrate and must stay empty.
    if (address.length === 0) continue;
    const separator = address.indexOf("@");
    const migrated = allocateAddress(
      separator === -1 ? address : address.slice(0, separator),
      INTERNAL_ADDRESS_DOMAIN,
      taken,
    );
    taken.add(migrated);
    migratedAddresses.set(identity, migrated);
  }
  const userAddress = migratedAddresses.get(LEGACY_USER_IDENTITY) ?? "";

  // Pass 1: read every room's full history and index which identity each stored
  // address was attributed to. The index exists only inside this migration.
  const history: Array<{ roomId: string; entry: EntryRecord }> = [];
  const legacyIdentities = new Map<string, LegacyIdentity[]>();
  const indexAddress = (address: string, identity: LegacyIdentity): void => {
    if (address.length === 0) return;
    const identities = legacyIdentities.get(address);
    if (identities === undefined) legacyIdentities.set(address, [identity]);
    else if (!identities.includes(identity)) identities.push(identity);
  };
  indexAddress(app.userAddress, LEGACY_USER_IDENTITY);
  for (const employee of employees) indexAddress(employee.address, employeeIdentities.get(employee.id)!);
  const authorIdentity = (authorType: string, authorId: string): LegacyIdentity | undefined => {
    if (authorType === "user") return LEGACY_USER_IDENTITY;
    if (authorType === "employee") return employeeIdentities.get(authorId);
    return undefined;
  };

  const rooms = await runtime.listFamily(RoomDoc, (id) => ({ id }));
  for (const { value: room } of rooms) {
    const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
    if (conversation === undefined) continue;
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await conversation.entries({}, 200, cursor, runtime.ctx);
      for (const entry of page.items) {
        if (!RoomMessageEntry.is(entry)) continue;
        const identity = authorIdentity(entry.data.authorType, entry.data.authorId);
        if (identity !== undefined) indexAddress(entry.data.address, identity);
        history.push({ roomId: room.id, entry });
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
  }

  // Pass 2: compute the rewritten headers. A known internal identity takes its
  // new address; an unknown or already-deleted one keeps its stored snapshot.
  const rewrites = new Map<string, MessageAddressOverrides>();
  for (const { roomId, entry } of history) {
    if (!RoomMessageEntry.is(entry)) continue;
    const data = entry.data;
    const identity = authorIdentity(data.authorType, data.authorId);
    const address =
      identity !== undefined &&
      data.address.length > 0 &&
      (legacyIdentities.get(data.address)?.includes(identity) ?? false)
        ? migratedAddresses.get(identity) ?? data.address
        : data.address;
    let to: MessageAddressOverride[] = [];
    let cc: MessageAddressOverride[] = [];
    if (data.mail !== null) {
      const allowedEmployees = new Set([...data.mail.recipients, ...data.mail.copies]);
      to = data.mail.to.map((target) =>
        migrateMailTarget(target, legacyIdentities, allowedEmployees, migratedAddresses, String(entry.id)),
      );
      cc = data.mail.cc.map((target) =>
        migrateMailTarget(target, legacyIdentities, allowedEmployees, migratedAddresses, String(entry.id)),
      );
    }
    const changed =
      address !== data.address ||
      (data.mail !== null &&
        (to.some((target, index) => target.address !== data.mail!.to[index]!.address) ||
          cc.some((target, index) => target.address !== data.mail!.cc[index]!.address)));
    if (changed) rewrites.set(`${roomId}|${String(entry.id)}`, { address, to, cc });
  }

  // Pass 3: one commit writes the new app record, the employees, and every
  // message override, so a failure leaves the stored format untouched.
  await runtime.harness.commit(async (tx: Tx) => {
    const doc = await tx.doc(AppDoc);
    doc.userAddress = userAddress;
    doc.addressFormatVersion = 2;
    for (const employee of orderedEmployees) {
      const address = migratedAddresses.get(employeeIdentities.get(employee.id)!);
      if (address === undefined) continue;
      const record = await tx.doc(EmployeeDoc, employee.id, { id: employee.id });
      if (record.address !== address) record.address = address;
    }
    for (const [key, addresses] of rewrites) {
      const flag = await tx.doc(MailFlagDoc, key, { key });
      flag.addresses = addresses;
    }
  }, runtime.ctx);
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
  scope: ExecutionModelScope,
): void {
  if (selection === null) return;
  const problem = runtime.catalog.chatSelectionProblem(chatSelection(selection));
  if (problem !== undefined) throw new ValidationError(workspaceMessages.executionModelUnavailable(scope, problem));
}

function assertApproval(runtime: EmitRuntime, config: ApprovalEvaluatorConfigDTO | null): void {
  if (config === null) throw new ValidationError(workspaceMessages.approvalJudgeRequired);
  const problem = runtime.catalog.approvalProblem({
    kind: config.kind,
    providerId: config.model.providerId,
    modelId: config.model.modelId,
    effort: config.kind === "llm" ? config.effort : "off",
  });
  if (problem !== undefined) throw new ValidationError(workspaceMessages.approvalJudgeUnavailable(problem));
}
