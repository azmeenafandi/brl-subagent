import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_COMMAND_NAMES } from "../types";

// ---------------------------------------------------------------------------
// Issue #92: pin the README `### Commands` table against the real /brl-subagent
// command dispatch (the `handlers` map in src/index.ts).
//
// Drift class this catches:
//   - `/brl-subagent backend`  — removed in v2.1.0, stale README row for months
//   - `/brl-subagent gitmode`  — removed in #78, stale README row
//   - `/brl-subagent update-check` — present in dispatch, README row was missing
//
// The handler map (`const handlers = { ... }` in src/index.ts) is the source
// of truth. RESERVED_COMMAND_NAMES is NOT the source of truth: it contains
// "graph", which is a reservation for delegate_task's graph mode (a
// preset/template name collision guard), not a /brl-subagent command.
// ---------------------------------------------------------------------------

const repoRoot = join(__dirname, "..", "..");

const readmeSource = readFileSync(join(repoRoot, "README.md"), "utf8");
const indexSource = readFileSync(join(repoRoot, "src", "index.ts"), "utf8");

/** README table row: `| `/brl-subagent <key>` | <description> |` */
const COMMAND_ROW_RE = /^\|\s*`\/brl-subagent ([a-z0-9-]+)`\s*\|/;

/** A key inside the handlers block: bare identifier or quoted string. */
const HANDLER_KEY_RE = /^\s*(?:"([^"]+)"|([a-zA-Z0-9_$-]+))\s*:/;

/** Parse the `### Commands` section of README.md → command keys (no bare menu row). */
function readmeCommands(): string[] {
	const lines = readmeSource.split(/\r?\n/);
	const section = lines.findIndex((l) => l.trim() === "### Commands");
	expect(section, "README must contain a `### Commands` section").toBeGreaterThanOrEqual(0);

	const commands: string[] = [];
	for (let i = section + 1; i < lines.length; i++) {
		// The Commands section ends at the next top-level `## ` heading.
		if (/^##\s/.test(lines[i])) break;
		const m = lines[i].match(COMMAND_ROW_RE);
		if (m) commands.push(m[1]);
	}
	return commands;
}

/** Parse the `const handlers` dispatch block in src/index.ts → handler keys. */
function handlerKeys(): string[] {
	const lines = indexSource.split(/\r?\n/);
	const start = lines.findIndex((l) => l.includes("const handlers: Record<string"));
	expect(start, "src/index.ts must contain the `const handlers` dispatch block").toBeGreaterThanOrEqual(0);

	const keys: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		// The block ends at the first standalone closing `};`.
		if (/^\s*};/.test(lines[i])) break;
		const m = lines[i].match(HANDLER_KEY_RE);
		if (m) keys.push(m[1] ?? m[2]);
	}
	return keys;
}

describe("README commands table vs. real dispatch (issue #92)", () => {
	const documented = readmeCommands();
	const dispatched = handlerKeys();

	it(`README documents ${documented.length} commands; dispatch has ${dispatched.length} handler keys`, () => {
		// Sanity guards: the parsers must not silently match nothing.
		expect(documented.length).toBeGreaterThan(0);
		expect(dispatched.length).toBeGreaterThan(0);
	});

	it("has no stale README rows — every documented command has a handler", () => {
		const stale = documented.filter((c) => !dispatched.includes(c));
		expect(stale, "README rows with no handler — removed commands must be deleted from the README table").toEqual([]);
	});

	it("has no missing README rows — every handler key is documented", () => {
		const missing = dispatched.filter((c) => !documented.includes(c));
		expect(missing, "handlers with no README row — new commands must be added to the README table").toEqual([]);
	});

	it("covers every dispatch key in RESERVED_COMMAND_NAMES (`graph` may be extra)", () => {
		const unreserved = dispatched.filter((c) => !RESERVED_COMMAND_NAMES.has(c));
		expect(unreserved, "every command name must be reserved against preset/template collisions").toEqual([]);
	});
});
