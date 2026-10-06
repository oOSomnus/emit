#!/usr/bin/env node
/**
 * Build Emit as one native single-executable application (Node SEA).
 *
 * The output keeps the Node/Fastify/Pi/SQLite behavior of a source run: the
 * server bundle, the prompt resources, and `dist/web` are embedded, so the
 * published artifact is a single file that runs without Node, npm, or a
 * checkout. The blob is injected into a copy of the executing Node binary, so
 * the artifact is native to this OS, architecture, and libc.
 *
 * Steps: patch the installed Pi Durable package, bundle the server to CJS,
 * embed prompts and web assets, generate the SEA blob, and inject it.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";
import { applyPiDurablePatch } from "./apply-pi-durable-patch.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const seaDir = path.join(repoRoot, "dist", "sea");
const bundlePath = path.join(seaDir, "emit.cjs");
const blobPath = path.join(seaDir, "emit.blob");
const outputPath = path.join(repoRoot, "dist", process.platform === "win32" ? "emit.exe" : "emit");
const packageJsonReadExpression = 'readFileSync(getPackageJsonPath(), "utf-8")';

// The binary is a copy of the running Node, so the toolchain must provide the
// SEA blob writer and the built-in SQLite the server uses.
{
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Building requires Node >= 22.19 (node:sea and node:sqlite); current version: ${process.version}`);
  }
  for (const specifier of ["node:sea", "node:sqlite"]) {
    try {
      require.resolve(specifier);
    } catch (error) {
      throw new Error(`Node is missing ${specifier}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  for (const tool of ["node", "npm"]) {
    const probe = spawnSync(tool, ["--version"], { stdio: "ignore" });
    if (probe.error !== undefined || probe.status !== 0) {
      throw new Error(`Building requires ${tool} to be available on PATH`);
    }
  }
}

// Bundle the patched dependency, never the raw published copy.
applyPiDurablePatch(path.join(repoRoot, "node_modules", "@earendil-works", "pi-durable"));

rmSync(seaDir, { recursive: true, force: true });
mkdirSync(seaDir, { recursive: true });

/** Locate an installed package's root without assuming a hoisting layout. */
function resolvePackageRoot(specifier) {
  let dir = path.dirname(fileURLToPath(import.meta.resolve(specifier)));
  for (;;) {
    const manifestPath = path.join(dir, "package.json");
    if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).name === specifier) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Unable to locate installed package ${specifier} from its entry point`);
    dir = parent;
  }
}

const piCodingAgentRoot = resolvePackageRoot("@earendil-works/pi-coding-agent");
const piCodingAgentConfigPath = path.join(piCodingAgentRoot, "dist", "config.js");
const piCodingAgentPackageJson = readFileSync(path.join(piCodingAgentRoot, "package.json"), "utf8");
let rewrittenConfigs = 0;

const result = await build({
  absWorkingDir: repoRoot,
  entryPoints: [path.join(repoRoot, "src", "server", "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22.19",
  splitting: false,
  minify: false,
  keepNames: true,
  metafile: true,
  outfile: bundlePath,
  // A bundled file has no meaningful import.meta; point both properties at the
  // executable so any remaining URL/join against them stays deterministic.
  banner: {
    js: [
      'var __emitMetaUrl = require("node:url").pathToFileURL(process.execPath).href;',
      'var __emitMetaDir = require("node:path").dirname(process.execPath);',
    ].join("\n"),
  },
  define: {
    "import.meta.url": "__emitMetaUrl",
    "import.meta.dirname": "__emitMetaDir",
  },
  plugins: [
    {
      name: "emit-bundle",
      setup(api) {
        // Emit only consumes the skill loader; bundling the package root would
        // pull in the TUI, the QuickJS worker, and the whole CLI.
        api.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
          path: path.join(piCodingAgentRoot, "dist", "core", "skills.js"),
        }));
        // The binary must not read an incidental package.json next to itself:
        // bake the bundled package's own metadata into this one expression.
        api.onLoad({ filter: /config\.js$/ }, (args) => {
          if (path.normalize(args.path) !== path.normalize(piCodingAgentConfigPath)) return undefined;
          const source = readFileSync(args.path, "utf8");
          const occurrences = source.split(packageJsonReadExpression).length - 1;
          if (occurrences !== 1) {
            throw new Error(
              `Expected ${packageJsonReadExpression} exactly once in ${piCodingAgentConfigPath}; found ${occurrences}`,
            );
          }
          rewrittenConfigs += 1;
          return {
            contents: source.replace(packageJsonReadExpression, JSON.stringify(piCodingAgentPackageJson)),
            loader: "js",
          };
        });
      },
    },
  ],
});

// A single bundle may only leave Node builtins for the runtime to resolve;
// anything installed but left external would mean the binary silently needs
// node_modules, so that fails the build. Uninstalled optional requires (the
// try/catch fallback pattern in third-party code) are reported, not hidden.
{
  const isBuiltin = (name) => name.startsWith("node:") || builtinModules.includes(name);
  const bundleOutput = result.metafile.outputs[path.relative(repoRoot, bundlePath)];
  if (bundleOutput === undefined) throw new Error(`metafile is missing output ${bundlePath}`);
  const missing = bundleOutput.imports.filter((entry) => entry.external && !isBuiltin(entry.path));
  const packaged = missing.filter((entry) => {
    try {
      require.resolve(entry.path);
      return true;
    } catch {
      return false;
    }
  });
  if (packaged.length > 0) {
    throw new Error(`Bundle does not embed installed dependencies: ${packaged.map((entry) => `${entry.kind} ${entry.path}`).join(", ")}`);
  }
  if (missing.length > 0) {
    process.stdout.write(`optional runtime requires kept as-is: ${missing.map((entry) => entry.path).join(", ")}\n`);
  }
  if (rewrittenConfigs !== 1) throw new Error(`Failed to update pi-coding-agent package metadata (${rewrittenConfigs} occurrence(s))`);
}

// Prompt resources are read through `getAsset("prompts/<file>")`.
const promptsDir = path.join(repoRoot, "src", "server", "prompts");
const promptFiles = readdirSync(promptsDir, { withFileTypes: true })
  .filter((entry) => entry.name.endsWith(".md") || entry.name.endsWith(".json"))
  .map((entry) => {
    if (!entry.isFile()) throw new Error(`Prompt resource ${entry.name} is not a regular file`);
    return entry.name;
  })
  .sort();

// The web output is enumerated into a manifest the runtime restores.
const webRoot = path.join(repoRoot, "dist", "web");
function collectWebFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Web asset ${full} is a symbolic link`);
    if (entry.isDirectory()) files.push(...collectWebFiles(full, `${prefix}${entry.name}/`));
    else if (entry.isFile()) files.push(`${prefix}${entry.name}`);
    else throw new Error(`Web asset ${full} is not a regular file`);
  }
  return files;
}
if (!existsSync(path.join(webRoot, "index.html"))) {
  throw new Error(`Missing web build output ${path.join(webRoot, "index.html")}; run npm run build first`);
}
const webFiles = collectWebFiles(webRoot).sort();
const manifestFile = path.join(seaDir, "web-manifest.json");
writeFileSync(manifestFile, JSON.stringify(webFiles));

const assets = {};
for (const file of promptFiles) assets[`prompts/${file}`] = path.join(promptsDir, file);
for (const file of webFiles) assets[`web/${file}`] = path.join(webRoot, file);
assets["web/.manifest.json"] = manifestFile;
if (new Set(Object.keys(assets)).size !== Object.keys(assets).length) {
  throw new Error("Duplicate embedded asset key");
}

const seaConfigPath = path.join(seaDir, "sea-config.json");
writeFileSync(
  seaConfigPath,
  `${JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets,
    },
    null,
    2,
  )}\n`,
);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${String(result.status)}`);
}

run(process.execPath, ["--experimental-sea-config", seaConfigPath]);
if (!existsSync(blobPath)) throw new Error(`SEA blob was not generated: ${blobPath}`);

copyFileSync(process.execPath, outputPath);
// The copy is not executable by default; postject modifies bytes only.
chmodSync(outputPath, 0o755);

if (process.platform === "darwin") {
  // Injection invalidates the signature; re-sign ad-hoc afterwards.
  run("codesign", ["--remove-signature", outputPath]);
}
await inject(outputPath, "NODE_SEA_BLOB", readFileSync(blobPath), {
  sentinelFuse: seaFuse,
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (process.platform === "darwin") run("codesign", ["--sign", "-", outputPath]);

const size = lstatSync(outputPath).size;
process.stdout.write(`Built ${path.relative(repoRoot, outputPath)} (${(size / 1024 / 1024).toFixed(1)} MiB, ${webFiles.length} web assets)\n`);
