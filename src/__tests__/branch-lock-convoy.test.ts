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

/** "resolved" | "rejected" | "PENDING" after `ms` — the convoy probe shape. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<string> {
	return Promise.race([
		promise.then(() => "resolved", () => "rejected"),
		new Promise<string>((r) => setTimeout(() => r("PENDING"), ms)),
	]);
}

function resetGit(): void {
	for (const fn of Object.values(mocks.git)) fn.mockReset();
	mocks.git.getRepoRoot.mockReturnValue("/repo");
	mocks.git.getHeadState.mockReturnValue({ sha: "abc123def456", detached: false, branch: "main" });
	mocks.git.getCurrentBranch.mockReturnValue("brl-subagent-owner");
	mocks.git.createWorkBranch.mockReturnValue({ ok: true, branch: "brl-subagent-owner" });
	mocks.git.captureDiff.mockReturnValue({ ok: true, diff: "" });
	mocks.git.restoreHead.mockReturnValue({ ok: true });
	mocks.git.deleteBranch.mockReturnValue({ ok: true });
	mocks.git.hasUncommittedChanges.mockReturnValue(false);
	mocks.git.commitAll.mockReturnValue({ ok: true, sha: "abc123" });
	mocks.git.captureWorkingDiff.mockReturnValue("");
}

/** Spawn with a prompt that never settles until the test releases its gate. */
function spawn(task: string, gitMode?: "branch"): Promise<unknown> {
	return spawnBackgroundSession(fakePi as never, fakeCtx as never, {
		task,
		...(gitMode === undefined ? {} : { gitMode }),
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
	__testResetGitBranchLocks();
});

afterAll(async () => {
	await env.tearDown();
});

describe("issue #465 (d) — the per-repo git wait is outside the spawn-queue critical section", () => {
	it("a non-git dispatch resolves while a branch-mode run holds its repository", async () => {
		// A: branch mode, prompt never settles → A's repo lock is held for its
		// whole lifetime (by design; #460 §1.1).
		await spawn("A: branch holder", "branch");
		expect(mocks.git.createWorkBranch).toHaveBeenCalledTimes(1);

		// B: the SAME repo, branch mode → queues on A's git lock. Pre-fix, B also
		// held the module-level spawn queue while it waited (measured: the whole
		// process stalled behind one run's repository).
		let bSettled = false;
		const bPromise = spawn("B: same repo", "branch").then(
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

		// Drain: A settles → B acquires, prompts; then B and C settle.
		gates[0]?.();
		await tick();
		await bPromise;
		gates[1]?.();
		gates[2]?.();
		await tick();
	});
});
