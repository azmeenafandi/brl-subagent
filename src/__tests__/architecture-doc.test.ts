// Purpose: Guards the generated module map in ARCHITECTURE.md against drift (issue #249).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");

describe("ARCHITECTURE.md module map (issue #249)", () => {
	it("the checked-in module map matches the source tree", () => {
		// Throws (with the CLI's stderr) when the map is stale — the failure message
		// names the remedy: `npm run docs:arch`.
		const output = execFileSync("node", ["scripts/docs-arch.mjs"], {
			cwd: ROOT,
			encoding: "utf8",
		});
		expect(output).toContain("module map is current");
	});

	it("every src module declares a first-line purpose header", () => {
		const files = readdirSync(SRC_DIR)
			.filter((f) => f.endsWith(".ts"))
			.sort();
		// Guard the guard: a path/extension change that makes the scan match nothing
		// must not turn this into a vacuous pass.
		expect(files.length).toBeGreaterThan(30);
		const missing = files.filter((f) => {
			const firstLine = (readFileSync(join(SRC_DIR, f), "utf8").split("\n").find((l) => l.trim().length > 0) ?? "").trim();
			return !/^\/\/ Purpose: \S/.test(firstLine);
		});
		expect(missing).toEqual([]);
	});
});
