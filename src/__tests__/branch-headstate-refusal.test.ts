/**
 * Issue #466 (ADR 0026 D4) — the pre-flight refusal for an unresolved head state.
 *
 * A branch dispatch in a repository whose durable record is still unresolved and
 * whose owner is NOT alive must refuse BEFORE the dirty check, name the work
 * branch, the recorded base and the exact repair commands, and end as the same
 * terminal failure every other refused spawn ends as (`updateAgentStatus` →
 * `finalizeRunEntry` → `completeTranscript` → throw, the #465 shape).
 *
 * Git is mocked here: the refusal is a decision about the RECORD and the process
 * table, and it must happen before any git command runs. The real-git half of
 * the contract lives in `headstate-git.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

const h = vi.hoisted(() => ({
	git: {
		getCurrentBranch: vi.fn(() => "brl-subagent-ref00001"),
		getHeadState: vi.fn(() => ({ sha: "base123", detached: false, branch: "main" })),
		createWorkBranch: vi.fn(() => ({ ok: true, branch: "brl-subagent-ref00001" })),
		newWorkBranchName: vi.fn(() => "brl-subagent-ref00001"),
		captureDiff: vi.fn(() => ({ ok: true, diff: "" })),
		restoreHead: vi.fn(() => ({ ok: true })),
		deleteBranch: vi.fn(() => ({ ok: true })),
		hasUncommittedChanges: vi.fn(() => false),
		getRepoRoot: vi.fn(),
		commitAll: vi.fn(),
		captureWorkingDiff: vi.fn(() => ""),
	},
	prompt: vi.fn(),
	abort: vi.fn(),
	session: {
		sessionId: "refusal-session",
		setSessionName: vi.fn(),
		messages: [] as unknown[],
	},
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
	class DefaultResourceLoader {
		reload = vi.fn().mockResolvedValue(undefined);
	}
	return {
		getAgentDir: () => "/tmp/brl-test-agentdir",
		createAgentSession: async () => ({
			session: { ...h.session, prompt: h.prompt, abort: h.abort },
		}),
		SessionManager: { create: () => ({ getSessionFile: () => undefined }) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader,
	};
});

vi.mock("../git", () => ({
	getCurrentBranch: h.git.getCurrentBranch,
	getHeadState: h.git.getHeadState,
	createWorkBranch: h.git.createWorkBranch,
	newWorkBranchName: h.git.newWorkBranchName,
	captureDiff: h.git.captureDiff,
	restoreHead: h.git.restoreHead,
	deleteBranch: h.git.deleteBranch,
	hasUncommittedChanges: h.git.hasUncommittedChanges,
	getRepoRoot: h.git.getRepoRoot,
	commitAll: h.git.commitAll,
	captureWorkingDiff: h.git.captureWorkingDiff,
}));

import { HEAD_STATE_VERSION, readHeadState, writeHeadState, type HeadStateRecord } from "../headstate";
import { currentProcessOwner } from "../recovery";
import { CUSTOM_ENTRY_TYPES } from "../types";
import { backgroundSessionDir, listPersistedAgents, spawnBackgroundSession } from "../session-manager";
import { createTempEnv } from "./fixtures/temp-lifecycle";

const WORK = "brl-subagent-ref00001";
const DEAD_OWNER = { pid: 999_999, start: "0" };

const fakePi = { appendEntry: vi.fn() };

describe("the pre-flight head-state refusal (#466 D4)", () => {
	const env = createTempEnv("brl-headstate-refuse");
	const ctx = () => ({ cwd: env.testCwd, modelRegistry: { find: vi.fn() }, hasUI: false });
	let repoRoot: string;

	function planted(over: Partial<HeadStateRecord> = {}): HeadStateRecord {
		return {
			version: HEAD_STATE_VERSION,
			repoRoot,
			runId: "run-interrupted",
			kind: "background",
			base: { sha: "base123", branch: "main", detached: false },
			workBranch: WORK,
			owner: DEAD_OWNER,
			createdAt: new Date().toISOString(),
			...over,
		};
	}

	async function spawn(): Promise<Error | undefined> {
		return spawnBackgroundSession(fakePi as never, ctx() as never, {
			task: "refusal probe",
			gitMode: "branch",
		}).then(
			() => undefined,
			(e: Error) => e,
		);
	}

	beforeEach(() => {
		env.setUp();
		vi.useFakeTimers();
		fakePi.appendEntry.mockClear();
		// The run never settles, so "proceeded past the guard" is observable.
		h.prompt.mockImplementation(() => new Promise<void>(() => {}));
		// Git is mocked: the record is keyed on the cwd the dispatch names.
		repoRoot = env.testCwd;
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("refuses before the dirty check, naming the work branch, the base and the commands (M11)", async () => {
		writeHeadState(planted());
		const error = await spawn();
		expect(error?.message).toContain(WORK);
		expect(error?.message).toContain("main");
		expect(error?.message).toContain("git stash push -u");
		expect(error?.message).toContain("git checkout main");
		// The refusal precedes EVERY git command — including the dirty check.
		expect(h.git.hasUncommittedChanges).not.toHaveBeenCalled();
		expect(h.git.createWorkBranch).not.toHaveBeenCalled();
		expect(h.prompt).not.toHaveBeenCalled();
		// The record is the only copy of the base: the refusal keeps it.
		expect(readHeadState(repoRoot).state).toBe("ok");
	});

	it("ends the refused dispatch failed exactly once, with its session dir pruned", async () => {
		writeHeadState(planted());
		await spawn();
		const agents = listPersistedAgents();
		expect(agents).toHaveLength(1);
		expect(agents[0].status).toBe("failed");
		expect(agents[0].error).toContain("unresolved branch-run state");
		expect(existsSync(backgroundSessionDir(agents[0].id))).toBe(false);
		const runs = fakePi.appendEntry.mock.calls
			.filter((call) => call[0] === CUSTOM_ENTRY_TYPES.run)
			.map((call) => call[1] as { status: string });
		expect(runs.filter((run) => run.status === "failed")).toHaveLength(1);
		// The terminal record is the LAST one, so every reader (which prefers the
		// last entry) classifies the refused dispatch as failed, not running.
		expect(runs[runs.length - 1].status).toBe("failed");
	});

	it("does not refuse a record whose owner is alive (M12)", async () => {
		writeHeadState(planted({ owner: currentProcessOwner() }));
		expect(await spawn()).toBeUndefined();
		expect(h.prompt).toHaveBeenCalledTimes(1);
	});

	it("does not refuse once the record is cleared", async () => {
		expect(await spawn()).toBeUndefined();
		expect(h.prompt).toHaveBeenCalledTimes(1);
	});
});
