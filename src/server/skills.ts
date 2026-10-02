/**
 * Skills: the Agent Skills format, loaded through Pi's own loader.
 *
 * Emit does not implement a second skill parser. Importing a directory runs the
 * same discovery and frontmatter validation the Pi coding agent uses, keeps the
 * diagnostics, and stores the resulting metadata as durable records. The full
 * `SKILL.md` body stays on disk and is read on demand, so a skill's detailed
 * instructions only enter a conversation when the employee actually needs them.
 */

import { basename, resolve } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { SkillDTO } from "../shared/contracts.ts";
import { SkillDoc, type SkillRecord } from "./documents.ts";
import type { EmitRuntime } from "./runtime.ts";
import { slugify } from "./workspace.ts";

export type SkillImportResult = {
  imported: SkillDTO[];
  diagnostics: { severity: string; message: string; path: string }[];
};

export function toSkillDTO(record: SkillRecord): SkillDTO {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    directory: record.directory,
    filePath: record.filePath,
    diagnostics: record.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
    addedAt: record.addedAt,
  };
}

export async function listSkills(runtime: EmitRuntime): Promise<SkillRecord[]> {
  const members = await runtime.listFamily(SkillDoc, (id) => ({ id }));
  return members.map((member) => member.value).sort((a, b) => a.name.localeCompare(b.name));
}

/** Discover skills in a directory without persisting anything. */
export function scanSkillDirectory(dir: string): { skills: Skill[]; diagnostics: SkillImportResult["diagnostics"] } {
  const result = loadSkillsFromDir({ dir: resolve(dir), source: "path" });
  return {
    skills: result.skills,
    diagnostics: result.diagnostics.map((diagnostic) => ({
      severity: diagnostic.type,
      message: diagnostic.message,
      path: diagnostic.path ?? resolve(dir),
    })),
  };
}

function skillIdFor(skill: Skill, taken: ReadonlySet<string>): string {
  const base = slugify(skill.name).replace(/-/g, "") || "skill";
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${base}${counter}`;
    counter += 1;
  }
  return candidate;
}

/** Import every skill discovered under a directory, keeping the parse diagnostics. */
export async function importSkillDirectory(runtime: EmitRuntime, dir: string): Promise<SkillImportResult> {
  const scan = scanSkillDirectory(dir);
  const existing = await listSkills(runtime);
  const takenIds = new Set(existing.map((skill) => skill.id));
  const imported: SkillDTO[] = [];

  for (const skill of scan.skills) {
    // Re-importing the same file updates its metadata instead of duplicating it.
    const already = existing.find((record) => record.filePath === skill.filePath);
    const id = already?.id ?? skillIdFor(skill, takenIds);
    takenIds.add(id);
    const saved = await runtime.updateFamily(SkillDoc, id, { id }, (doc) => {
      doc.id = id;
      doc.name = skill.name;
      doc.description = skill.description;
      doc.directory = skill.baseDir;
      doc.filePath = skill.filePath;
      doc.diagnostics = scan.diagnostics
        .filter((diagnostic) => diagnostic.path === skill.filePath)
        .map((diagnostic) => ({ severity: diagnostic.severity, message: diagnostic.message }));
      if (doc.addedAt === 0) doc.addedAt = Date.now();
    });
    imported.push(toSkillDTO(saved));
  }

  runtime.emit({ type: "skills" });
  return { imported, diagnostics: scan.diagnostics };
}

export async function deleteSkill(runtime: EmitRuntime, id: string): Promise<void> {
  await runtime.harness.commit(async (tx) => {
    await tx.retireDoc(SkillDoc, id);
  }, runtime.ctx);
  runtime.emit({ type: "skills" });
}

/**
 * The prompt section that advertises an employee's bound skills.
 *
 * Only name, description, and location are rendered. The body is fetched with
 * the `load_skill` tool, which is what keeps long instructions out of every
 * request while still making them available.
 */
export function renderSkillSection(skills: readonly SkillRecord[], selectedIds: readonly string[]): string {
  const bound = skills.filter((skill) => selectedIds.includes(skill.id));
  if (bound.length === 0) return "";
  const lines = bound.map(
    (skill) => `- ${skill.name}: ${skill.description}\n  SKILL.md: ${skill.filePath}`,
  );
  return (
    "You have these Agent Skills. They are advertised here; read one with the load_skill tool " +
    "before doing work that matches its description.\n\n" +
    lines.join("\n")
  );
}

export function findBoundSkill(
  skills: readonly SkillRecord[],
  selectedIds: readonly string[],
  name: string,
): SkillRecord | undefined {
  const lowered = name.trim().toLowerCase();
  return skills.find(
    (skill) =>
      selectedIds.includes(skill.id) &&
      (skill.id.toLowerCase() === lowered ||
        skill.name.toLowerCase() === lowered ||
        basename(skill.directory).toLowerCase() === lowered),
  );
}
