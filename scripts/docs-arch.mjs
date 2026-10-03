#!/usr/bin/env node
// Purpose: Generates the module-map block in .development/ARCHITECTURE.md from each src/*.ts `// Purpose:` header.
//
// Keeps the volatile half of ARCHITECTURE.md from drifting (issue #249): the map is a
// pure function of the source tree, so adding/removing/renaming a module (or editing a
// purpose) without regenerating fails the drift test in src/__tests__/architecture-doc.test.ts.
//
// Usage:
//   node scripts/docs-arch.mjs          → check (exit 1 when stale)
//   node scripts/docs-arch.mjs --write  → regenerate the block in place
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "src");
const DOC_PATH = join(ROOT, ".development", "ARCHITECTURE.md");

export const BEGIN_MARKER = "<!-- BEGIN GENERATED: module-map (npm run docs:arch) -->";
export const END_MARKER = "<!-- END GENERATED: module-map -->";

/** Every top-level src/*.ts must open with exactly one purpose line. */
export function collectModules() {
	const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts")).sort();
	return files.map((file) => {
		const text = readFileSync(join(SRC_DIR, file), "utf8");
		const firstLine = (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
		const match = /^\/\/ Purpose: (.+)$/.exec(firstLine);
		if (!match) {
			throw new Error(
				`src/${file}: missing first-line "// Purpose: <one line>" header (required by the module map, see issue #249)`,
			);
		}
		return { file, purpose: match[1].trim() };
	});
}

export function renderModuleMap(modules) {
	const rows = modules.map((m) => `| \`${m.file}\` | ${m.purpose} |`);
	return [
		BEGIN_MARKER,
		"",
		"_Generated from each module's `// Purpose:` header by `npm run docs:arch` — edit the source, not this block._",
		"",
		"| Module | Purpose |",
		"|---|---|",
		...rows,
		"",
		`**${modules.length} modules** — every one is listed because a new module without a purpose fails CI.`,
		"",
		END_MARKER,
	].join("\n");
}

export function replaceModuleMap(doc, block) {
	const begin = doc.indexOf(BEGIN_MARKER);
	const end = doc.indexOf(END_MARKER);
	if (begin === -1 || end === -1 || end < begin) {
		throw new Error("ARCHITECTURE.md: generated module-map markers not found");
	}
	return doc.slice(0, begin) + block + doc.slice(end + END_MARKER.length);
}

function main() {
	const write = process.argv.includes("--write");
	const modules = collectModules();
	const block = renderModuleMap(modules);
	const next = replaceModuleMap(readFileSync(DOC_PATH, "utf8"), block);
	const current = readFileSync(DOC_PATH, "utf8");
	if (write) {
		if (next !== current) writeFileSync(DOC_PATH, next);
		console.log(`docs:arch — module map written (${modules.length} modules).`);
		return;
	}
	if (next === current) {
		console.log(`docs:arch — module map is current (${modules.length} modules).`);
		return;
	}
	console.error("docs:arch — module map is STALE. Run: npm run docs:arch");
	process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
