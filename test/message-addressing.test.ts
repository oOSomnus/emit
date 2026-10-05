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
  requestedIds: readonly string[] = [],
  mentionAll = false,
  candidates: readonly AddressableMember[] = members,
) {
  return resolveMessageAddressing(requestedIds, mentionAll, candidates);
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

function resolveUnknownInput(requestedIds: unknown, mentionAll: unknown, candidates: unknown) {
  return resolveMessageAddressing(
    requestedIds as readonly string[],
    mentionAll as boolean,
    candidates as readonly AddressableMember[],
  );
}

describe("resolveMessageAddressing", () => {
  it("deduplicates repeated explicit recipients", () => {
    const result = resolve(["bea", "ada", "bea"]);

    expectRecipientIds(result.recipientIds, ["ada", "bea"]);
    expect(result.recipientIds).toHaveLength(2);
    expect(result.mentionAll).toBe(false);
  });

  it("keeps an empty selection empty", () => {
    const result = resolve();

    expect(result.recipientIds).toEqual([]);
    expect(result.mentionAll).toBe(false);
  });

  it("expands the explicit mention-all toggle to enabled members only", () => {
    const result = resolve([], true);

    expectRecipientIds(result.recipientIds, ["ada", "bea"]);
    expect(result.mentionAll).toBe(true);
  });

  it("unions explicit recipients with the explicit mention-all toggle", () => {
    const result = resolve(["bea"], true);

    expectRecipientIds(result.recipientIds, ["ada", "bea"]);
    expect(result.mentionAll).toBe(true);
  });

  it("selects duplicate display names by their explicit ids", () => {
    const samMembers: AddressableMember[] = [
      { id: "sam-one", name: "Sam", address: "sam.one@example.test", enabled: true },
      { id: "sam-two", name: "Sam", address: "sam.two@example.test", enabled: true },
    ];

    const result = resolve(["sam-two"], false, samMembers);

    expect(result.recipientIds).toEqual(["sam-two"]);
  });

  it("reports an explicitly selected employee who is not a member", () => {
    expectAddressingError(
      () => resolve(["outsider"]),
      { code: "not-member", token: "outsider", employeeId: "outsider" },
    );
  });

  it("rejects an empty explicit recipient ID", () => {
    expectAddressingError(
      () => resolve([""]),
      { code: "not-member", token: "", employeeId: "" },
    );
  });

  it("reports a disabled recipient", () => {
    expectAddressingError(
      () => resolve(["cara"]),
      { code: "disabled", token: "Cara", employeeId: "cara" },
    );
  });

  it("reports an empty all-members selection", () => {
    const disabledOnly: AddressableMember[] = [
      { id: "cara", name: "Cara", address: "cara@example.test", enabled: false },
    ];

    expectAddressingError(
      () => resolve([], true, disabledOnly),
      { code: "empty-all", token: "", employeeId: "" },
    );
  });

  it.each([
    ["non-array recipient IDs", "not-an-array", false, members],
    ["non-string recipient IDs", ["ada", 7], false, members],
    ["non-boolean mentionAll", [], "false", members],
    ["non-array members", [], false, null],
  ])("throws TypeError for %s", (_label, requestedIds, mentionAll, candidates) => {
    expect(() => resolveUnknownInput(requestedIds, mentionAll, candidates)).toThrow(TypeError);
  });

  it.each([
    ["id", { id: 7, name: "Ada", address: "ada@example.test", enabled: true }],
    ["name", { id: "ada", name: 7, address: "ada@example.test", enabled: true }],
    ["address", { id: "ada", name: "Ada", address: 7, enabled: true }],
    ["enabled flag", { id: "ada", name: "Ada", address: "ada@example.test", enabled: "yes" }],
    ["member entry", "ada"],
  ])("throws TypeError for a non-conforming member %s", (_label, candidate) => {
    expect(() => resolveUnknownInput([], false, [candidate])).toThrow(TypeError);
  });
});
