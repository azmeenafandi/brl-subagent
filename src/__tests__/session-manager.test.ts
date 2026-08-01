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

import { spawnBackgroundSession } from "../session-manager";

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
		// Ordering is the critical property: the SDK returns [] from
		// getAppendSystemPrompt until reload() runs, so reload MUST have
		// completed before createAgentSession was invoked.
		expect(reloadCalledAtCreateTime).toBe(true);
	});

	it("uses no resourceLoader when systemPrompt is empty", async () => {
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "do the thing",
			systemPrompt: "",
		});

		expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
		const options = mocks.createAgentSession.mock.calls[0][0];
		expect(options.resourceLoader).toBeUndefined();
	});

	it("does not create a resourceLoader when systemPrompt is only whitespace", async () => {
		await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "do the thing",
			systemPrompt: "   \n\t ",
		});

		const options = mocks.createAgentSession.mock.calls[0][0];
		expect(options.resourceLoader).toBeUndefined();
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
