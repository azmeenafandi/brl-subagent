#!/usr/bin/env node
// Purpose: Generates the ADR index block in .development/decisions/README.md from each NNNN-*.md decision record.
//
// Keeps the decision-record index from drifting (issue #253): the table is a pure function of the
// `.development/decisions/*.md` files, so adding or renaming a record (or editing its heading/Status/Date)
// without regenerating fails the drift test in src/__tests__/decisions-index.test.ts.
//
// Usage:
//   node scripts/docs-decisions.mjs          → check (exit 1 when stale)
//   node scripts/docs-decisions.mjs --write  → regenerate the block in place
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECISIONS_DIR = join(ROOT, ".development", "decisions");
const README_PATH = join(DECISIONS_DIR, "README.md");

export const BEGIN_MARKER = "<!-- BEGIN GENERATED: adr-index (npm run docs:decisions) -->";
export const END_MARKER = "<!-- END GENERATED: adr-index -->";

const HEADING_RE = /^# (\d{4})\. (.+)$/;

/** Every .development/decisions/NNNN-*.md must carry a `# NNNN. Title` heading plus Status and Date metadata. */
export function collectDecisions() {
	const files = readdirSync(DECISIONS_DIR)
		.filter((f) => f.endsWith(".md") && f !== "README.md")
		.sort();
	return files.map((file) => {
		const text = readFileSync(join(DECISIONS_DIR, file), "utf8");
		const firstLine = (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
		const heading = HEADING_RE.exec(firstLine);
		if (!heading) {
			throw new Error(
				`.development/decisions/${file}: missing "# NNNN. Title" first heading (required by the ADR index, see issue #253)`,
			);
		}
		return {
			file,
			number: heading[1],
			title: heading[2].trim(),
			status: readMeta(text, "Status", file),
			date: readMeta(text, "Date", file),
		};
	});
}

function readMeta(text, key, file) {
	const match = new RegExp(`^- \\*\\*${key}:\\*\\*\\s+(.+)$`, "m").exec(text);
	if (!match) {
		throw new Error(
			`.development/decisions/${file}: missing "- **${key}:**" metadata line (required by the ADR index, see issue #253)`,
		);
	}
	return match[1].trim();
}

export function renderAdrIndex(decisions) {
	const rows = [...decisions]
		.sort((a, b) => a.number.localeCompare(b.number))
		.map((d) => `| ${d.number} | [${d.title}](./${d.file}) | ${d.status} | ${d.date} |`);
	return [
		BEGIN_MARKER,
		"",
		"_Generated from each `.development/decisions/NNNN-*.md` record by `npm run docs:decisions` — edit the records, not this block._",
		"",
		"| # | Decision | Status | Date |",
		"|---|---|---|---|",
		...rows,
		"",
		`**${decisions.length} decisions** — every one is listed because a record without a heading/Status/Date fails CI.`,
		"",
		END_MARKER,
	].join("\n");
}

export function replaceAdrIndex(doc, block) {
	const begin = doc.indexOf(BEGIN_MARKER);
	const end = doc.indexOf(END_MARKER);
	if (begin === -1 || end === -1 || end < begin) {
		throw new Error(".development/decisions/README.md: generated adr-index markers not found");
	}
	return doc.slice(0, begin) + block + doc.slice(end + END_MARKER.length);
}

function main() {
	const write = process.argv.includes("--write");
	const decisions = collectDecisions();
	const block = renderAdrIndex(decisions);
	const current = readFileSync(README_PATH, "utf8");
	const next = replaceAdrIndex(current, block);
	if (write) {
		if (next !== current) writeFileSync(README_PATH, next);
		console.log(`docs:decisions — ADR index written (${decisions.length} decisions).`);
		return;
	}
	if (next === current) {
		console.log(`docs:decisions — ADR index is current (${decisions.length} decisions).`);
		return;
	}
	console.error("docs:decisions — ADR index is STALE. Run: npm run docs:decisions");
	process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
