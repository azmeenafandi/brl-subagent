/**
 * Issue #466 (ADR 0026) — the head state against REAL git (Gate A).
 *
 * The unit suite (`headstate.test.ts`) pins the policy table over injected deps;
 * this one pins the same table on real repositories, where the truth is the
 * filesystem: the boot restores a clean orphan and KEEPS its branch with the
 * commit, leaves a dirty tree and a hand-moved tree alone, and repairs an unborn
 * HEAD. The plain-object cases (`W466P-P11` F1/F2/F3/F4a/F5) are the dossier's;
 * nothing here re-derives a measurement.
 *
 * The two spawn tests drive the REAL `spawnBackgroundSession` (SDK stubbed, as in
 * session-manager.test.ts) because the record's write point is the spawn's own
 * critical section: M1 (no record) and M10 (keyed on `process.cwd()`) are only
 * observable there.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const session = vi.hoisted(() => ({
	sessionId: "headstate-session",
	setSessionName: vi.fn(),
	prompt: vi.fn(),
	abort: vi.fn(),
	messages: [] as unknown[],
}));

// Only the heavy session construction is stubbed; the run lifecycle under test is real.
vi.mock("@earendil-works/pi-coding-agent", () => {
	class DefaultResourceLoader {
		reload = vi.fn().mockResolvedValue(undefined);
	}
	return {
		getAgentDir: () => "/tmp/brl-test-agentdir",
		createAgentSession: async () => ({ session }),
		SessionManager: { create: () => ({ getSessionFile: () => undefined }) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader,
	};
});

import {
	getCurrentBranch,
	getHeadBranch,
	getRepoRoot,
	hasUncommittedChanges,
	listWorkBranches,
	restoreHead,
} from "../git";
import {
	HEAD_STATE_VERSION,
	readHeadState,
	reconcileHeadStates,
	writeHeadState,
	type HeadStateDeps,
	type HeadStateRecord,
} from "../headstate";
import { classifyOwner, currentProcessOwner, defaultRecoveryDeps } from "../recovery";
import { spawnBackgroundSession } from "../session-manager";
import { createTempEnv } from "./fixtures/temp-lifecycle";
import { commitFile, createTempGitRepo, gitRun } from "./fixtures/temp-git-repo";

function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { encoding: "utf-8" });
		return true;
	} catch {
		return false;
	}
}

const GIT_OK = gitAvailable();
const WORK = "brl-subagent-clean001";

/** The production wiring of the table's deps, with owner liveness overridable. */
function realDeps(over: Partial<HeadStateDeps> = {}): HeadStateDeps {
	return {
		getRepoRoot,
		getHeadBranch,
		restoreHead,
		hasUncommittedChanges,
		listWorkBranches,
		classifyOwner: () => "dead",
		...over,
	};
}

/** A record as the spawn would have left it, for a repository on `main`. */
function planted(repoRoot: string, baseSha: string, workBranch: string = WORK): HeadStateRecord {
	return {
		version: HEAD_STATE_VERSION,
		repoRoot,
		runId: "run-planted",
		kind: "background",
		base: { sha: baseSha, branch: "main", detached: false },
		workBranch,
		owner: { pid: 999_999, start: "0" },
		createdAt: new Date().toISOString(),
	};
}

const fakePi = { appendEntry: vi.fn() };

describe.skipIf(!GIT_OK)("reconcileHeadStates against real git", () => {
	const env = createTempEnv("brl-headstate-git");
	const repos: string[] = [];

	async function newRepo(): Promise<{ repo: string; baseSha: string }> {
		const repo = await createTempGitRepo("brl-hs-");
		repos.push(repo);
		return { repo, baseSha: gitRun(repo, ["rev-parse", "HEAD"]) };
	}

	beforeEach(() => env.setUp());
	afterAll(async () => {
		await Promise.all(repos.map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("restores a clean orphan and KEEPS the branch with its commit (P4R, M8)", async () => {
		const { repo, baseSha } = await newRepo();
		gitRun(repo, ["checkout", "-q", "-b", WORK]);
		await commitFile(repo, "work.txt", "run work\n", "run work");
		writeHeadState(planted(repo, baseSha));

		const [outcome] = reconcileHeadStates(realDeps());
		expect(outcome).toMatchObject({ verdict: "restore", workBranch: WORK });
		expect(getCurrentBranch(repo)).toBe("main");
		// D3: the branch is the only copy of the work — never deleted.
		expect(listWorkBranches(repo)).toEqual([WORK]);
		expect(gitRun(repo, ["log", "-1", "--format=%s", WORK])).toBe("run work");
		expect(readHeadState(repo).state).toBe("absent");
	});

	it("leaves a dirty orphan untouched and keeps its record (P11 F2, M6)", async () => {
		const { repo, baseSha } = await newRepo();
		gitRun(repo, ["checkout", "-q", "-b", WORK]);
		await writeFile(join(repo, "wip.txt"), "uncommitted\n");
		writeHeadState(planted(repo, baseSha));

		expect(reconcileHeadStates(realDeps())[0].verdict).toBe("needs-manual");
		expect(getCurrentBranch(repo)).toBe(WORK);
		expect(hasUncommittedChanges(repo)).toBe(true);
		expect(readHeadState(repo).state).toBe("ok");
	});

	it("never switches a tree that was moved by hand (P11 F3, M7)", async () => {
		const { repo, baseSha } = await newRepo();
		gitRun(repo, ["checkout", "-q", "-b", "someone-elses-branch"]);
		writeHeadState(planted(repo, baseSha));

		expect(reconcileHeadStates(realDeps())[0].verdict).toBe("already-off");
		expect(getCurrentBranch(repo)).toBe("someone-elses-branch");
		expect(readHeadState(repo).state).toBe("absent");
	});

	it("restores an unborn HEAD — the branch was deleted while checked out (P11 F4a, M13)", async () => {
		const { repo, baseSha } = await newRepo();
		gitRun(repo, ["checkout", "-q", "-b", WORK]);
		gitRun(repo, ["update-ref", "-d", `refs/heads/${WORK}`]);
		// The state the dirty row must NOT gate: `status` calls the missing tree "dirty".
		expect(getHeadBranch(repo)).toEqual({ branch: WORK, unborn: true });
		expect(hasUncommittedChanges(repo)).toBe(true);
		writeHeadState(planted(repo, baseSha));

		expect(reconcileHeadStates(realDeps())[0].verdict).toBe("no-branch");
		expect(getCurrentBranch(repo)).toBe("main");
		expect(hasUncommittedChanges(repo)).toBe(false);
	});

	it("never touches a record whose owner is alive (P11 F5, M5)", async () => {
		const { repo, baseSha } = await newRepo();
		gitRun(repo, ["checkout", "-q", "-b", WORK]);
		writeHeadState({ ...planted(repo, baseSha), owner: currentProcessOwner() });
		const deps = realDeps({ classifyOwner: (owner) => classifyOwner(owner, defaultRecoveryDeps()) });

		expect(reconcileHeadStates(deps)[0].verdict).toBe("skip-owner");
		expect(getCurrentBranch(repo)).toBe(WORK);
		expect(readHeadState(repo).state).toBe("ok");
	});
});

describe.skipIf(!GIT_OK)("the spawn's durable record (M1, M10)", () => {
	const env = createTempEnv("brl-headstate-spawn");
	const repos: string[] = [];
	let repoA: string;

	function fakeCtx(cwd: string) {
		return { cwd, modelRegistry: { find: vi.fn() }, hasUI: false };
	}

	beforeAll(async () => {
		repoA = await createTempGitRepo("brl-hs-a-");
		repos.push(repoA);
	});
	beforeEach(() => {
		env.setUp();
		vi.useFakeTimers();
		// The run never settles: the record is observable while it is live.
		session.prompt.mockImplementation(() => new Promise<void>(() => {}));
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});
	afterAll(async () => {
		await env.tearDown();
		await Promise.all(repos.map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("clears the record once the run has settled off the branch", async () => {
		session.prompt.mockImplementationOnce(async () => {});
		await spawnBackgroundSession(fakePi as never, fakeCtx(repoA) as never, {
			task: "head-state probe",
			gitMode: "branch",
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(readHeadState(repoA).state).toBe("absent");
	});

	it("names the branch it created, and the base it started from", async () => {
		const repo = await createTempGitRepo("brl-hs-b-");
		repos.push(repo);
		const baseSha = gitRun(repo, ["rev-parse", "HEAD"]);

		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx(repo) as never, {
			task: "head-state probe",
			gitMode: "branch",
		});

		const read = readHeadState(repo);
		expect(read.state).toBe("ok");
		if (read.state !== "ok") return;
		expect(read.record.workBranch).toBe(getCurrentBranch(repo));
		expect(read.record.base).toMatchObject({ branch: "main", sha: baseSha, detached: false });
		expect(read.record).toMatchObject({ kind: "background", runId: agent.id, repoRoot: getRepoRoot(repo) });
	});

	it("keys the record on the DISPATCHED repo, not on process.cwd() (M10)", async () => {
		await spawnBackgroundSession(fakePi as never, fakeCtx(repoA) as never, {
			task: "head-state probe",
			gitMode: "branch",
		});
		expect(readHeadState(repoA).state).toBe("ok");
		expect(readHeadState(process.cwd()).state).toBe("absent");
	});
});
