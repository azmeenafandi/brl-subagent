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
	statSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, isAbsolute as pathIsAbsolute, resolve } from "node:path";
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
	retainedSessionPointer,
	__setStorageDir,
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
/** Distinct, sweep-eligible ids for seeded (pre-existing) retained dirs. */
const UUID_SEED_1 = "33333333-3333-4333-8333-333333333331";
const UUID_SEED_2 = "33333333-3333-4333-8333-333333333332";
const UUID_SEED_3 = "33333333-3333-4333-8333-333333333333";
const UUID_SEED_4 = "33333333-3333-4333-8333-333333333334";
const UUID_SEED_5 = "33333333-3333-4333-8333-333333333335";

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

describe("issue #408 — the real SDK-created session dir is repaired owner-only", () => {
	it("chmods the per-run dir and its session file after createAgentSession", async () => {
		// The REAL SessionManager creates the per-run dir with the process
		// default (0o755), so this exercises the repair at the actual SDK
		// boundary — not only the mocked spawn path. POSIX-only: Windows
		// synthesizes modes.
		if (process.platform === "win32") return;
		mocks.session.prompt.mockReturnValue(new Promise(() => {})); // stays running
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "owner-only session dir",
		});

		const dir = backgroundSessionDir(agent.id);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		// Defense-in-depth: the flat session file is owner-only too.
		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		expect(statSync(join(dir, files[0])).mode & 0o777).toBe(0o600);
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

// ---------------------------------------------------------------------------
// Issue #404 — retain a transport-failed attempt-1 run's session dir
//
// The #401 retry preamble points at the retained dir, so the retention class is
// exactly the auto-retry class: failed + exit_error + a transport signature +
// attempt 1 + a background dispatch. Everything else keeps the T2 prune. The
// caps (count / size / age) live in session-manager.ts; these tests pin the
// behaviour, not the numbers, except where a number is the mechanism.
// ---------------------------------------------------------------------------

/** The retention brand written by the settle path. */
const RETAINED_MARKER = ".transport-retained";

function markerPath(dir: string): string {
	return join(dir, RETAINED_MARKER);
}

/**
 * Grow the session file past the retention size floor. A mocked SDK session is
 * a few hundred bytes; a real one is MBs by the time a transport drop happens.
 */
function inflateSession(file: string): void {
	appendFileSync(file, `${JSON.stringify({ type: "message", padding: "x".repeat(4096) })}\n`);
}

interface TransportFailOptions {
	attempt?: number;
	/** Skip the size-floor inflation (a start-entry-only session). */
	keepTiny?: boolean;
	/** Bytes to extend the session file to (sparse; for the size caps). */
	truncateTo?: number;
	/** Called after the spawn, before the failure lands. */
	beforeFail?: (agent: { id: string; _sessionFile?: string }) => void;
}

/** Spawn, optionally tamper, then settle with a transport-class failure. */
async function spawnTransportFail(
	options: TransportFailOptions = {},
): Promise<{ id: string; dir: string; file: string }> {
	const d = deferred();
	mocks.session.prompt.mockReturnValue(d.promise);
	const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
		task: "transport run",
		originalParams: { background: true, errorCategory: "exit_error" },
		...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
	});
	const dir = backgroundSessionDir(agent.id);
	const file = agent._sessionFile!;
	if (options.truncateTo !== undefined) truncateSync(file, options.truncateTo);
	else if (!options.keepTiny) inflateSession(file);
	options.beforeFail?.(agent);
	d.reject(new Error("Connection error."));
	await tick();
	return { id: agent.id, dir, file };
}

/** A pre-existing retained dir, marked `daysOld` days ago, holding `bytes`. */
function seedRetainedDir(id: string, daysOld: number, bytes: number): string {
	const dir = backgroundSessionDir(id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "seed.jsonl"), "{}\n");
	if (bytes > 0) truncateSync(join(dir, "seed.jsonl"), bytes);
	writeFileSync(markerPath(dir), "seeded\n");
	const when = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
	utimesSync(markerPath(dir), when, when);
	return dir;
}

/** Marked session dirs currently under the sandboxed sessions root. */
function markedDirs(): string[] {
	const root = join(env.storageDir, "sessions");
	if (!existsSync(root)) return [];
	return readdirSync(root).filter((name) => existsSync(markerPath(join(root, name))));
}

describe("U3 T6 — issue #404: a transport-failed attempt-1 run retains its session", () => {
	it("settles failed, keeps the conversation and brands the dir", async () => {
		const { id, dir } = await spawnTransportFail();
		expect(getAgent(id)?.status).toBe("failed");
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(markerPath(dir))).toBe(true);
		// The conversation itself is what the retry's child is pointed at.
		expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length).toBeGreaterThan(0);
	});

	it("prunes an attempt-2 transport failure (the preamble only serves attempt 1)", async () => {
		const { id, dir } = await spawnTransportFail({ attempt: 2 });
		expect(getAgent(id)?.status).toBe("failed");
		expect(existsSync(dir)).toBe(false);
	});

	it("prunes a non-transport failure — retention is the auto-retry class only", async () => {
		const d = deferred();
		mocks.session.prompt.mockReturnValue(d.promise);
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "provider failure run",
			originalParams: { background: true },
		});
		const dir = backgroundSessionDir(agent.id);
		inflateSession(agent._sessionFile!);
		d.reject(new Error("provider exploded"));
		await tick();

		expect(getAgent(agent.id)?.status).toBe("failed");
		expect(existsSync(dir)).toBe(false);
	});

	it("prunes a completed run", async () => {
		const d = deferred();
		mocks.session.prompt.mockReturnValue(d.promise);
		mocks.session.messages = [
			{ role: "user", content: "task" },
			{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		];
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "completed run",
			originalParams: { background: true },
		});
		const dir = backgroundSessionDir(agent.id);
		inflateSession(agent._sessionFile!);
		d.resolve();
		await tick();

		expect(getAgent(agent.id)?.status).toBe("completed");
		expect(existsSync(dir)).toBe(false);
	});

	it("does not throw on an empty session dir (nothing to retain)", async () => {
		const { id, dir, file } = await spawnTransportFail({
			keepTiny: true,
			beforeFail: (agent) => rmSync(agent._sessionFile!, { force: true }),
		});
		expect(existsSync(file)).toBe(false);
		expect(existsSync(dir)).toBe(false);
		expect(getAgent(id)?.status).toBe("failed");
	});

	it("leaves an interrupted run UNMARKED when it later settles transport-failed", async () => {
		const d = deferred();
		mocks.session.prompt.mockReturnValue(d.promise);
		const agent = await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
			task: "interrupted transport run",
			originalParams: { background: true, errorCategory: "exit_error" },
		});
		const dir = backgroundSessionDir(agent.id);
		inflateSession(agent._sessionFile!);
		markAgentInterrupted(agent.id, new Date().toISOString());

		d.reject(new Error("Connection error."));
		await tick();

		expect(getAgent(agent.id)?.status).toBe("failed");
		// D3 keeps the dir; #404 must not mark it, or the sweep would reclaim a
		// run that is still awaiting resolution.
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(markerPath(dir))).toBe(false);
	});

	it("prunes (and completes) when the marker cannot be written", async () => {
		const { id, dir } = await spawnTransportFail({
			beforeFail: (agent) => {
				// A directory on the marker path makes every write attempt fail.
				mkdirSync(markerPath(dirname(agent._sessionFile!)), { recursive: true });
			},
		});
		expect(getAgent(id)?.status).toBe("failed");
		expect(existsSync(dir)).toBe(false);
	});

	it("does not throw when the session dir vanished before the settle", async () => {
		const { id, dir } = await spawnTransportFail({
			beforeFail: (agent) => rmSync(dirname(agent._sessionFile!), { recursive: true, force: true }),
		});
		expect(getAgent(id)?.status).toBe("failed");
		expect(existsSync(dir)).toBe(false);
	});

	it("does not spend a slot on a start-entry-only session (size floor)", async () => {
		let size = 0;
		const { id, dir, file } = await spawnTransportFail({
			keepTiny: true,
			beforeFail: (agent) => {
				size = statSync(agent._sessionFile!).size;
			},
		});
		expect(size).toBeLessThan(2 * 1024); // the premise: nothing to read
		expect(existsSync(file)).toBe(false);
		expect(existsSync(dir)).toBe(false);
		expect(getAgent(id)?.status).toBe("failed");
	});

	it("lets a single over-cap dir survive its own settle, then the next settle reclaims it", async () => {
		const big = await spawnTransportFail({ truncateTo: 60 * 1024 * 1024 });
		expect(existsSync(big.dir)).toBe(true); // overshoot by one
		expect(existsSync(markerPath(big.dir))).toBe(true);

		const next = await spawnTransportFail();
		expect(existsSync(big.dir)).toBe(false); // the next settle reclaims it
		expect(existsSync(next.dir)).toBe(true);
	});

	it("resolves the retained-session pointer absolutely even from the default relative root", () => {
		// The one case where the resolve is load-bearing: the default STORAGE_DIR is
		// relative, and the retried child resolves against its own cwd.
		__setStorageDir(".pi/subagents-relative-pin");
		const pointer = retainedSessionPointer(UUID_A);
		expect(pathIsAbsolute(pointer)).toBe(true);
		expect(pointer).toBe(resolve(".pi/subagents-relative-pin/sessions/" + UUID_A));
	});

	it("keeps at most five marked dirs, pruning the oldest", async () => {
		const seeded = [
			seedRetainedDir(UUID_SEED_1, 5, 0),
			seedRetainedDir(UUID_SEED_2, 4, 0),
			seedRetainedDir(UUID_SEED_3, 3, 0),
			seedRetainedDir(UUID_SEED_4, 2, 0),
			seedRetainedDir(UUID_SEED_5, 1, 0),
		];
		expect(markedDirs()).toHaveLength(5);

		const settled = await spawnTransportFail();

		expect(existsSync(seeded[0])).toBe(false); // oldest
		for (const dir of seeded.slice(1)) expect(existsSync(dir)).toBe(true);
		expect(existsSync(settled.dir)).toBe(true);
		expect(markedDirs()).toHaveLength(5);
	});

	it("keeps the marked set under 50 MB, pruning the oldest", async () => {
		const first = seedRetainedDir(UUID_SEED_1, 2, 30 * 1024 * 1024);
		const second = seedRetainedDir(UUID_SEED_2, 1, 30 * 1024 * 1024);

		const settled = await spawnTransportFail();

		expect(existsSync(first)).toBe(false); // 30 + 30 + current > 50 MB
		expect(existsSync(second)).toBe(true); // one prune is enough
		expect(existsSync(settled.dir)).toBe(true);
	});

	it("prunes a marked dir older than 14 days", async () => {
		const stale = seedRetainedDir(UUID_SEED_1, 15, 0);
		const fresh = seedRetainedDir(UUID_SEED_2, 13, 0);

		await spawnTransportFail();

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("never touches an unmarked dir while sweeping", async () => {
		// An interrupted run's dir, well past every cap, must survive the sweep.
		const unmarked = backgroundSessionDir(UUID_SEED_1);
		mkdirSync(unmarked, { recursive: true });
		writeFileSync(join(unmarked, "keep.jsonl"), "{}\n");
		truncateSync(join(unmarked, "keep.jsonl"), 60 * 1024 * 1024);
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(join(unmarked, "keep.jsonl"), old, old);

		await spawnTransportFail();

		expect(existsSync(unmarked)).toBe(true);
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
