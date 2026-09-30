// Purpose: Guards the generated ADR index in .development/decisions/README.md against drift (issue #253).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DECISIONS_DIR = join(ROOT, ".development", "decisions");

describe("ADR index (issue #253)", () => {
	it("the checked-in ADR index matches the decision records", () => {
		// Throws (with the CLI's stderr) when the index is stale — the failure message
		// names the remedy: `npm run docs:decisions`.
		const output = execFileSync("node", ["scripts/docs-decisions.mjs"], {
			cwd: ROOT,
			encoding: "utf8",
		});
		expect(output).toContain("ADR index is current");
	});

	it("every decision record is well-formed and uniquely numbered", () => {
		const files = readdirSync(DECISIONS_DIR)
			.filter((f) => f.endsWith(".md") && f !== "README.md")
			.sort();
		// Guard the guard: a path/extension change that makes the scan match nothing
		// must not turn this into a vacuous pass.
		expect(files.length).toBeGreaterThanOrEqual(12);

		const numbers = new Set<string>();
		for (const file of files) {
			expect(file, `${file}: filename must be NNNN-slug.md`).toMatch(/^\d{4}-[a-z0-9-]+\.md$/);
			const text = readFileSync(join(DECISIONS_DIR, file), "utf8");
			const firstLine = (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
			const heading = /^# (\d{4})\. .+$/.exec(firstLine);
			expect(heading, `${file}: missing "# NNNN. Title" first heading`).not.toBeNull();
			const number = heading![1];
			expect(file, `${file}: filename number must match heading number`).toMatch(new RegExp(`^${number}-`));
			numbers.add(number);
			expect(text, `${file}: missing "- **Status:**" line`).toMatch(/^- \*\*Status:\*\*\s+.+$/m);
			expect(text, `${file}: missing "- **Date:**" line`).toMatch(/^- \*\*Date:\*\*\s+.+$/m);
		}
		expect(numbers.size, "decision numbers must be unique").toBe(files.length);
	});
});
