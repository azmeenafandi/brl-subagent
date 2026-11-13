/**
 * Import convention guard (issue #476) — the ratchet on the rule, not the rule itself.
 *
 * `scripts/check-imports.mjs` is the executable half; this file is what makes it
 * true tomorrow. Three layers:
 *
 * 1. the real tree — `src/*.ts` must report zero violations, and the corpus size
 *    is pinned so a scan that matches nothing cannot pass as a clean scan;
 * 2. one fixture per rule, in both directions (violating and compliant), so
 *    deleting a rule or loosening a threshold fails here rather than silently
 *    relaxing the convention;
 * 3. the CLI contract — exit 0 clean / 1 violations / 2 usage error, unreadable
 *    dir, EMPTY corpus, spawned as a real `node` process (the CI step's shape).
 *
 * The mutant each fixture kills is named where it matters: value+value must be
 * REPORTED (never auto-merged — that would reorder module requests), an
 * inline-type-only statement is a VALUE statement (it keeps its position), and
 * the 140/141 boundary is exact.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectViolations } from "../../scripts/check-imports.mjs";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "check-imports.mjs");
const SRC = join(ROOT, "src");

/** `src/*.ts` as last re-pointed: 48 at the convention's introduction (issue #476),
 * 49 after `unit-params.ts` (ADR 0027 S1), 51 after `runtime.ts` + `mode-runners.ts`
 * (ADR 0027 S2), 52 after `worktree-report.ts` (issue #474), 53 after
 * `background-pipeline.ts` (ADR 0027 S3), 55 after `boot-recovery.ts` +
 * `terminal-notifier.ts` (ADR 0027 S4), 58 after `commands.ts` +
 * `delegate-handler.ts` + `agent-tools.ts` (ADR 0027 S5), 59 after
 * `scratch-root.ts` (issue #511, U1). Re-point it with the
 * commit that adds or removes a module — never to match a scan that silently
 * stopped matching. */
const SRC_FILE_COUNT = 59;

const scratch = mkdtempSync(join(tmpdir(), "brl-476-imports-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Violations for one in-memory fixture. The adapter refreshes changed paths, so one name is safe. */
function violations(text: string): { rule: string; line: number; message: string }[] {
	return collectViolations([{ path: "fixture.ts", text }]);
}

/** The rule ids only — most fixtures assert the set, not the prose. */
function rules(text: string): string[] {
	return violations(text).map((item) => item.rule);
}

/** The module specifier that makes a one-binding import render at exactly `length` characters. */
function specifierAtLength(length: number): string {
	const head = "import { a } from '";
	const tail = "';";
	return "m".repeat(length - head.length - tail.length);
}

/** A one-binding import whose canonical single-line rendering is exactly `length` characters. */
function importAtLength(length: number): string {
	return `import { a } from '${specifierAtLength(length)}';`;
}

/** A temp corpus directory holding the given files, for the spawned CLI. */
function corpus(name: string, files: Record<string, string>): string {
	const dir = join(scratch, name);
	mkdirSync(dir, { recursive: true });
	for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
	return dir;
}

function runCli(dir: string) {
	return spawnSync("node", [SCRIPT, "--dir", dir], { cwd: ROOT, encoding: "utf8" });
}

describe("the real tree", () => {
	it("src/*.ts is clean, and the scan actually covered the tree", () => {
		const files = readdirSync(SRC)
			.filter((file) => file.endsWith(".ts"))
			.sort();
		// Mutant killed: a scan that reads nothing reports "0 violations" and passes.
		expect(files.length).toBe(SRC_FILE_COUNT);
		const found = collectViolations(files.map((file) => ({ path: join(SRC, file), text: readFileSync(join(SRC, file), "utf8") })));
		expect(found).toEqual([]);
	});
});

describe("the type block", () => {
	it("reports a type statement that sits below a value import", () => {
		// Mutant killed: deleting `type-block-order` from the checker.
		const found = violations('import { a } from "./a";\nimport type { T } from "./t";\n');
		expect(found.map((item) => item.rule)).toEqual(["type-block-order"]);
		expect(found[0].line).toBe(2);
	});

	it("reports an unsorted type block", () => {
		const found = violations('import type { A } from "./b";\nimport type { B } from "./a";\nimport { x } from "./x";\n');
		expect(found.map((item) => item.rule)).toEqual(["type-block-sorted"]);
		expect(found[0].line).toBe(2);
	});

	it("accepts a sorted type block above the value imports", () => {
		expect(rules('import type { B } from "./a";\nimport type { A } from "./b";\nimport { x } from "./x";\n')).toEqual([]);
	});
});

describe("one specifier, two statements", () => {
	it("requires two type statements to be one", () => {
		expect(rules('import type { A } from "./x";\nimport type { B } from "./x";\n')).toEqual(["duplicate"]);
	});

	it("requires a type statement to fold into the value statement", () => {
		expect(rules('import { a } from "./x";\nimport type { T } from "./x";\n')).toEqual(["duplicate", "type-block-order"]);
	});

	it("accepts the folded form — inline `type` modifiers on the value statement", () => {
		expect(rules('import { a, type T } from "./x";\n')).toEqual([]);
	});

	it("reports two value imports and never proposes merging them", () => {
		// Mutant killed: treating value+value as mergeable. Merging value statements
		// would change the module-request order, so the guard must only report.
		const found = violations('import { a } from "./x";\nimport { b } from "./x";\n');
		expect(found.map((item) => item.rule)).toEqual(["duplicate"]);
		expect(found[0].message).toContain("never auto-merged");
	});

	it("exempts a namespace statement paired with a named one", () => {
		expect(rules('import * as ns from "./x";\nimport { a } from "./x";\n')).toEqual([]);
	});

	it("exempts a repeated side-effect import", () => {
		expect(rules('import "./x";\nimport "./x";\n')).toEqual([]);
	});

	it("exempts an import-attribute statement", () => {
		expect(rules('import { a } from "./x";\nimport { b } from "./x" with { type: "json" };\n')).toEqual([]);
	});
});

describe("inline-type-only statements are value statements", () => {
	it("is not hoisted above the value imports that precede it", () => {
		// Mutant killed: treating `import { type T }` as `import type` — it retains
		// its module request, so it may not move.
		expect(rules('import { a } from "./a";\nimport { type T } from "./t";\nimport { b } from "./b";\n')).toEqual([]);
	});

	it("is reported when the same position uses a statement-level `import type`", () => {
		expect(rules('import { a } from "./a";\nimport type { T } from "./t";\nimport { b } from "./b";\n')).toEqual(["type-block-order"]);
	});
});

describe("the 140-character boundary", () => {
	it("accepts exactly 140 characters on one line", () => {
		expect(importAtLength(140)).toHaveLength(140);
		expect(rules(`${importAtLength(140)}\n`)).toEqual([]);
	});

	it("reports 141 characters left on one line", () => {
		// Mutant killed: loosening the limit to 141 (or dropping the wrap rule).
		expect(rules(`${importAtLength(141)}\n`)).toEqual(["wrap"]);
	});

	it("accepts 141 characters wrapped one binding per line", () => {
		expect(rules(`import {\n\ta,\n} from '${specifierAtLength(141)}';\n`)).toEqual([]);
	});

	it("reports a multi-line statement that is not one binding per line", () => {
		expect(rules(`import { a,\n} from '${specifierAtLength(141)}';\n`)).toEqual(["wrap"]);
	});

	it("reports a statement under the limit that is already multi-line", () => {
		expect(rules('import {\n\ta,\n\tb,\n} from "./x";\n')).toEqual(["collapse"]);
	});

	it("exempts a statement with a comment inside it, in both directions", () => {
		expect(rules('import {\n\t/* keep */ a,\n\tb,\n} from "./x";\n')).toEqual([]);
	});

	it("exempts an import-attribute statement, in both directions", () => {
		expect(rules(`import { a } from '${specifierAtLength(141)}' with { type: "json" };\n`)).toEqual([]);
		expect(rules('import {\n\ta,\n} from "./x" with { type: "json" };\n')).toEqual([]);
	});
});

describe("the CLI contract", () => {
	it("exits 0 and reports the file count on a clean corpus", () => {
		const result = runCli(corpus("clean", { "a.ts": 'import { a } from "./a";\n' }));
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("imports: 1 files, 0 violations");
	});

	it("exits 1 and names the violation", () => {
		const result = runCli(corpus("dirty", { "a.ts": 'import { a } from "./a";\nimport type { T } from "./t";\n' }));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("type-block-order");
		expect(result.stderr).toContain("imports: 1 files, 1 violations");
	});

	it("exits 2 when the directory does not exist", () => {
		expect(runCli(join(scratch, "absent")).status).toBe(2);
	});

	it("exits 2 on an empty corpus — an empty scan is not a clean scan", () => {
		// Mutant killed: dropping the real-tree corpus assertion without this, a
		// scan that finds nothing would look green.
		expect(runCli(corpus("empty", {})).status).toBe(2);
	});
});
