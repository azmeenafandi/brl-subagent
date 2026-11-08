/**
 * Issue #466 (ADR 0026) — the durable head state: the store and the boot policy.
 *
 * Unit layer (no git): the record's keying/atomicity/parse tolerance, the eight
 * verdicts of dossier §4's table over INJECTED deps (so the order of the rows is
 * pinned without a repository), the one notice builder, and the staleness sweep.
 * The same table against real git is in `headstate-git.test.ts`; the pre-flight
 * refusal in `branch-headstate-refusal.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import {
	HEAD_STATE_VERSION,
	buildHeadStateNotice,
	headStatePath,
	listHeadStates,
	readHeadState,
	reconcileHeadStates,
	sweepHeadStates,
	writeHeadState,
	type HeadStateDeps,
	type HeadStateRecord,
} from "../headstate";
import type { HeadState } from "../git";
import { createTempEnv } from "./fixtures/temp-lifecycle";

const env = createTempEnv("brl-headstate");
const ROOT = "/tmp/brl-headstate-repo";
const WORK = "brl-subagent-dead1234";
const BASE: HeadState = { sha: "base123", branch: "main", detached: false };
const DAY_MS = 86_400_000;

function record(over: Partial<HeadStateRecord> = {}): HeadStateRecord {
	return {
		version: HEAD_STATE_VERSION,
		repoRoot: ROOT,
		runId: "run-1",
		kind: "background",
		base: BASE,
		workBranch: WORK,
		owner: { pid: 4242, start: "123456" },
		createdAt: new Date().toISOString(),
		...over,
	};
}

/** Injected deps that record every call, so "no git command ran" is assertable. */
function harness(over: Partial<HeadStateDeps> = {}): { deps: HeadStateDeps; calls: string[] } {
	const calls: string[] = [];
	const deps: HeadStateDeps = {
		getRepoRoot: (dir) => {
			calls.push("getRepoRoot");
			return dir;
		},
		classifyOwner: () => {
			calls.push("classifyOwner");
			return "dead";
		},
		// The tree starts on the work branch and, once `restoreHead` runs, reports
		// the recorded base — the state machine a real restore produces.
		getHeadBranch: heads({ branch: WORK, unborn: false }, { branch: BASE.branch, unborn: false }, calls),
		restoreHead: (_cwd, base) => {
			calls.push(`restoreHead:${base.detached ? "detached" : base.branch}`);
			return { ok: true };
		},
		hasUncommittedChanges: () => {
			calls.push("hasUncommittedChanges");
			return false;
		},
		...over,
	};
	return { deps, calls };
}

/**
 * A `getHeadBranch` stub: `first` on the first call (before the restore), `after`
 * from then on. The table reads HEAD twice, so a constant stub would misreport a
 * successful restore as a mis-landing one.
 */
function heads(
	first: { branch?: string; unborn: boolean },
	after: { branch?: string; unborn: boolean },
	calls?: string[],
): HeadStateDeps["getHeadBranch"] {
	let reads = 0;
	return () => {
		calls?.push("getHeadBranch");
		return reads++ === 0 ? first : after;
	};
}

/** Write a raw (unparseable/incomplete) state file, bypassing `writeHeadState`. */
function plantRaw(text: string, repoRoot: string = ROOT): string {
	mkdirSync(env.headStateDir, { recursive: true });
	const file = headStatePath(repoRoot);
	writeFileSync(file, text);
	return file;
}

beforeEach(() => env.setUp());
afterAll(() => env.tearDown());

describe("the head-state store", () => {
	it("keys one record per resolved repository root, never on process.cwd() (M10)", () => {
		writeHeadState(record({ repoRoot: "/repo-a" }));
		writeHeadState(record({ repoRoot: "/repo-b" }));
		expect(headStatePath("/repo-a")).not.toBe(headStatePath("/repo-b"));
		expect(headStatePath("/repo-a").endsWith(".json")).toBe(true);
		expect(listHeadStates().map((r) => r.repoRoot).sort()).toEqual(["/repo-a", "/repo-b"]);
		expect(listHeadStates().some((r) => r.repoRoot === process.cwd())).toBe(false);
	});

	it("writes atomically and owner-only, and a stray temp file is never a record", () => {
		expect(writeHeadState(record())).toBe(true);
		expect(writeHeadState(record({ runId: "run-2" }))).toBe(true);
		expect(readdirSync(env.headStateDir)).toEqual([expect.stringMatching(/^[0-9a-f]{16}\.json$/)]);
		expect(statSync(headStatePath(ROOT)).mode & 0o777).toBe(0o600);
		expect(statSync(env.headStateDir).mode & 0o777).toBe(0o700);
		expect(listHeadStates()[0].runId).toBe("run-2");
		// The crash window of a write leaves a `.tmp` behind; the reader ignores it.
		writeFileSync(`${headStatePath(ROOT)}.4242.abc.tmp`, '{"version": 1, "repo');
		expect(listHeadStates()).toHaveLength(1);
	});

	it("distinguishes an absent record from a corrupt one (L1 warns, absent is silent)", () => {
		expect(readHeadState(ROOT)).toEqual({ state: "absent" });
		plantRaw(JSON.stringify({ ...record(), version: 99 }));
		expect(readHeadState(ROOT).state).toBe("corrupt");
		plantRaw(JSON.stringify({ ...record(), kind: "unit" }));
		expect(readHeadState(ROOT).state).toBe("corrupt");
		plantRaw('{"version": 1, "repoRoot": "/tru');
		expect(readHeadState(ROOT).state).toBe("corrupt");
	});
});

describe("the boot policy table (dossier §4, in its fixed order)", () => {
	it("row 7: a clean tree on the recorded branch is restored and the record cleared", () => {
		writeHeadState(record());
		const h = harness();
		expect(reconcileHeadStates(h.deps)).toEqual([
			expect.objectContaining({ verdict: "restore", workBranch: WORK, base: BASE }),
		]);
		expect(h.calls).toContain("restoreHead:main");
		// Cleared, and the work branch is never touched: no delete dep exists.
		expect(readHeadState(ROOT)).toEqual({ state: "absent" });
	});

	it("row 5: a deleted-but-checked-out branch restores BEFORE the dirty check (M13)", () => {
		writeHeadState(record());
		const h = harness({
			getHeadBranch: heads({ branch: WORK, unborn: true }, { branch: BASE.branch, unborn: false }),
			// Row 6 must NOT be consulted: an unborn HEAD reads dirty for the wrong
			// reason, and `git checkout <base>` is the repair.
			hasUncommittedChanges: () => {
				throw new Error("the dirty check must not gate an unborn HEAD");
			},
		});
		expect(reconcileHeadStates(h.deps)[0].verdict).toBe("no-branch");
		expect(h.calls).toContain("restoreHead:main");
		expect(readHeadState(ROOT).state).toBe("absent");
	});

	it("row 6: a dirty tree is left alone and keeps its record (M6)", () => {
		writeHeadState(record());
		const h = harness({ hasUncommittedChanges: () => true });
		expect(reconcileHeadStates(h.deps)[0]).toMatchObject({ verdict: "needs-manual" });
		expect(h.calls.some((c) => c.startsWith("restoreHead"))).toBe(false);
		expect(readHeadState(ROOT).state).toBe("ok");
	});

	it("row 4: a tree moved off the recorded branch is never switched, only cleared (M7)", () => {
		writeHeadState(record());
		const h = harness({ getHeadBranch: () => ({ branch: "someone-elses-branch", unborn: false }) });		expect(reconcileHeadStates(h.deps)[0].verdict).toBe("already-off");
		expect(h.calls.some((c) => c.startsWith("restoreHead"))).toBe(false);
		expect(readHeadState(ROOT).state).toBe("absent");
	});

	it("row 3: a live or unverifiable owner is never repaired (M5)", () => {
		writeHeadState(record());
		for (const state of ["alive", "unknown"] as const) {
			const h = harness({ classifyOwner: () => state });
			expect(reconcileHeadStates(h.deps)[0].verdict).toBe("skip-owner");
			// Not even a git READ happens past the owner row.
			expect(h.calls).not.toContain("getHeadBranch");
		}
		expect(readHeadState(ROOT).state).toBe("ok");
	});

	it("row 2: a repository that no longer resolves is skipped and kept", () => {
		writeHeadState(record());
		const h = harness({ getRepoRoot: () => undefined });
		expect(reconcileHeadStates(h.deps)[0].verdict).toBe("skip-missing");
		expect(readHeadState(ROOT).state).toBe("ok");
	});

	it("row 1: an unversioned record runs no git command and stays put (M9)", () => {
		plantRaw(JSON.stringify({ repoRoot: ROOT, workBranch: WORK }));
		const h = harness();
		expect(reconcileHeadStates(h.deps)[0]).toMatchObject({ verdict: "skip-record" });
		expect(h.calls).toEqual([]);
		expect(readHeadState(ROOT).state).toBe("corrupt");
	});

	it("row 7: a failed restore keeps the record and reports it (M14)", () => {
		writeHeadState(record());
		const h = harness({ restoreHead: () => ({ ok: false, error: "would be overwritten" }) });
		expect(reconcileHeadStates(h.deps)[0]).toMatchObject({
			verdict: "restore-failed",
			detail: "would be overwritten",
		});
		expect(readHeadState(ROOT).state).toBe("ok");
	});

	it("row 7: a restore that does not LAND on the recorded base is not a repair", () => {
		writeHeadState(record());
		const h = harness({ getHeadBranch: heads({ branch: WORK, unborn: false }, { branch: "other", unborn: false }) });
		expect(reconcileHeadStates(h.deps)[0].verdict).toBe("restore-failed");
		expect(readHeadState(ROOT).state).toBe("ok");
	});

	it("a detached base is replayed by sha, and landing on a branch is not that base", () => {
		const detached: HeadState = { sha: "deadbeefcafe", branch: "HEAD", detached: true };
		writeHeadState(record({ base: detached }));
		const h = harness({
			getHeadBranch: heads({ branch: WORK, unborn: false }, { branch: undefined, unborn: false }),
		});
		expect(reconcileHeadStates(h.deps)[0].verdict).toBe("restore");
		expect(h.calls).toContain("restoreHead:detached");
		expect(readHeadState(ROOT).state).toBe("absent");
	});

	it("isolates one throwing record so the rest still get a verdict", () => {
		writeHeadState(record({ repoRoot: "/repo-a" }));
		writeHeadState(record({ repoRoot: "/repo-b" }));
		let calls = 0;
		const h = harness({
			getRepoRoot: () => {
				if (++calls === 1) throw new Error("repo vanished");
				return "/repo-b";
			},
		});
		expect(reconcileHeadStates(h.deps).map((o) => o.verdict)).toEqual(["needs-manual", "restore"]);
	});
});

describe("the notice and the sweep", () => {
	it("builds no notice when nothing is reportable, and names branch, base and commands otherwise", () => {
		expect(buildHeadStateNotice([{ verdict: "already-off" }, { verdict: "skip-owner" }])).toBeUndefined();
		const repair = buildHeadStateNotice([
			{ verdict: "needs-manual", repoRoot: "/tmp/repo-a", workBranch: WORK, base: BASE, detail: "uncommitted changes" },
		]);
		expect(repair?.content).toContain(WORK);
		expect(repair?.content).toContain("git checkout main");
		expect(repair?.content).toContain("git stash push -u");
		expect(repair?.content).toContain("repo-a");
		const restored = buildHeadStateNotice([
			{ verdict: "restore", repoRoot: "/tmp/repo-a", workBranch: WORK, base: BASE, orphans: 3 },
		]);
		expect(restored?.content).toContain(`RESTORED main`);
		expect(restored?.content).toContain("3 brl-subagent-* branches");
	});

	it("sweeps only records whose repository is gone and that are past the window", () => {
		const old = new Date(Date.now() - 31 * DAY_MS).toISOString();
		writeHeadState(record({ repoRoot: "/gone-old", createdAt: old }));
		writeHeadState(record({ repoRoot: "/gone-fresh" }));
		writeHeadState(record({ repoRoot: "/alive-old", createdAt: old }));
		expect(sweepHeadStates({ repoGone: (r) => r.repoRoot.startsWith("/gone-") })).toBe(1);
		expect(listHeadStates().map((r) => r.repoRoot).sort()).toEqual(["/alive-old", "/gone-fresh"]);
	});

	it("sweeps an unparseable record on the file's own age (it names no repository)", () => {
		const file = plantRaw("not a record", "/corrupt");
		const old = (Date.now() - 31 * DAY_MS) / 1000;
		utimesSync(file, old, old);
		expect(sweepHeadStates({ repoGone: () => true })).toBe(1);
		expect(readHeadState("/corrupt")).toEqual({ state: "absent" });
	});
});
