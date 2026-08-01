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
		SessionManager: { inMemory: () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: MockDefaultResourceLoader,
	};
});

import { spawnBackgroundSession } from "../session-manager";

const fakePi = {};
const fakeCtx = { cwd: "/tmp/brl-test-cwd", modelRegistry: {} };

beforeEach(() => {
	mocks.createAgentSession.mockReset();
	mocks.createAgentSession.mockResolvedValue({ session: mocks.session });
	mocks.session.prompt.mockClear();
	mocks.session.setSessionName.mockClear();
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
		// spawnBackgroundSession awaits loader.reload() before createAgentSession,
		// so by the time the mock was called the reload must have happened.
		expect(options.resourceLoader.reload).toHaveBeenCalledTimes(1);
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
});
