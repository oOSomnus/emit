/**
 * Durable document definitions for Emit.
 *
 * Everything the application remembers outside a conversation transcript lives
 * in one of these typed documents, so it is committed atomically with the
 * transcript that produced it. Session documents hold workspace-wide state;
 * keyed families hold one record per employee, room, work item, and approval.
 */

import { defineDoc, defineDocFamily, defineEntry } from "@earendil-works/pi-durable";
import type { ReviewOutcome, RiskLevel, UserAuthorizationLevel } from "../shared/contracts.ts";
import type { LocalizedText } from "../shared/i18n.ts";

/** The resolved wake set stored on a routed group message. */
export type RoomMessageAddressing = { recipientIds: string[]; mentionAll: boolean };

/** Immutable public message written into a room conversation's transcript. */
export type RoomMessageData = {
  authorType: "user" | "employee" | "system";
  authorId: string;
  authorName: string;
  address: string;
  body: string;
  /** Present only for application-authored system notices. */
  bodyLocalized?: LocalizedText;
  /** Wall-clock milliseconds when the message was appended. */
  createdAt: number;
  /** Present when the message is a delivery or answer for a work item. */
  workId: string;
  /** The wake set of a routed group message; null for mail, notices, and answers. */
  addressing: RoomMessageAddressing | null;
  notice: boolean;
  mail: MailEnvelope | null;
};

export type MailEnvelope = {
  subject: string;
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  /** Employee ids in To: each of them is asked to work on this mail. */
  recipients: string[];
  /** Employee ids in CC: they are copied in and never woken by the mail. */
  copies: string[];
  /** Entry id of the message this one replies to, as a decimal string. */
  inReplyTo: string;
  sent: boolean;
  /** A draft is stored but not sent: nobody is addressed and no work starts. */
  draft: boolean;
};

/** One public message in a room transcript. */
export const RoomMessageEntry = defineEntry<RoomMessageData>("emit.message");

export type ModelSelectionRecord = {
  providerId: string;
  modelId: string;
  effort: string;
};

export type AppRecord = {
  onboarded: boolean;
  userName: string;
  userAddress: string;
  /**
   * Internal address format of the stored records: 1 until the one-time
   * migration to the single internal domain has run, 2 afterwards. Not part of
   * the HTTP contract.
   */
  addressFormatVersion: 1 | 2;
  defaultExecutionModel: ModelSelectionRecord | null;
  approval: ApprovalRecordConfig;
  collaboration: { maxDepth: number; maxCrossEmployeeWakes: number; maxModelTurns: number };
  policyVersion: number;
};

export type ApprovalRecordConfig = {
  kind: "llm" | "classifier";
  providerId: string;
  modelId: string;
  effort: string;
  criteriaVersion: number;
};

export type EmployeeRecord = {
  id: string;
  name: string;
  address: string;
  addressSource: "llm" | "manual";
  role: string;
  instructions: string;
  executionModel: ModelSelectionRecord;
  skillIds: string[];
  mcpServerIds: string[];
  allowedTools: string[];
  trustedReadOnlyTools: string[];
  enabled: boolean;
  configVersion: number;
  createdAt: number;
};

/** Authorized directories of one work context, with their save version. */
export type DirectoryConfigRecord = {
  paths: string[];
  defaultPath: string;
  version: number;
};

/** One employee-shared note of a work context, with its real source. */
export type WorkNoteRecord = {
  id: string;
  title: string;
  body: string;
  /** "user" or the employee id that last wrote it. */
  authorId: string;
  sourceRoomId: string;
  sourceEntryId: string;
  sourceWorkId: string;
  createdAt: number;
  updatedAt: number;
};

/** One reference a work context carries: a local file or a URL. */
export type WorkResourceRecord = {
  id: string;
  kind: "file" | "url";
  name: string;
  location: string;
};

/**
 * A first-class work object: goal, instructions, directories, references, and
 * the notes employees explicitly share with each other inside it.
 */
export type WorkContextRecord = {
  id: string;
  name: string;
  goal: string;
  instructions: string;
  directories: DirectoryConfigRecord;
  resources: WorkResourceRecord[];
  notes: WorkNoteRecord[];
  version: number;
  createdAt: number;
  updatedAt: number;
};

/** Immutable snapshot of the directory configuration one run was authorized under. */
export type WorkDirectoryScopeRecord = {
  /** The conversation the work started from, kept for audit. */
  roomId: string;
  /** The work context whose directory version this snapshot matches. */
  workContextId: string;
  version: number;
  paths: string[];
  defaultPath: string;
};

export type RoomRecord = {
  id: string;
  kind: "channel" | "dm" | "mail";
  name: string;
  topic: string;
  /** The work context this conversation is fixed to. */
  workContextId: string;
  /** Channel members: the employees that may be addressed in this room. */
  memberIds: string[];
  /** Bumped on every membership change; the concurrency token for members. */
  membershipVersion: number;
  /** For DMs: the two sorted participants ("user" or an employee id). */
  dmParticipantIds: string[];
  /** Employee id used to identify a DM; it never determines directory scope. */
  employeeId: string;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  /** Conversation that holds this room's public transcript. */
  conversationId: number;
};

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  directory: string;
  filePath: string;
  diagnostics: { severity: string; message: string }[];
  addedAt: number;
};

export type McpServerRecord = {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  description: string;
  enabled: boolean;
  connectionState: "unknown" | "connected" | "error";
  connectionMessage: string;
  checkedAt: number;
  tools: { name: string; description: string; readOnly: boolean }[];
};

export type WorkRecord = {
  id: string;
  employeeId: string;
  roomId: string;
  /** The work context this run belongs to. */
  workContextId: string;
  kind: "message" | "mail" | "delegation";
  status: "queued" | "running" | "succeeded" | "failed" | "stopped" | "waiting-approval" | "waiting-mail";
  sourceEntryId: string;
  parentWorkId: string;
  rootWorkId: string;
  depth: number;
  startedAt: number;
  finishedAt: number;
  error: string;
  /** Present when the failure reason is application-authored. */
  errorLocalized?: LocalizedText;
  /** Employee execution conversation carrying this work. */
  conversationId: number;
  /** Immutable work-context directory snapshot bound to this run. */
  directoryScope: WorkDirectoryScopeRecord;
  /** The plain-text request that started this work, for audit context. */
  intent: string;
  /** Answer text produced by the run. */
  answer: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Durable task that starts this queued work; empty once started. */
  dispatchTaskId: string;
  /** Durable task that feeds a finished child's reply back into this work. */
  mailResumeTaskId: string;
  /** Child works whose replies this work waits for before it may answer. */
  awaitedMailWorkIds: string[];
};

export type ApprovalStatus =
  | "evaluating"
  | "pending-human"
  | "approved"
  | "rejected"
  | "blocked"
  | "cancelled"
  | "invalidated";

export type ApprovalEvidenceRecord =
  | {
      kind: "llm";
      criteriaVersion: number;
      rationale: string;
      risk: RiskLevel;
      outcome: ReviewOutcome;
      readOnly: boolean;
      userAuthorization: UserAuthorizationLevel;
    }
  | {
      kind: "classifier";
      criteriaVersion: number;
      outcome: ReviewOutcome;
      risk: RiskLevel;
      /** Rendered questions and criteria snapshot at evaluation time. */
      questions: string;
      outcomeProbability: number | null;
      outcomeProbabilities: Record<string, number>;
      riskProbability: number | null;
      riskProbabilities: Record<string, number>;
      readOnly: boolean | null;
      readOnlyProbability: number | null;
      authorized: boolean | null;
      authorizedProbability: number | null;
    }
  | { kind: "policy"; rationale: string; rationaleLocalized?: LocalizedText };

export type ApprovalTimelineRecord = {
  at: number;
  actor: string;
  text: string;
  /** Present when the actor label is application-generated. */
  actorLocalized?: LocalizedText;
  /** Present when the timeline sentence is application-authored. */
  textLocalized?: LocalizedText;
};

export type ApprovalRecord = {
  id: string;
  /** Tool task this case gates; unique per call. */
  toolTaskId: string;
  workId: string;
  rootWorkId: string;
  employeeId: string;
  employeeName: string;
  toolName: string;
  argsHash: string;
  /** Redacted argument preview for humans. */
  argumentsPreview: string;
  cwd: string;
  /** The work context whose directory version this grant is bound to. */
  directoryWorkContextId: string;
  /** The conversation the call came from; kept for audit, not for the check. */
  directoryRoomId: string;
  directoryVersion: number;
  directoryPaths: string[];
  targetPaths: string[];
  risk: RiskLevel;
  status: ApprovalStatus;
  executionState: "not-started" | "running" | "succeeded" | "failed" | "interrupted";
  executionDetail: string;
  /** Present when the execution detail is application-authored. */
  executionDetailLocalized?: LocalizedText;
  createdAt: number;
  updatedAt: number;
  decidedAt: number;
  decidedBy: string;
  comment: string;
  autoDecisionSource: "" | "llm" | "classifier" | "policy" | "human";
  autoDecisionReason: string;
  /** Present when the automatic decision reason is application-authored. */
  autoDecisionReasonLocalized?: LocalizedText;
  evidence: ApprovalEvidenceRecord | null;
  originKind: "room" | "delegation";
  originRoomId: string;
  originRoomName: string;
  originEntryId: string;
  originParentWorkId: string;
  /** Employee configuration version the grant is bound to. */
  configVersion: number;
  /** Policy version the grant is bound to. */
  policyVersion: number;
  timeline: ApprovalTimelineRecord[];
};

/** One address as a historical message header stored it. */
export type MessageAddressOverride = { name: string; address: string };

/**
 * The address projection of one historical message entry.
 *
 * Message entries are immutable, so the one-time internal-address migration
 * cannot rewrite their headers. It records the rewritten headers on the
 * message's flag document instead, and every reader projects them over the
 * stored entry. `to` and `cc` are stored even for a non-mail entry so the
 * projection stays a pure read.
 */
export type MessageAddressOverrides = {
  address: string;
  to: MessageAddressOverride[];
  cc: MessageAddressOverride[];
};

export type MailFlagRecord = {
  /** `${roomId}|${entryId}` */
  key: string;
  read: boolean;
  archived: boolean;
  /** False once a draft has been sent or replaced, which retires it. */
  active: boolean;
  /** Present only when the migration rewrote this message's address headers. */
  addresses?: MessageAddressOverrides;
};

export type CollaborationRecord = {
  rootWorkId: string;
  crossEmployeeWakes: number;
  modelTurns: number;
  maxDepthReached: number;
};

/**
 * Work binding of one employee execution conversation.
 *
 * Tools and hooks run inside a conversation and must attribute their work
 * without guessing: this document is written when the conversation is created,
 * so any tool task can read it and learn which work item, employee, and room it
 * belongs to.
 */
export type ConversationContextRecord = {
  workId: string;
  employeeId: string;
  roomId: string;
  rootWorkId: string;
  depth: number;
};

export const AppDoc = defineDoc<AppRecord>({
  kind: "emit.app",
  version: 2,
  scope: "session",
  initial: () => ({
    onboarded: false,
    userName: "",
    userAddress: "",
    addressFormatVersion: 2,
    defaultExecutionModel: null,
    approval: {
      kind: "llm",
      providerId: "",
      modelId: "",
      effort: "off",
      criteriaVersion: 3,
    },
    collaboration: { maxDepth: 3, maxCrossEmployeeWakes: 12, maxModelTurns: 40 },
    policyVersion: 1,
  }),
  /**
   * Version 1 stored the team name and its slug, which no longer exist as
   * configuration. The stored user address is kept: rewriting it, the
   * employees' addresses, and the historical message headers is the one-time
   * migration's job, and it must not run while this document is read.
   */
  migrate: (value) => {
    const migrated = { ...value };
    delete migrated.workspaceName;
    delete migrated.workspaceSlug;
    return { ...migrated, addressFormatVersion: 1 } as unknown as AppRecord;
  },
});

export const EmployeeDoc = defineDocFamily<EmployeeRecord, { id: string }>({
  kind: "emit.employee",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    id: seed.id,
    name: "",
    address: "",
    addressSource: "manual",
    role: "",
    instructions: "",
    executionModel: { providerId: "", modelId: "", effort: "off" },
    skillIds: [],
    mcpServerIds: [],
    allowedTools: [],
    trustedReadOnlyTools: [],
    enabled: true,
    configVersion: 1,
    createdAt: 0,
  }),
});

export const RoomDoc = defineDocFamily<RoomRecord, { id: string }>({
  kind: "emit.room",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    id: seed.id,
    kind: "channel",
    name: "",
    topic: "",
    workContextId: "",
    memberIds: [],
    membershipVersion: 1,
    dmParticipantIds: [],
    employeeId: "",
    createdAt: 0,
    lastMessageAt: 0,
    messageCount: 0,
    conversationId: 0,
  }),
});

export const SkillDoc = defineDocFamily<SkillRecord, { id: string }>({
  kind: "emit.skill",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    id: seed.id,
    name: "",
    description: "",
    directory: "",
    filePath: "",
    diagnostics: [],
    addedAt: 0,
  }),
});

export const McpDoc = defineDocFamily<McpServerRecord, { id: string }>({
  kind: "emit.mcp",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    id: seed.id,
    name: "",
    transport: "stdio",
    command: "",
    args: [],
    env: {},
    cwd: "",
    url: "",
    headers: {},
    description: "",
    enabled: true,
    connectionState: "unknown",
    connectionMessage: "",
    checkedAt: 0,
    tools: [],
  }),
});

export const WorkDoc = defineDocFamily<WorkRecord, { id: string }>({
  kind: "emit.work",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    id: seed.id,
    employeeId: "",
    roomId: "",
    workContextId: "",
    kind: "message",
    status: "queued",
    sourceEntryId: "",
    parentWorkId: "",
    rootWorkId: seed.id,
    depth: 0,
    startedAt: 0,
    finishedAt: 0,
    error: "",
    conversationId: 0,
    intent: "",
    directoryScope: { roomId: "", workContextId: "", version: 0, paths: [], defaultPath: "" },
    answer: "",
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    dispatchTaskId: "",
    mailResumeTaskId: "",
    awaitedMailWorkIds: [],
  }),
});

export const ApprovalDoc = defineDocFamily<ApprovalRecord, { id: string }>({
  kind: "emit.approval",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    id: seed.id,
    toolTaskId: "",
    workId: "",
    rootWorkId: "",
    employeeId: "",
    employeeName: "",
    toolName: "",
    argsHash: "",
    argumentsPreview: "",
    cwd: "",
    directoryWorkContextId: "",
    directoryRoomId: "",
    directoryVersion: 0,
    directoryPaths: [],
    targetPaths: [],
    risk: "unknown",
    status: "evaluating",
    executionState: "not-started",
    executionDetail: "",
    createdAt: 0,
    updatedAt: 0,
    decidedAt: 0,
    decidedBy: "",
    comment: "",
    autoDecisionSource: "",
    autoDecisionReason: "",
    evidence: null,
    originKind: "room",
    originRoomId: "",
    originRoomName: "",
    originEntryId: "",
    originParentWorkId: "",
    configVersion: 0,
    policyVersion: 0,
    timeline: [],
  }),
});

export const MailFlagDoc = defineDocFamily<MailFlagRecord, { key: string }>({
  kind: "emit.mail-flag",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ key: seed.key, read: false, archived: false, active: true }),
});

/**
 * Durable receipt of one employee mail send.
 *
 * A tool call must survive a replay with the same effect once: the send's
 * entry, works, tasks, and this receipt are written in one commit, and a
 * replay that finds the receipt returns the recorded outcome instead of
 * sending again. The key is `tool:<toolTaskId>`.
 */
export type MailSendReceiptRecord = {
  key: string;
  roomId: string;
  entryId: string;
  workIds: string[];
};

export const MailSendReceiptDoc = defineDocFamily<MailSendReceiptRecord, { key: string }>({
  kind: "emit.mail-send-receipt",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ key: seed.key, roomId: "", entryId: "", workIds: [] }),
});

/**
 * Durable receipt of one employee group message.
 *
 * Like the mail receipt: the entry, the queued works, the dispatch tasks, and
 * this receipt are one commit, so a replayed tool call returns the recorded
 * outcome instead of sending (and waking) a second time. The key is
 * `tool:<toolTaskId>`.
 *
 * The same family carries the work-level key `reply:<workId>`: the first
 * ordinary reply an employee sent into the channel its own work started from.
 * `deliverAnswer` reads it to keep that work's final answer out of the room,
 * while still recording the answer on the work.
 */
export type MessageSendReceiptRecord = {
  key: string;
  roomId: string;
  entryId: string;
  workIds: string[];
};

export const MessageSendReceiptDoc = defineDocFamily<MessageSendReceiptRecord, { key: string }>({
  kind: "emit.message-send-receipt",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ key: seed.key, roomId: "", entryId: "", workIds: [] }),
});

/**
 * Durable receipt of one work-context mutation made by a tool.
 *
 * Inviting members and saving notes both happen inside a tool call, so both
 * write this receipt in the same commit as the change: a replay with the same
 * tool task id returns the recorded outcome without repeating the notice or
 * overwriting a newer note. The key is `tool:<toolTaskId>`.
 */
export type WorkContextMutationReceiptRecord = {
  key: string;
  workContextId: string;
  roomId: string;
  noteId: string;
  version: number;
};

export const WorkContextMutationReceiptDoc = defineDocFamily<WorkContextMutationReceiptRecord, { key: string }>({
  kind: "emit.work-context-mutation-receipt",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ key: seed.key, workContextId: "", roomId: "", noteId: "", version: 0 }),
});

/**
 * One first-class work object.
 *
 * A work context is what a conversation is fixed to: its goal, instructions,
 * authorized directories, references, and the notes employees explicitly
 * share inside it. Conversations never own directories themselves.
 */
export const WorkContextDoc = defineDocFamily<WorkContextRecord, { id: string }>({
  kind: "emit.work-context",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    id: seed.id,
    name: "",
    goal: "",
    instructions: "",
    directories: { paths: [], defaultPath: "", version: 1 },
    resources: [],
    notes: [],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }),
});

export const CollaborationDoc = defineDocFamily<CollaborationRecord, { rootWorkId: string }>({
  kind: "emit.collab",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    rootWorkId: seed.rootWorkId,
    crossEmployeeWakes: 0,
    modelTurns: 0,
    maxDepthReached: 0,
  }),
});

export const ConversationContextDoc = defineDoc<ConversationContextRecord>({
  kind: "emit.conversation-context",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    workId: "",
    employeeId: "",
    roomId: "",
    rootWorkId: "",
    depth: 0,
  }),
});

/** Documents indexed for full scans by the API layer. */
export const FAMILY_SCAN_LIMIT = 500;
