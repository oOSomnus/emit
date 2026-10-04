/**
 * Group-message addressing: who a channel message wakes.
 *
 * The same pure function runs in the browser for the live preview and on the
 * server as the authority. It never guesses: an @ token that matches nobody is
 * an error, a name shared by two members must be disambiguated with an
 * address, and `@all` expands to the members that are enabled at send time.
 *
 * Mention text inside fenced code blocks or inline code is not addressing —
 * an employee quoting `@someone` in a snippet must not wake anybody.
 */

import type { EmployeeDTO } from "./contracts.ts";

export type MessageAddressingErrorCode =
  | "unknown-mention"
  | "ambiguous-mention"
  | "not-member"
  | "disabled"
  | "empty-all";

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

const BOUNDARY = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  ",",
  ".",
  ";",
  ":",
  "!",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  '"',
  "'",
  "，",
  "。",
  "；",
  "：",
  "！",
  "？",
  "（",
  "）",
  "【",
  "】",
  "「",
  "」",
  "《",
  "》",
  "“",
  "”",
  "‘",
  "’",
  "、",
]);

const ALL_TOKENS = new Set(["all", "全体"]);

/** Reject malformed runtime input: the types this contract is written against. */
function assertInputs(
  body: unknown,
  requestedIds: unknown,
  mentionAll: unknown,
  members: unknown,
): asserts body is string {
  if (typeof body !== "string") throw new TypeError("message body must be a string");
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

/** Remove fenced code blocks and inline code spans from the scanned text. */
function withoutCode(body: string): string {
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/**
 * Resolve the wake set of one message.
 *
 * @param body the message text, scanned for @ mentions outside code
 * @param requestedIds explicitly selected recipient ids from the composer
 * @param mentionAll the explicit "address everyone" toggle
 * @param members the room's employees, enabled and disabled, with names and addresses
 */
export function resolveMessageAddressing(
  body: string,
  requestedIds: readonly string[],
  mentionAll: boolean,
  members: readonly AddressableMember[],
): ResolvedMessageAddressing {
  assertInputs(body, requestedIds, mentionAll, members);
  const byId = new Map(members.map((member) => [member.id, member]));
  const resolved = new Set<string>();
  let addressesEveryone = mentionAll;

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

  // Longest key first, so "Ada Lovelace" wins over a member named "Ada"; the
  // matched text must end at a boundary, so "@Adalovelace" is not a mention.
  type Key = { key: string; ids: string[] };
  const keys = new Map<string, Key>();
  const addKey = (key: string, id: string) => {
    if (key.length === 0) return;
    const existing = keys.get(key);
    if (existing === undefined) keys.set(key, { key, ids: [id] });
    else if (!existing.ids.includes(id)) existing.ids.push(id);
  };
  for (const member of members) {
    addKey(member.name.toLowerCase(), member.id);
    addKey(member.address.toLowerCase(), member.id);
  }
  const ordered = [...keys.values()].sort((a, b) => b.key.length - a.key.length);

  const text = withoutCode(body);
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@") continue;
    if (index > 0 && !BOUNDARY.has(text[index - 1]!)) continue;
    const rest = text.slice(index + 1);
    const lowered = rest.toLowerCase();
    const matched = ordered.find((candidate) => {
      if (!lowered.startsWith(candidate.key)) return false;
      const after = rest[candidate.key.length] ?? "";
      return after === "" || BOUNDARY.has(after);
    });
    if (matched !== undefined) {
      if (matched.ids.length > 1) {
        throw new MessageAddressingError("ambiguous-mention", rest.slice(0, matched.key.length), "");
      }
      resolved.add(requireMember(matched.ids[0]!).id);
      index += matched.key.length;
      continue;
    }
    let end = index + 1;
    while (end < text.length && !BOUNDARY.has(text[end]!)) end += 1;
    const token = text.slice(index + 1, end);
    if (ALL_TOKENS.has(token.toLowerCase())) addressesEveryone = true;
    else if (token.length > 0) throw new MessageAddressingError("unknown-mention", token, "");
    index = end - 1;
  }

  if (addressesEveryone) {
    const enabled = members.filter((member) => member.enabled);
    if (enabled.length === 0) throw new MessageAddressingError("empty-all", "", "");
    for (const member of enabled) resolved.add(member.id);
  }

  return { recipientIds: [...resolved], mentionAll: addressesEveryone };
}
