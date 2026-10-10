/**
 * #299 fix A.2 — unit tests for the THREE-state `groupHasMembers` inspection.
 *
 * The point of the test is the *partial* inspection: a `/proc`-capable host
 * whose listing fails, or whose member stat read fails for a reason other than
 * the process being gone, must answer UNKNOWN (`undefined`) — never a
 * positively-empty `false`. Absence of evidence must never read as evidence of
 * absence.
 *
 * `node:fs` is mocked with a thin wrapper around the real module so the failure
 * paths are deterministic. Only `readdirSync`/`readFileSync` are intercepted;
 * every other call and every un-stubbed path falls through to the real module,
 * and the real `/proc` is never mutated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const control = vi.hoisted(() => ({
	readdirError: undefined as NodeJS.ErrnoException | undefined,
	dirEntries: undefined as string[] | undefined,
	statErrors: new Map<string, NodeJS.ErrnoException>(),
	statContents: new Map<string, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: ((...args: unknown[]) => {
			if (control.readdirError) throw control.readdirError;
			if (control.dirEntries) return control.dirEntries;
			return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
		}) as typeof actual.readdirSync,
		readFileSync: ((...args: unknown[]) => {
			const file = String(args[0]);
			const err = control.statErrors.get(file);
			if (err) throw err;
			const contents = control.statContents.get(file);
			if (contents !== undefined) return contents;
			return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
		}) as typeof actual.readFileSync,
	};
});

import { groupHasMembers, __setProcAvailableForTest } from "../proc";

const PGID = 4321;
const MEMBER = 5500;
const OTHER_PGID = 9999;

function errno(code: string): NodeJS.ErrnoException {
	const err = new Error(code) as NodeJS.ErrnoException;
	err.code = code;
	return err;
}

/** A synthetic `/proc/<pid>/stat` line with a controllable state and pgrp. */
function statLine(state: string, pgrp: number): string {
	// `<pid> (comm) <state> <ppid> <pgrp> …` — the reader slices at the LAST `)`
	// and indexes field 2 (pgrp) after `(comm)`.
	return `${MEMBER} (node) ${state} 1 ${pgrp} 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
}

beforeEach(() => {
	control.readdirError = undefined;
	control.dirEntries = undefined;
	control.statErrors.clear();
	control.statContents.clear();
	__setProcAvailableForTest(true);
});

afterEach(() => {
	__setProcAvailableForTest(undefined);
});

describe("groupHasMembers tri-state (#299 fix A.2)", () => {
	it("returns true when a live same-pgid member is observed", () => {
		control.dirEntries = [String(MEMBER), "self"];
		control.statContents.set(`/proc/${MEMBER}/stat`, statLine("S", PGID));
		expect(groupHasMembers(PGID)).toBe(true);
	});

	it("returns false (positively empty) when a completed scan finds no member", () => {
		control.dirEntries = [String(MEMBER), "self"];
		control.statContents.set(`/proc/${MEMBER}/stat`, statLine("S", OTHER_PGID));
		expect(groupHasMembers(PGID)).toBe(false);
	});

	it("skips the leader itself and zombies (a corpse is not a live member)", () => {
		control.dirEntries = [String(PGID), String(MEMBER), "self"];
		control.statContents.set(`/proc/${MEMBER}/stat`, statLine("Z", PGID));
		expect(groupHasMembers(PGID)).toBe(false);
	});

	it("returns undefined when the /proc listing fails on a /proc-capable host", () => {
		control.readdirError = errno("EACCES");
		expect(groupHasMembers(PGID)).toBeUndefined();
	});

	it("returns undefined when a member stat read fails for a reason other than vanishing", () => {
		control.dirEntries = [String(MEMBER), "self"];
		control.statErrors.set(`/proc/${MEMBER}/stat`, errno("EACCES"));
		expect(groupHasMembers(PGID)).toBeUndefined();
	});

	it("skips a member that vanished mid-scan (ENOENT) and keeps scanning", () => {
		control.dirEntries = [String(MEMBER), "self"];
		control.statErrors.set(`/proc/${MEMBER}/stat`, errno("ENOENT"));
		expect(groupHasMembers(PGID)).toBe(false);
	});

	it("returns undefined on an unreadable/parse-anomalous stat (no errno)", () => {
		control.dirEntries = [String(MEMBER), "self"];
		control.statContents.set(`/proc/${MEMBER}/stat`, "garbage without a paren");
		expect(groupHasMembers(PGID)).toBeUndefined();
	});

	it("returns undefined on a truncated member record (valid `)` but too few fields)", () => {
		control.dirEntries = [String(MEMBER), "self"];
		// `5500 (node) S 1` — the pgrp field is absent; `Number(undefined)` is NaN
		// and was silently read as a NON-member (a positively-empty `false`).
		control.statContents.set(`/proc/${MEMBER}/stat`, `${MEMBER} (node) S 1`);
		expect(groupHasMembers(PGID)).toBeUndefined();
	});

	it("returns undefined on a record with no state token (fields shifted)", () => {
		control.dirEntries = [String(MEMBER), "self"];
		// The state slot is gone, so field 2 holds no pgrp either.
		control.statContents.set(`/proc/${MEMBER}/stat`, `${MEMBER} (node) ${PGID}`);
		expect(groupHasMembers(PGID)).toBeUndefined();
	});

	it("returns undefined on a malformed zombie record (Z but no pgrp)", () => {
		control.dirEntries = [String(MEMBER), "self"];
		// A zombie skip is only honest for a WELL-FORMED record; a missing pgrp is
		// malformed, so the inspection is partial → unknown, not a silent skip.
		control.statContents.set(`/proc/${MEMBER}/stat`, `${MEMBER} (node) Z 1`);
		expect(groupHasMembers(PGID)).toBeUndefined();
	});

	it.each([
		["single-space shifted record", `${MEMBER} (node) 1 1 ${OTHER_PGID} 0 0`],
		["double-space shifted record", `${MEMBER} (node)  1 1 ${OTHER_PGID} 0 0`],
		["numeric token in the state slot", `${MEMBER} (node) 5 1 ${OTHER_PGID} 0 0`],
	])("#299 fix A.4: a %s is PARTIAL, never a positively-empty non-member", (_label, stat) => {
		control.dirEntries = [String(MEMBER), "self"];
		// The state token is missing (or not a letter), so every field shifts left:
		// the pgrp slot now holds `9999`, a REAL integer. The A.3 numeric-pgrp guard
		// alone accepted it as a justified non-member and reported the group empty;
		// the state-shape check is what marks the record malformed.
		control.statContents.set(`/proc/${MEMBER}/stat`, stat);
		expect(groupHasMembers(PGID)).toBeUndefined();
	});

	it("still skips a well-formed `X` (dead) record with a numeric pgrp", () => {
		control.dirEntries = [String(MEMBER), "self"];
		control.statContents.set(`/proc/${MEMBER}/stat`, statLine("X", PGID));
		expect(groupHasMembers(PGID)).toBe(false);
	});

	it("still returns false for a well-formed record with a valid letter and a different pgrp", () => {
		control.dirEntries = [String(MEMBER), "self"];
		control.statContents.set(`/proc/${MEMBER}/stat`, statLine("R", OTHER_PGID));
		expect(groupHasMembers(PGID)).toBe(false);
	});

	it("degrades to false on an invalid pgid (documented boundary, before any /proc read)", () => {
		expect(groupHasMembers(0)).toBe(false);
		expect(groupHasMembers(-1)).toBe(false);
		expect(groupHasMembers(Number.NaN)).toBe(false);
	});

	it("degrades to false (documented platform boundary) when /proc is unavailable", () => {
		__setProcAvailableForTest(false);
		expect(groupHasMembers(PGID)).toBe(false);
	});
});
