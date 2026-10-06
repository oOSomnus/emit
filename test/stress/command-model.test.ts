import * as fc from "fast-check";
import type { WorkContextDTO, WorkNoteResponseDTO } from "../../src/shared/contracts.ts";
import { describe, expect, it } from "vitest";
import { createE2eFixture } from "../helpers/e2e-fixture.ts";
import { loadTestSettings } from "../helpers/test-settings.ts";
import { printStressMetrics, StressMetrics, stressRequest } from "../helpers/stress-metrics.ts";

const settings = loadTestSettings();
const requestTimeoutMs = Math.min(settings.durationMs, 30_000);

type NoteState = { id: string; title: string; body: string };
type ContextModel = {
  version: number;
  goal: string;
  instructions: string;
  note: NoteState | undefined;
};
type ContextSystem = { baseUrl: string; contextId: string; metrics: StressMetrics };
type Command = fc.AsyncCommand<ContextModel, ContextSystem>;

class PatchContextCommand implements Command {
  constructor(readonly goal: string, readonly instructions: string) {}

  check(): boolean {
    return true;
  }

  async run(model: ContextModel, system: ContextSystem): Promise<void> {
    const response = await stressRequest<WorkContextDTO>(system.metrics, system.baseUrl, `/api/work-contexts/${system.contextId}`, {
      method: "PATCH",
      body: { expectedVersion: model.version, goal: this.goal, instructions: this.instructions },
      timeoutMs: requestTimeoutMs,
    });
    expect(response.body.id).toBe(system.contextId);
    const expectedVersion = model.version + (this.goal === model.goal && this.instructions === model.instructions ? 0 : 1);
    expect(response.body.version).toBe(expectedVersion);
    expect(response.body.goal).toBe(this.goal);
    expect(response.body.instructions).toBe(this.instructions);
    model.version = response.body.version;
    model.goal = this.goal;
    model.instructions = this.instructions;
  }

  toString(): string {
    return `PatchContext(${JSON.stringify(this.goal)}, ${JSON.stringify(this.instructions)})`;
  }
}

class CreateNoteCommand implements Command {
  constructor(readonly title: string, readonly body: string) {}

  check(model: Readonly<ContextModel>): boolean {
    return model.note === undefined;
  }

  async run(model: ContextModel, system: ContextSystem): Promise<void> {
    const response = await stressRequest<WorkNoteResponseDTO>(system.metrics, system.baseUrl, `/api/work-contexts/${system.contextId}/notes`, {
      method: "POST",
      body: { title: this.title, body: this.body, expectedVersion: model.version },
      timeoutMs: requestTimeoutMs,
    });
    expect(response.body.workContext.version).toBe(model.version + 1);
    expect(response.body.note.title).toBe(this.title.trim());
    expect(response.body.note.body).toBe(this.body);
    expect(response.body.workContext.notes).toContainEqual(expect.objectContaining({ id: response.body.note.id, title: this.title.trim() }));
    model.version = response.body.workContext.version;
    model.note = { id: response.body.note.id, title: this.title.trim(), body: this.body };
  }

  toString(): string {
    return `CreateNote(${JSON.stringify(this.title)})`;
  }
}

class UpdateNoteCommand implements Command {
  constructor(readonly title: string, readonly body: string) {}

  check(model: Readonly<ContextModel>): boolean {
    return model.note !== undefined;
  }

  async run(model: ContextModel, system: ContextSystem): Promise<void> {
    const note = model.note;
    if (note === undefined) throw new Error("UpdateNoteCommand ran without a modeled note");
    const response = await stressRequest<WorkNoteResponseDTO>(
      system.metrics,
      system.baseUrl,
      `/api/work-contexts/${system.contextId}/notes/${note.id}`,
      {
        method: "PATCH",
        body: { expectedVersion: model.version, title: this.title, body: this.body },
        timeoutMs: requestTimeoutMs,
      },
    );
    expect(response.body.workContext.version).toBe(model.version + 1);
    expect(response.body.note).toMatchObject({ id: note.id, title: this.title.trim(), body: this.body });
    model.version = response.body.workContext.version;
    model.note = { id: note.id, title: this.title.trim(), body: this.body };
  }

  toString(): string {
    return `UpdateNote(${JSON.stringify(this.title)})`;
  }
}

class DeleteNoteCommand implements Command {
  check(model: Readonly<ContextModel>): boolean {
    return model.note !== undefined;
  }

  async run(model: ContextModel, system: ContextSystem): Promise<void> {
    const note = model.note;
    if (note === undefined) throw new Error("DeleteNoteCommand ran without a modeled note");
    const response = await stressRequest<WorkContextDTO>(
      system.metrics,
      system.baseUrl,
      `/api/work-contexts/${system.contextId}/notes/${note.id}`,
      { method: "DELETE", body: { expectedVersion: model.version }, timeoutMs: requestTimeoutMs },
    );
    expect(response.body.version).toBe(model.version + 1);
    expect(response.body.notes).toEqual([]);
    model.version = response.body.version;
    model.note = undefined;
  }

  toString(): string {
    return "DeleteNote";
  }
}

class StaleContextWriteCommand implements Command {
  check(model: Readonly<ContextModel>): boolean {
    return model.version > 1;
  }

  async run(model: ContextModel, system: ContextSystem): Promise<void> {
    const response = await stressRequest<unknown>(system.metrics, system.baseUrl, `/api/work-contexts/${system.contextId}`, {
      method: "PATCH",
      body: { expectedVersion: model.version - 1, goal: "stale model overwrite" },
      expectedStatuses: [409],
      timeoutMs: requestTimeoutMs,
    });
    expect(response.status).toBe(409);
    const saved = await stressRequest<WorkContextDTO>(system.metrics, system.baseUrl, `/api/work-contexts/${system.contextId}`, {
      timeoutMs: requestTimeoutMs,
    });
    expect(saved.body.version).toBe(model.version);
    expect(saved.body.goal).toBe(model.goal);
    expect(saved.body.instructions).toBe(model.instructions);
    expect(saved.body.notes).toHaveLength(model.note === undefined ? 0 : 1);
  }

  toString(): string {
    return "RejectStaleContextWrite";
  }
}

describe("manual stress: deterministic public-API command model", () => {
  it("matches generated context and note commands against durable HTTP state", async () => {
    const fixture = await createE2eFixture();
    const metrics = new StressMetrics(() => fixture.emit.rssBytes());
    let contextSequence = 0;
    const textArbitrary = fc.string({ minLength: 1, maxLength: 32 }).map((value) => `generated:${value}`);
    const commandArbitraries: fc.Arbitrary<Command>[] = [
      fc.tuple(textArbitrary, textArbitrary).map(([goal, instructions]) => new PatchContextCommand(goal, instructions)),
      fc.tuple(textArbitrary, textArbitrary).map(([title, body]) => new CreateNoteCommand(title, body)),
      fc.tuple(textArbitrary, textArbitrary).map(([title, body]) => new UpdateNoteCommand(title, body)),
      fc.constant(new DeleteNoteCommand()),
      fc.constant(new StaleContextWriteCommand()),
    ];
    const propertyRuns = settings.propertyRuns;
    const maxCommands = Math.max(1, Math.floor(settings.operations / propertyRuns));
    try {
      await fc.assert(
        fc.asyncProperty(fc.commands(commandArbitraries, { maxCommands }), async (commands) => {
          contextSequence += 1;
          const created = await stressRequest<WorkContextDTO>(metrics, fixture.emit.url, "/api/work-contexts", {
            method: "POST",
            body: {
              name: `Generated context ${contextSequence}`,
              goal: "Initial modeled goal",
              instructions: "Initial modeled instructions",
              directories: { paths: [fixture.workRoot], defaultPath: fixture.workRoot },
              resources: [],
            },
            timeoutMs: requestTimeoutMs,
          });
          expect(created.body).toMatchObject({ version: 1, goal: "Initial modeled goal", instructions: "Initial modeled instructions", notes: [] });
          const model: ContextModel = {
            version: 1,
            goal: "Initial modeled goal",
            instructions: "Initial modeled instructions",
            note: undefined,
          };
          const system: ContextSystem = { baseUrl: fixture.emit.url, contextId: created.body.id, metrics };
          await fc.asyncModelRun(async () => ({ model, real: system }), commands);

          const persisted = await stressRequest<WorkContextDTO>(metrics, fixture.emit.url, `/api/work-contexts/${created.body.id}`, {
            timeoutMs: requestTimeoutMs,
          });
          expect(persisted.body.version).toBe(model.version);
          expect(persisted.body.goal).toBe(model.goal);
          expect(persisted.body.instructions).toBe(model.instructions);
          expect(persisted.body.notes).toHaveLength(model.note === undefined ? 0 : 1);
          if (model.note !== undefined) {
            const note = await stressRequest<{ id: string; title: string; body: string }>(
              metrics,
              fixture.emit.url,
              `/api/work-contexts/${created.body.id}/notes/${model.note.id}`,
              { timeoutMs: requestTimeoutMs },
            );
            expect(note.body).toMatchObject(model.note);
          }
        }),
        {
          seed: settings.seed,
          numRuns: propertyRuns,
          ...(settings.path === undefined ? {} : { path: settings.path }),
        },
      );
      expect(metrics.summary().errors).toBe(0);
      console.info(`[stress] command-model ${JSON.stringify({ propertyRuns, maxCommandsPerRun: maxCommands })}`);
    } finally {
      try {
        metrics.close();
        printStressMetrics("public-command-model", metrics);
      } finally { await fixture.close(); }
    }
  }, settings.durationMs + 120_000);
});
