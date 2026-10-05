/**
 * Prompt resource loading.
 *
 * This is the private half of the prompts module: business code never reads
 * these files directly, it calls the typed renderers in `index.ts`. Every file
 * is read once at module init from a fixed list, so the failure mode of a
 * missing or malformed resource is a configuration error at startup, never a
 * silent empty prompt at request time.
 */
import { readFileSync } from "node:fs";
import { getAsset, isSea } from "node:sea";

/** Read one bundled text resource relative to this module. */
export function readResource(file: string): string {
  // The binary embeds this directory; a source run reads it from disk. Both
  // paths produce the same text, so renderers cannot tell them apart.
  if (isSea()) return getAsset(`prompts/${file}`, "utf8");
  return readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
}

/**
 * Split a multi-fragment template file into named fragments.
 *
 * A `## fragment-id` heading starts a fragment; headings never reach the
 * model. Leading/trailing blank lines of a fragment are structural padding,
 * not prompt text.
 */
export function resourceFragments(file: string): ReadonlyMap<string, string> {
  const text = readResource(file);
  const fragments = new Map<string, string>();
  let current: string | undefined;
  let buffer: string[] = [];
  const flush = () => {
    if (current === undefined) return;
    if (fragments.has(current)) throw new Error(`Prompt resource ${file} contains duplicate fragment ${current}`);
    fragments.set(current, buffer.join("\n").replace(/^\n+/, "").replace(/\n+$/, ""));
    buffer = [];
  };
  for (const line of text.split("\n")) {
    const match = /^## ([a-z0-9-]+)$/.exec(line);
    if (match !== null) {
      flush();
      current = match[1];
      buffer = [];
    } else if (current !== undefined) {
      buffer.push(line);
    }
  }
  flush();
  return fragments;
}

/** Parse one bundled JSON resource and fail loudly on malformed content. */
export function resourceJson<T>(file: string): T {
  return JSON.parse(readResource(file)) as T;
}

/** Substitute `{{variable}}` placeholders; a missing variable is a bug, not an empty prompt. */
export function fill(
  template: string,
  source: { file: string; fragment?: string },
  vars: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      const at = source.fragment === undefined ? source.file : `${source.file}#${source.fragment}`;
      throw new Error(`Prompt template ${at} is missing variable ${key}`);
    }
    return String(value);
  });
}
