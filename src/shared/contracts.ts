/**
 * Wire contracts shared by the Emit server and web client.
 *
 * These types are the only vocabulary crossing the HTTP/SSE seam. The server
 * converts durable records into them and validates every command against them,
 * so the browser never sees storage identities, credentials, or Pi types.
 */

import type { LocalizedText } from "./i18n.ts";

export type ModelKind = "chat" | "classifier";

/**
 * One application message as it crosses the wire.
 *
 * `message` is always the canonical text (the English string the server
 * produces, or a raw native reason); `messageLocalized`, when present, is the
 * pair the browser renders in its own language. The two are separate so
 * persisted text and model context never depend on the browser locale.
 */
export type ApiErrorBody = { message: string; messageLocalized?: LocalizedText };

/** The result of a real connection probe, in both languages when app-authored. */
export type CheckResultDTO = { ok: boolean; message: string; messageLocalized?: LocalizedText };

/** A stored reference to one model entry in the Pi catalog. */
export type ModelRefDTO = {
  providerId: string;
  modelId: string;
};

/** A chat model plus the reasoning effort a conversation runs with. */
export type ChatSelectionDTO = {
  model: ModelRefDTO;
  /** ModelThinkingLevel from pi-ai; "off" when the model cannot reason. */
  effort: string;
};

export type ApprovalEvaluatorConfigDTO =
  | {
      kind: "llm";
      model: ModelRefDTO;
      effort: string;
      /** Prompt version used for the criteria the model answers. */
      criteriaVersion: number;
    }
  | {
      kind: "classifier";
      model: ModelRefDTO;
      criteriaVersion: number;
    };

export type CollaborationLimitsDTO = {
  maxDepth: number;
  maxCrossEmployeeWakes: number;
  maxModelTurns: number;
};

export type AppConfigDTO = {
  onboarded: boolean;
  workspace: { name: string; slug: string };
  user: { name: string; address: string };
  defaultExecutionModel: ChatSelectionDTO | null;
  approval: ApprovalEvaluatorConfigDTO | null;
  collaboration: CollaborationLimitsDTO;
  /** Bumped whenever the approval surface changes; invalidates unconsumed grants. */
  policyVersion: number;
};

/** One way a provider can be authenticated, derived from Pi's native metadata. */
export type ProviderAuthMethodDTO = {
  type: "api_key" | "oauth";
  label: string;
  /** True when Emit can run an interactive login for this method. */
  interactive: boolean;
  /** True when the method is backed by a provider subscription. */
  subscription: boolean;
};

export type ProviderStatusDTO = {
  providerId: string;
  name: string;
  /** Where auth came from, or null when the provider is unconfigured. */
  authSource: string | null;
  configured: boolean;
  /** True for providers Emit built from user configuration rather than the Pi catalog. */
  custom: boolean;
  /** Every native auth method for this provider, in native order. */
  authMethods: ProviderAuthMethodDTO[];
  /** The type of the credential Emit has stored, or null when none is stored. */
  storedAuthType: "api_key" | "oauth" | null;
  /** Non-sensitive reason the auth check failed, or null when it succeeded. */
  authError: string | null;
};

export type ModelInfoDTO = {
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  kind: ModelKind;
  contextWindow: number;
  /** Reasoning efforts this model accepts, including "off" first; empty for non-reasoning kinds. */
  efforts: string[];
  /** True when the model accepts tool calls (chat models only). */
  toolCalling: boolean;
  /**
   * True when this exact model is usable with the provider's current
   * credential. A provider can be authenticated while a specific model is not
   * listed for that credential (e.g. GitHub Copilot's per-plan filter).
   */
  configured: boolean;
};

export type EmployeeToolPolicyDTO = {
  /** Tool names the employee may call; empty means only collaboration tools. */
  allowedTools: string[];
  /** MCP tools explicitly trusted as read-only, exempt from gated approval. */
  trustedReadOnlyTools: string[];
};

export type EmployeeDTO = {
  id: string;
  name: string;
  address: string;
  addressSource: "llm" | "manual";
  role: string;
  instructions: string;
  executionModel: ChatSelectionDTO;
  skillIds: string[];
  mcpServerIds: string[];
  toolPolicy: EmployeeToolPolicyDTO;
  enabled: boolean;
  configVersion: number;
  createdAt: number;
};

export type EmployeeDraftDTO = {
  name: string;
  role: string;
  instructions?: string;
  executionModel?: ChatSelectionDTO;
  skillIds?: string[];
  mcpServerIds?: string[];
  toolPolicy?: EmployeeToolPolicyDTO;
  generateAddress?: boolean;
};

export type RoomKind = "channel" | "dm" | "mail";

/** One work context's authorized directories and the version they were saved at. */
export type DirectoryConfigDTO = {
  paths: string[];
  defaultPath: string;
  version: number;
};

export type DirectoryDraftDTO = {
  paths: string[];
  defaultPath: string;
};

/** One reference a work context carries: a local file or a URL. */
export type WorkResourceDTO = {
  id: string;
  kind: "file" | "url";
  name: string;
  location: string;
};

/** The editable resource shape; a missing id means "create a new reference". */
export type WorkResourceDraftDTO = Omit<WorkResourceDTO, "id"> & { id?: string };

/** One shared note of a work context, with the real message it came from. */
export type WorkNoteDTO = {
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

/** Note metadata without the body; bodies are fetched by id on demand. */
export type WorkNoteSummaryDTO = Omit<WorkNoteDTO, "body">;

/** One first-class work context: goal, instructions, directories, resources, notes. */
export type WorkContextDTO = {
  id: string;
  name: string;
  goal: string;
  instructions: string;
  directories: DirectoryConfigDTO;
  resources: WorkResourceDTO[];
  notes: WorkNoteSummaryDTO[];
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkContextDraftDTO = {
  name: string;
  goal?: string;
  instructions?: string;
  directories?: DirectoryDraftDTO;
  resources?: WorkResourceDraftDTO[];
};

export type WorkContextPatchDTO = Partial<WorkContextDraftDTO> & { expectedVersion: number };

export type WorkNoteCreateDTO = {
  title: string;
  body: string;
  expectedVersion: number;
  /** The real room message this note was saved from, when it came from one. */
  source?: { roomId: string; entryId: string };
};

export type WorkNotePatchDTO = {
  title: string;
  body: string;
  expectedVersion: number;
};

export type WorkNoteDeleteDTO = { expectedVersion: number };

export type WorkNoteResponseDTO = { note: WorkNoteDTO; workContext: WorkContextDTO };

export type RoomDTO = {
  id: string;
  kind: RoomKind;
  name: string;
  topic: string;
  /** The work context this conversation is fixed to; never rebound. */
  workContextId: string;
  /** Channel members: the employees that may be addressed in this room. */
  memberIds: string[];
  /** Bumped on every membership change; the concurrency token for members. */
  membershipVersion: number;
  /** For DMs: the two sorted participants ("user" or an employee id). */
  dmParticipantIds: string[];
  /** Employee id for DMs; absent otherwise. */
  employeeId?: string;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  unread: number;
};

export type MessageAuthorDTO = {
  type: "user" | "employee" | "system";
  id: string;
  name: string;
  /** Present for application-generated display names ("You"/"你", "System"/"系统"). */
  nameLocalized?: LocalizedText;
  address?: string;
};

export type MailMetaDTO = {
  subject: string;
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  /** Employee ids this mail asks to work on it. */
  recipients: string[];
  /** Employee ids copied in, which are never woken by the mail. */
  copies: string[];
  /** Entry ids this message replies to, within the same mail room. */
  inReplyTo?: string;
  read: boolean;
  archived: boolean;
  sent: boolean;
  /** Drafts are stored in the thread but are not delivered and start no work. */
  draft: boolean;
};

/** One mail entry as the mailbox lists it, with the thread it belongs to. */
export type MailboxItemDTO = {
  roomId: string;
  roomName: string;
  message: MessageDTO;
};

export type ToolActivityDTO = {
  callId: string;
  name: string;
  status: "pending" | "running" | "done";
  /** Retained tool output, already bounded by the harness. */
  output?: string;
};

/**
 * The wake set of one group message, as it was resolved at send time.
 *
 * A plain channel message stores an empty set: everyone can read it, nobody
 * was started by it.
 */
export type MessageAddressingDTO = { recipientIds: string[]; mentionAll: boolean };

export type MessageDTO = {
  id: string;
  roomId: string;
  author: MessageAuthorDTO;
  body: string;
  /** Present only for application-authored system notices. */
  bodyLocalized?: LocalizedText;
  createdAt: number;
  /** Work id when this message started or carries employee work. */
  workId?: string;
  /** The employees this group message was addressed to, when it was routed. */
  addressing?: MessageAddressingDTO;
  mail?: MailMetaDTO;
  /** Marks a system notice, such as a stopped run or an interrupted tool. */
  notice?: boolean;
};

export type WorkStatusDTO =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "waiting-approval"
  | "waiting-mail";

export type WorkDTO = {
  id: string;
  employeeId: string;
  employeeName: string;
  roomId: string;
  roomName: string;
  /** The work context this run belongs to. */
  workContextId: string;
  kind: "message" | "mail" | "delegation";
  status: WorkStatusDTO;
  /** Message that started this work, when it came from a room. */
  sourceEntryId?: string;
  parentWorkId?: string;
  rootWorkId: string;
  depth: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** Present when the failure reason is application-authored. */
  errorLocalized?: LocalizedText;
  /** Live streamed answer text for the running generation. */
  progressText?: string;
  /** Final answer, when the work produced one. */
  answer?: string;
  tools?: ToolActivityDTO[];
  usage?: { input: number; output: number; cost: number };
  /** Durable task that will start this queued work; present for queued work. */
  dispatchTaskId?: string;
  /** Durable task that feeds a related reply back into this work. */
  mailResumeTaskId?: string;
  /** Child works whose replies this work waits for before answering. */
  awaitedMailWorkIds: string[];
};

/**
 * One step of a work's durable execution record.
 *
 * Steps are the model context as it was actually sent: user input, assistant
 * text, tool calls, and tool results, redacted and bounded. System prompts and
 * thinking never reach this shape.
 */
export type WorkExecutionStepDTO = {
  /** Stable within the work: entry id plus the message and part it came from. */
  id: string;
  entryId: string;
  taskId?: string;
  kind: "input" | "assistant" | "tool-call" | "tool-result";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: string;
  isError?: boolean;
  /** The step was cut at the display limit. */
  truncated?: boolean;
  /** Task state for the durable work that wrote this entry. */
  taskStatus?: string;
  taskError?: string;
};

export type WorkExecutionDTO = {
  work: WorkDTO;
  /** Steps of this page, oldest first. */
  steps: WorkExecutionStepDTO[];
  /** Opaque cursor for the next, older page. */
  nextCursor?: string;
  approvals: ApprovalDTO[];
};

export type RiskLevel = "low" | "medium" | "high" | "critical" | "unknown";
export type ReviewOutcome = "allow" | "deny";
export type UserAuthorizationLevel = "high" | "medium" | "low" | "unknown";

export type ApprovalStatusDTO =
  | "evaluating"
  | "pending-human"
  | "approved"
  | "rejected"
  | "blocked"
  | "cancelled"
  | "invalidated";

export type ApprovalExecutionDTO = {
  state: "not-started" | "running" | "succeeded" | "failed" | "interrupted";
  detail?: string;
  /** Present when the execution detail is application-authored. */
  detailLocalized?: LocalizedText;
};

export type ApprovalDecisionSourceDTO = "llm" | "classifier" | "human" | "policy";

export type ApprovalEvidenceDTO =
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
      questions: {
        key: string;
        type: string;
        instructions: string;
        criteria: { label: string; description: string }[];
      }[];
      answers: {
        key: string;
        choice?: string;
        probability?: number;
        probabilities?: Record<string, number>;
      }[];
      outcome: ReviewOutcome;
      risk: RiskLevel;
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

export type ApprovalTimelineEntryDTO = {
  at: number;
  actor: string;
  text: string;
  /** Present when the actor label is application-generated. */
  actorLocalized?: LocalizedText;
  /** Present when the timeline sentence is application-authored. */
  textLocalized?: LocalizedText;
};

export type ApprovalDTO = {
  id: string;
  workId?: string;
  employeeId: string;
  employeeName: string;
  toolName: string;
  /** Redacted, human-readable argument preview. */
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
  status: ApprovalStatusDTO;
  execution: ApprovalExecutionDTO;
  createdAt: number;
  updatedAt: number;
  decidedAt?: number;
  decidedBy?: string;
  comment?: string;
  /** Why the automatic evaluator did not grant this call. */
  autoDecision?: { source: ApprovalDecisionSourceDTO; reason: string; reasonLocalized?: LocalizedText };
  evidence?: ApprovalEvidenceDTO;
  origin:
    | { kind: "room"; roomId: string; roomName: string; entryId: string; subject?: string }
    | { kind: "delegation"; parentWorkId: string };
  timeline: ApprovalTimelineEntryDTO[];
};

export type SkillDTO = {
  id: string;
  name: string;
  description: string;
  directory: string;
  filePath: string;
  /** Parse diagnostics recorded when the skill was imported. */
  diagnostics: { severity: string; message: string }[];
  addedAt: number;
};

export type McpServerDTO = {
  id: string;
  name: string;
  transport: "stdio" | "http";
  /** Rendered as a command line for stdio, or a URL for HTTP. */
  target: string;
  enabled: boolean;
  description?: string;
  /** Last observed connection state. */
  connection: { state: "unknown" | "connected" | "error"; message?: string; checkedAt: number };
  tools: { name: string; description: string; readOnly: boolean }[];
};

export type McpServerDraftDTO = {
  /** Existing server id when editing; absent when creating. */
  id?: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  enabled?: boolean;
};

/** Wire protocols a custom endpoint may declare. */
export const CUSTOM_PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

/**
 * One fully-resolved custom endpoint, as stored and returned to the browser.
 * It never carries a secret: the API key is held by the native credential
 * store and obtained through the provider's login flow.
 */
export type CustomProviderConfigDTO = {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  /** Environment variable Pi may also read the key from; "" means keyless. */
  apiKeyEnv: string;
  models: {
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    input: ("text" | "image")[];
  }[];
};

/** The editable shape of one custom endpoint, used as the PUT request body. */
export type CustomProviderDraftDTO = {
  id: string;
  name?: string;
  baseUrl: string;
  api: CustomProviderApi;
  apiKeyEnv?: string;
  models: {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    input?: ("text" | "image")[];
  }[];
};

/** A native provider login prompt, with its cancellation signal stripped. */
export type AuthPromptDTO = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  /** Present when the prompt text is application-authored. */
  messageLocalized?: LocalizedText;
  placeholder?: string;
  options?: { id: string; label: string; description?: string; labelLocalized?: LocalizedText; descriptionLocalized?: LocalizedText }[];
};

/** A native login event, safe to send to the browser. */
export type AuthEventDTO =
  | { type: "info"; message: string; messageLocalized?: LocalizedText; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string; messageLocalized?: LocalizedText };

export type AuthSessionStatusDTO = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

/** The observable state of one native provider login. */
export type AuthSessionDTO = {
  id: string;
  providerId: string;
  authType: "api_key" | "oauth";
  status: AuthSessionStatusDTO;
  /** The prompt awaiting an answer, or null when the flow is not waiting. */
  prompt: AuthPromptDTO | null;
  /** The most recent non-secret native events, oldest first. */
  events: AuthEventDTO[];
  /** Terminal detail, or a refresh note after a successful login. */
  message: string | null;
  /** Present when the terminal detail is application-authored. */
  messageLocalized?: LocalizedText;
};

export type BootstrapDTO = {
  app: AppConfigDTO;
  employees: EmployeeDTO[];
  rooms: RoomDTO[];
  workContexts: WorkContextDTO[];
  work: WorkDTO[];
  approvals: ApprovalDTO[];
  skills: SkillDTO[];
  mcpServers: McpServerDTO[];
  providers: ProviderStatusDTO[];
  customProviders: CustomProviderConfigDTO[];
  storagePath: string;
};

/** Events pushed over SSE. */
export type ServerEvent =
  | { type: "message"; roomId: string; message: MessageDTO }
  | { type: "room"; room: RoomDTO }
  | { type: "work-context"; workContext: WorkContextDTO }
  | { type: "work"; work: WorkDTO }
  | { type: "approval"; approval: ApprovalDTO }
  /** Live text and tool activity of one running work item. */
  | { type: "work-progress"; workId: string; progressText: string; tools: ToolActivityDTO[] }
  | { type: "approvals" }
  | { type: "employee"; employee: EmployeeDTO }
  | { type: "employees" }
  | { type: "skills" }
  | { type: "mcp" }
  | { type: "app"; app: AppConfigDTO }
  | { type: "notice"; text: string; textLocalized: LocalizedText };
