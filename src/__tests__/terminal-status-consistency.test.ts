/**
 * Issue #179 — the terminal-status consistency ratchet (item 5 of the C1 review response).
 *
 * WHY THIS EXISTS
 * The #179 fix widened the failure predicate in `isSubagentError`. Several other places kept
 * their OWN copy of that predicate (`exitCode !== 0 || stopReason === "error" || "aborted"`)
 * and were not widened with it — so a subtask ending `length` / `toolUse` / `deferred` /
 * `pending` was recorded FAILED but rendered as a SUCCESS in the TUI and counted as succeeded
 * in the parallel header. That is the very defect #179 exists to remove, reintroduced by
 * silent divergence between copies of one rule.
 *
 * TWO GUARDS
 *   1. BEHAVIOURAL — for every member of the SDK's StopReason union, the shared predicate and
 *      the shared tally must agree on the verdict.
 *   2. STRUCTURAL — no module outside `types.ts` may reimplement the predicate. This is the
 *      durable half: it fails the moment someone writes a private copy, rather than waiting
 *      for the copies to disagree in production.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	isSubagentError,
	countSubagentOutcomes,
	EMPTY_USAGE,
	type SubagentResult,
} from "../types";

/** Build a minimal result — `isSubagentError` reads only `exitCode` and `stopReason`. */
function result(exitCode: number, stopReason?: string): SubagentResult {
	return {
		task: "probe",
		exitCode,
		messages: [],
		stderr: "",
		usage: { ...EMPTY_USAGE },
		...(stopReason ? { stopReason } : {}),
	} as SubagentResult;
}

/**
 * The SDK's StopReason union (@earendil-works/pi-ai): "pending" | "stop" | "length" |
 * "toolUse" | "error" | "aborted" | "deferred". Listed explicitly so the expectations are
 * readable; the structural guard below is what catches a future divergence.
 */
const CASES: Array<{ stopReason: string | undefined; exitCode: number; isError: boolean }> = [
	{ stopReason: "stop", exitCode: 0, isError: false },
	{ stopReason: undefined, exitCode: 0, isError: false },
	{ stopReason: "error", exitCode: 0, isError: true },
	{ stopReason: "aborted", exitCode: 0, isError: true },
	{ stopReason: "length", exitCode: 0, isError: true },
	{ stopReason: "toolUse", exitCode: 0, isError: true },
	{ stopReason: "deferred", exitCode: 0, isError: true },
	{ stopReason: "pending", exitCode: 0, isError: true },
	// exitCode still counts, independently of the stop reason
	{ stopReason: "stop", exitCode: 1, isError: true },
	{ stopReason: undefined, exitCode: 1, isError: true },
];

describe("terminal-status consistency (issue #179)", () => {
	it("isSubagentError classifies every StopReason as expected", () => {
		for (const c of CASES) {
			const label = `stopReason=${c.stopReason ?? "(none)"} exitCode=${c.exitCode}`;
			expect(isSubagentError(result(c.exitCode, c.stopReason)), label).toBe(c.isError);
		}
	});

	it("countSubagentOutcomes agrees with isSubagentError for every StopReason", () => {
		for (const c of CASES) {
			const r = result(c.exitCode, c.stopReason);
			const tally = countSubagentOutcomes([r]);
			const label = `stopReason=${c.stopReason ?? "(none)"} exitCode=${c.exitCode}`;
			expect({ succeeded: tally.succeeded, failed: tally.failed }, label).toEqual(
				c.isError ? { succeeded: 0, failed: 1 } : { succeeded: 1, failed: 0 },
			);
		}
	});

	it("countSubagentOutcomes totals a mixed batch and ignores undefined", () => {
		const tally = countSubagentOutcomes([
			result(0, "stop"),
			result(0, "length"),
			result(0, "toolUse"),
			result(0, "aborted"),
			undefined,
		]);
		expect(tally).toEqual({ succeeded: 1, failed: 3 });
	});

	it("no module outside types.ts reimplements the failure predicate", () => {
		// A reimplementation is any comparison of `stopReason` against one of the failure
		// reasons. It is structurally how the copies desynced: each was correct when written.
		const PREDICATE = /stopReason\s*[!=]==?\s*"(?:error|aborted|length|toolUse|deferred|pending)"/;

		const dir = join(process.cwd(), "src");
		const offenders: string[] = [];

		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			if (entry.name === "types.ts") continue; // the one legitimate home
			const path = join(dir, entry.name);
			const lines = readFileSync(path, "utf-8").split("\n");
			lines.forEach((line, i) => {
				if (PREDICATE.test(line)) offenders.push(`src/${entry.name}:${i + 1}: ${line.trim()}`);
			});
		}

		expect(
			offenders,
			"These reimplement the failure predicate instead of calling isSubagentError(). " +
				"A private copy silently desyncs when the predicate is widened (issue #179). " +
				"Route them through isSubagentError() / countSubagentOutcomes().",
		).toEqual([]);
	});
});
