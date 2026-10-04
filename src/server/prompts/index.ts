/**
 * Every model-visible instruction that Emit itself authors, as readable
 * resources.
 *
 * Business modules render prompts only through this module's typed renderers;
 * natural-language sentences live in the adjacent resource files, and
 * conditionals stay in the calling code. The loader validates resources once
 * at startup; a missing fragment, an unknown variable, or malformed JSON is a
 * configuration error, never a silent fallback to a stale inline string.
 */
import { fill, readResource, resourceFragments, resourceJson } from "./loader.ts";
import type { SkillRecord, RoomMessageData } from "../documents.ts";
import type { MailAddress } from "../rooms.ts";
import type { MessageDTO } from "../../shared/contracts.ts";
import type { WorkKind } from "../work.ts";

// The shapes of the work input prompt; kept here so the prompt and its limits
// cannot drift apart.
export const HISTORY_MESSAGE_LIMIT = 40;
export const HISTORY_BODY_LIMIT = 2_000;

const FILES = [
  "employee.md",
  "context.md",
  "skills.md",
  "work-input.md",
  "continuations.md",
  "tool-results.md",
  "approval-system.md",
  "approval-user.md",
  "approval-context.md",
  "address-system.md",
  "address-user.md",
] as const;

const fragmentFiles: Record<string, ReadonlyMap<string, string>> = {};
for (const file of FILES) fragmentFiles[file] = resourceFragments(file);

function fragment(file: string, id: string): string {
  const found = fragmentFiles[file]?.get(id);
  if (found === undefined) throw new Error(`提示词资源 ${file} 缺少片段 ${id}`);
  return found;
}

function filled(
  file: string,
  id: string,
  vars: Readonly<Record<string, string | number>>,
): string {
  return fill(fragment(file, id), { file, fragment: id }, vars);
}

// --- Employee identity, workspace context, skills -------------------------

export function renderEmployeeIdentity(input: {
  name: string;
  address: string;
  role: string;
  instructions: string;
}): string {
  return filled("employee.md", "identity", {
    name: input.name,
    address: input.address,
    role: input.role,
    instructionsBlock:
      input.instructions.length > 0
        ? `\n\n${fragment("employee.md", "instructions-heading")}\n${input.instructions}`
        : "",
  });
}

export type EmployeeContextInput = {
  /** Workspace facts, or null when the app record cannot be read. */
  app: {
    workspaceName: string;
    workspaceSlug: string;
    maxDepth: number;
    maxCrossEmployeeWakes: number;
  } | null;
  directory:
    | { kind: "error"; message: string }
    | { kind: "missing-room" }
    | {
        kind: "paths";
        roomLabel: "频道" | "私信" | "邮件会话";
        roomName: string;
        directoryVersion: number;
        paths: readonly string[];
        defaultPath: string;
      };
  workContext: {
    id: string;
    name: string;
    goal: string;
    instructions: string;
    resources: readonly { id: string; kind: "file" | "url"; name: string; location: string }[];
    remainingResources: number;
    notes: readonly {
      id: string;
      title: string;
      authorId: string;
      sourceRoomId: string;
      sourceEntryId: string;
      sourceWorkId: string;
    }[];
    remainingNotes: number;
  } | null;
  work: { kind: "delegation" } | { kind: "room" } | { kind: "none" };
};

export function renderEmployeeContext(input: EmployeeContextInput): string {
  const parts: string[] = [];
  if (input.app !== null) {
    parts.push(
      filled("context.md", "workspace", {
        workspaceName: input.app.workspaceName,
        workspaceSlug: input.app.workspaceSlug,
      }),
      filled("context.md", "collaboration", {
        maxDepth: input.app.maxDepth,
        maxCrossEmployeeWakes: input.app.maxCrossEmployeeWakes,
      }),
    );
  }
  if (input.workContext !== null) {
    const resources = JSON.stringify(input.workContext.resources) ?? "[]";
    const notes = JSON.stringify(input.workContext.notes) ?? "[]";
    parts.push(
      filled("context.md", "work-context", {
        id: input.workContext.id,
        name: input.workContext.name,
        goal: input.workContext.goal,
        instructions: input.workContext.instructions,
      }),
      filled("context.md", "work-context-resources", {
        indexes: resources,
        total: input.workContext.resources.length + input.workContext.remainingResources,
        remaining: input.workContext.remainingResources,
      }),
      filled("context.md", "work-context-notes", {
        indexes: notes,
        total: input.workContext.notes.length + input.workContext.remainingNotes,
        remaining: input.workContext.remainingNotes,
      }),
    );
  }
  if (input.directory.kind === "error") {
    parts.push(input.directory.message);
  } else if (input.directory.kind === "missing-room") {
    parts.push(fragment("context.md", "directory-missing-room"));
  } else {
    parts.push(
      filled("context.md", "directory-source", {
        roomLabel: input.directory.roomLabel,
        roomName: input.directory.roomName,
        directoryVersion: input.directory.directoryVersion,
      }),
    );
    if (input.directory.paths.length === 0) {
      parts.push(fragment("context.md", "directory-empty"));
    } else {
      parts.push(
        filled("context.md", "directory-paths", { paths: input.directory.paths.join("、") }),
        filled("context.md", "directory-default", { defaultPath: input.directory.defaultPath }),
      );
    }
  }
  if (input.work.kind === "delegation") parts.push(fragment("context.md", "work-delegation"));
  else if (input.work.kind === "room") parts.push(fragment("context.md", "work-room"));
  return parts.join("\n");
}

/** The prompt section that advertises an employee's bound skills. */
export function renderSkillSection(
  skills: readonly SkillRecord[],
  selectedIds: readonly string[],
): string {
  const bound = skills.filter((skill) => selectedIds.includes(skill.id));
  if (bound.length === 0) return "";
  const lines = bound.map((skill) =>
    filled("skills.md", "item", {
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
    }),
  );
  return `${fragment("skills.md", "intro")}\n\n${lines.join("\n")}`;
}

// --- Work input ------------------------------------------------------------

export function renderWorkInput(
  history: readonly MessageDTO[],
  intent: string,
  kind: WorkKind,
  mailSource?: { entryId: string; message: RoomMessageData },
): string {
  const parts: string[] = [];
  if (history.length > 0) {
    parts.push(fragment("work-input.md", "history-header"));
    for (const message of history.slice(-HISTORY_MESSAGE_LIMIT)) {
      const authorLabel =
        message.author.type === "user"
          ? fragment("work-input.md", "author-user")
          : message.author.type === "employee"
            ? message.author.name
            : fragment("work-input.md", "author-system");
      const body =
        message.body.length > HISTORY_BODY_LIMIT
          ? `${message.body.slice(0, HISTORY_BODY_LIMIT)}…`
          : message.body;
      parts.push(filled("work-input.md", "message", { authorLabel, body }));
    }
    parts.push("");
  }
  if (kind === "mail") {
    const mail = mailSource?.message.mail;
    if (mailSource === undefined || mail === null || mail === undefined) {
      throw new Error("找不到本次邮件原文，无法生成回复任务");
    }
    const source = mailSource.message;
    parts.push(
      fragment("work-input.md", "mail-rules-header"),
      fragment("work-input.md", "mail-auto-reply"),
      fragment("work-input.md", "mail-send-mail-use"),
      fragment("work-input.md", "mail-enough-info"),
      fragment("work-input.md", "mail-envelope-intro"),
      JSON.stringify({
        entryId: mailSource.entryId,
        from: { type: source.authorType, name: source.authorName, address: source.address },
        to: mail.to,
        cc: mail.cc,
        subject: mail.subject,
        inReplyTo: mail.inReplyTo,
      }),
      "",
    );
  }
  parts.push(
    kind === "mail"
      ? fragment("work-input.md", "request-mail")
      : kind === "delegation"
        ? fragment("work-input.md", "request-delegation")
        : fragment("work-input.md", "request-message"),
  );
  parts.push(kind === "mail" && mailSource !== undefined ? mailSource.message.body : intent);
  return parts.join("\n");
}

// --- Continuations ---------------------------------------------------------

export function renderDelegationContinuation(employeeName: string, text: string): string {
  return filled("continuations.md", "delegation-result", { employeeName, text });
}

export type MailContinuationInput = {
  subject: string;
  from: { name: string; address: string };
  to: readonly MailAddress[];
  cc: readonly MailAddress[];
  inReplyTo: string;
  entryId: string;
  outcome: "reply" | "failed" | "stopped";
  body: string;
  error: string;
};

export function renderMailContinuation(input: MailContinuationInput): string {
  const names = (addresses: readonly MailAddress[]): string =>
    addresses.map((entry) => `${entry.name} <${entry.address}>`).join("、");
  return filled("continuations.md", "mail-continuation", {
    subject: input.subject,
    fromName: input.from.name,
    fromAddress: input.from.address,
    to: names(input.to),
    cc: input.cc.length > 0 ? names(input.cc) : "(无)",
    inReplyTo: input.inReplyTo,
    entryId: input.entryId,
    outcome: fragment("continuations.md", `mail-continuation-outcome-${input.outcome}`),
    errorBlock:
      input.error.length > 0
        ? filled("continuations.md", "mail-continuation-error", { error: input.error })
        : "",
    body: input.body,
  });
}

// --- Tool results and collaboration tool text ------------------------------

export const TOOL_RESULT_FRAGMENTS = [
  "read-too-large",
  "read-lines-suffix",
  "write-ok",
  "edit-ambiguous",
  "edit-ok",
  "shell-failed",
  "shell-failed-spill",
  "shell-exit",
  "shell-exit-spill",
  "skill-directory",
  "skill-truncated",
  "skill-missing",
  "send-message-ok",
  "send-channel-ok",
  "send-channel-nobody",
  "invite-ok",
  "invite-replay",
  "note-list",
  "note-saved",
  "send-mail-ok",
  "delegate-ok",
] as const;

export type ToolResultFragment = (typeof TOOL_RESULT_FRAGMENTS)[number];

export function renderToolResult(
  fragmentId: ToolResultFragment,
  input: Readonly<Record<string, string | number>> = {},
): string {
  return filled("tool-results.md", fragmentId, input);
}

export type BuiltinToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "run_shell"
  | "load_skill"
  | "send_message"
  | "invite_to_channel"
  | "list_work_notes"
  | "read_work_note"
  | "save_work_note"
  | "send_mail"
  | "delegate_task";

const BUILTIN_TOOL_NAMES: readonly BuiltinToolName[] = [
  "read_file",
  "write_file",
  "edit_file",
  "run_shell",
  "load_skill",
  "send_message",
  "invite_to_channel",
  "list_work_notes",
  "read_work_note",
  "save_work_note",
  "send_mail",
  "delegate_task",
];

type ToolTextResource = { description: string; parameters: Record<string, string> };

const toolResources = resourceJson<Record<string, ToolTextResource>>("tools.json");
for (const name of BUILTIN_TOOL_NAMES) {
  const entry = toolResources[name];
  if (entry === undefined || typeof entry.description !== "string") {
    throw new Error(`提示词资源 tools.json 缺少工具 ${name} 的说明`);
  }
}

/** Tool and parameter descriptions, keyed by the built-in tool name. */
export const toolTextResources: Record<BuiltinToolName, ToolTextResource> = Object.fromEntries(
  BUILTIN_TOOL_NAMES.map((name) => [name, toolResources[name]!]),
) as Record<BuiltinToolName, ToolTextResource>;

// --- Approval review -------------------------------------------------------

export function renderApprovalSystem(): string {
  return readResource("approval-system.md").trim();
}

export function renderApprovalUser(caseJson: string): string {
  return fill(readResource("approval-user.md"), { file: "approval-user.md" }, { caseJson });
}

export const APPROVAL_CONTEXT_LABELS = [
  "compaction-marker",
  "reset-marker",
  "tool-call",
  "tool-result",
  "error-mark",
  "origin-room",
  "origin-delegation",
] as const;

export type ApprovalContextLabel = (typeof APPROVAL_CONTEXT_LABELS)[number];

export function renderApprovalContext(
  label: ApprovalContextLabel,
  input: Readonly<Record<string, string | number>> = {},
): string {
  return filled("approval-context.md", label, input);
}

export type ClassifierQuestions = {
  outcome: { type: "choice"; instructions: string; criteria: Record<string, string> };
  risk: { type: "choice"; instructions: string; criteria: Record<string, string> };
  read_only: { type: "bool"; instructions: string; criteria: { true: string; false: string } };
  authorized: { type: "bool"; instructions: string; criteria: { true: string; false: string } };
};

const classifierResource = resourceJson<{
  evidence_trust: string;
  questions: {
    [K in keyof ClassifierQuestions]: {
      type: string;
      instructions: string;
      criteria: Record<string, string>;
    };
  };
}>("classifier.json");
for (const key of ["outcome", "risk", "read_only", "authorized"] as const) {
  if (classifierResource.questions[key]?.instructions === undefined) {
    throw new Error(`提示词资源 classifier.json 缺少 ${key} 问题`);
  }
}

export const classifierEvidenceTrust: string = classifierResource.evidence_trust;

/** The v3 native classifier questions, word for word. */
export function classifierQuestions(): ClassifierQuestions {
  const resource = classifierResource.questions;
  return {
    outcome: { type: "choice", instructions: resource.outcome.instructions, criteria: { ...resource.outcome.criteria } },
    risk: { type: "choice", instructions: resource.risk.instructions, criteria: { ...resource.risk.criteria } },
    read_only: {
      type: "bool",
      instructions: resource.read_only.instructions,
      criteria: {
        true: resource.read_only.criteria.true ?? "",
        false: resource.read_only.criteria.false ?? "",
      },
    },
    authorized: {
      type: "bool",
      instructions: resource.authorized.instructions,
      criteria: {
        true: resource.authorized.criteria.true ?? "",
        false: resource.authorized.criteria.false ?? "",
      },
    },
  };
}

// --- Address suggestion and connection probes ------------------------------

export function renderAddressSystem(): string {
  return readResource("address-system.md").trim();
}

export function renderAddressUser(input: { workspaceSlug: string; name: string; role: string }): string {
  return fill(
    readResource("address-user.md"),
    { file: "address-user.md" },
    {
      workspaceSlug: input.workspaceSlug,
      name: input.name,
      role: input.role.length > 0 ? input.role : "(unnamed role)",
    },
  );
}

const probeResource = resourceJson<{
  chat: string;
  classifier: {
    state: { probe: string };
    question: { type: string; instructions: string; criteria: { true?: string; false?: string } };
  };
}>("probes.json");

export const probeResources: {
  chat: string;
  classifier: {
    state: { probe: string };
    question: { type: "bool"; instructions: string; criteria: { true: string; false: string } };
  };
} = {
  chat: probeResource.chat,
  classifier: {
    state: { probe: probeResource.classifier.state.probe },
    question: {
      type: "bool",
      instructions: probeResource.classifier.question.instructions,
      criteria: {
        true: probeResource.classifier.question.criteria.true ?? "",
        false: probeResource.classifier.question.criteria.false ?? "",
      },
    },
  },
};
