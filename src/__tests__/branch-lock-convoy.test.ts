// Purpose: Pin issue #465 — a branch-mode run's per-repo lock must not also be a
// process-wide spawn barrier (#460 M2), and a repository whose lock owner is
// terminal-but-unsettled must refuse later branch-mode dispatches by name
// instead of hanging them forever (#460 M1).
//
// Direction (d): the module-level `spawnQueue` protects the pi API import +
// `createAgentSession`, NOT the per-repo git wait — so a locked repository must
// not block an unrelated dispatch. Direction (b): the lock's owner is recorded,
// and a waiter is refused BEFORE it installs its chain link or waits.
//
// The grace is driven to 0 in the refusal tests so the mechanism fires
// deterministically; the shipped value is 30 s (see the constant's comment).
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
	createAgentSession: vi.fn(),
	createdSessionDirs: [] as string[],
	git: {
		getCurrentBranch: vi.fn(),
		getHeadState: vi.fn(),
		createWorkBranch: vi.fn(),
		// Issue #466: the caller mints the work branch name, so the record can
		// name it before the branch exists — this file mocks `../git`, and a
		// missing export here is a spawn-time throw, not a no-op.
		newWorkBranchName: vi.fn(),
		captureDiff: vi.fn(),
		restoreHead: vi.fn(),
		deleteBranch: vi.fn(),
		hasUncommittedChanges: vi.fn(),
		getRepoRoot: vi.fn(),
		commitAll: vi.fn(),
		captureWorkingDiff: vi.fn(),
	},
	session: {
		sessionId: "test-session",
		setSessionName: vi.fn(),
		prompt: vi.fn(),
		abort: vi.fn().mockResolvedValue(undefined),
		messages: [] as Array<Record<string, unknown>>,
	},
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
	class MockDefaultResourceLoader {
		options: Record<string, unknown>;
		reload = vi.fn().mockResolvedValue(undefined);
		constructor(options: Record<string, unknown>) {
			this.options = options;
		}
	}
	return {
		getAgentDir: () => "/tmp/brl-test-agentdir",
		createAgentSession: mocks.createAgentSession,
		// The per-run dir is created here (the real SDK does it) so the refusal's
		// prune is observable rather than a no-op on a path that never existed.
		SessionManager: {
			create: (_cwd: string, dir: string) => {
				mkdirSync(dir, { recursive: true });
				mocks.createdSessionDirs.push(dir);
				return { getSessionFile: () => join(dir, "session.jsonl") };
			},
		},
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: MockDefaultResourceLoader,
	};
});

vi.mock("../git", () => ({
	getCurrentBranch: mocks.git.getCurrentBranch,
	getHeadState: mocks.git.getHeadState,
	createWorkBranch: mocks.git.createWorkBranch,
	newWorkBranchName: mocks.git.newWorkBranchName,
	captureDiff: mocks.git.captureDiff,
	restoreHead: mocks.git.restoreHead,
	deleteBranch: mocks.git.deleteBranch,
	hasUncommittedChanges: mocks.git.hasUncommittedChanges,
	getRepoRoot: mocks.git.getRepoRoot,
	commitAll: mocks.git.commitAll,
	captureWorkingDiff: mocks.git.captureWorkingDiff,
}));

import {
	backgroundSessionDir,
	listPersistedAgents,
	spawnBackgroundSession,
	updateAgentStatus,
	__setStuckOwnerGraceMs,
	__testResetGitBranchLocks,
} from "../session-manager";
import { listInflightRuns } from "../run-registry";
import { createTempEnv } from "./fixtures/temp-lifecycle";

const fakePi = { appendEntry: vi.fn() };
const fakeCtx = { cwd: "/tmp/brl-convoy-cwd", modelRegistry: { find: vi.fn() } };

const env = createTempEnv("brl-convoy-465", { withCwd: false });

/** Deferred prompt gates, in spawn order — one per `session.prompt()` call. */
let gates: Array<() => void> = [];

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Release every prompt gate currently registered, then let the settles run.
 * Repeats, because a queued spawn only reaches `prompt()` after the run it
 * waited for settles — its gate does not exist yet on the first pass.
 */
async function settleAll(rounds = 4): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		for (const gate of gates.splice(0)) gate();
		await tick();
	}
}

/** Release exactly one registered prompt gate (index into the spawn order). */
function releasePrompt(index: number): void {
	const gate = gates.splice(index, 1)[0];
	gate?.();
}

/** "resolved" | "rejected" | "PENDING" after `ms` — the convoy probe shape. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<string> {
	return Promise.race([
		promise.then(() => "resolved", () => "rejected"),
		new Promise<string>((r) => setTimeout(() => r("PENDING"), ms)),
	]);
}

function resetGit(): void {
	for (const fn of Object.values(mocks.git)) fn.mockReset();
	// One cwd per repository: `getRepoRoot` echoes the cwd it is given, so two
	// cwds are two lock keys (#224's keying, taken as given here).
	mocks.git.getRepoRoot.mockImplementation((cwd: string) => cwd);
	mocks.git.getHeadState.mockReturnValue({ sha: "abc123def456", detached: false, branch: "main" });
	mocks.git.getCurrentBranch.mockReturnValue("brl-subagent-owner");
	// The minted name IS the created branch (#466): one value keeps the lock
	// owner's stamped `workBranch` and the branch git was asked for identical.
	mocks.git.newWorkBranchName.mockReturnValue("brl-subagent-owner");
	mocks.git.createWorkBranch.mockImplementation((_cwd: string, _sha: string, branch: string) => ({ ok: true, branch }));
	mocks.git.captureDiff.mockReturnValue({ ok: true, diff: "" });
	mocks.git.restoreHead.mockReturnValue({ ok: true });
	mocks.git.deleteBranch.mockReturnValue({ ok: true });
	mocks.git.hasUncommittedChanges.mockReturnValue(false);
	mocks.git.commitAll.mockReturnValue({ ok: true, sha: "abc123" });
	mocks.git.captureWorkingDiff.mockReturnValue("");
}

/**
 * Spawn with a prompt that never settles until the test releases its gate.
 * `cwd` selects the repository (one lock key per cwd, see `resetGit`).
 */
function spawn(task: string, gitMode?: "branch", cwd?: string): Promise<unknown> {
	return spawnBackgroundSession(fakePi as never, fakeCtx as never, {
		task,
		...(gitMode === undefined ? {} : { gitMode }),
		...(cwd === undefined ? {} : { cwd }),
	});
}

beforeEach(() => {
	env.setUp();
	fakePi.appendEntry.mockClear();
	mocks.createdSessionDirs.length = 0;
	gates = [];
	mocks.session.prompt.mockImplementation(() => new Promise<void>((r) => { gates.push(r); }));
	mocks.session.messages = [
		{ role: "user", content: "probe task" },
		{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
	];
	mocks.createAgentSession.mockReset();
	mocks.createAgentSession.mockImplementation(async () => ({ session: mocks.session }));
	resetGit();
	__setStuckOwnerGraceMs(30_000);
	__testResetGitBranchLocks();
});

afterAll(async () => {
	await env.tearDown();
});

describe("issue #465 (d) — the per-repo git wait is outside the spawn-queue critical section", () => {
	it("a non-git dispatch resolves while a branch-mode run holds its repository", async () => {
		// A: branch mode, prompt never settles → A's repo lock is held for its
		// whole lifetime (by design; #460 §1.1).
		await spawn("A: branch holder", "branch", "/repo-1");
		expect(mocks.git.createWorkBranch).toHaveBeenCalledTimes(1);

		// B: the SAME repo, branch mode → queues on A's git lock. Pre-fix, B also
		// held the module-level spawn queue while it waited (measured: the whole
		// process stalled behind one run's repository).
		let bSettled = false;
		const bPromise = spawn("B: same repo", "branch", "/repo-1").then(
			() => { bSettled = true; },
			() => { bSettled = true; },
		);
		await tick(50);

		// C: no git mode → touches no repository at all. It must NOT inherit B's
		// wait. 1 s is 20x the harness's own setup cost and far below the 30 s
		// grace, so a PENDING verdict here is the convoy and nothing else.
		expect(await settlesWithin(spawn("C: unrelated"), 1000)).toBe("resolved");

		// B is still blocked on the repository (the lock's own contract, #224):
		// releasing the QUEUE must not hand out a second branch setup.
		expect(bSettled).toBe(false);
		expect(mocks.git.createWorkBranch).toHaveBeenCalledTimes(1);

		// Drain: A settles → B acquires the lock and prompts → B and C settle.
		await settleAll(4);
		await bPromise;
	});
});

describe("issue #465 (b) — a terminal-but-unsettled owner refuses later branch-mode dispatches", () => {
	it("refuses before waiting, names the owner and its work branch, and leaves no zombie", async () => {
		// The measured #460 shape: the deadline wrote `stopped` + `completedAt`,
		// the prompt ignored the abort, so the settle (the only releaser of the
		// branch lock) never ran and `_sessionRef` is still held.
		__setStuckOwnerGraceMs(0);
		const owner = (await spawn("A: wedged owner", "branch", "/repo-1")) as { id: string };
		updateAgentStatus(owner.id, "stopped", "Timed out after 120ms");

		const refusal = await spawn("B: refused", "branch", "/repo-1").catch((err: Error) => err);
		expect(refusal).toBeInstanceOf(Error);
		expect((refusal as Error).message).toMatch(/gitMode 'branch' refused/);
		expect((refusal as Error).message).toContain(owner.id);
		expect((refusal as Error).message).toContain("brl-subagent-owner");

		// #473 finding 1: the message's second half is pinned VERBATIM. The shape
		// assertions above let it drift for two issues: #465 shipped "the repository
		// stays on it, and the lock is only cleared by a process restart", which #466
		// made false in exactly the case it describes (the boot now restores a
		// provable orphan). The repair half and its precondition must be stated, and
		// the manual commands must survive only as the needs-manual fallback.
		expect((refusal as Error).message).toContain(
			"this process keeps the repository on it for the rest of its life, and only a " +
				"restart releases the lock. That restart is also the repair: at the next boot " +
				"the recorded base is restored — when the owner is provably dead, HEAD is " +
				"exactly brl-subagent-owner and the working tree is clean — and " +
				"brl-subagent-owner is KEPT with the run's commits.",
		);
		expect((refusal as Error).message).toContain("git stash push -u");
		expect((refusal as Error).message).not.toContain("only cleared by a process restart");

		// The refused dispatch is provably never-started: refused BEFORE its chain
		// link, so it never touched git.
		expect(mocks.git.createWorkBranch).toHaveBeenCalledTimes(1);

		// No zombie: the record is terminal, not `running` (the measured gap in
		// #460 §4.4 — `failPreStart` alone leaves `running`).
		const refusedRecord = listPersistedAgents().find((r) => r.task === "B: refused");
		expect(refusedRecord?.status).toBe("failed");
		const refusedId = refusedRecord!.id;

		// Run entries are an APPEND log: the spawn record stays `running` and the
		// terminal record is added on top. "No zombie" therefore means exactly one
		// terminal entry and that entry being the last one for this id (#453's
		// one-logical-run reading contract).
		const entries = fakePi.appendEntry.mock.calls
			.map((call) => call[1] as Record<string, unknown>)
			.filter((entry) => entry.task === "B: refused");
		const terminal = entries.filter((e) => e.status !== "running");
		expect(terminal).toHaveLength(1);
		expect(terminal[0].status).toBe("failed");
		expect(entries[entries.length - 1]).toBe(terminal[0]);

		// Registry entry cleared, session dir pruned (#404 gate → refused = prune).
		expect(listInflightRuns().filter((run) => run.id === refusedId)).toHaveLength(0);
		expect(existsSync(backgroundSessionDir(refusedId))).toBe(false);

		// Drain A so its lock does not leak into the next case.
		await settleAll();
	});

	it("the owner map is per repository: another repo's release does not clear it", async () => {
		// A holds R1 (never settles). B holds R2 and settles cooperatively, which
		// releases R2's lock and its owner.
		const ownerA = (await spawn("A: R1 wedged", "branch", "/repo-1")) as { id: string };
		await spawn("B: R2 cooperative", "branch", "/repo-2");
		// A's gate (0) stays OPEN on purpose — only B settles.
		releasePrompt(1);
		await tick();
		await tick();

		// A is now terminal-but-unsettled in R1.
		__setStuckOwnerGraceMs(0);
		updateAgentStatus(ownerA.id, "stopped", "Timed out after 120ms");

		// R1: refused. If B's release had cleared ownership beyond its own key,
		// R1 would have NO owner and this dispatch would block instead — hence the
		// bounded verdict before the message is read.
		const cSpawn = spawn("C: R1 must be refused", "branch", "/repo-1");
		expect(await settlesWithin(cSpawn, 2000)).toBe("rejected");
		expect(((await cSpawn.catch((e: Error) => e)) as Error).message).toContain(ownerA.id);

		// R2: B is gone, so a fresh branch-mode dispatch there proceeds normally.
		const r2 = await settlesWithin(spawn("D: R2 proceeds", "branch", "/repo-2"), 1000);
		expect(r2).toBe("resolved");

		await settleAll();
	});

	it("a cooperative run that settles is never refused, even with the grace at zero", async () => {
		__setStuckOwnerGraceMs(0);
		await spawn("A: cooperative", "branch", "/repo-1");
		releasePrompt(0);
		await tick();
		await tick();

		// A settled: `_sessionRef` cleared and the lock released — nothing is
		// wedged, so the second dispatch into the same repo must proceed.
		expect(await settlesWithin(spawn("B: after a real settle", "branch", "/repo-1"), 1000)).toBe("resolved");

		await settleAll();
	});
});
