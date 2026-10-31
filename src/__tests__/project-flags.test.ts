/**
 * Issue #415 — the umbrella project-local `processChecks` flag.
 *
 * #412 shipped TWO process mechanisms: the opt-in Jev-line gate and rule 2's
 * durable-shape auto-switch. The first was opt-in; the second was global, so
 * any user dispatching `high`/`xhigh` + `background:false` + an explicit
 * timeout had their instruction overridden (the switch drops the timeout and
 * applies the 30-minute background default). An explicit foreground timeout is
 * usually a budget cap, so that could triple time and cost against a user's
 * explicit parameter.
 *
 * #415 replaces both per-rule fields with ONE umbrella flag, read in exactly
 * one place:
 *
 *     { "brl-subagent": { "processChecks": true } }
 *
 * FAIL-OPEN is the product contract: a missing, unreadable or malformed
 * `package.json` means `false` — a user's dispatch is never rejected and never
 * reshaped because their project's manifest is absent or broken.
 *
 * The RATCHET at the bottom keeps it that way: only `src/project-flags.ts` may
 * read the `brl-subagent` manifest key, and the field whitelist is exactly
 * `PROCESS_CHECK_KEYS` — a second reader or a third field fails this suite.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	PROCESS_CHECK_KEYS,
	isProcessChecksEnabled,
	readProcessChecks,
} from "../project-flags";
import { validatePreTask } from "../validate";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function tempProject(manifest: unknown | null, raw?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-process-checks-"));
	if (raw !== undefined) {
		fs.writeFileSync(path.join(dir, "package.json"), raw, "utf8");
	} else if (manifest !== null) {
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest), "utf8");
	}
	return dir;
}

const OPTED_IN = tempProject({ name: "opted-in", "brl-subagent": { processChecks: true } });
const OPTED_OUT = tempProject({ name: "opted-out" });

// ---------------------------------------------------------------------------
// The reader — both directions
// ---------------------------------------------------------------------------

describe("readProcessChecks — the project-local opt-in", () => {
	it("is ON for a project whose package.json opts in", () => {
		expect(readProcessChecks(OPTED_IN)).toBe(true);
	});

	it("is OFF for a project with no opt-in field (a user's dispatch is never reshaped)", () => {
		expect(readProcessChecks(OPTED_OUT)).toBe(false);
		expect(readProcessChecks(tempProject({ "brl-subagent": { processChecks: false } }))).toBe(false);
	});

	it("is strictly `=== true`: a truthy non-boolean does not opt in", () => {
		for (const value of ["true", 1, "yes", {}] as unknown[]) {
			expect(readProcessChecks(tempProject({ "brl-subagent": { processChecks: value } }))).toBe(false);
		}
	});

	it("is OFF when the `brl-subagent` key is not an object", () => {
		expect(readProcessChecks(tempProject({ "brl-subagent": true }))).toBe(false);
		expect(readProcessChecks(tempProject({ "brl-subagent": ["processChecks"] }))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Fail-open — the manifest's absence or damage is never a dispatch failure
// ---------------------------------------------------------------------------

describe("readProcessChecks — fail-open", () => {
	it("is OFF when package.json is absent", () => {
		expect(readProcessChecks(OPTED_OUT)).toBe(false);
		expect(readProcessChecks(path.join(os.tmpdir(), "brl-process-checks-does-not-exist"))).toBe(false);
	});

	it("is OFF (never throws) when package.json is malformed", () => {
		const broken = tempProject(null);
		fs.writeFileSync(path.join(broken, "package.json"), "{not json", "utf8");
		expect(readProcessChecks(broken)).toBe(false);
	});

	it("is OFF when package.json is empty or not a file", () => {
		expect(readProcessChecks(tempProject(null, ""))).toBe(false);
		const asDir = tempProject(null);
		fs.mkdirSync(path.join(asDir, "package.json"));
		expect(readProcessChecks(asDir)).toBe(false);
	});

	it("is OFF for an undefined/empty cwd (unit callers that never resolve a project)", () => {
		expect(readProcessChecks(undefined)).toBe(false);
		expect(readProcessChecks("")).toBe(false);
	});

	it("validatePreTask fails open too — a broken manifest never rejects a user's task", () => {
		const broken = tempProject(null);
		fs.writeFileSync(path.join(broken, "package.json"), "{not json", "utf8");
		expect(validatePreTask({ task: "Implement the thing.", cwd: broken }).valid).toBe(true);
		expect(validatePreTask({ task: "Implement the thing.", cwd: OPTED_OUT }).valid).toBe(true);
	});

	it("validatePreTask enforces the line only when the flag is ON", () => {
		const result = validatePreTask({ task: "Implement the thing.", cwd: OPTED_IN });
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toMatch(/missing Jev dispatch line/);
	});
});

describe("the flag's two public names agree", () => {
	it("isProcessChecksEnabled is the validation seam's reading of readProcessChecks", () => {
		expect(isProcessChecksEnabled(OPTED_IN)).toBe(readProcessChecks(OPTED_IN));
		expect(isProcessChecksEnabled(OPTED_OUT)).toBe(readProcessChecks(OPTED_OUT));
	});
});

// ---------------------------------------------------------------------------
// Ratchet — one reader, one field
// ---------------------------------------------------------------------------

/** Every production `.ts` file under `src/` (tests are fixtures, not readers). */
function productionSources(): Array<{ file: string; text: string }> {
	const sources: Array<{ file: string; text: string }> = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__tests__" || entry.name === "__snapshots__") continue;
				walk(absolute);
			} else if (entry.name.endsWith(".ts")) {
				sources.push({
					file: path.relative(path.join(REPO_ROOT, "src"), absolute).split(path.sep).join("/"),
					text: fs.readFileSync(absolute, "utf8"),
				});
			}
		}
	};
	walk(path.join(REPO_ROOT, "src"));
	return sources;
}

const MANIFEST_KEY_RE = /\[\s*["']brl-subagent["']\s*\]/g;
/**
 * An ACCESS to the manifest key — bracket access (`manifest["brl-subagent"]`)
 * or a destructuring key (`{ "brl-subagent": section }`). Deliberately NOT the
 * bare package name/dir string, which every module uses for logs, commands and
 * `.pi/brl-subagent` paths.
 */
const MANIFEST_KEY_ACCESS_RE =
	/(?:\[\s*["']brl-subagent["']\s*\]|[{,]\s*["']brl-subagent["']\s*:)/;

describe("ratchet — only src/project-flags.ts reads the brl-subagent manifest key", () => {
	const sources = productionSources();
	const readers = sources.filter((s) => MANIFEST_KEY_ACCESS_RE.test(s.text)).map((s) => s.file);

	it("has exactly one reader, and it is src/project-flags.ts", () => {
		expect(readers).toEqual(["project-flags.ts"]);
	});

	it("the reader actually reads package.json (the scan is not vacuous)", () => {
		const reader = sources.find((s) => s.file === "project-flags.ts");
		expect(reader, "src/project-flags.ts must exist").toBeDefined();
		expect(reader?.text).toContain('"package.json"');
		expect(reader?.text).toContain("readFileSync");
	});

	it("no other production module reads package.json for the flag", () => {
		const offenders = sources
			.filter((s) => s.file !== "project-flags.ts")
			.filter((s) => /readFileSync\([^)]*["']package\.json["']/.test(s.text))
			.map((s) => s.file);
		expect(offenders).toEqual([]);
	});

	it("the field whitelist is exactly the umbrella flag", () => {
		expect([...PROCESS_CHECK_KEYS]).toEqual(["processChecks"]);
	});

	it("the reader accesses ONLY whitelisted fields (a third field fails)", () => {
		const reader = sources.find((s) => s.file === "project-flags.ts");
		expect(reader).toBeDefined();
		const accessed = [...(reader?.text.matchAll(MANIFEST_KEY_RE) ?? [])].length;
		// Coverage: the key must be accessed at least once, or the whitelist check
		// below would pass vacuously.
		expect(accessed, "project-flags.ts must access the manifest key").toBeGreaterThan(0);

		const fields = [
			...((reader?.text ?? "").matchAll(
				/\[\s*["']brl-subagent["']\s*\]\s*\?\.\s*([A-Za-z_$][\w$]*)/g,
			) ?? []),
		].map((m) => m[1]);
		expect(fields.length, "the field access must be found for the whitelist scan").toBeGreaterThan(0);
		const unknown = fields.filter((f) => !(PROCESS_CHECK_KEYS as readonly string[]).includes(f));
		expect(unknown, `an unlisted process-check field is read: ${unknown.join(", ")}`).toEqual([]);
	});

	it("this repository opts in (the tracked manifest carries the flag)", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
			"brl-subagent"?: { processChecks?: unknown };
		};
		expect(manifest["brl-subagent"]?.processChecks).toBe(true);
	});

	it("the scan covers the production tree (coverage assertion, Rule 19)", () => {
		expect(sources.length).toBeGreaterThanOrEqual(30);
		expect(sources.some((s) => s.file === "index.ts")).toBe(true);
	});
});
