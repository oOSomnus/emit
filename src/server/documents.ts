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

/** Immutable public message written into a room conversation's transcript. */
export type RoomMessageData = {
  authorType: "user" | "employee" | "system";
  authorId: string;
  authorName: string;
  address: string;
  body: string;
  /** Wall-clock milliseconds when the message was appended. */
  createdAt: number;
  /** Present when the message is a delivery or answer for a work item. */
  workId: string;
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
  workspaceName: string;
  workspaceSlug: string;
  userName: string;
  userAddress: string;
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

export type RoomDirectoriesRecord = {
  paths: string[];
  defaultPath: string;
  version: number;
};

export type WorkDirectoryScopeRecord = {
  roomId: string;
  version: number;
  paths: string[];
  defaultPath: string;
};

export type RoomRecord = {
  id: string;
  kind: "channel" | "dm" | "mail";
  name: string;
  topic: string;
  memberIds: string[];
  /** Employee id used to identify a DM; it never determines directory scope. */
  employeeId: string;
  directories: RoomDirectoriesRecord;
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
  kind: "message" | "mail" | "delegation";
  status: "queued" | "running" | "succeeded" | "failed" | "stopped" | "waiting-approval";
  sourceEntryId: string;
  parentWorkId: string;
  rootWorkId: string;
  depth: number;
  startedAt: number;
  finishedAt: number;
  error: string;
  /** Employee execution conversation carrying this work. */
  conversationId: number;
  /** Immutable room-directory snapshot bound to this run. */
  directoryScope: WorkDirectoryScopeRecord;
  /** The plain-text request that started this work, for audit context. */
  intent: string;
  /** Answer text produced by the run. */
  answer: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
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
  | { kind: "policy"; rationale: string };

export type ApprovalTimelineRecord = { at: number; actor: string; text: string };

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
  directoryRoomId: string;
  directoryVersion: number;
  directoryPaths: string[];
  targetPaths: string[];
  risk: RiskLevel;
  status: ApprovalStatus;
  executionState: "not-started" | "running" | "succeeded" | "failed" | "interrupted";
  executionDetail: string;
  createdAt: number;
  updatedAt: number;
  decidedAt: number;
  decidedBy: string;
  comment: string;
  autoDecisionSource: "" | "llm" | "classifier" | "policy" | "human";
  autoDecisionReason: string;
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

export type MailFlagRecord = {
  /** `${roomId}|${entryId}` */
  key: string;
  read: boolean;
  archived: boolean;
  /** False once a draft has been sent or replaced, which retires it. */
  active: boolean;
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
  version: 1,
  scope: "session",
  initial: () => ({
    onboarded: false,
    workspaceName: "",
    workspaceSlug: "",
    userName: "",
    userAddress: "",
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
    memberIds: [],
    employeeId: "",
    directories: { paths: [], defaultPath: "", version: 1 },
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
    directoryScope: { roomId: "", version: 0, paths: [], defaultPath: "" },
    answer: "",
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
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
