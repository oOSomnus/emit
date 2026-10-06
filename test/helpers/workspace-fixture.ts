import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatSelectionDTO, DirectoryDraftDTO, EmployeeDTO, RoomDTO, WorkContextDTO } from "../../src/shared/contracts.ts";
import { providerConfig } from "./emit-fixture.ts";

async function requestJson<T>(baseUrl: string, method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${responseBody}`);
  }
  try {
    return JSON.parse(responseBody) as T;
  } catch (error) {
    throw new Error(`${method} ${path} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Seed a fresh test workspace exclusively through Emit's public HTTP API. */
export async function seedTestWorkspace(options: {
  url: string;
  providerBaseUrl: string;
  root: string;
}): Promise<{
  workContextId: string;
  employeeIds: readonly string[];
  channelId: string;
  mailRoomId: string;
}> {
  await requestJson(options.url, "PUT", "/api/providers/custom", {
    providers: [providerConfig(options.providerBaseUrl)],
  });

  const executionModel: ChatSelectionDTO = {
    model: { providerId: "fake", modelId: "fake-chat" },
    effort: "off",
  };
  const reviewerModel: ChatSelectionDTO = {
    model: { providerId: "fake", modelId: "fake-reviewer" },
    effort: "off",
  };
  await requestJson(options.url, "POST", "/api/setup", {
    userName: "Test User",
    defaultExecutionModel: executionModel,
    approval: {
      kind: "llm",
      model: reviewerModel.model,
      effort: reviewerModel.effort,
      criteriaVersion: 3,
    },
  });

  const workDirectory = join(options.root, "work");
  mkdirSync(workDirectory, { recursive: true });
  const directories: DirectoryDraftDTO = { paths: [workDirectory], defaultPath: workDirectory };
  const workContext = await requestJson<WorkContextDTO>(options.url, "POST", "/api/work-contexts", {
    name: "Test Workspace",
    directories,
  });

  const employees: EmployeeDTO[] = [];
  for (const name of ["Alice", "Bob"]) {
    employees.push(
      await requestJson<EmployeeDTO>(options.url, "POST", "/api/employees", {
        name,
        role: "Test assistant",
        executionModel,
        generateAddress: true,
      }),
    );
  }
  const employeeIds = employees.map((employee) => employee.id);
  const channel = await requestJson<RoomDTO>(options.url, "POST", "/api/rooms", {
    kind: "channel",
    name: "General",
    topic: "",
    workContextId: workContext.id,
    memberIds: employeeIds,
  });
  const mailRoom = await requestJson<RoomDTO>(options.url, "POST", "/api/rooms", {
    kind: "mail",
    name: "Inbox",
    topic: "",
    workContextId: workContext.id,
    memberIds: employeeIds,
  });

  return {
    workContextId: workContext.id,
    employeeIds,
    channelId: channel.id,
    mailRoomId: mailRoom.id,
  };
}
