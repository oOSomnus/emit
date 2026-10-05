/**
 * Group-message addressing: who a channel message wakes.
 *
 * The same pure function runs in the browser for the live preview and on the
 * server as the authority. Routing comes only from the explicit selection: the
 * recipient ids the composer (or a tool) selected, plus the explicit
 * "address everyone" toggle. The message text is content, never a routing
 * signal — an @ mention, a name, an address, or `@all` in the body wakes
 * nobody.
 */

import type { EmployeeDTO } from "./contracts.ts";

export type MessageAddressingErrorCode = "not-member" | "disabled" | "empty-all";

/** A failed addressing resolution; the caller formats it in its own language. */
export class MessageAddressingError extends Error {
  constructor(
    readonly code: MessageAddressingErrorCode,
    readonly token: string,
    readonly employeeId: string,
  ) {
    super(`message addressing failed: ${code} (${token || employeeId})`);
    this.name = "MessageAddressingError";
  }
}

/** The member facts addressing needs; the full employee list includes disabled ones. */
export type AddressableMember = Pick<EmployeeDTO, "id" | "name" | "address" | "enabled">;

export type ResolvedMessageAddressing = { recipientIds: string[]; mentionAll: boolean };

/** Reject malformed runtime input: the types this contract is written against. */
function assertInputs(
  requestedIds: unknown,
  mentionAll: unknown,
  members: unknown,
): void {
  if (!Array.isArray(requestedIds) || requestedIds.some((id) => typeof id !== "string")) {
    throw new TypeError("requestedIds must be an array of strings");
  }
  if (typeof mentionAll !== "boolean") throw new TypeError("mentionAll must be a boolean");
  if (!Array.isArray(members)) throw new TypeError("members must be an array");
  for (const member of members) {
    if (typeof member !== "object" || member === null) throw new TypeError("each member must be an object");
    const entry = member as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.address !== "string") {
      throw new TypeError("each member needs string id, name, and address");
    }
    if (typeof entry.enabled !== "boolean") throw new TypeError("each member needs a boolean enabled flag");
  }
}

/**
 * Resolve the wake set of one message from the explicit selection alone.
 *
 * @param requestedIds the selected recipient ids; deduplicated, validated
 * @param mentionAll the explicit "address everyone" toggle
 * @param members the room's employees, enabled and disabled
 */
export function resolveMessageAddressing(
  requestedIds: readonly string[],
  mentionAll: boolean,
  members: readonly AddressableMember[],
): ResolvedMessageAddressing {
  assertInputs(requestedIds, mentionAll, members);
  const byId = new Map(members.map((member) => [member.id, member]));
  const resolved = new Set<string>();

  const requireMember = (id: string): AddressableMember => {
    const member = byId.get(id);
    if (member === undefined) throw new MessageAddressingError("not-member", id, id);
    if (!member.enabled) throw new MessageAddressingError("disabled", member.name, member.id);
    return member;
  };

  for (const id of requestedIds) {
    if (id.length === 0) throw new MessageAddressingError("not-member", "", "");
    resolved.add(requireMember(id).id);
  }

  if (mentionAll) {
    const enabled = members.filter((member) => member.enabled);
    if (enabled.length === 0) throw new MessageAddressingError("empty-all", "", "");
    for (const member of enabled) resolved.add(member.id);
  }

  return { recipientIds: [...resolved], mentionAll };
}
