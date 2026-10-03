/**
 * The browser's only contact with the server.
 *
 * Requests are plain `fetch` calls and every live update arrives on one SSE
 * stream. The client holds no domain logic: it renders what the server sends
 * and refetches the surfaces an event names.
 */

import type {
  ApiErrorBody,
  ApprovalDTO,
  AppConfigDTO,
  AuthSessionDTO,
  BootstrapDTO,
  ChatSelectionDTO,
  CheckResultDTO,
  CustomProviderConfigDTO,
  CustomProviderDraftDTO,
  EmployeeDTO,
  EmployeeDraftDTO,
  MailboxItemDTO,
  MessageDTO,
  ModelInfoDTO,
  ProviderStatusDTO,
  RoomDirectoryDraftDTO,
  RoomDirectoryPatchDTO,
  RoomDTO,
  ServerEvent,
  SkillDTO,
  WorkDTO,
  WorkExecutionDTO,
} from "../shared/contracts.ts";
import { isLocalizedText, type LocalizedText } from "../shared/i18n.ts";
import { uiText } from "./messages.ts";

/** One failed HTTP request; `messageLocalized` is present for app-authored errors. */
export class ApiError extends Error {
  readonly status: number;
  readonly messageLocalized?: LocalizedText;

  constructor(status: number, message: string, messageLocalized?: LocalizedText) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.messageLocalized = messageLocalized;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // A bodyless request (DELETE, or a POST with no payload) must not advertise a
  // JSON content type: Fastify rejects an empty body that claims to be JSON.
  const headers =
    init?.body === undefined
      ? { ...(init?.headers ?? {}) }
      : { "content-type": "application/json", ...(init?.headers ?? {}) };
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const body = (typeof payload === "object" && payload !== null ? payload : {}) as Partial<ApiErrorBody>;
    const messageLocalized = isLocalizedText(body.messageLocalized) ? body.messageLocalized : undefined;
    if (typeof body.message === "string") {
      throw new ApiError(response.status, body.message, messageLocalized);
    }
    // A response without a message is a failed request, not an application
    // error: name the status in the user's language.
    const fallback = uiText((messages) => messages.common.requestFailed(response.status));
    throw new ApiError(response.status, fallback["zh-CN"], fallback);
  }
  return payload as T;
}

export const api = {
  bootstrap: () => request<BootstrapDTO>("/api/bootstrap"),

  setup: (input: {
    workspaceName: string;
    userName: string;
    defaultExecutionModel: ChatSelectionDTO | null;
    approval: AppConfigDTO["approval"];
  }) => request<AppConfigDTO>("/api/setup", { method: "POST", body: JSON.stringify(input) }),

  updateApp: (patch: Record<string, unknown>) =>
    request<AppConfigDTO>("/api/app", { method: "PATCH", body: JSON.stringify(patch) }),

  models: () => request<{ models: ModelInfoDTO[]; providers: ProviderStatusDTO[] }>("/api/models"),

  checkModel: (model: { providerId: string; modelId: string }, kind: "chat" | "classifier") =>
    request<CheckResultDTO>("/api/models/check", {
      method: "POST",
      body: JSON.stringify({ model, kind }),
    }),

  createEmployee: (draft: EmployeeDraftDTO) =>
    request<EmployeeDTO>("/api/employees", { method: "POST", body: JSON.stringify(draft) }),

  updateEmployee: (id: string, patch: Record<string, unknown>) =>
    request<EmployeeDTO>(`/api/employees/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteEmployee: (id: string) => request<{ ok: true }>(`/api/employees/${id}`, { method: "DELETE" }),

  rooms: () => request<RoomDTO[]>("/api/rooms"),

  createRoom: (input: {
    kind: "channel" | "dm" | "mail";
    name: string;
    topic?: string;
    employeeId?: string;
    directories?: RoomDirectoryDraftDTO;
  }) => request<RoomDTO>("/api/rooms", { method: "POST", body: JSON.stringify(input) }),

  updateRoomDirectories: (id: string, draft: RoomDirectoryPatchDTO) =>
    request<RoomDTO>(`/api/rooms/${id}/directories`, { method: "PATCH", body: JSON.stringify(draft) }),

  messages: (roomId: string) => request<{ room: RoomDTO; messages: MessageDTO[] }>(`/api/rooms/${roomId}/messages`),

  sendMessage: (
    roomId: string,
    input: {
      body: string;
      employeeId?: string;
      subject?: string;
      to?: string[];
      cc?: string[];
      draft?: boolean;
      inReplyTo?: string;
    },
  ) =>
    request<{ message: MessageDTO; workId?: string; workIds?: string[]; error?: string; errorLocalized?: LocalizedText }>(
      `/api/rooms/${roomId}/messages`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  sendDraft: (roomId: string, entryId: string) =>
    request<{ message: MessageDTO; workIds: string[]; error?: string; errorLocalized?: LocalizedText }>(
      `/api/rooms/${roomId}/mail-send`,
      {
        method: "POST",
        body: JSON.stringify({ entryId }),
      },
    ),

  mailbox: () => request<{ items: MailboxItemDTO[] }>("/api/mail"),

  mailFlag: (roomId: string, entryId: string, change: { read?: boolean; archived?: boolean; active?: boolean }) =>
    request<{ ok: true; messages: MessageDTO[]; room?: RoomDTO }>(`/api/rooms/${roomId}/mail-flag`, {
      method: "POST",
      body: JSON.stringify({ entryId, ...change }),
    }),

  works: () => request<WorkDTO[]>("/api/works"),

  stopWork: (id: string) => request<{ ok: true }>(`/api/works/${id}/stop`, { method: "POST", body: "{}" }),

  /** One page of a work's durable execution record. */
  workExecution: (id: string, cursor?: string) =>
    request<WorkExecutionDTO>(
      `/api/works/${id}/execution${cursor !== undefined && cursor.length > 0 ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),

  approvals: () => request<{ approvals: ApprovalDTO[]; policyVersion: number }>("/api/approvals"),

  decideApproval: (id: string, decision: "approved" | "rejected", comment: string) =>
    request<ApprovalDTO>(`/api/approvals/${id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, comment }),
    }),

  skills: () => request<{ skills: SkillDTO[] }>("/api/skills"),

  importSkill: (directory: string) =>
    request<{ imported: SkillDTO[]; diagnostics: { severity: string; message: string; path: string }[] }>(
      "/api/skills/import",
      { method: "POST", body: JSON.stringify({ directory }) },
    ),

  deleteSkill: (id: string) => request<{ ok: true }>(`/api/skills/${id}`, { method: "DELETE" }),

  mcpServers: () => request<{ servers: BootstrapDTO["mcpServers"] }>("/api/mcp"),

  saveMcpServer: (draft: Record<string, unknown>) =>
    request<BootstrapDTO["mcpServers"][number]>("/api/mcp", { method: "POST", body: JSON.stringify(draft) }),

  deleteMcpServer: (id: string) => request<{ ok: true }>(`/api/mcp/${id}`, { method: "DELETE" }),

  connectMcpServer: (id: string) =>
    request<{ ok: boolean; message: string; messageLocalized?: LocalizedText; tools: string[] }>(
      `/api/mcp/${id}/connect`,
      {
        method: "POST",
        body: "{}",
      },
    ),

  customProviders: () => request<{ providers: CustomProviderConfigDTO[] }>("/api/providers/custom"),

  setCustomProviders: (providers: CustomProviderDraftDTO[]) =>
    request<{ providers: CustomProviderConfigDTO[]; statuses: ProviderStatusDTO[] }>("/api/providers/custom", {
      method: "PUT",
      body: JSON.stringify({ providers }),
    }),

  deleteProviderCredential: (id: string) =>
    request<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}/credential`, { method: "DELETE" }),

  refreshProvider: (id: string) =>
    request<{ ok: boolean; message: string; messageLocalized?: LocalizedText }>(
      `/api/providers/${encodeURIComponent(id)}/refresh`,
      {
        method: "POST",
        body: "{}",
      },
    ),

  startAuthSession: (providerId: string, type: "api_key" | "oauth") =>
    request<AuthSessionDTO>("/api/auth/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId, type }),
    }),

  authSession: (id: string) => request<AuthSessionDTO>(`/api/auth/sessions/${encodeURIComponent(id)}`),

  respondAuthSession: (id: string, promptId: string, value: string) =>
    request<AuthSessionDTO>(`/api/auth/sessions/${encodeURIComponent(id)}/respond`, {
      method: "POST",
      body: JSON.stringify({ promptId, value }),
    }),

  cancelAuthSession: (id: string) =>
    request<AuthSessionDTO>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/** Subscribe to the server event stream; returns the unsubscribe function. */
export function subscribeEvents(onEvent: (event: ServerEvent) => void, onStateChange: (open: boolean) => void): () => void {
  let source: EventSource | undefined;
  let closed = false;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    source = new EventSource("/api/events");
    source.onopen = () => {
      retry = 0;
      onStateChange(true);
    };
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as ServerEvent);
      } catch {
        // A malformed frame is dropped; the next event or a reload resyncs.
      }
    };
    source.onerror = () => {
      onStateChange(false);
      source?.close();
      source = undefined;
      retry = Math.min(retry + 1, 8);
      setTimeout(connect, 300 * retry);
    };
  };

  connect();
  return () => {
    closed = true;
    source?.close();
  };
}
