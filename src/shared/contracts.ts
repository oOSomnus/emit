/**
 * Wire contracts shared by the Emit server and web client.
 *
 * These types are the only vocabulary crossing the HTTP/SSE seam. The server
 * converts durable records into them and validates every command against them,
 * so the browser never sees storage identities, credentials, or Pi types.
 */

export type ModelKind = "chat" | "classifier";

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
      /** Minimum probability of the `approve` choice to auto-approve. */
      minApproveProbability: number;
      /** Minimum probability that the operation is user-authorized. */
      minAuthorizedProbability: number;
      /** When true, `authorized` must clear its threshold as well. */
      requireAuthorized: boolean;
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
  cwd: string;
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
  cwd?: string;
  skillIds?: string[];
  mcpServerIds?: string[];
  toolPolicy?: EmployeeToolPolicyDTO;
  generateAddress?: boolean;
};

export type RoomKind = "channel" | "dm" | "mail";

export type RoomDTO = {
  id: string;
  kind: RoomKind;
  name: string;
  topic: string;
  memberIds: string[];
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

export type MessageDTO = {
  id: string;
  roomId: string;
  author: MessageAuthorDTO;
  body: string;
  createdAt: number;
  /** Work id when this message started or carries employee work. */
  workId?: string;
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
  | "waiting-approval";

export type WorkDTO = {
  id: string;
  employeeId: string;
  employeeName: string;
  roomId: string;
  roomName: string;
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
  /** Live streamed answer text for the running generation. */
  progressText?: string;
  /** Final answer, when the work produced one. */
  answer?: string;
  tools?: ToolActivityDTO[];
  usage?: { input: number; output: number; cost: number };
};

export type ApprovalStatusDTO =
  | "evaluating"
  | "pending-human"
  | "approved"
  | "rejected"
  | "cancelled"
  | "invalidated";

export type ApprovalExecutionDTO = {
  state: "not-started" | "running" | "succeeded" | "failed" | "interrupted";
  detail?: string;
};

export type ApprovalDecisionSourceDTO = "llm" | "classifier" | "human" | "policy";

export type ApprovalEvidenceDTO =
  | {
      kind: "llm";
      criteriaVersion?: number;
      rationale: string;
      risk: string;
      recommendation: string;
      readOnly?: boolean;
      userAuthorization?: "high" | "medium" | "low" | "unknown";
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
      answers: { key: string; choice?: string; probability?: number; probabilities?: Record<string, number> }[];
      readOnlyProbability?: number;
      authorizedProbability?: number;
    }
  | { kind: "policy"; rationale: string };

export type ApprovalTimelineEntryDTO = {
  at: number;
  actor: string;
  text: string;
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
  risk: string;
  status: ApprovalStatusDTO;
  execution: ApprovalExecutionDTO;
  createdAt: number;
  updatedAt: number;
  decidedAt?: number;
  decidedBy?: string;
  comment?: string;
  /** Why the automatic evaluator did not grant this call. */
  autoDecision?: { source: ApprovalDecisionSourceDTO; reason: string };
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
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
};

/** A native login event, safe to send to the browser. */
export type AuthEventDTO =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

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
};

export type BootstrapDTO = {
  app: AppConfigDTO;
  employees: EmployeeDTO[];
  rooms: RoomDTO[];
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
  | { type: "notice"; text: string };
