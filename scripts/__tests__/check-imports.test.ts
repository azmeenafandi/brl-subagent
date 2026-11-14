/**
 * Tests for the import-convention guard's published rule set and its CI invocation (issue #476).
 *
 * Deliberately thin: the rule fixtures — one per rule, in both directions — live in
 * `src/__tests__/import-convention.test.ts`, which is where the convention's own behaviour belongs.
 * Restating them here would be a second copy of the same assertions, and the `scripts` surface is
 * a 1.0 ratio. What this file pins is what no src test can: that the guard is importable from the
 * tooling surface at all (issue #490's floor check needs an import, not a mention), that its rule
 * ids are exactly the five its header documents, and that the committed tree is clean when run the
 * way CI runs it.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RULES } from "../check-imports.mjs";

const ROOT = process.cwd();

describe("check-imports — the rule set", () => {
	it("publishes exactly the five documented rule ids", () => {
		// A deleted rule must fail here, not silently stop reporting.
		expect(Object.values(RULES).sort()).toEqual(["collapse", "duplicate", "type-block-order", "type-block-sorted", "wrap"]);
	});
});

describe("check-imports — the CI invocation", () => {
	it("reports the committed src tree clean", () => {
		const result = spawnSync(process.execPath, [join(ROOT, "scripts", "check-imports.mjs")], { cwd: ROOT, encoding: "utf8" });
		// stderr is not asserted empty: the AST adapter's tsgo child prints `context canceled` on
		// exit (pre-existing, issue #490 out of scope — it is not a violation and CI ignores it).
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/^imports: \d+ files, 0 violations/);
	});
});
