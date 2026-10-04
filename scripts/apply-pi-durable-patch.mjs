// Applies Emit's narrow patch set to the installed @earendil-works/pi-durable package.
//
// The patch attaches the Emit conversation id to Pi model requests so OpenCode-routed sessions stay correlated
// (see test/opencode-session.test.ts). It replaces the previous patch-package based postinstall: patch-package
// pulled in a vulnerable micromatch/braces dependency chain for a single unified diff.
//
// Usage:
//   CLI:    node scripts/apply-pi-durable-patch.mjs
//   Import: import { applyPiDurablePatch } from "./scripts/apply-pi-durable-patch.mjs";
//           applyPiDurablePatch("/path/to/node_modules/@earendil-works/pi-durable");
//
// The function is synchronous and idempotent: an already patched file is a no-op, and any other observed state
// (missing anchor, duplicated anchor, unexpected package) fails loudly with the target path.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-durable";
const PACKAGE_VERSION = "1.0.0";

// Anchors keep the surrounding indentation and the `const options = {` opener so each snippet is unique in its file.
const PATCHES = [
	{
		file: "dist/harness/generation.js",
		original: [
			"            const options = {",
			"                ...streamOptions,",
			"                signal: runtime.signal,",
			"",
		].join("\n"),
		patched: [
			"            const options = {",
			"                ...streamOptions,",
			"                sessionId: String(conversationId),",
			"                signal: runtime.signal,",
			"",
		].join("\n"),
	},
	{
		file: "dist/harness/compaction.js",
		original: [
			"            const options = {",
			"                ...forwarded,",
			'                cacheRetention: "none",',
			"",
		].join("\n"),
		patched: [
			"            const options = {",
			"                ...forwarded,",
			"                sessionId: String(runtime.conversationId),",
			'                cacheRetention: "none",',
			"",
		].join("\n"),
	},
];

function countOccurrences(haystack, needle) {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

export function applyPiDurablePatch(packageDir) {
	const manifestPath = path.join(packageDir, "package.json");
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read ${PACKAGE_NAME} package manifest at ${manifestPath}: ${error.message}`);
	}
	if (manifest.name !== PACKAGE_NAME || manifest.version !== PACKAGE_VERSION) {
		throw new Error(
			`Expected ${PACKAGE_NAME}@${PACKAGE_VERSION} at ${packageDir}, found ${String(manifest.name)}@${String(manifest.version)}`,
		);
	}

	// Validate every target before writing anything, so a failure later cannot leave a half-patched package.
	const edits = [];
	for (const patch of PATCHES) {
		const filePath = path.join(packageDir, patch.file);
		let source;
		try {
			source = readFileSync(filePath, "utf8");
		} catch (error) {
			throw new Error(`Cannot read patch target ${filePath}: ${error.message}`);
		}
		const originalCount = countOccurrences(source, patch.original);
		const patchedCount = countOccurrences(source, patch.patched);
		if (originalCount === 1 && patchedCount === 0) {
			edits.push({ filePath, contents: source.replace(patch.original, patch.patched) });
		} else if (originalCount === 0 && patchedCount === 1) {
			// Already applied (reinstalled package after a patched run, or a rerun): idempotent no-op.
		} else {
			throw new Error(
				`Cannot apply patch to ${filePath}: expected the unpatched anchor exactly once or the patched anchor exactly once, ` +
					`found unpatched=${originalCount}, patched=${patchedCount}`,
			);
		}
	}
	for (const edit of edits) {
		try {
			writeFileSync(edit.filePath, edit.contents);
		} catch (error) {
			throw new Error(`Cannot write patch target ${edit.filePath}: ${error.message}`);
		}
	}
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === selfPath) {
	const repoRoot = path.dirname(path.dirname(selfPath));
	applyPiDurablePatch(path.join(repoRoot, "node_modules", PACKAGE_NAME));
	console.log(`Applied ${PACKAGE_NAME} patch.`);
}
