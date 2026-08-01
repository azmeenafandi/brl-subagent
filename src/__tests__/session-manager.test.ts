import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must exist before vi.mock factory runs (hoisted).
const mocks = vi.hoisted(() => ({
	createAgentSession: vi.fn(),
	session: {
		sessionId: "test-session",
		setSessionName: vi.fn(),
		prompt: vi.fn().mockResolvedValue(undefined),
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

import { spawnBackgroundSession, getAgent, getTranscriptPath, steerAgent, updateAgentStatus } from "../session-manager";
import { getTranscriptPath as transcriptGetTranscriptPath } from "../transcript";

const fakePi = {};
const fakeCtx = {
	cwd: "/tmp/brl-test-cwd",
	modelRegistry: {
		find: vi.fn().mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5" }),
	},
};

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
		expect(options.resourceLoader.options.appendSystemPrompt).toEqual([
			"## Preset Guidance\n\nFor security audits.",
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

	it("calls session.prompt with the task", async () => {
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "do the thing",
		});

		expect(mocks.session.prompt).toHaveBeenCalledTimes(1);
		expect(mocks.session.prompt).toHaveBeenCalledWith("do the thing");
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
});
