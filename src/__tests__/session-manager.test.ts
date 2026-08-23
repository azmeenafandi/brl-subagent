import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mocks must exist before vi.mock factory runs (hoisted).
const mocks = vi.hoisted(() => ({
	createAgentSession: vi.fn(),
	git: {
		getCurrentBranch: vi.fn(),
		createWorkBranch: vi.fn(),
		captureDiff: vi.fn(),
		switchToBranch: vi.fn(),
		deleteBranch: vi.fn(),
		hasUncommittedChanges: vi.fn(),
		commitAll: vi.fn(),
		captureWorkingDiff: vi.fn(),
	},
	session: {
		sessionId: "test-session",
		setSessionName: vi.fn(),
		prompt: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn().mockResolvedValue(undefined),
	},
}));

// Track whether reload() has been called at the moment createAgentSession runs,
// so the ordering property (reload BEFORE createAgentSession) is pinned — the
// SDK returns [] from getAppendSystemPrompt until reload() runs.
let reloadCalledAtCreateTime: boolean;

// Shared reload mock so tests can make reload reject on the loader instance
// created INSIDE spawnBackgroundSession (each call constructs its own).
const reloadImpl = vi.hoisted(() => ({
	reload: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
	class MockDefaultResourceLoader {
		options: Record<string, unknown>;
		reload = reloadImpl.reload;
		constructor(options: Record<string, unknown>) {
			this.options = options;
		}
	}
	return {
		getAgentDir: () => "/tmp/brl-test-agentdir",
		createAgentSession: mocks.createAgentSession,
		SessionManager: { inMemory: () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: MockDefaultResourceLoader,
	};
});

// W4: mock the git module so branch lifecycle tests never touch a real repo.
vi.mock("../git", () => ({
	getCurrentBranch: mocks.git.getCurrentBranch,
	createWorkBranch: mocks.git.createWorkBranch,
	captureDiff: mocks.git.captureDiff,
	switchToBranch: mocks.git.switchToBranch,
	deleteBranch: mocks.git.deleteBranch,
	hasUncommittedChanges: mocks.git.hasUncommittedChanges,
	commitAll: mocks.git.commitAll,
	captureWorkingDiff: mocks.git.captureWorkingDiff,
}));

// Issue #53: mock the event bus so a test can force a throw inside the settle
// handlers. The REAL event-bus swallows listener errors (emit never throws),
// so the defensive try/catch around the .then/.catch bodies can only be
// exercised with a throwing emit mock.
const eventBusMock = vi.hoisted(() => ({
	emit: vi.fn(),
	createEvent: vi.fn(
		(type: string, agentId: string, data: Record<string, unknown> = {}) => ({
			type,
			agentId,
			timestamp: Date.now(),
			data,
		})
	),
}));

vi.mock("../event-bus", () => ({
	emit: eventBusMock.emit,
	createEvent: eventBusMock.createEvent,
}));

import { spawnBackgroundSession, getAgent, getTranscriptPath, steerAgent, updateAgentStatus, __setStorageDir } from "../session-manager";
import { getTranscriptPath as transcriptGetTranscriptPath, __setOutputDir } from "../transcript";
import { CUSTOM_ENTRY_TYPES } from "../types";

// Issue #98: spawnBackgroundSession persists session run entries via
// pi.appendEntry (same store the foreground path writes to).
const fakePi = { appendEntry: vi.fn() };
const fakeCtx = {
	cwd: "/tmp/brl-test-cwd",
	modelRegistry: {
		find: vi.fn().mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5" }),
	},
};

// Issue #52: isolate EVERY test from the real repo .pi/ — the agent-record
// storage dir and the transcript output dir are redirected to throwaway temp
// dirs (fresh per test). The __set* setters reach the SAME module instance the
// tests drive (static imports + vitest module cache), so the hanging-prompt
// mocks can no longer leave zombie 'running' records in the repo .pi/subagents.
let tempPiBase = ""; // <tmpdir>/brl-session-test-XXXX, fresh per test
let tempStorageDir = ""; // <tempPiBase>/subagents — mirrors .pi/subagents
let tempOutputDir = ""; // <tempPiBase>/output — mirrors .pi/output

beforeEach(() => {
	// Remove the PREVIOUS test's base (the last one is removed in afterAll) so
	// temp dirs don't accumulate across the file's ~50 spawn tests.
	if (tempPiBase) rmSync(tempPiBase, { recursive: true, force: true });
	tempPiBase = mkdtempSync(join(tmpdir(), "brl-session-test-"));
	tempStorageDir = join(tempPiBase, "subagents");
	tempOutputDir = join(tempPiBase, "output");
	__setStorageDir(tempStorageDir);
	__setOutputDir(tempOutputDir);
	fakePi.appendEntry.mockClear();
});

afterAll(() => {
	if (tempPiBase) rmSync(tempPiBase, { recursive: true, force: true });
});

beforeEach(() => {
	mocks.createAgentSession.mockReset();
	mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => {
		// Capture ordering at the exact moment createAgentSession is invoked.
		const loader = options.resourceLoader as { reload?: ReturnType<typeof vi.fn> } | undefined;
		reloadCalledAtCreateTime = loader?.reload?.mock.calls.length > 0;
		return { session: mocks.session };
	});
	mocks.session.prompt.mockClear();
	mocks.session.setSessionName.mockClear();
	(fakeCtx.modelRegistry.find as ReturnType<typeof vi.fn>).mockClear();
	reloadImpl.reload.mockReset();
	reloadImpl.reload.mockResolvedValue(undefined);
	eventBusMock.emit.mockReset();
	eventBusMock.emit.mockImplementation(() => {});
});

// The per-repo git lock (C2) is held for the agent's lifetime; tests that
// never settle would leak it into the next test — release before each test.
beforeEach(async () => {
	const { __testResetGitBranchLocks } = await import("../session-manager");
	__testResetGitBranchLocks();
});

describe("spawnBackgroundSession systemPrompt injection", () => {
	it("passes systemPrompt via DefaultResourceLoader.appendSystemPrompt", async () => {
		const systemPrompt = "## Preset Guidance\n\nFor security audits.";
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "do the thing",
			systemPrompt,
		});

		expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
		const options = mocks.createAgentSession.mock.calls[0][0];
		expect(options.resourceLoader).toBeDefined();
		// F26: the prompt is wrapped in a marker frame. The "/" in
		// "</system-prompt>" forces a multi-component relative path (never a
		// single-component name like ".env"), and SUBAGENT_INSTRUCTIONS makes
		// one component exceed NAME_MAX — so resolvePromptInput's existsSync
		// can never match. Literal content is preserved inside the frame.
		expect(options.resourceLoader.options.appendSystemPrompt).toEqual([
			"\n<system-prompt>\n## Preset Guidance\n\nFor security audits.\n</system-prompt>\n",
		]);
		// F25: the loader must never import extension/skill code from the
		// target cwd — it is LLM-controlled and untrusted.
		expect(options.resourceLoader.options.noExtensions).toBe(true);
		expect(options.resourceLoader.options.noSkills).toBe(true);
		// Ordering is the critical property: the SDK returns [] from
		// getAppendSystemPrompt until reload() runs, so reload MUST have
		// completed before createAgentSession was invoked.
		expect(reloadCalledAtCreateTime).toBe(true);
	});

	it("a path-looking systemPrompt is NOT read as a file (F26 security property)", async () => {
		// Behavioral test: simulate the real SDK's resolvePromptInput
		// (existsSync → readFileSync) against a planted .env in the cwd.
		// Pre-fix, systemPrompt: ".env" would resolve to the file contents;
		// post-fix the wrapped value must resolve to the literal.
		const fs = require("node:fs") as typeof import("node:fs");
		const path = require("node:path") as typeof import("node:path");
		const envFile = path.join(process.cwd(), ".env");
		fs.writeFileSync(envFile, "SECRET=planted-file-content", "utf-8");
		try {
			await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "do the thing",
				systemPrompt: ".env",
			});

			const options = mocks.createAgentSession.mock.calls[0][0];
			const wrapped = options.resourceLoader.options.appendSystemPrompt[0] as string;
			// Simulate the SDK's resolvePromptInput on the wrapped value:
			// if existsSync is true it would readFileSync and substitute.
			const resolved = fs.existsSync(wrapped)
				? fs.readFileSync(wrapped, "utf-8")
				: wrapped;
			expect(resolved).toBe("\n<system-prompt>\n.env\n</system-prompt>\n");
			expect(resolved).not.toContain("planted-file-content");
		} finally {
			try { fs.unlinkSync(envFile); } catch { /* ok */ }
		}
	});

	it("still passes a resourceLoader when systemPrompt is empty (F25)", async () => {
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "do the thing",
			systemPrompt: "",
		});

		expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
		const options = mocks.createAgentSession.mock.calls[0][0];
		// F25: ALWAYS pass our own loader. If resourceLoader were undefined,
		// createAgentSession would build its own DefaultResourceLoader and
		// import extensions/skills from the untrusted target cwd (RCE).
		expect(options.resourceLoader).toBeDefined();
		expect(options.resourceLoader.options.appendSystemPrompt).toBeUndefined();
		expect(options.resourceLoader.options.noExtensions).toBe(true);
		expect(options.resourceLoader.options.noSkills).toBe(true);
	});

	it("still passes a resourceLoader when systemPrompt is only whitespace (F25)", async () => {
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "do the thing",
			systemPrompt: "   \n\t ",
		});

		const options = mocks.createAgentSession.mock.calls[0][0];
		expect(options.resourceLoader).toBeDefined();
		expect(options.resourceLoader.options.appendSystemPrompt).toBeUndefined();
		expect(options.resourceLoader.options.noExtensions).toBe(true);
		expect(options.resourceLoader.options.noSkills).toBe(true);
	});

	it("never loads extensions or skills from the target cwd (F25)", async () => {
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "do the thing",
			systemPrompt: "audit this",
		});

		const options = mocks.createAgentSession.mock.calls[0][0];
		expect(options.resourceLoader.options.noExtensions).toBe(true);
		expect(options.resourceLoader.options.noSkills).toBe(true);
	});

	it("calls session.prompt with the task wrapped in the data fence (F27)", async () => {
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "do the thing",
		});

		expect(mocks.session.prompt).toHaveBeenCalledTimes(1);
		// F27: the task is wrapped in <task>...</task> — the user message is
		// DATA, not instructions, so injected text can't hijack the subagent.
		expect(mocks.session.prompt).toHaveBeenCalledWith(
			"<task>\ndo the thing\n</task>",
		);
	});

	describe("model resolution", () => {
		it("resolves the model string to a Model object via the registry", async () => {
			await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "do the thing",
				model: "anthropic/claude-sonnet-4-5",
			});

			expect(fakeCtx.modelRegistry.find).toHaveBeenCalledWith(
				"anthropic",
				"claude-sonnet-4-5",
			);
			const options = mocks.createAgentSession.mock.calls[0][0];
			expect(options.model).toEqual({
				provider: "anthropic",
				id: "claude-sonnet-4-5",
			});
		});

		it("passes no model when none given (SDK falls back to findInitialModel)", async () => {
			await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "do the thing",
			});

			expect(fakeCtx.modelRegistry.find).not.toHaveBeenCalled();
			const options = mocks.createAgentSession.mock.calls[0][0];
			expect(options.model).toBeUndefined();
		});

		it("passes no model when the string has no slash separator", async () => {
			await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "do the thing",
				model: "not-a-provider-model-string",
			});

			expect(fakeCtx.modelRegistry.find).not.toHaveBeenCalled();
			const options = mocks.createAgentSession.mock.calls[0][0];
			expect(options.model).toBeUndefined();
		});
	});

	describe("thinkingLevel forwarding", () => {
		it("passes thinkingLevel to createAgentSession", async () => {
			await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "do the thing",
				thinkingLevel: "high",
			});

			const options = mocks.createAgentSession.mock.calls[0][0];
			expect(options.thinkingLevel).toBe("high");
		});
	});

	describe("toolOptions forwarding (background honors restrictions)", () => {
		it("passes the tools allowlist to createAgentSession", async () => {
			await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "do the thing",
				toolOptions: { tools: ["read", "grep", "find", "ls"] },
			});

			const options = mocks.createAgentSession.mock.calls[0][0];
			expect(options.tools).toEqual(["read", "grep", "find", "ls"]);
		});

		it("passes excludeTools to createAgentSession", async () => {
			await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "do the thing",
				toolOptions: { excludeTools: ["write", "edit", "bash"] },
			});

			const options = mocks.createAgentSession.mock.calls[0][0];
			expect(options.excludeTools).toEqual(["write", "edit", "bash"]);
		});

		it("passes noTools: 'builtin' when noBuiltinTools is set", async () => {
			await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "do the thing",
				toolOptions: { noBuiltinTools: true },
			});

			const options = mocks.createAgentSession.mock.calls[0][0];
			expect(options.noTools).toBe("builtin");
		});

		it("defaults to the full toolset when no toolOptions are given", async () => {
			await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "do the thing",
			});

			const options = mocks.createAgentSession.mock.calls[0][0];
			expect(options.tools).toEqual(["read", "bash", "grep", "find", "ls", "write", "edit"]);
			expect(options.excludeTools).toBeUndefined();
			expect(options.noTools).toBeUndefined();
		});
	});

	describe("loader.reload failure", () => {
		it("propagates the error out of spawnBackgroundSession", async () => {
			// Make reload reject — the failure must surface, not hang.
			reloadImpl.reload.mockRejectedValueOnce(new Error("reload exploded"));

			await expect(
				spawnBackgroundSession(fakePi as never, fakeCtx as never, {
					task: "do the thing",
					systemPrompt: "some prompt",
				}),
			).rejects.toThrow("reload exploded");
		});
	});
});

describe("agent id validation (F24)", () => {
	const VALID_UUID = "05b8b0d9-4a1e-4f2a-9c3d-6e7f8a9b0c1d";
	// Separate id for the attack-chain test: steerAgent keeps an in-memory map
	// entry keyed by the VALID lookup id, which would pollute other tests.
	const ATTACK_UUID = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

	// Clean up any planted records/transcripts/escape targets between tests so
	// a failed run can't leak state into the next test. All paths live in the
	// per-test temp dirs (issue #52) — never in the real repo .pi/.
	const cleanupF24 = () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const path = require("node:path") as typeof import("node:path");
		for (const id of [VALID_UUID, ATTACK_UUID]) {
			for (const p of [
				path.join(tempStorageDir, `${id}.json`),
				path.join(tempOutputDir, `agent-${id}.jsonl`),
			]) {
				try { fs.unlinkSync(p); } catch { /* ok */ }
			}
		}
		try { fs.unlinkSync(path.join(tempPiBase, "..", "brl-persist-bypass-test.json")); } catch { /* ok */ }
	};

	beforeEach(cleanupF24);
	afterEach(cleanupF24);

	it("getAgent returns null for a path-traversal id without touching the fs", () => {
		// A traversal id must never reach loadAgent()'s join(STORAGE_DIR, id+'.json').
		expect(getAgent("../../etc/passwd")).toBeNull();
	});

	it("getAgent returns null for an absolute-path id", () => {
		expect(getAgent("/tmp/foo")).toBeNull();
	});

	it("getAgent returns null for a non-uuid id", () => {
		expect(getAgent("foo")).toBeNull();
	});

	it("getAgent accepts a valid uuid (no throw; just not found)", () => {
		expect(getAgent(VALID_UUID)).toBeNull();
	});

	it("updateAgentStatus returns null for a traversal id (via getAgent)", () => {
		expect(updateAgentStatus("../../etc/passwd", "running")).toBeNull();
	});

	it("steerAgent returns null for a traversal id (via getAgent)", () => {
		expect(steerAgent("../../etc/passwd", "hi")).toBeNull();
	});

	it("getTranscriptPath throws for a traversal id", () => {
		expect(() => getTranscriptPath("../../etc/passwd")).toThrow();
	});

	it("getTranscriptPath throws for an absolute path", () => {
		expect(() => getTranscriptPath("/tmp/foo")).toThrow();
	});

	it("getTranscriptPath accepts a valid uuid", () => {
		expect(() => getTranscriptPath(VALID_UUID)).not.toThrow();
	});

	it("transcript.getTranscriptPath throws for a traversal id", () => {
		expect(() => transcriptGetTranscriptPath("../../etc/passwd")).toThrow();
	});

	it("persistAgent refuses a planted record with a traversal id (F24 indirection bypass)", () => {
		// Attack chain from the review: plant a record with a valid-UUID filename
		// but a traversal id FIELD, then steer it — getAgent passes the UUID
		// check, loadAgent returns the crafted record, and persistAgent would
		// write via join(STORAGE_DIR, agent.id) outside the storage dir.
		const fs = require("node:fs") as typeof import("node:fs");
		const path = require("node:path") as typeof import("node:path");
		const plantDir = tempStorageDir;
		const transcriptDir = tempOutputDir;
		fs.mkdirSync(plantDir, { recursive: true });
		fs.mkdirSync(transcriptDir, { recursive: true });
		const planted = path.join(plantDir, `${ATTACK_UUID}.json`);
		// The traversal id "../../brl-persist-bypass-test" from a two-level-deep
		// storage dir (tempPiBase/subagents) resolves to tempPiBase/.. (the OS
		// tmp dir) — exactly where a regression would land the file.
		const escapeTarget = path.join(
			tempPiBase,
			"..",
			"brl-persist-bypass-test.json",
		);
		// steerAgent requires the transcript to exist (appendEntry throws otherwise)
		fs.writeFileSync(
			path.join(transcriptDir, `agent-${ATTACK_UUID}.jsonl`),
			"",
			"utf-8",
		);

		fs.writeFileSync(
			planted,
			JSON.stringify({
				id: "../../brl-persist-bypass-test", // traversal id field
				status: "running",
				task: "planted",
				startedAt: Date.now(),
			}),
			"utf-8",
		);

		const result = steerAgent(ATTACK_UUID, "hi");
		expect(result).not.toBeNull(); // getAgent accepted the valid UUID
		expect(fs.existsSync(escapeTarget)).toBe(false); // NO write outside the storage dir
	});

	it("persistAgent still writes valid records (regression guard)", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const path = require("node:path") as typeof import("node:path");
		const plantDir = tempStorageDir;
		const transcriptDir = tempOutputDir;
		fs.mkdirSync(plantDir, { recursive: true });
		fs.mkdirSync(transcriptDir, { recursive: true });
		const planted = path.join(plantDir, `${VALID_UUID}.json`);
		fs.writeFileSync(
			path.join(transcriptDir, `agent-${VALID_UUID}.jsonl`),
			"",
			"utf-8",
		);
		fs.writeFileSync(
			planted,
			JSON.stringify({ id: VALID_UUID, status: "running", task: "ok", startedAt: Date.now() }),
			"utf-8",
		);

		steerAgent(VALID_UUID, "hi");
		const persisted = JSON.parse(fs.readFileSync(planted, "utf-8"));
		expect(persisted.status).toBe("steered"); // valid record persisted normally
	});
});

describe("stopAgent — real abort (issue #28 W1)", () => {
	const VALID_UUID = "c7d8e9f0-1a2b-3c4d-5e6f-7a8b9c0d1e2f";

	it("aborts the session ref and marks the agent stopped", async () => {
		const abort = vi.fn().mockResolvedValue(undefined);
		// A never-resolving prompt keeps the agent 'running' (real sessions
		// stay running until the LLM turn settles).
		mocks.session.prompt.mockReturnValue(new Promise(() => {}));
		const { spawnBackgroundSession, stopAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test stop",
		});
		agent._sessionRef = { abort } as never;

		const result = await stopAgent(agent.id);

		expect(result?.status).toBe("stopped");
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("does not call abort for an already-completed agent", async () => {
		const { spawnBackgroundSession, stopAgent, updateAgentStatus } = await import("../session-manager");
		mocks.session.prompt.mockResolvedValue(undefined);
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test stop completed",
		});
		await new Promise((r) => setTimeout(r, 0));
		updateAgentStatus(agent.id, "completed");

		const abort = vi.fn().mockResolvedValue(undefined);
		agent._sessionRef = { abort } as never;
		const result = await stopAgent(agent.id);

		expect(result?.status).toBe("completed");
		expect(abort).not.toHaveBeenCalled();
	});

	it("returns null for an unknown id", async () => {
		const { stopAgent } = await import("../session-manager");
		expect(await stopAgent("00000000-0000-0000-0000-000000000000")).toBeNull();
	});

	it("returns null for a traversal id", async () => {
		const { stopAgent } = await import("../session-manager");
		expect(await stopAgent("../../etc/passwd")).toBeNull();
	});
});

describe("spawnBackgroundSession .then abort discrimination (probe contract)", () => {
	const VALID_UUID = "1f2e3d4c-5b6a-7f8e-9d0c-1b2a3f4e5d6c";

	it("marks agent stopped (not completed) when prompt resolves with an aborted run", async () => {
		// Probe contract: abort makes prompt() RESOLVE with the failure message
		// carrying stopReason "aborted" on the last assistant message.
		mocks.session.prompt.mockResolvedValue(undefined);
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Aborted" },
		];
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test aborted run",
		});
		// Let the .then run.
		await new Promise((r) => setTimeout(r, 0));

		const after = getAgent(agent.id);
		expect(after?.status).toBe("stopped");
		expect(after?.completedAt).toBeDefined();
	});

	it("marks agent stopped when stopAgent pre-set status before abort", async () => {
		// stopAgent sets 'stopped' FIRST, then abort() resolves the run — the
		// .then must not overwrite it with 'completed'. The prompt stays
		// pending until the abort settles, like a real mid-run stop.
		let resolvePrompt: () => void = () => {};
		mocks.session.prompt.mockReturnValue(new Promise<void>((r) => { resolvePrompt = r; }));
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "stop" },
		];
		const { spawnBackgroundSession, getAgent, stopAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test pre-stopped",
		});
		// stopAgent: flips status to stopped, then aborts the session — the
		// abort settles the run, which resolves the pending prompt.
		const abort = vi.fn().mockImplementation(async () => { resolvePrompt(); });
		agent._sessionRef = { abort } as never;
		await stopAgent(agent.id);
		// Let the .then fire after the abort settles.
		await new Promise((r) => setTimeout(r, 0));

		const after = getAgent(agent.id);
		expect(after?.status).toBe("stopped");
		expect(abort).toHaveBeenCalledTimes(1);
	});
});

function resetGitMocks() {
	mocks.git.getCurrentBranch.mockReset();
	mocks.git.createWorkBranch.mockReset();
	mocks.git.captureDiff.mockReset();
	mocks.git.switchToBranch.mockReset();
	mocks.git.deleteBranch.mockReset();
	mocks.git.hasUncommittedChanges.mockReset();
	mocks.git.commitAll.mockReset();
	mocks.git.captureWorkingDiff.mockReset();
	// Setup reads the base branch; the cleanup concurrency guard reads the
	// current branch and expects it to still be the work branch.
	mocks.git.getCurrentBranch
		.mockReturnValueOnce("main")       // setup: base
		.mockReturnValue("brl-subagent-abc12345"); // cleanup: still on ours
	mocks.git.createWorkBranch.mockReturnValue({ ok: true, branch: "brl-subagent-abc12345" });
	mocks.git.captureDiff.mockReturnValue({ ok: true, diff: "diff --git a/x.ts b/x.ts" });
	mocks.git.switchToBranch.mockReturnValue({ ok: true });
	mocks.git.deleteBranch.mockReturnValue({ ok: true });
	// C1: base tree clean at setup; agent dirt exists at teardown.
	mocks.git.hasUncommittedChanges
		.mockReturnValueOnce(false)         // setup: clean tree
		.mockReturnValue(true);             // teardown: agent dirt to commit
	mocks.git.commitAll.mockReturnValue({ ok: true, sha: "abc123" });
	mocks.git.captureWorkingDiff.mockReturnValue("diff --git a/y.ts b/y.ts");
}

describe("spawnBackgroundSession per-agent timeout (issue #28 W3)", () => {
	const VALID_UUID = "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d";

	it("aborts the session and marks stopped after the deadline", async () => {
		vi.useFakeTimers();
		try {
			// A never-resolving prompt keeps the agent 'running' past the deadline.
			mocks.session.prompt.mockReturnValue(new Promise(() => {}));
			mocks.session.abort.mockClear();
			const { spawnBackgroundSession, getAgent } = await import("../session-manager");
			const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "test timeout",
				timeout: 5000,
			});

			// Advance past the deadline — the timer fires, flips status, aborts.
			await vi.advanceTimersByTimeAsync(5001);

			expect(mocks.session.abort).toHaveBeenCalledTimes(1);
			const after = getAgent(agent.id);
			expect(after?.status).toBe("stopped");
			expect(after?.error).toContain("Timed out after 5000ms");
			expect(after?.completedAt).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not abort when the agent completes before the deadline", async () => {
		vi.useFakeTimers();
		try {
			mocks.session.prompt.mockResolvedValue(undefined);
			mocks.session.messages = [
				{ role: "user", content: "probe task" },
				{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
			];
			mocks.session.abort.mockClear();
			const { spawnBackgroundSession, getAgent } = await import("../session-manager");
			const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "test completes in time",
				timeout: 5000,
			});

			// Let the prompt settle (completed), then pass the deadline.
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(5001);

			const after = getAgent(agent.id);
			expect(after?.status).toBe("completed");
			expect(mocks.session.abort).not.toHaveBeenCalled();
			// M2: the timeout handle must actually be CLEARED, not just guarded
			// by completedAt — a leaked timer would fire on a future spawn.
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("ignores a zero/undefined timeout (no timer armed)", async () => {
		vi.useFakeTimers();
		try {
			mocks.session.prompt.mockReturnValue(new Promise(() => {}));
			mocks.session.abort.mockClear();
			const { spawnBackgroundSession } = await import("../session-manager");
			await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "test no timeout",
				timeout: 0,
			});

			await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

			expect(mocks.session.abort).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clamps an oversized timeout to the 30min hard cap (m1)", async () => {
		vi.useFakeTimers();
		try {
			mocks.session.prompt.mockReturnValue(new Promise(() => {}));
			mocks.session.abort.mockClear();
			const { spawnBackgroundSession, getAgent } = await import("../session-manager");
			const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "test oversized timeout",
				// Direct spawnBackgroundSession call (no resolveSubagentParams):
				// a raw overflow value must not become an instant kill.
				timeout: 2 ** 31,
			});
			// Clamped to 30min — 1ms is NOT enough to fire.
			await vi.advanceTimersByTimeAsync(1);
			expect(mocks.session.abort).not.toHaveBeenCalled();
			// It fires at the 30min clamp.
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
			expect(mocks.session.abort).toHaveBeenCalledTimes(1);
			expect(getAgent(agent.id)?.status).toBe("stopped");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("spawnBackgroundSession gitMode branch lifecycle (issue #28 W4)", () => {
	const VALID_UUID = "4a5b6c7d-8e9f-0a1b-2c3d-4e5f6a7b8c9d";

	function resetGitMocks() {
		mocks.git.getCurrentBranch.mockReset();
		mocks.git.createWorkBranch.mockReset();
		mocks.git.captureDiff.mockReset();
		mocks.git.switchToBranch.mockReset();
		mocks.git.deleteBranch.mockReset();
		mocks.git.hasUncommittedChanges.mockReset();
		mocks.git.commitAll.mockReset();
		mocks.git.captureWorkingDiff.mockReset();
		// Setup reads the base branch; the cleanup concurrency guard reads the
		// current branch and expects it to still be the work branch.
		mocks.git.getCurrentBranch
			.mockReturnValueOnce("main")       // setup: base
			.mockReturnValue("brl-subagent-abc12345"); // cleanup: still on ours
		mocks.git.createWorkBranch.mockReturnValue({ ok: true, branch: "brl-subagent-abc12345" });
		mocks.git.captureDiff.mockReturnValue({ ok: true, diff: "diff --git a/x.ts b/x.ts" });
		mocks.git.switchToBranch.mockReturnValue({ ok: true });
		mocks.git.deleteBranch.mockReturnValue({ ok: true });
		// C1: base tree clean at setup; agent dirt exists at teardown.
		mocks.git.hasUncommittedChanges
			.mockReturnValueOnce(false)         // setup: clean tree
			.mockReturnValue(true);             // teardown: agent dirt to commit
		mocks.git.commitAll.mockReturnValue({ ok: true, sha: "abc123" });
		mocks.git.captureWorkingDiff.mockReturnValue("diff --git a/y.ts b/y.ts");
	}

	it("creates a work branch before the prompt when gitMode=branch", async () => {
		resetGitMocks();
		mocks.session.prompt.mockReturnValue(new Promise(() => {}));
		const { spawnBackgroundSession } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test git mode",
			gitMode: "branch",
		});

		expect(mocks.git.getCurrentBranch).toHaveBeenCalledTimes(1);
		expect(mocks.git.createWorkBranch).toHaveBeenCalledTimes(1);
		// The session's prompt was called with the fence-wrapped task.
		expect(mocks.session.prompt).toHaveBeenCalledTimes(1);
	});

	it("does not touch git when gitMode is none/undefined", async () => {
		resetGitMocks();
		mocks.session.prompt.mockReturnValue(new Promise(() => {}));
		const { spawnBackgroundSession } = await import("../session-manager");
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test no git",
		});

		expect(mocks.git.getCurrentBranch).not.toHaveBeenCalled();
		expect(mocks.git.createWorkBranch).not.toHaveBeenCalled();
	});

	it("throws (refusing to spawn unisolated) when branch creation fails", async () => {
		resetGitMocks();
		mocks.git.createWorkBranch.mockReturnValue({ ok: false, error: "dirty tree" });
		const { spawnBackgroundSession } = await import("../session-manager");
		await expect(
			spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "test git fail",
				gitMode: "branch",
			})
		).rejects.toThrow(/Refusing to spawn the background agent unisolated/);
		// No session was started.
		expect(mocks.session.prompt).not.toHaveBeenCalled();
	});

	it("captures the diff and discards the branch on completion", async () => {
		resetGitMocks();
		mocks.session.prompt.mockResolvedValue(undefined);
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		];
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test git complete",
			gitMode: "branch",
		});
		// Let the .then run.
		await new Promise((r) => setTimeout(r, 0));

		expect(mocks.git.captureDiff).toHaveBeenCalledTimes(1);
		expect(mocks.git.switchToBranch).toHaveBeenCalledWith(expect.anything(), "main");
		expect(mocks.git.deleteBranch).toHaveBeenCalledTimes(1);
		const after = getAgent(agent.id);
		expect(after?.status).toBe("completed");
		expect(after?.result?.gitBranch).toBe("brl-subagent-abc12345");
		expect(after?.result?.gitDiff).toContain("diff --git");
		// Issue #122 nit: the usage merge must preserve the branch's real
		// exitCode (0 on the completed path — not clobbered by the seed).
		expect(after?.result?.exitCode).toBe(0);
	});

	it("captures any partial diff and discards the branch on failure", async () => {
		resetGitMocks();
		mocks.session.prompt.mockRejectedValue(new Error("auth failed"));
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test git fail run",
			gitMode: "branch",
		});
		await new Promise((r) => setTimeout(r, 0));

		// Partial work before the failure is still worth capturing; the branch
		// is discarded either way.
		expect(mocks.git.captureDiff).toHaveBeenCalledTimes(1);
		expect(mocks.git.switchToBranch).toHaveBeenCalledTimes(1);
		expect(mocks.git.deleteBranch).toHaveBeenCalledTimes(1);
		const after = getAgent(agent.id);
		expect(after?.status).toBe("failed");
		expect(after?.result?.gitDiff).toContain("diff --git");
	});
});

describe("W4 concurrency guard — cleanup when another spawn moved the tree", () => {
	const VALID_UUID = "5e6f7a8b-9c0d-1e2f-3a4b-5c6d7e8f9a0b";

	it("skips switch/delete when the tree is no longer on our work branch", async () => {
		// Setup: base is main, work branch created.
		mocks.git.getCurrentBranch.mockReset();
		mocks.git.createWorkBranch.mockReset();
		mocks.git.captureDiff.mockReset();
		mocks.git.switchToBranch.mockReset();
		mocks.git.deleteBranch.mockReset();
		mocks.git.hasUncommittedChanges.mockReset();
		mocks.git.commitAll.mockReset();
		mocks.git.getCurrentBranch
			.mockReturnValueOnce("main")       // setup: base
			.mockReturnValue("brl-subagent-other"); // cleanup: ANOTHER spawn's branch
		mocks.git.createWorkBranch.mockReturnValue({ ok: true, branch: "brl-subagent-abc12345" });
		mocks.git.hasUncommittedChanges.mockReturnValue(false);

		mocks.session.prompt.mockResolvedValue(undefined);
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		];
		const { spawnBackgroundSession } = await import("../session-manager");
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test concurrent cleanup",
			gitMode: "branch",
		});
		await new Promise((r) => setTimeout(r, 0));

		// The tree moved — do NOT yank it back, do NOT delete the other's context.
		expect(mocks.git.switchToBranch).not.toHaveBeenCalled();
		expect(mocks.git.deleteBranch).not.toHaveBeenCalled();
	});
});

describe("W4 review fixes — C1 dirty tree, commit-on-teardown, M1 aborted diff, C2 lock", () => {
	const VALID_UUID = "6a7b8c9d-0e1f-2a3b-4c5d-6e7f8a9b0c1d";

	it("C1: refuses to spawn when the base tree has uncommitted changes", async () => {
		// Setup-time dirty tree — isolation cannot be guaranteed.
		mocks.git.getCurrentBranch.mockReset();
		mocks.git.createWorkBranch.mockReset();
		mocks.git.hasUncommittedChanges.mockReset();
		mocks.git.hasUncommittedChanges.mockReturnValue(true);
		mocks.git.getCurrentBranch.mockReturnValue("main");

		const { spawnBackgroundSession } = await import("../session-manager");
		await expect(
			spawnBackgroundSession(fakePi as never, fakeCtx as never, {
				task: "test dirty tree",
				gitMode: "branch",
			})
		).rejects.toThrow(/uncommitted changes/);
		// No branch was created, no prompt was started.
		expect(mocks.git.createWorkBranch).not.toHaveBeenCalled();
		expect(mocks.session.prompt).not.toHaveBeenCalled();
	});

	it("C1: commits the agent's work before capturing the diff at teardown", async () => {
		resetGitMocks();
		mocks.session.prompt.mockResolvedValue(undefined);
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		];
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test commit teardown",
			gitMode: "branch",
		});
		await new Promise((r) => setTimeout(r, 0));

		// Dirty at teardown → commitAll ran before captureDiff.
		expect(mocks.git.commitAll).toHaveBeenCalledTimes(1);
		const after = getAgent(agent.id);
		expect(after?.result?.gitDiff).toContain("diff --git");
	});

	it("C1: falls back to working-tree diff when commitAll fails (no git identity)", async () => {
		resetGitMocks();
		mocks.git.commitAll.mockReturnValue({ ok: false, error: "no identity" });
		mocks.session.prompt.mockResolvedValue(undefined);
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		];
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test commit fail",
			gitMode: "branch",
		});
		await new Promise((r) => setTimeout(r, 0));

		expect(mocks.git.captureWorkingDiff).toHaveBeenCalledTimes(1);
		const after = getAgent(agent.id);
		expect(after?.result?.gitDiff).toContain("diff --git a/y.ts");
	});

	it("M1: records the diff on the ABORTED path (stop/timeout)", async () => {
		resetGitMocks();
		mocks.session.prompt.mockResolvedValue(undefined);
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Aborted" },
		];
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test aborted diff",
			gitMode: "branch",
		});
		await new Promise((r) => setTimeout(r, 0));

		const after = getAgent(agent.id);
		expect(after?.status).toBe("stopped");
		expect(after?.result?.gitBranch).toBe("brl-subagent-abc12345");
		expect(after?.result?.gitDiff).toContain("diff --git");
		// Issue #122 nit: the usage merge must NOT clobber the branch's real
		// exitCode — the aborted path sets exitCode 1 and the seed must stay
		// absent-preserving (a blunt seed after the spread would reset it to 0).
		expect(after?.result?.exitCode).toBe(1);
	});

	it("C2: a second concurrent branch-mode spawn waits for the first's lock", async () => {
		// First spawn: prompt that we control (deferred).
		resetGitMocks();
		let resolveFirstPrompt!: () => void;
		mocks.session.prompt.mockReturnValue(new Promise<void>((r) => { resolveFirstPrompt = r; }));
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" },
		];
		const { spawnBackgroundSession } = await import("../session-manager");
		const first = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "first lock holder",
			gitMode: "branch",
		});
		// First spawn acquired the lock; its getCurrentBranch read 'main'.
		expect(mocks.git.getCurrentBranch).toHaveBeenCalledTimes(1);

		// Second spawn on the SAME cwd must block until the first settles.
		mocks.git.getCurrentBranch.mockReset();
		mocks.git.createWorkBranch.mockReset();
		mocks.git.hasUncommittedChanges.mockReset();
		mocks.git.getCurrentBranch.mockReturnValue("main");
		mocks.git.createWorkBranch.mockReturnValue({ ok: true, branch: "brl-subagent-second" });
		mocks.git.hasUncommittedChanges.mockReturnValue(false);
		mocks.session.prompt.mockReturnValue(new Promise(() => {}));

		let secondSettled = false;
		const secondPromise = spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "second waiting",
			gitMode: "branch",
		}).then(() => { secondSettled = true; });

		// Give the second spawn a tick — it must NOT have acquired the lock.
		await new Promise((r) => setTimeout(r, 50));
		expect(secondSettled).toBe(false);
		expect(mocks.git.getCurrentBranch).not.toHaveBeenCalled();

		// First settles → its .then runs cleanupWorkBranch → releases the lock.
		resolveFirstPrompt();
		await new Promise((r) => setTimeout(r, 0));

		// Second now proceeds: getCurrentBranch (setup) is called again.
		await new Promise((r) => setTimeout(r, 20));
		expect(mocks.git.getCurrentBranch).toHaveBeenCalled();
		await secondPromise;
		expect(secondSettled).toBe(true);
	});
});

describe("settle handlers never throw — missing transcript / throwing emit (issue #53)", () => {
	// Issue #53: spawnBackgroundSession's .then/.catch settle handlers run in
	// promise callbacks — a throw (fs failure, deleted transcript, emit error)
	// would escape as an uncaughtException and kill the whole pi process.
	// These tests pin the defensive try/catch + markTerminalBestEffort.
	const fs = require("node:fs") as typeof import("node:fs");
	const path = require("node:path") as typeof import("node:path");

	// Track ids spawned inside this block so afterEach can clean up the
	// persisted record and transcript files (in the per-test TEMP dirs, #52).
	const spawnedIds: string[] = [];

	const cleanupPiFiles = () => {
		for (const id of spawnedIds) {
			try { fs.unlinkSync(path.join(tempStorageDir, `${id}.json`)); } catch { /* ok */ }
			try { fs.unlinkSync(path.join(tempOutputDir, `agent-${id}.jsonl`)); } catch { /* ok */ }
		}
		spawnedIds.length = 0;
	};

	afterEach(cleanupPiFiles);

	it("does not crash when the transcript is deleted before a FAILING run settles", async () => {
		// Deferred reject: the prompt rejects on a later macrotask so the file
		// can be deleted between spawn and settle (pre-fix, the settle-path
		// completeTranscript would throw "Transcript not found" → uncaught).
		mocks.session.prompt.mockReturnValue(
			new Promise((_, reject) => {
				setTimeout(() => reject(new Error("auth failed")), 0);
			})
		);
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test transcript deleted (fail)",
		});
		spawnedIds.push(agent.id);
		// startTranscript ran during spawn, so the file exists — delete it
		// BEFORE the deferred rejection settles.
		fs.unlinkSync(path.join(tempOutputDir, `agent-${agent.id}.jsonl`));

		// Let the deferred rejection settle.
		await new Promise((r) => setTimeout(r, 10));

		const after = getAgent(agent.id);
		expect(after?.status).toBe("failed");
		expect(after?.completedAt).toBeDefined();
		expect(after?.error).toBe("auth failed");
	});

	it("does not crash when the failed-event emit throws (defensive wrapper)", async () => {
		mocks.session.prompt.mockRejectedValue(new Error("auth failed"));
		// The real event-bus never throws, but any throw from a settle-handler
		// step must be contained — force emit to blow up on the failure event.
		eventBusMock.emit.mockImplementation((event: { type: string }) => {
			if (event.type === "subagent:failed") throw new Error("emit exploded");
		});
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test emit throws",
		});
		spawnedIds.push(agent.id);

		await new Promise((r) => setTimeout(r, 10));

		// The record was already flipped terminal before the emit; the catch
		// wrapper logs and best-effort keeps it terminal — never rethrows.
		const after = getAgent(agent.id);
		expect(after?.status).toBe("failed");
		expect(after?.completedAt).toBeDefined();
	});

	it("sanitizes error messages (issue #30) before persist/echo — cwd paths are neutralized", async () => {
		// F7: prompt() rejection messages can embed absolute paths (cwd prefixes,
		// spawn commands). The .catch handler persists agent.error (disk) and
		// echoes it into the subagent:failed event — both must carry the
		// SANITIZED form so the local filesystem structure does not leak into the
		// main agent's context or onto disk.
		mocks.session.prompt.mockRejectedValue(
			new Error("config load failed: /tmp/brl-test-cwd/.pi/settings.json")
		);
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test error sanitization",
		});
		spawnedIds.push(agent.id);

		await new Promise((r) => setTimeout(r, 10));

		const after = getAgent(agent.id);
		expect(after?.status).toBe("failed");
		expect(after?.error).toContain("<cwd>");
		expect(after?.error).toContain(".pi/settings.json");
		expect(after?.error).not.toContain("/tmp/brl-test-cwd");

		// The subagent:failed event must carry the sanitized form too.
		const failedEvents = eventBusMock.emit.mock.calls
			.map(([e]) => e as { type: string; data?: { error?: string } })
			.filter((e) => e.type === "subagent:failed");
		expect(failedEvents.length).toBe(1);
		expect(failedEvents[0].data?.error).not.toContain("/tmp/brl-test-cwd");
		expect(failedEvents[0].data?.error).toContain("<cwd>");
	});

	it("does not crash when the transcript is deleted before a COMPLETING run settles", async () => {
		mocks.session.prompt.mockReturnValue(
			new Promise((resolve) => {
				setTimeout(() => resolve(undefined), 0);
			})
		);
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		];
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test transcript deleted (complete)",
		});
		spawnedIds.push(agent.id);
		fs.unlinkSync(path.join(tempOutputDir, `agent-${agent.id}.jsonl`));

		// Let the deferred resolve settle.
		await new Promise((r) => setTimeout(r, 10));

		const after = getAgent(agent.id);
		expect(after?.status).toBe("completed");
		expect(after?.completedAt).toBeDefined();
	});
});

describe("persisted file modes (F6 / issue #29)", () => {
	it("writes agent records and transcripts owner-only (0o600)", async () => {
		// Records hold task/error/result.messages (full conversation) and
		// finalOutput; transcripts hold the full conversation too — both must
		// be created 0o600 and their dirs 0o700 (mode applies on CREATE; not
		// retroactive). POSIX-only: Windows reports default 0666/0755.
		if (process.platform === "win32") return;
		const fs = require("node:fs") as typeof import("node:fs");
		const path = require("node:path") as typeof import("node:path");

		// Never-resolving prompt keeps the agent 'running' so the record and
		// transcript (created synchronously during spawn) stay in place.
		mocks.session.prompt.mockReturnValue(new Promise(() => {}));
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");

		// The temp storage/output dirs are freshly created per test (issue #52),
		// so the subagents/output dirs below are guaranteed to be CREATED by
		// this spawn — the 0o700 dir-mode assertions always apply.
		const subagentsExisted = fs.existsSync(tempStorageDir);
		const outputExisted = fs.existsSync(tempOutputDir);

		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test file modes",
		});

		const recordPath = path.join(tempStorageDir, `${agent.id}.json`);
		const transcriptPath = path.join(tempOutputDir, `agent-${agent.id}.jsonl`);
		try {
			expect(getAgent(agent.id)).not.toBeNull();
			expect(fs.existsSync(recordPath)).toBe(true);
			expect(fs.existsSync(transcriptPath)).toBe(true);
			expect(fs.statSync(recordPath).mode & 0o777).toBe(0o600);
			expect(fs.statSync(transcriptPath).mode & 0o777).toBe(0o600);
			// Freshly-created storage/output subdirs must be 0o700 (owner-only).
			if (!subagentsExisted) {
				expect(fs.statSync(tempStorageDir).mode & 0o777).toBe(0o700);
			}
			if (!outputExisted) {
				expect(fs.statSync(tempOutputDir).mode & 0o777).toBe(0o700);
			}
		} finally {
			try { fs.unlinkSync(recordPath); } catch { /* ok */ }
			try { fs.unlinkSync(transcriptPath); } catch { /* ok */ }
		}
	});
});

describe("test storage isolation (issue #52)", () => {
	it("a hanging-prompt spawn leaves NO new files in the real repo .pi/", async () => {
		// Regression for the zombie vector: pre-fix, the hanging-prompt mocks
		// persisted 'running' records into the REAL repo .pi/subagents (and the
		// transcripts into .pi/output). With the storage/output dirs redirected
		// to per-test temp dirs, the real .pi must be untouched even though
		// this agent stays 'running' forever.
		const fs = require("node:fs") as typeof import("node:fs");
		const path = require("node:path") as typeof import("node:path");
		const realSubagents = path.join(process.cwd(), ".pi", "subagents");
		const realOutput = path.join(process.cwd(), ".pi", "output");
		const list = (dir: string): string[] => {
			try { return fs.readdirSync(dir).sort(); } catch { return []; }
		};
		const subagentsBefore = list(realSubagents);
		const outputBefore = list(realOutput);

		// Never-resolving prompt keeps the agent 'running' — the old-world
		// zombie scenario.
		mocks.session.prompt.mockReturnValue(new Promise(() => {}));
		const { spawnBackgroundSession } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "test isolation zombie",
		});
		expect(agent.status).toBe("running");

		// The record + transcript landed in the TEMP dirs...
		expect(fs.existsSync(path.join(tempStorageDir, `${agent.id}.json`))).toBe(true);
		expect(fs.existsSync(path.join(tempOutputDir, `agent-${agent.id}.jsonl`))).toBe(true);

		// ...and the real repo .pi/ gained nothing.
		expect(list(realSubagents)).toEqual(subagentsBefore);
		expect(list(realOutput)).toEqual(outputBefore);
	});
});

describe("issue #31 — terminal paths release agent._sessionRef", () => {
	// Issue #31: the live session ref must not survive terminal paths — the
	// settlement branches (completed/aborted/stopped/failed) capture the final
	// output while the session is still live, then null the ref. The index.ts
	// poller treats a nulled ref on a terminal agent as EXPECTED (it gates the
	// crash branch on !agent.completedAt and prefers agent.finalOutput), so a
	// released ref must never read as a crash. These tests pin the settlement
	// side of that contract: after a mocked run settles, the in-memory agent
	// (the same object the poller holds) has _sessionRef === undefined.
	//
	// NOTE: assert the ref is live BEFORE settling via a manually-controlled
	// (deferred) prompt — an immediately-resolved prompt settles during spawn's
	// own microtask drain, before the test body resumes.

	it("releases the ref on the completed path (finalOutput captured first)", async () => {
		let resolvePrompt: () => void = () => {};
		mocks.session.prompt.mockReturnValue(new Promise<void>((r) => { resolvePrompt = r; }));
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		];

		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "#31 ref release (completed)",
		});
		// Live ref while the run is pending — the poller still polls this.
		expect(agent._sessionRef).toBeDefined();

		resolvePrompt();
		await new Promise((r) => setTimeout(r, 0));

		expect(agent.status).toBe("completed");
		expect(agent.completedAt).toBeDefined();
		// The final output was captured BEFORE the ref was released — this is
		// what index.ts's `agent.finalOutput ?? ...` prefers at finalize.
		expect(agent.finalOutput).toBe("done");
		expect(agent._sessionRef).toBeUndefined();
	});

	it("releases the ref on the aborted/stopped path", async () => {
		let resolvePrompt: () => void = () => {};
		mocks.session.prompt.mockReturnValue(new Promise<void>((r) => { resolvePrompt = r; }));
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Aborted" },
		];

		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "#31 ref release (aborted)",
		});
		expect(agent._sessionRef).toBeDefined();

		resolvePrompt();
		await new Promise((r) => setTimeout(r, 0));

		expect(agent.status).toBe("stopped");
		expect(agent.completedAt).toBeDefined();
		expect(agent._sessionRef).toBeUndefined();
	});

	it("releases the ref on the failed path", async () => {
		let rejectPrompt: (err: Error) => void = () => {};
		mocks.session.prompt.mockReturnValue(new Promise<void>((_, reject) => { rejectPrompt = reject; }));

		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "#31 ref release (failed)",
		});
		expect(agent._sessionRef).toBeDefined();

		rejectPrompt(new Error("auth failed"));
		await new Promise((r) => setTimeout(r, 0));

		expect(agent.status).toBe("failed");
		expect(agent.completedAt).toBeDefined();
		expect(agent._sessionRef).toBeUndefined();
	});

	it("releases the ref via markTerminalBestEffort when a settle handler throws", async () => {
		// The aborted branch calls updateAgentStatus(id, 'stopped') BEFORE its own
		// ref release — if that emit throws (settle-handler step failure), the
		// handler jumps to markTerminalBestEffort, which must still null the ref.
		// This is the one path where markTerminalBestEffort's release is
		// load-bearing (the primary branch never reached its release line).
		let resolvePrompt: () => void = () => {};
		mocks.session.prompt.mockReturnValue(new Promise<void>((r) => { resolvePrompt = r; }));
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "partial output before the settle throw" }], stopReason: "aborted", errorMessage: "Aborted" },
		];
		eventBusMock.emit.mockImplementation((event: { type: string }) => {
			if (event.type === "subagent:stopped") throw new Error("emit exploded");
		});

		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "#31 ref release (settle throw)",
		});
		expect(agent._sessionRef).toBeDefined();

		resolvePrompt();
		await new Promise((r) => setTimeout(r, 10));

		// updateAgentStatus flipped the status before the emit threw — the record
		// stays terminal, and markTerminalBestEffort captured the output (while
		// the ref was still live) and nulled the ref. The finalOutput assertion
		// FAILS without the capture-before-release fix (finalOutput would be
		// undefined — the session's output would die with the released graph).
		expect(agent.status).toBe("stopped");
		expect(agent.completedAt).toBeDefined();
		expect(agent.finalOutput).toBe("partial output before the settle throw");
		expect(agent._sessionRef).toBeUndefined();
	});

	it("releases the ref on the stopped-in-catch path (rejecting prompt while already stopped)", async () => {
		// The .catch stopped branch (session-manager ~824) is only reachable when
		// the prompt REJECTS while the status is already 'stopped' — e.g. stopAgent
		// flipped the status, then the run rejects. It must capture the final
		// output and release the ref just like the other terminal paths.
		let rejectPrompt: (err: Error) => void = () => {};
		mocks.session.prompt.mockReturnValue(new Promise<void>((_, reject) => { rejectPrompt = reject; }));
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "stopped mid-run" }], stopReason: "aborted", errorMessage: "Aborted" },
		];
		const { stopAgent } = await import("../session-manager");

		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "#31 ref release (stopped in catch)",
		});
		expect(agent._sessionRef).toBeDefined();

		// stopAgent flips the status to 'stopped' (real stop_subagent flow) —
		// then the run rejects, landing in the .catch stopped branch.
		await stopAgent(agent.id);
		expect(agent.status).toBe("stopped");

		rejectPrompt(new Error("run rejected after stop"));
		await new Promise((r) => setTimeout(r, 0));

		expect(agent.status).toBe("stopped");
		expect(agent.completedAt).toBeDefined();
		expect(agent.finalOutput).toBe("stopped mid-run");
		expect(agent._sessionRef).toBeUndefined();
	});
});

// =========================================================================
// Issue #98: background run entries — spawn persist + settle finalization.
// Background runs must be retry-able: the spawn entry (id == agent id) is
// what state.findRunById resolves, and the finalize entry keeps its status
// in lockstep with the agent record.
// =========================================================================
describe("spawnBackgroundSession run-entry persistence (issue #98)", () => {
	// Review F1: sync-throw finalization is covered by the dedicated test
	// below. Review F2 (catch-all status derivation) fires only when a
	// settle handler throws between the agent-status flip and its own
	// finalizeRunEntry call — exercising it deterministically would need
	// an injectable persistAgent/emit throw, so the derivation is covered
	// by code review + the passing done/failed/aborted tests here.
	it("persists a session run entry with the agent id at spawn", async () => {
		// A never-resolving prompt keeps the agent 'running' — only the spawn
		// entry is written, no finalization yet.
		mocks.session.prompt.mockReturnValue(new Promise(() => {}));
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "retryable background task",
			description: "bg-label",
			model: "anthropic/claude-sonnet-4-5",
			thinkingLevel: "high",
		});

		expect(fakePi.appendEntry).toHaveBeenCalledTimes(1);
		const [customType, run] = fakePi.appendEntry.mock.calls[0];
		expect(customType).toBe(CUSTOM_ENTRY_TYPES.run);
		// id == agent id — the id the caller holds IS the retry-able run id.
		expect(run.id).toBe(agent.id);
		expect(run.status).toBe("running");
		expect(run.task).toBe("retryable background task");
		expect(run.description).toBe("bg-label");
		// Review F3: consumers (history/retry menu/reports) read run.label —
		// the background label must land there, not only in description.
		expect(run.label).toBe("bg-label");
		expect(run.model).toBe("anthropic/claude-sonnet-4-5");
		expect(run.thinkingLevel).toBe("high");
	});

	it("persists originalParams on the spawn run entry (retry merge source)", async () => {
		mocks.session.prompt.mockReturnValue(new Promise(() => {}));
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "bg task",
			originalParams: {
				systemPrompt: "bg prompt",
				model: "anthropic/claude-sonnet-4-5",
				thinkingLevel: "high",
				preset: "code-reviewer",
			},
		});

		const run = fakePi.appendEntry.mock.calls[0][1];
		expect(run.originalParams).toEqual({
			systemPrompt: "bg prompt",
			model: "anthropic/claude-sonnet-4-5",
			thinkingLevel: "high",
			preset: "code-reviewer",
		});
	});

	it("finalizes the run entry to done when the agent completes", async () => {
		mocks.session.prompt.mockResolvedValue(undefined);
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		];
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "completes",
		});
		// Let the .then settle handler run.
		await new Promise((r) => setTimeout(r, 0));

		expect(fakePi.appendEntry).toHaveBeenCalledTimes(2);
		const run = fakePi.appendEntry.mock.calls[1][1];
		expect(run.id).toBe(agent.id);
		expect(run.status).toBe("done");
		expect(run.finishedAt).toBeDefined();
		expect(run.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("finalizes the run entry to failed when the session rejects", async () => {
		mocks.session.prompt.mockRejectedValue(new Error("auth failed"));
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "fails",
		});
		// Let the .catch settle handler run.
		await new Promise((r) => setTimeout(r, 0));

		expect(fakePi.appendEntry).toHaveBeenCalledTimes(2);
		const run = fakePi.appendEntry.mock.calls[1][1];
		expect(run.id).toBe(agent.id);
		expect(run.status).toBe("failed");
		expect(run.errorMessage).toBe("auth failed");
	});

	it("finalizes the run entry to failed when the run is aborted", async () => {
		// Probe contract: abort makes prompt() RESOLVE with stopReason "aborted".
		mocks.session.prompt.mockResolvedValue(undefined);
		mocks.session.messages = [
			{ role: "user", content: "probe task" },
			{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Aborted" },
		];
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "aborts",
		});
		await new Promise((r) => setTimeout(r, 0));

		expect(fakePi.appendEntry).toHaveBeenCalledTimes(2);
		const run = fakePi.appendEntry.mock.calls[1][1];
		expect(run.id).toBe(agent.id);
		expect(run.status).toBe("failed");
		expect(run.errorMessage).toBe("Aborted or timed out");
	});

	it("finalizes the run entry to failed when prompt() throws synchronously (review F1)", async () => {
		// A synchronous prompt() throw means the .then/.catch settle handlers
		// never attach — without the F1 catch path a zombie 'running' entry
		// would survive and findRunById would retry a run that never started.
		mocks.session.prompt.mockImplementation(() => {
			throw new Error("sync preflight failure");
		});

		await expect(
			spawnBackgroundSession(fakePi as never, fakeCtx as never, { task: "sync-throws" })
		).rejects.toThrow("sync preflight failure");

		expect(fakePi.appendEntry).toHaveBeenCalledTimes(2);
		const spawnRun = fakePi.appendEntry.mock.calls[0][1];
		expect(spawnRun.status).toBe("running");
		const finalRun = fakePi.appendEntry.mock.calls[1][1];
		expect(finalRun.id).toBe(spawnRun.id);
		expect(finalRun.status).toBe("failed");
		expect(finalRun.errorMessage).toBe("sync preflight failure");
		expect(finalRun.finishedAt).toBeDefined();
	});
});

// Issue #122: the finalized background run entry carries the audit fields
// (cost/tokensIn/tokensOut/outputSummary/fullOutput) the same way the
// foreground and parallel paths do — consumers (drill-in, retry, metrics)
// must behave identically for background runs.
// =========================================================================
describe("spawnBackgroundSession run-entry audit fields (issue #122)", () => {
	it("carries the REAL summed session usage on the finalized entry when the agent completed", async () => {
		// Real data flow (no setAgentResult planting): the assistant messages
		// in the session carry per-turn usage; the terminal path folds them
		// with accumulateUsage and merges the sum onto the run entry.
		mocks.session.prompt.mockResolvedValue(undefined);
		// A long final message verifies outputSummary is the CAPPED slice while
		// fullOutput keeps the entire output.
		const fullOutput = "completed audit output " + "x".repeat(250);
		mocks.session.messages = [
			{ role: "user", content: "audit task" },
			{
				role: "assistant",
				content: [{ type: "text", text: "planning turn" }],
				usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, cost: { total: 0.5 }, totalTokens: 1500 },
			},
			{
				role: "assistant",
				content: [{ type: "text", text: fullOutput }],
				stopReason: "stop",
				usage: { input: 500, output: 250, cost: { total: 0.25 }, totalTokens: 750 },
			},
		];
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "audit fields",
		});
		// Let the completion settle handler run.
		await new Promise((r) => setTimeout(r, 0));

		expect(fakePi.appendEntry).toHaveBeenCalledTimes(2);
		const run = fakePi.appendEntry.mock.calls[1][1];
		expect(run.status).toBe("done");
		// Folded from BOTH assistant turns: input 1000+500, output 200+250,
		// cacheRead 300, cacheWrite 50, cost 0.5+0.25, turns 2, contextTokens
		// = last turn's totalTokens (accumulateUsage semantics).
		expect(run.cost).toBeCloseTo(0.75, 10);
		expect(run.tokensIn).toBe(1500);
		expect(run.tokensOut).toBe(450);
		expect(run.outputSummary).toBe(fullOutput.slice(0, 200));
		expect(run.outputSummary).toHaveLength(200);
		expect(run.fullOutput).toBe(fullOutput);
		// The agent record itself carries the merged usage — extracted from the
		// session, never planted via setAgentResult.
		const after = getAgent(agent.id);
		expect(after?.result?.usage).toMatchObject({
			input: 1500,
			output: 450,
			cacheRead: 300,
			cacheWrite: 50,
			cost: 0.75,
			turns: 2,
			contextTokens: 750,
		});
		// Issue #122 nit: the merge seeds the FULL required SubagentResult shape
		// (messages/exitCode/stderr are required fields) when the record doesn't
		// already provide it — a non-gitMode run must not persist a partial
		// record with undefined required fields.
		expect(after?.result?.messages).toEqual([]);
		expect(typeof after?.result?.exitCode).toBe("number");
		expect(after?.result?.stderr).toBe("");
	});

	it("carries the summed session usage on the finalized entry when the run is aborted", async () => {
		// Probe contract: abort makes prompt() RESOLVE with stopReason
		// "aborted" on the last assistant message. A timed-out/aborted run
		// burned tokens — the 'failed' entry must carry the REAL summed usage.
		mocks.session.prompt.mockResolvedValue(undefined);
		mocks.session.messages = [
			{ role: "user", content: "audit task" },
			{
				role: "assistant",
				content: [{ type: "text", text: "partial work" }],
				stopReason: "stop",
				usage: { input: 800, output: 120, cacheRead: 40, cacheWrite: 10, cost: { total: 0.4 }, totalTokens: 960 },
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "interrupted" }],
				stopReason: "aborted",
				errorMessage: "Aborted",
				usage: { input: 60, output: 30, cost: { total: 0.05 }, totalTokens: 90 },
			},
		];
		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "audit fields abort",
		});
		// Let the aborted settle handler run.
		await new Promise((r) => setTimeout(r, 0));

		expect(fakePi.appendEntry).toHaveBeenCalledTimes(2);
		const run = fakePi.appendEntry.mock.calls[1][1];
		expect(run.status).toBe("failed");
		expect(run.errorMessage).toBe("Aborted or timed out");
		// Summed across both assistant turns: input 800+60, output 120+30,
		// cacheRead 40, cacheWrite 10, cost 0.4+0.05, turns 2.
		expect(run.cost).toBeCloseTo(0.45, 10);
		expect(run.tokensIn).toBe(860);
		expect(run.tokensOut).toBe(150);
		// The agent record is 'stopped' and carries the merged usage.
		const after = getAgent(agent.id);
		expect(after?.status).toBe("stopped");
		expect(after?.result?.usage).toMatchObject({
			input: 860,
			output: 150,
			cacheRead: 40,
			cacheWrite: 10,
			turns: 2,
			contextTokens: 90,
		});
	});

	it("finalizes with zeroed audit fields on a rejected preflight (no assistant messages)", async () => {
		// Genuine failure branch (.catch): a preflight auth/model rejection
		// usually has NO assistant messages — the usage fold yields zeros
		// (honest: no model call happened) and must not crash.
		mocks.session.prompt.mockRejectedValue(new Error("no api key for provider"));
		mocks.session.messages = [{ role: "user", content: "audit task" }];

		const { spawnBackgroundSession, getAgent } = await import("../session-manager");
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "audit fields reject",
		});
		// Let the .catch settle handler run.
		await new Promise((r) => setTimeout(r, 0));

		expect(fakePi.appendEntry).toHaveBeenCalledTimes(2);
		const run = fakePi.appendEntry.mock.calls[1][1];
		expect(run.status).toBe("failed");
		expect(run.cost).toBe(0);
		expect(run.tokensIn).toBe(0);
		expect(run.tokensOut).toBe(0);
		const after = getAgent(agent.id);
		expect(after?.status).toBe("failed");
		expect(after?.result?.usage).toMatchObject({ input: 0, output: 0, turns: 0 });
	});

	it("finalizes with zeroed/empty audit fields on an early failure (no result, no output)", async () => {
		// Synchronous prompt() throw: no result and no captured output exist
		// when the finalize runs — it must still succeed with the empty-usage
		// fallback (zeros) and no missing fields.
		mocks.session.prompt.mockImplementation(() => {
			throw new Error("sync preflight failure");
		});

		await expect(
			spawnBackgroundSession(fakePi as never, fakeCtx as never, { task: "sync-throws-audit" })
		).rejects.toThrow("sync preflight failure");

		expect(fakePi.appendEntry).toHaveBeenCalledTimes(2);
		const finalRun = fakePi.appendEntry.mock.calls[1][1];
		expect(finalRun.status).toBe("failed");
		expect(finalRun.cost).toBe(0);
		expect(finalRun.tokensIn).toBe(0);
		expect(finalRun.tokensOut).toBe(0);
		expect(finalRun.outputSummary).toBe("");
		expect(finalRun.fullOutput).toBeUndefined();
	});
});
