/**
 * Option B U2 (A₁): file-backed background sessions + retention (C1).
 *
 * These tests drive the REAL SDK `SessionManager` (only `createAgentSession`,
 * the resource loader, settings and agent-dir are stubbed) so the session file
 * is genuinely created on disk by the SDK. Every path is sandboxed into a
 * per-test temp dir by `createTempEnv` — the real `.pi/subagents` store is never
 * touched (asserted in T1).
 *
 * Contract under test:
 *   T1  a background run's session file exists (under `.pi/subagents/sessions/<id>/`)
 *       while the run is live;
 *   T2  the per-run dir is pruned on EVERY terminal settle path (success,
 *       timeout/abort, error, user-stop);
 *   T3  a crashed/torn-tail session stays on disk and is loadable + self-heals,
 *       and the U1 interrupted mark is intact;
 *   T4  an interrupted (marked) run KEEPS its session file until resolved;
 *   T5  `pruneBackgroundSession` is validated, idempotent and root-bounded.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTempEnv } from "./fixtures/temp-lifecycle";

const mocks = vi.hoisted(() => ({
	createAgentSession: vi.fn(),
	session: {
		sessionId: "test-session",
		setSessionName: vi.fn(),
		prompt: vi.fn(),
		abort: vi.fn(),
		steer: vi.fn(),
		messages: [] as Array<{
			role: string;
			content?: unknown;
			stopReason?: string;
			errorMessage?: string;
		}>,
	},
}));

// Partial mock: keep the REAL SessionManager (so files are really written) and
// stub only the heavy session/loader construction.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	class MockDefaultResourceLoader {
		options: Record<string, unknown>;
		reload = vi.fn().mockResolvedValue(undefined);
		constructor(options: Record<string, unknown>) {
			this.options = options;
		}
	}
	return {
		...actual,
		getAgentDir: () => "/tmp/brl-test-agentdir",
		createAgentSession: mocks.createAgentSession,
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: MockDefaultResourceLoader,
	};
});

import {
	backgroundSessionDir,
	pruneBackgroundSession,
	getAgent,
	markAgentInterrupted,
	spawnBackgroundSession,
	stopAgent,
} from "../session-manager";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const fakePi = { appendEntry: vi.fn() };
const fakeCtx = {
	cwd: "/tmp/brl-test-cwd",
	modelRegistry: {
		find: vi.fn().mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5" }),
	},
};

// Isolate EVERY test from the real repo .pi/.
const env = createTempEnv("brl-bg-session", { withCwd: false });

/** 12-char hex-ish uuid accepted by assertSafeAgentId (UUID_RE). */
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
	env.setUp();
	mocks.session.setSessionName.mockReset();
	mocks.session.prompt.mockReset();
	mocks.session.abort.mockReset();
	mocks.session.steer.mockReset();
	// A data-property define (not `= []`) so a prior witness's throwing getter is
	// always replaced and later direct `messages = [...]` assignments work.
	Object.defineProperty(mocks.session, "messages", { configurable: true, writable: true, value: [] });
	mocks.session.abort.mockResolvedValue(undefined);
	mocks.createAgentSession.mockReset();
	// Simulate the SDK: constructing the agent session appends the first user
	// message, which materializes the session file under the explicit sessionDir.
	mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => {
		(options.sessionManager as { appendMessage: (m: unknown) => void }).appendMessage({
			role: "user",
			content: "task",
		});
		return { session: mocks.session };
	});
});

afterAll(async () => {
	await env.tearDown();
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

/** A promise whose settlement the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
	let resolve!: () => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("U2 T1 — the session file exists during a live background run", () => {
	it("writes under the explicit per-run dir and never into the real store", async () => {
		mocks.session.prompt.mockReturnValue(new Promise(() => {})); // stays running
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "live run",
		});

		const dir = backgroundSessionDir(agent.id);
		expect(agent._sessionFile).toBeDefined();
		expect(agent._sessionFile!.startsWith(dir)).toBe(true);
		// The SDK really created the file (header + first user message).
		expect(existsSync(agent._sessionFile!)).toBe(true);
		expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
		// Sandbox proof: the real repo store was never used for this id.
		expect(existsSync(join(process.cwd(), ".pi/subagents/sessions", agent.id))).toBe(false);
	});
});

describe("U2 T2 — prune on EVERY terminal settle path", () => {
	it("success: removes the per-run dir when the prompt completes", async () => {
		const d = deferred();
		mocks.session.prompt.mockReturnValue(d.promise);
		mocks.session.messages = [
			{ role: "user", content: "task" },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		];
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "success run",
		});
		const dir = backgroundSessionDir(agent.id);
		expect(existsSync(dir)).toBe(true); // created during the run
		d.resolve();
		await tick();
		expect(getAgent(agent.id)?.status).toBe("completed");
		expect(existsSync(dir)).toBe(false);
	});

	it("timeout/abort: removes the dir when the deadline aborts the run", async () => {
		let resolvePrompt: () => void = () => {};
		mocks.session.prompt.mockReturnValue(
			new Promise<void>((r) => {
				resolvePrompt = r;
			}),
		);
		mocks.session.messages = [
			{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Aborted" },
		];
		mocks.session.abort.mockImplementation(async () => resolvePrompt());

		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "timeout run",
			timeout: 5,
		});
		const dir = backgroundSessionDir(agent.id);
		expect(existsSync(dir)).toBe(true);
		await tick();
		expect(getAgent(agent.id)?.status).toBe("stopped");
		expect(existsSync(dir)).toBe(false);
	});

	it("error: removes the dir when the prompt rejects", async () => {
		const d = deferred();
		mocks.session.prompt.mockReturnValue(d.promise);
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "error run",
		});
		const dir = backgroundSessionDir(agent.id);
		expect(existsSync(dir)).toBe(true);
		d.reject(new Error("provider exploded"));
		await tick();
		expect(getAgent(agent.id)?.status).toBe("failed");
		expect(existsSync(dir)).toBe(false);
	});

	it("user-stop: removes the dir when stopAgent aborts the run", async () => {
		let resolvePrompt: () => void = () => {};
		mocks.session.prompt.mockReturnValue(
			new Promise<void>((r) => {
				resolvePrompt = r;
			}),
		);
		mocks.session.messages = [{ role: "assistant", content: [], stopReason: "stop" }];
		mocks.session.abort.mockImplementation(async () => resolvePrompt());

		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "stopped run",
		});
		const dir = backgroundSessionDir(agent.id);
		expect(existsSync(dir)).toBe(true);
		await stopAgent(agent.id);
		await tick();
		expect(getAgent(agent.id)?.status).toBe("stopped");
		expect(existsSync(dir)).toBe(false);
	});
});

describe("U2 T3 — a crash leaves a loadable session (torn-tail tolerant)", () => {
	it("keeps the file, the U1 mark, and reloads the prior entries", async () => {
		mocks.session.prompt.mockReturnValue(new Promise(() => {}));
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "crash run",
		});
		const file = agent._sessionFile!;
		expect(existsSync(file)).toBe(true);

		// Simulate a mid-write kill: a partial final JSON line with no newline.
		appendFileSync(file, '{"type":"message","id":"torn","par');

		// U1 boot scan marks the record interrupted (owner died mid-run).
		const iso = new Date().toISOString();
		markAgentInterrupted(agent.id, iso);

		// D3: the file is kept ...
		expect(existsSync(file)).toBe(true);
		expect(getAgent(agent.id)?.interruptedAt).toBe(iso);

		// ... and loadable: the torn tail is skipped, prior entries intact.
		const reopened = SessionManager.open(file);
		const entries = reopened.getEntries();
		expect(entries.length).toBeGreaterThanOrEqual(1);
		expect(entries[0].type).toBe("message");
	});
});

describe("U2 T4 — an interrupted run is NOT pruned", () => {
	it("keeps the session file even when the marked run later settles", async () => {
		let resolvePrompt: () => void = () => {};
		mocks.session.prompt.mockReturnValue(
			new Promise<void>((r) => {
				resolvePrompt = r;
			}),
		);
		mocks.session.messages = [{ role: "assistant", content: [], stopReason: "stop" }];
		mocks.session.abort.mockImplementation(async () => resolvePrompt());

		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "interrupted run",
		});
		const file = agent._sessionFile!;
		markAgentInterrupted(agent.id, new Date().toISOString());

		// The marked run settles (as if the process survived the mark).
		await stopAgent(agent.id);
		await tick();

		expect(getAgent(agent.id)?.status).toBe("stopped");
		expect(existsSync(file)).toBe(true);
	});
});

describe("U2 T5 — prune helper safety", () => {
	it("is idempotent on a missing directory", () => {
		expect(() => pruneBackgroundSession(UUID_A)).not.toThrow();
		expect(() => pruneBackgroundSession(UUID_A)).not.toThrow();
	});

	it("removes exactly the per-run dir", () => {
		const dir = backgroundSessionDir(UUID_A);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "s.jsonl"), "{}\n");
		pruneBackgroundSession(UUID_A);
		expect(existsSync(dir)).toBe(false);
	});

	it("rejects a path-traversal / non-uuid id", () => {
		expect(() => backgroundSessionDir("../../etc")).toThrow();
		expect(() => pruneBackgroundSession("../../etc/passwd")).toThrow();
		// Nothing outside the sessions root is touched.
		const decoy = join(env.storageDir, "not-sessions");
		mkdirSync(decoy, { recursive: true });
		writeFileSync(join(decoy, "keep.txt"), "keep");
		expect(() => pruneBackgroundSession(UUID_B)).not.toThrow();
		expect(existsSync(join(decoy, "keep.txt"))).toBe(true);
		// A same-id dir OUTSIDE `sessions/` is never the prune target.
		const sibling = join(env.storageDir, UUID_B);
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(sibling, "keep.txt"), "keep");
		pruneBackgroundSession(UUID_B);
		expect(existsSync(join(sibling, "keep.txt"))).toBe(true);
	});
});

describe("U3 T5 — background recovery posture snapshot", () => {
	it("writes the posture onto the agent record and the run entry", async () => {
		mocks.session.prompt.mockReturnValue(new Promise(() => {}));
		fakePi.appendEntry.mockClear();
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "bg posture",
			recoveryPosture: "off",
		});
		expect(getAgent(agent.id)?.recoveryPosture).toBe("off");
		const runEntry = fakePi.appendEntry.mock.calls
			.map((c) => c[1] as { id?: string; status?: string; recoveryPosture?: string })
			.find((d) => d?.id === agent.id && d?.status === "running");
		expect(runEntry?.recoveryPosture).toBe("off");
	});
});

/** for the three settle paths that
 * reach `finalizeRunEntry` by a route the U2 `.then`/`.catch` matrix does not
 * cover: the git-setup refusal, a synchronous `prompt()` throw, and the
 * `markTerminalBestEffort` catch-all. Each test proves the run's session dir is
 * pruned, so a future bypass of `finalizeRunEntry` on that route fails here.
 */
describe("U3 T7 — prune on the remaining settle paths", () => {
	/** The per-run session dirs still present under the sandboxed sessions root. */
	const remainingSessionDirs = (): string[] => {
		const root = join(env.storageDir, "sessions");
		return existsSync(root) ? readdirSync(root) : [];
	};

	it("git-refusal: prunes the dir when gitMode=branch setup fails", async () => {
		const nonRepo = mkdtempSync(join(tmpdir(), "brl-u3-nonrepo-"));
		try {
			mocks.session.prompt.mockReturnValue(new Promise(() => {}));
			await expect(
				spawnBackgroundSession(fakePi as never, fakeCtx as never, {
					task: "branch run",
					cwd: nonRepo,
					gitMode: "branch",
				}),
			).rejects.toThrow(/work branch setup failed/);
			await tick();
			expect(remainingSessionDirs()).toEqual([]);
		} finally {
			rmSync(nonRepo, { recursive: true, force: true });
		}
	});

	it("sync prompt() throw: prunes the dir when prompt throws synchronously", async () => {
		mocks.session.prompt.mockImplementation(() => {
			throw new Error("sync boom");
		});
		await expect(
			spawnBackgroundSession(fakePi as never, fakeCtx as never, { task: "sync throw run" }),
		).rejects.toThrow(/sync boom/);
		expect(remainingSessionDirs()).toEqual([]);
	});

	it("markTerminalBestEffort: prunes the dir when a settle step throws", async () => {
		const d = deferred();
		mocks.session.prompt.mockReturnValue(d.promise);
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "catch-all run",
		});
		const dir = backgroundSessionDir(agent.id);
		expect(existsSync(dir)).toBe(true);
		// Make a settle-handler step throw (the top-of-handler reads messages),
		// forcing the `markTerminalBestEffort` catch-all to own the finalize.
		Object.defineProperty(mocks.session, "messages", {
			configurable: true,
			get() {
				throw new Error("settle boom");
			},
		});
		d.resolve();
		await tick();
		expect(getAgent(agent.id)?.status).toBe("completed");
		expect(existsSync(dir)).toBe(false);
	});
});
