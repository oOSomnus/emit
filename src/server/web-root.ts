/**
 * Resolve the directory that serves the frontend.
 *
 * A source run serves `dist/web` from the repository checkout. A
 * single-executable binary has no source tree, so the build embeds the web
 * bundle as SEA assets and this module restores them under the data directory
 * (the executable's own location may be read-only). The cache is a regenerable
 * copy of build output: a missing or corrupt file is rewritten on the next
 * start rather than failing forever.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAsset, getRawAsset, isSea } from "node:sea";

const CACHE_DIR_NAME = ".emit-web";
const CACHE_MANIFEST_NAME = ".manifest.json";
const MANIFEST_ASSET = "web/.manifest.json";

/**
 * The web root to serve: an explicit `--web-root` wins; a source run uses the
 * repository's `dist/web`; a binary restores its embedded bundle into the data
 * directory and returns that path. Called once after the data directory lock is
 * held and before the HTTP server listens, so a failure aborts startup.
 */
export function resolveWebRoot(dataDir: string, override: string | undefined): string {
  if (override !== undefined) return override;
  if (!isSea()) return resolve(import.meta.dirname, "../../dist/web");
  return restoreEmbeddedWeb(dataDir);
}

/** Restore the embedded `web/` assets into `<dataDir>/.emit-web` and return it. */
function restoreEmbeddedWeb(dataDir: string): string {
  const cacheRoot = join(dataDir, CACHE_DIR_NAME);
  const manifest = readEmbeddedManifest();
  // Read every asset before writing anything: a missing asset must abort
  // startup, not leave a half-restored cache behind.
  const assets = manifest.map((relativePath) => ({ relativePath, bytes: readAssetBytes(relativePath) }));
  const previous = readCachedManifest(join(cacheRoot, CACHE_MANIFEST_NAME));

  assertNotSymlink(cacheRoot, `内嵌前端缓存目录 ${cacheRoot}`);
  mkdirSync(cacheRoot, { recursive: true });
  for (const { relativePath, bytes } of assets) {
    const target = join(cacheRoot, relativePath);
    assertNotSymlinkedComponents(cacheRoot, relativePath);
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
  }
  if (previous !== undefined) removeStaleFiles(cacheRoot, previous, new Set(manifest));
  writeIfChanged(join(cacheRoot, CACHE_MANIFEST_NAME), Buffer.from(JSON.stringify(manifest)));
  return cacheRoot;
}

/**
 * The build-generated manifest: a sorted JSON array of POSIX-style relative
 * paths. Rejected unless every entry is a safe relative path, there are no
 * duplicates, and `index.html` is present.
 */
function readEmbeddedManifest(): string[] {
  let raw: string;
  try {
    raw = getAsset(MANIFEST_ASSET, "utf8");
  } catch (error) {
    throw new Error(`内嵌前端清单缺失：${MANIFEST_ASSET}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const manifest = validateManifest(parseManifest(raw, MANIFEST_ASSET), MANIFEST_ASSET);
  if (!manifest.includes("index.html")) {
    throw new Error(`内嵌前端清单 ${MANIFEST_ASSET} 缺少 index.html`);
  }
  return manifest;
}

/** The previous cache manifest, or `undefined` when it is absent or damaged. */
function readCachedManifest(file: string): string[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return validateManifest(parseManifest(raw, file), file);
  } catch {
    return undefined;
  }
}

function parseManifest(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`前端清单 ${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validate manifest entries as safe, unique, relative paths. */
function validateManifest(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`前端清单 ${label} 必须是字符串数组`);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`前端清单 ${label} 含有空路径或非字符串项`);
    }
    if (isAbsolute(entry)) throw new Error(`前端清单 ${label} 含有绝对路径：${entry}`);
    const segments = entry.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new Error(`前端清单 ${label} 含有非法路径：${entry}`);
    }
    if (seen.has(entry)) throw new Error(`前端清单 ${label} 含有重复路径：${entry}`);
    seen.add(entry);
  }
  return value as string[];
}

/** Zero-copy view of one embedded asset; a missing key aborts startup. */
function readAssetBytes(relativePath: string): Buffer {
  try {
    return Buffer.from(getRawAsset(`web/${relativePath}`));
  } catch (error) {
    throw new Error(`内嵌前端资源缺失：web/${relativePath}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

/** Remove cache files recorded by the previous manifest that the new one drops. */
function removeStaleFiles(cacheRoot: string, previous: readonly string[], current: ReadonlySet<string>): void {
  for (const relativePath of previous) {
    if (current.has(relativePath)) continue;
    // Never follow a symlink out of the cache: a tampered tree is skipped, not
    // deleted through, and stale directories left behind are harmless.
    const target = join(cacheRoot, relativePath);
    if (!isRegularFileThroughDirectories(cacheRoot, relativePath)) continue;
    unlinkSync(target);
  }
}

function isRegularFileThroughDirectories(cacheRoot: string, relativePath: string): boolean {
  let current = cacheRoot;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    const info = lstatOrUndefined(current);
    if (info === undefined) return false;
    const last = index === segments.length - 1;
    if (last) return info.isFile();
    if (!info.isDirectory()) return false;
  }
  return false;
}

function writeIfChanged(file: string, bytes: Buffer): void {
  if (existsSync(file) && readFileSync(file).equals(bytes)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

/** Refuse to restore through a symlinked cache root or asset path component. */
function assertNotSymlinkedComponents(cacheRoot: string, relativePath: string): void {
  let current = cacheRoot;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    assertNotSymlink(current, `内嵌前端缓存路径 ${current}`);
  }
}

function assertNotSymlink(path: string, label: string): void {
  const info = lstatOrUndefined(path);
  if (info !== undefined && info.isSymbolicLink()) {
    throw new Error(`${label} 是符号链接，拒绝写入`);
  }
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
