import { describe, expect, it } from "vitest";
import {
  MessageAddressingError,
  resolveMessageAddressing,
  type AddressableMember,
} from "../src/shared/message-addressing.ts";

const members: AddressableMember[] = [
  { id: "ada", name: "Ada", address: "ada@example.test", enabled: true },
  { id: "bea", name: "Bea", address: "bea@example.test", enabled: true },
  { id: "cara", name: "Cara", address: "cara@example.test", enabled: false },
];

function resolve(
  body: string,
  requestedIds: readonly string[] = [],
  mentionAll = false,
  candidates: readonly AddressableMember[] = members,
) {
  return resolveMessageAddressing(body, requestedIds, mentionAll, candidates);
}

function expectRecipientIds(actual: readonly string[], expected: readonly string[]) {
  expect([...actual].sort()).toEqual([...expected].sort());
}

function expectAddressingError(
  run: () => unknown,
  expected: {
    code: MessageAddressingError["code"];
    token: string;
    employeeId: string;
  },
) {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MessageAddressingError);
  const error = thrown as MessageAddressingError;
  expect(error.code).toBe(expected.code);
  expect(error.token).toBe(expected.token);
  expect(error.employeeId).toBe(expected.employeeId);
}

function resolveUnknownInput(
  body: unknown,
  requestedIds: unknown,
  mentionAll: unknown,
  candidates: unknown,
) {
  return resolveMessageAddressing(
    body as string,
    requestedIds as readonly string[],
    mentionAll as boolean,
    candidates as readonly AddressableMember[],
  );
}

describe("resolveMessageAddressing", () => {
  it("unions explicit recipients with body mentions and deduplicates them", () => {
    const result = resolve("@Ada, @bea@example.test and @Ada", ["bea"]);

    expectRecipientIds(result.recipientIds, ["ada", "bea"]);
    expect(result.recipientIds).toHaveLength(2);
    expect(result.mentionAll).toBe(false);
  });

  it.each(["@all", "@全体"])("expands %s to enabled members only", (body) => {
    const result = resolve(body);

    expectRecipientIds(result.recipientIds, ["ada", "bea"]);
    expect(result.mentionAll).toBe(true);
  });

  it("expands the explicit mention-all toggle to enabled members", () => {
    const result = resolve("No body mention", [], true);

    expectRecipientIds(result.recipientIds, ["ada", "bea"]);
    expect(result.mentionAll).toBe(true);
  });

  it("resolves a unique name and a full address mention", () => {
    const result = resolve("@ADA; please ask @bea@example.test");

    expectRecipientIds(result.recipientIds, ["ada", "bea"]);
  });

  it("chooses the longest matching name when one employee name prefixes another", () => {
    const candidates: AddressableMember[] = [
      { id: "ada", name: "Ada", address: "ada@example.test", enabled: true },
      { id: "ada-lovelace", name: "Ada Lovelace", address: "lovelace@example.test", enabled: true },
    ];

    const result = resolve("@Ada Lovelace, see the notes", [], false, candidates);

    expect(result.recipientIds).toEqual(["ada-lovelace"]);
  });

  it.each([
    ["start of text", ""],
    ["space", " "],
    ["tab", "\t"],
    ["newline", "\n"],
    ["comma", ","],
    ["period", "."],
    ["question mark", "?"],
    ["exclamation mark", "!"],
    ["colon", ":"],
    ["semicolon", ";"],
    ["opening parenthesis", "("],
    ["closing parenthesis", ")"],
  ])("recognizes mentions after a %s boundary", (_label, prefix) => {
    const result = resolve(`${prefix}@Ada)`);

    expect(result.recipientIds).toEqual(["ada"]);
  });

  it("does not interpret ordinary email addresses as mentions", () => {
    const result = resolve("Contact ada@example.test or bea+tag@example.test for details.");

    expect(result.recipientIds).toEqual([]);
    expect(result.mentionAll).toBe(false);
  });

  it("ignores mentions and unknown tokens inside fenced and single-backtick code", () => {
    const result = resolve("```text\n@Ada @unknown\n``` and `@Bea @missing` then @Ada");

    expect(result.recipientIds).toEqual(["ada"]);
  });

  it("disambiguates duplicate names with a full address", () => {
    const samMembers: AddressableMember[] = [
      { id: "sam-one", name: "Sam", address: "sam.one@example.test", enabled: true },
      { id: "sam-two", name: "Sam", address: "sam.two@example.test", enabled: true },
    ];

    const result = resolve("@sam.two@example.test", [], false, samMembers);

    expect(result.recipientIds).toEqual(["sam-two"]);
  });

  it("allows explicit recipient IDs when duplicate names are not mentioned", () => {
    const samMembers: AddressableMember[] = [
      { id: "sam-one", name: "Sam", address: "sam.one@example.test", enabled: true },
      { id: "sam-two", name: "Sam", address: "sam.two@example.test", enabled: true },
    ];

    const result = resolve("Please take a look", ["sam-two"], false, samMembers);

    expect(result.recipientIds).toEqual(["sam-two"]);
  });

  it("still rejects an ambiguous body name when an explicit recipient is selected", () => {
    const samMembers: AddressableMember[] = [
      { id: "sam-one", name: "Sam", address: "sam.one@example.test", enabled: true },
      { id: "sam-two", name: "Sam", address: "sam.two@example.test", enabled: true },
    ];

    expectAddressingError(
      () => resolve("@Sam", ["sam-one"], false, samMembers),
      { code: "ambiguous-mention", token: "Sam", employeeId: "" },
    );
  });

  it("reports an unknown leading @ token", () => {
    expectAddressingError(
      () => resolve("Thanks, @nobody."),
      { code: "unknown-mention", token: "nobody", employeeId: "" },
    );
  });

  it("reports an explicitly selected employee who is not a member", () => {
    expectAddressingError(
      () => resolve("", ["outsider"]),
      { code: "not-member", token: "outsider", employeeId: "outsider" },
    );
  });

  it("reports a disabled recipient", () => {
    expectAddressingError(
      () => resolve("", ["cara"]),
      { code: "disabled", token: "Cara", employeeId: "cara" },
    );
  });

  it("reports an empty all-members selection", () => {
    const disabledOnly: AddressableMember[] = [
      { id: "cara", name: "Cara", address: "cara@example.test", enabled: false },
    ];

    expectAddressingError(
      () => resolve("@all", [], false, disabledOnly),
      { code: "empty-all", token: "", employeeId: "" },
    );
  });

  it.each([
    ["non-array recipient IDs", "", "not-an-array", false, members],
    ["non-boolean mentionAll", "", [], "false", members],
    ["non-array members", "", [], false, null],
    ["non-string body", 123, [], false, members],
  ])("throws for %s", (_label, body, requestedIds, mentionAll, candidates) => {
    expect(() => resolveUnknownInput(body, requestedIds, mentionAll, candidates)).toThrow();
  });

  it.each([
    ["id", { id: 7, name: "Ada", address: "ada@example.test", enabled: true }],
    ["name", { id: "ada", name: 7, address: "ada@example.test", enabled: true }],
    ["address", { id: "ada", name: "Ada", address: 7, enabled: true }],
    ["enabled flag", { id: "ada", name: "Ada", address: "ada@example.test", enabled: "yes" }],
    ["member entry", "ada"],
  ])("throws for a non-conforming member %s", (_label, candidate) => {
    expect(() => resolveUnknownInput("@Ada", [], false, [candidate])).toThrow();
  });
});
