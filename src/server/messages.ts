/**
 * Application messages the server attaches to browser-visible outcomes.
 *
 * The values and helpers live in the leaf module `./app-text.ts`; this module
 * assembles the catalog from `./messages/*` and re-exports the helpers so
 * existing importers keep one stable surface.
 */

import { apiMessages } from "./messages/api.ts";
import { approvalMessages } from "./messages/approval.ts";
import { addressingMessages } from "./messages/addressing.ts";
import { authMessages } from "./messages/auth.ts";
import { llmCallMessages } from "./messages/llm-calls.ts";
import { mcpMessages } from "./messages/mcp.ts";
import { mailMessages } from "./messages/mail.ts";
import { modelMessages } from "./messages/models.ts";
import { providerMessages } from "./messages/providers.ts";
import { roomMessages } from "./messages/rooms.ts";
import { workMessages } from "./messages/work.ts";
import { workContextMessages } from "./messages/work-contexts.ts";
import { workspaceMessages } from "./messages/workspace.ts";

export { AppError, appText, fromError, rawText, type AppText } from "./app-text.ts";

export const appMessages = {
  api: apiMessages,
  addressing: addressingMessages,
  workspace: workspaceMessages,
  rooms: roomMessages,
  work: workMessages,
  workContexts: workContextMessages,
  mail: mailMessages,
  approval: approvalMessages,
  models: modelMessages,
  auth: authMessages,
  providers: providerMessages,
  mcp: mcpMessages,
  llmCalls: llmCallMessages,
};
