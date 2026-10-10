/**
 * Option B U1 — recovery (identity, liveness, detection engine, child reap).
 *
 * The decision engine is pure over injected dependencies, so the four-branch
 * matrix is tested without processes. The integration tests then exercise the
 * REAL Linux/POSIX /proc reads (start token + marker scan) with spawned
 * fixtures. The platform boundary is honoured in-test: `/proc`-dependent cases
 * skip (with a clear message) when `isProcAvailable()` is false.
 *
 * MUTATION SELF-CHECKS (performed by hand; recorded here so the next reader
 * knows these tests are the tripwire):
 *   - Invert the owner-alive branch in `decideRecovery` (alive → mark):
 *     "two conductors: a live owner's record is untouched" FAILS.
 *   - Reap by a recorded pid / drop the `findByMarker` verification:
 *     "never reaps a foreign process that does not carry the marker" FAILS.
 *   Both mutations were applied, observed to fail, and reverted.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	decideRecovery,
	recoverRecord,
	reapPids,
	runBootScan,
	recoverProduction,
	classifyOwner,
	defaultRecoveryDeps,
	currentProcessOwner,
	newDispatchIdentity,
	dedupeRunEntriesById,
	pidAlive,
	pidGone,
	readStartToken,
	findByMarker,
	groupHasMembers,
	isProcAvailable,
	type RecoveryDeps,
	type RecoveryRecord,
} from "../recovery";
import {
	__setProcessGroupKillSupportedForTest,
	supportsProcessGroupKill,
} from "../kill-escalation";
import { registerInflightRun, registryDir, __setRegistryDir } from "../run-registry";
import { isInterruptedRun, isSubagentRunShape, type ProcessOwner, type SubagentRun } from "../types";
import { resolveTerminalRunEntry } from "../state";
import { CHILD_MARKER_ENV_KEY } from "../sanitize";
import {
	activeChildCount,
	reapActiveChildren,
	runSubagent,
	__setEscalationTimingForTest,
	__registerActiveChildForTest,
} from "../runner";
import { listPersistedAgents, markAgentInterrupted } from "../session-manager";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// #299 fix A.2 — deterministic `/proc` inspection failure for the tri-state
// integration test (T-new). The mock is a TRANSPARENT wrapper: with no control
// flag set it delegates every call to the real `node:fs`, so every other test in
// this file is unaffected.
// ---------------------------------------------------------------------------

const groupScanControl = vi.hoisted(() => ({
	readdirError: undefined as NodeJS.ErrnoException | undefined,
	statErrors: new Map<string, NodeJS.ErrnoException>(),
	statContents: new Map<string, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: ((...args: unknown[]) => {
			if (groupScanControl.readdirError) throw groupScanControl.readdirError;
			return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
		}) as typeof actual.readdirSync,
		readFileSync: ((...args: unknown[]) => {
			const file = String(args[0]);
			const err = groupScanControl.statErrors.get(file);
			if (err) throw err;
			const contents = groupScanControl.statContents.get(file);
			if (contents !== undefined) return contents;
			return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
		}) as typeof actual.readFileSync,
	};
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALIVE_PID = 4242;
const DEAD_PID = 999_999_999;
const ALIVE_OWNER = { pid: ALIVE_PID, start: "100" };
const DEAD_OWNER = { pid: DEAD_PID, start: "100" };

/** Build injected deps: only ALIVE_PID is alive, with a matching start token. */
function makeDeps(overrides: Partial<RecoveryDeps> = {}): RecoveryDeps {
	return {
		pidAlive: (pid) => pid === ALIVE_PID,
		startTokenOf: (pid) => (pid === ALIVE_PID ? "100" : undefined),
		findByMarker: () => [],
		kill: vi.fn(),
		sleep: async () => {},
		graceMs: 0,
		...overrides,
	};
}

function record(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
	return { id: "rec-1", kind: "run", status: "running", ...overrides };
}

function spawnSleeper(env: NodeJS.ProcessEnv = process.env): ChildProcess {
	return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
		env,
	});
}

async function waitForSpawn(child: ChildProcess): Promise<number> {
	// `pid` is assigned by the time spawn() returns; only wait for the event when
	// it is not (so a listener attached after the event cannot hang).
	if (child.pid === undefined) await once(child, "spawn");
	if (child.pid === undefined) throw new Error("spawned child has no pid");
	return child.pid;
}

async function waitUntil(
	predicate: () => boolean,
	timeoutMs = 5000,
	throwOnTimeout = true,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			if (throwOnTimeout) throw new Error("waitUntil timed out");
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const spawned: ChildProcess[] = [];
function track(child: ChildProcess): ChildProcess {
	spawned.push(child);
	return child;
}

/**
 * Pids launched as a GRANDCHILD of a wrapper (not a direct ChildProcess of this
 * test process), so they need their own cleanup. A test adds the pid it reads
 * from the readiness file; afterEach force-kills any survivor.
 */
const strayPids = new Set<number>();

afterEach(async () => {
	for (const child of spawned.splice(0)) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
	for (const pid of strayPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	strayPids.clear();
	// #299 fix A.2: never leak a forced `/proc` inspection failure into the next
	// test (the node:fs mock is transparent when these are clear).
	groupScanControl.readdirError = undefined;
	groupScanControl.statErrors.clear();
	groupScanControl.statContents.clear();
	// Any test that shortened the escalation timing must not leak it into the
	// next file-scoped test (idempotent reset to production timing).
	__setEscalationTimingForTest();
	// Likewise restore real process-group capability detection after T5.
	__setProcessGroupKillSupportedForTest(undefined);
});

// ---------------------------------------------------------------------------
// 1. Pure decision matrix
// ---------------------------------------------------------------------------

describe("recovery decision matrix (pure)", () => {
	it("idempotent-skip: a marked record with no leftover child is skipped", () => {
		const plan = decideRecovery(
			record({ interruptedAt: "2026-10-09T00:00:00.000Z", owner: DEAD_OWNER, childMarker: "m" }),
			makeDeps({ findByMarker: () => [] }),
		);
		expect(plan).toEqual({ decision: "skip", reason: "already-interrupted" });
	});

	it("B2: a marked record with a live marker child is revisited (reap-only, never re-marked)", async () => {
		const deps = makeDeps({ findByMarker: () => [555] });
		const marked = record({
			interruptedAt: "2026-10-09T00:00:00.000Z",
			owner: DEAD_OWNER,
			childMarker: "m",
		});
		expect(decideRecovery(marked, deps)).toEqual({
			decision: "reap",
			reason: "revisit-interrupted",
			reap: [555],
		});
		const outcome = await recoverRecord(marked, deps);
		expect(outcome).toMatchObject({ decision: "reap", reason: "revisit-interrupted", reaped: [555] });
	});

	it("owner-alive: a live owner's record is skipped and nothing is killed", () => {
		const kill = vi.fn();
		const plan = decideRecovery(
			record({ owner: ALIVE_OWNER, childMarker: "m" }),
			makeDeps({ kill, findByMarker: () => [DEAD_PID] }),
		);
		expect(plan).toEqual({ decision: "skip", reason: "owner-alive" });
		expect(kill).not.toHaveBeenCalled();
	});

	it("owner-dead-mark: a dead owner with no marker match is marked", () => {
		const plan = decideRecovery(
			record({ owner: DEAD_OWNER, childMarker: "m" }),
			makeDeps({ findByMarker: () => [] }),
		);
		expect(plan).toEqual({ decision: "mark", reason: "owner-dead", reap: [] });
	});

	it("marker-found-reap: a dead owner plus a verified marker match reaps and marks", () => {
		const plan = decideRecovery(
			record({ owner: DEAD_OWNER, childMarker: "m" }),
			makeDeps({ findByMarker: () => [555, 556] }),
		);
		expect(plan).toEqual({ decision: "mark", reason: "child-orphaned", reap: [555, 556] });
	});

	it("ownership-unverifiable: alive but no start token → leave untouched", () => {
		const plan = decideRecovery(
			record({ owner: ALIVE_OWNER, childMarker: "m" }),
			makeDeps({ startTokenOf: () => undefined }),
		);
		expect(plan).toEqual({ decision: "skip", reason: "ownership-unverifiable" });
		expect(classifyOwner(ALIVE_OWNER, makeDeps({ startTokenOf: () => undefined }))).toBe("unknown");
	});

	it("ownership-unverifiable: an empty recorded start token is never acted on", () => {
		const plan = decideRecovery(
			record({ owner: { pid: ALIVE_PID, start: "" }, childMarker: "m" }),
			makeDeps({ findByMarker: () => [555] }),
		);
		expect(plan).toEqual({ decision: "skip", reason: "ownership-unverifiable" });
	});

	it("no-owner: a record with no recorded owner is left untouched", () => {
		const plan = decideRecovery(record({ childMarker: "m" }), makeDeps({ findByMarker: () => [1] }));
		expect(plan).toEqual({ decision: "skip", reason: "no-owner" });
	});

	it("B3: absent owner skips and the kill path is never touched", async () => {
		const kill = vi.fn();
		const deps = makeDeps({ kill, findByMarker: () => [555] });
		const outcome = await recoverRecord(record({ childMarker: "m" }), deps);
		expect(outcome).toMatchObject({ decision: "skip", reason: "no-owner", reaped: [] });
		expect(kill).not.toHaveBeenCalled();
	});

	it("B3: present-but-unparsable owner is mark-only (owner-unverifiable), never killed", async () => {
		// The deliberate U1 split: a corrupt owner object still proves the run
		// was interrupted, but ownership is unverifiable → mark, never reap.
		const badOwners = [{}, { pid: "not-a-pid" }, { pid: 0 }, { pid: -5 }, { pid: NaN }, { pid: 1.5 }] as unknown as ProcessOwner[];
		for (const owner of badOwners) {
			const kill = vi.fn();
			const deps = makeDeps({ kill, findByMarker: () => [555] });
			expect(decideRecovery(record({ owner, childMarker: "m" }), deps)).toEqual({
				decision: "mark",
				reason: "owner-unverifiable",
				reap: [],
			});
			const outcome = await recoverRecord(record({ owner, childMarker: "m" }), deps);
			expect(outcome).toMatchObject({ decision: "mark", reason: "owner-unverifiable", reaped: [] });
			expect(kill).not.toHaveBeenCalled();
		}
	});

	it("recoverRecord escalates SIGTERM → SIGKILL for a survivor", async () => {
		const kill = vi.fn();
		const deps = makeDeps({
			findByMarker: () => [555],
			kill,
			// survive SIGTERM (pidAlive stays true), then die on SIGKILL
			pidAlive: (pid) => pid === 555 || pid === ALIVE_PID,
		});
		const outcome = await recoverRecord(record({ owner: DEAD_OWNER, childMarker: "m" }), deps);
		expect(kill.mock.calls).toEqual([
			[555, "SIGTERM"],
			[555, "SIGKILL"],
		]);
		expect(outcome.reaped).toEqual([555]);
	});

	it("a marker-absent record never triggers a kill (foreign-process guard)", async () => {
		const kill = vi.fn();
		const deps = makeDeps({ findByMarker: () => [], kill });
		const outcome = await recoverRecord(record({ owner: DEAD_OWNER, childMarker: "absent" }), deps);
		expect(outcome.decision).toBe("mark");
		expect(kill).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Dispatch identity (fresh vs retry)
// ---------------------------------------------------------------------------

describe("newDispatchIdentity (D4 record identity)", () => {
	it("a fresh dispatch mints a dispatchId with attempt 1 and no resumeOf", () => {
		const identity = newDispatchIdentity(undefined);
		expect(identity.attempt).toBe(1);
		expect(identity.resumeOf).toBeUndefined();
		expect(identity.dispatchId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("a retry inherits dispatchId and increments attempt", () => {
		const original = { id: "orig", dispatchId: "disp-1" } as SubagentRun;
		expect(newDispatchIdentity(original)).toEqual({ dispatchId: "disp-1", resumeOf: "orig", attempt: 2 });
		const second = { id: "orig-2", dispatchId: "disp-1", attempt: 2 } as SubagentRun;
		expect(newDispatchIdentity(second)).toEqual({ dispatchId: "disp-1", resumeOf: "orig-2", attempt: 3 });
	});

	it("a retry of a pre-U1 record (no dispatchId) mints one", () => {
		const identity = newDispatchIdentity({ id: "old" } as SubagentRun);
		expect(identity.resumeOf).toBe("old");
		expect(identity.attempt).toBe(2);
		expect(identity.dispatchId).toMatch(/^[0-9a-f-]{36}$/);
	});
});

// ---------------------------------------------------------------------------
// Candidate projection (dedupe)
// ---------------------------------------------------------------------------

describe("run-entry dedupe before the scan", () => {
	const base = { task: "t", startedAt: "2026-10-09T00:00:00.000Z" };
	const spawnEntry: SubagentRun = { ...base, id: "r", status: "running" };
	const terminalEntry: SubagentRun = { ...base, id: "r", status: "done", finishedAt: base.startedAt };
	const markedEntry: SubagentRun = { ...base, id: "r", status: "running", interruptedAt: "2026-10-09T01:00:00.000Z" };

	it("prefers a terminal entry over a stale running spawn entry (either order)", () => {
		expect(dedupeRunEntriesById([spawnEntry, terminalEntry])).toEqual([terminalEntry]);
		expect(dedupeRunEntriesById([terminalEntry, spawnEntry])).toEqual([terminalEntry]);
	});

	it("prefers an interrupted mark over the unmarked spawn entry", () => {
		expect(dedupeRunEntriesById([spawnEntry, markedEntry])).toEqual([markedEntry]);
	});

	it("B1: dedupe and resolveTerminalRunEntry agree on the marked-vs-spawn pair", () => {
		// The historical duplicate rule picked the marked clone while the shared
		// resolver picked the unmarked spawn. The rule is now ONE: among
		// non-terminal entries the `interruptedAt` clone wins, so U3's shared
		// lookup reads the recovered state.
		const resolved = resolveTerminalRunEntry([spawnEntry, markedEntry], "r");
		const deduped = dedupeRunEntriesById([spawnEntry, markedEntry]);
		expect(resolved).toBe(markedEntry);
		expect(resolved?.interruptedAt).toBe("2026-10-09T01:00:00.000Z");
		expect(deduped).toEqual([resolved]);
	});

	it("a terminal entry still beats both the spawn and the interrupted clone", () => {
		expect(dedupeRunEntriesById([spawnEntry, markedEntry, terminalEntry])).toEqual([terminalEntry]);
		expect(resolveTerminalRunEntry([spawnEntry, markedEntry, terminalEntry], "r")).toBe(terminalEntry);
	});

	it("a completed run is never marked (terminal entry wins over the stale spawn)", async () => {
		const owner = DEAD_OWNER;
		const records: RecoveryRecord[] = dedupeRunEntriesById([spawnEntry, terminalEntry]).map((r) => ({
			id: r.id,
			kind: "run",
			status: r.status,
			interruptedAt: r.interruptedAt,
			owner,
		}));
		const marked: string[] = [];
		const summary = await runBootScan({ records, deps: makeDeps(), mark: (r) => marked.push(r.id) });
		expect(summary.marked).toBe(0);
		expect(marked).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 5. Idempotency
// ---------------------------------------------------------------------------

describe("boot scan idempotency", () => {
	it("scanning twice marks once (the second pass is a no-op)", async () => {
		const records = [record({ owner: DEAD_OWNER, childMarker: "m" })];
		const deps = makeDeps({ findByMarker: () => [555] });
		const marked: string[] = [];
		const first = await runBootScan({ records, deps, mark: (r) => marked.push(r.id) });
		const second = await runBootScan({ records, deps, mark: (r) => marked.push(r.id) });
		expect(first.marked).toBe(1);
		expect(second.marked).toBe(0);
		expect(marked).toEqual(["rec-1"]);
	});
});

// ---------------------------------------------------------------------------
// 7. Record shape tolerance
// ---------------------------------------------------------------------------

describe("isSubagentRunShape tolerance", () => {
	it("parses a run record carrying every new durability field", () => {
		const run: Partial<SubagentRun> = {
			id: "r1",
			task: "t",
			status: "running",
			dispatchId: "d1",
			resumeOf: "r0",
			attempt: 2,
			interruptedAt: "2026-10-09T00:00:00.000Z",
			owner: { pid: 1, start: "2" },
			childMarker: "m1",
		};
		expect(isSubagentRunShape(run)).toBe(true);
	});

	it("still rejects a malformed record", () => {
		expect(isSubagentRunShape({ id: "r", task: "t", status: "bogus" })).toBe(false);
	});

	it("isInterruptedRun keys on running + interruptedAt, never a status value", () => {
		expect(isInterruptedRun({ id: "r", task: "t", status: "running", interruptedAt: "iso" } as SubagentRun)).toBe(true);
		expect(isInterruptedRun({ id: "r", task: "t", status: "running" } as SubagentRun)).toBe(false);
		expect(isInterruptedRun({ id: "r", task: "t", status: "done", interruptedAt: "iso" } as SubagentRun)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Real /proc reading sanity
// ---------------------------------------------------------------------------

describe("real /proc reads (Linux)", () => {
	it("reads a numeric start token for the current process", () => {
		if (!isProcAvailable()) return;
		expect(readStartToken(process.pid)).toMatch(/^\d+$/);
		expect(currentProcessOwner()).toEqual({ pid: process.pid, start: readStartToken(process.pid) });
	});

	it("findByMarker ignores a process that does not carry the marker", async () => {
		if (!isProcAvailable()) return;
		const foreign = track(spawnSleeper());
		await waitForSpawn(foreign);
		expect(findByMarker(`marker-nobody-has-${crypto.randomUUID()}`)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3. Two conductors: a live owner's records stay untouched
// ---------------------------------------------------------------------------

describe("two conductors in one cwd", () => {
	it("a live owner's record is untouched (this test process's own identity)", async () => {
		if (!isProcAvailable()) return;
		const owner = currentProcessOwner();
		const records = [
			record({ id: "live-1", owner, childMarker: `foreign-${crypto.randomUUID()}` }),
		];
		const deps = defaultRecoveryDeps();
		const marked: string[] = [];
		const summary = await runBootScan({ records, deps, mark: (r) => marked.push(r.id) });
		expect(summary.marked).toBe(0);
		expect(summary.skipped).toBe(1);
		expect(marked).toEqual([]);
		expect(decideRecovery(records[0], deps)).toEqual({ decision: "skip", reason: "owner-alive" });
	});
});

// ---------------------------------------------------------------------------
// 2. Real /proc integration: dead conductor, orphaned child
// ---------------------------------------------------------------------------

describe("real /proc integration", () => {
	const env = createTempEnv("brl-recovery", { withCwd: false });

	beforeAll(() => {
		env.setUp();
		fs.mkdirSync(env.storageDir, { recursive: true });
	});
	afterAll(async () => {
		await env.tearDown();
	});

	it("B2: a marked record with a live marker child is revisited and reaped on boot (never re-marked)", async () => {
		if (!isProcAvailable()) return;

		const marker = `revisit-${crypto.randomUUID()}`;
		const orphan = track(spawnSleeper({ ...process.env, [CHILD_MARKER_ENV_KEY]: marker }));
		const orphanPid = await waitForSpawn(orphan);
		await waitUntil(() => findByMarker(marker).includes(orphanPid));

		const rec = record({
			id: crypto.randomUUID(),
			interruptedAt: "2026-10-09T00:00:00.000Z",
			owner: { pid: DEAD_PID, start: "100" },
			childMarker: marker,
		});
		let marks = 0;
		const deps = { ...defaultRecoveryDeps(), sleep: async () => {}, graceMs: 0 };
		const summary = await runBootScan({ records: [rec], deps, mark: () => { marks++; } });

		await waitUntil(() => !pidAlive(orphanPid));
		expect(pidAlive(orphanPid)).toBe(false);
		expect(marks).toBe(0); // already-interrupted is never re-marked
		expect(summary.marked).toBe(0);
		expect(summary.revisited).toBe(1);
		expect(summary.reaped).toBe(1);
	});

	it("reaps a marker-verified orphan and marks both records", async () => {
		if (!isProcAvailable()) return;

		// The "conductor" fixture — recorded as owner, then killed.
		const parent = track(spawnSleeper());
		const parentPid = await waitForSpawn(parent);
		const start = readStartToken(parentPid);
		expect(start).toBeDefined();
		parent.kill("SIGKILL");
		await once(parent, "exit");
		const owner = { pid: parentPid, start: start! };

		// The orphan child — carries the run's marker.
		const marker = `marker-${crypto.randomUUID()}`;
		const orphan = track(spawnSleeper({ ...process.env, [CHILD_MARKER_ENV_KEY]: marker }));
		const orphanPid = await waitForSpawn(orphan);
		await waitUntil(() => findByMarker(marker).includes(orphanPid));

		// Two persisted records for the dead run: an agent record on disk and a
		// session run entry. Both carry the same owner + marker.
		const agentId = crypto.randomUUID();
		fs.writeFileSync(
			path.join(env.storageDir, `${agentId}.json`),
			JSON.stringify({
				id: agentId,
				sessionId: agentId,
				type: "general-purpose",
				description: "orphan test",
				status: "running",
				startedAt: Date.now(),
				task: "t",
				model: "m",
				thinkingLevel: "medium",
				dispatchId: "d",
				owner,
				childMarker: marker,
			}),
		);

		const runId = crypto.randomUUID();
		const runEntry: RecoveryRecord = {
			id: runId,
			kind: "run",
			status: "running",
			owner,
			childMarker: marker,
			source: {},
		};

		const agentRecords = listPersistedAgents().filter((a) => a.id === agentId);
		expect(agentRecords).toHaveLength(1);
		const records: RecoveryRecord[] = [
			runEntry,
			{
				id: agentRecords[0].id,
				kind: "agent",
				status: agentRecords[0].status,
				interruptedAt: agentRecords[0].interruptedAt,
				owner: agentRecords[0].owner,
				childMarker: agentRecords[0].childMarker,
				source: agentRecords[0],
			},
		];

		const marked: string[] = [];
		const deps = { ...defaultRecoveryDeps(), sleep: async () => {}, graceMs: 0 };
		const summary = await runBootScan({
			records,
			deps,
			mark: (rec, iso) => {
				marked.push(`${rec.kind}:${rec.id}`);
				if (rec.kind === "agent") markAgentInterrupted(rec.id, iso);
			},
		});

		expect(summary.marked).toBe(2);
		expect(marked).toContain(`agent:${agentId}`);
		expect(marked).toContain(`run:${runId}`);

		// Both records are marked: the agent JSON on disk, the run entry object.
		const persisted = JSON.parse(fs.readFileSync(path.join(env.storageDir, `${agentId}.json`), "utf-8"));
		expect(typeof persisted.interruptedAt).toBe("string");
		expect(runEntry.interruptedAt).toBeTruthy();

		// The orphan is gone.
		await waitUntil(() => !pidAlive(orphanPid));
		expect(pidAlive(orphanPid)).toBe(false);
	});

	it("never reaps a foreign process that does not carry the marker", async () => {
		if (!isProcAvailable()) return;
		const foreign = track(spawnSleeper());
		const foreignPid = await waitForSpawn(foreign);

		// The record's OWNER PID is the live foreign process, but the recorded
		// start token is deliberately wrong → the engine classifies the owner as
		// dead (pid reuse) and would, WITHOUT marker verification, reap foreignPid.
		// The marker matches nobody, so a correct engine only marks.
		const records = [
			record({
				id: "foreign-guard",
				owner: { pid: foreignPid, start: "0" },
				childMarker: `marker-absent-${crypto.randomUUID()}`,
			}),
		];
		const deps = { ...defaultRecoveryDeps(), sleep: async () => {}, graceMs: 0 };
		const summary = await runBootScan({ records, deps, mark: () => {} });

		expect(summary.marked).toBe(1);
		expect(summary.reaped).toBe(0);
		expect(pidAlive(foreignPid)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 4. Shutdown reap
// ---------------------------------------------------------------------------

/**
 * Create a temp dir, write one executable wrapper script into it, point
 * BRL_PI_BIN at it for the duration of `fn`, then restore the environment and
 * remove the dir (issue #306 nit 4 — the setup/cleanup formerly duplicated by
 * withSleepWrapper and withIgnoreTermWrapper). `writeScript` returns the script
 * path; `fn` receives the temp dir so it can place sibling files (e.g. a
 * readiness marker).
 */
async function withTempPiBin<T>(
	prefix: string,
	writeScript: (dir: string) => string,
	fn: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const script = writeScript(dir);
	const previous = process.env.BRL_PI_BIN;
	process.env.BRL_PI_BIN = script;
	try {
		return await fn(dir);
	} finally {
		if (previous === undefined) delete process.env.BRL_PI_BIN;
		else process.env.BRL_PI_BIN = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * A wrapper that ignores pi's args and sleeps — lets runSubagent spawn a
 * long-lived child we can reap without touching a real model. Runs `fn` with
 * BRL_PI_BIN pointed at it and always restores the environment.
 */
async function withSleepWrapper<T>(fn: () => Promise<T>): Promise<T> {
	return withTempPiBin(
		"brl-reap-",
		(dir) => {
			const script = path.join(dir, "sleep.sh");
			fs.writeFileSync(script, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
			return script;
		},
		fn,
	);
}

/**
 * A wrapper that spawns a long-lived `bash` GRANDCHILD (which inherits the
 * per-run marker env from the wrapper) and then waits. Models the realistic
 * child→grandchild tree the marker scan must cover (#299). By default the
 * grandchild inherits the marker; with `stripMarker` it is launched via
 * `env -u BRL_SUBAGENT_CHILD_MARKER`, modelling an env-scrubbing/setsid subtree
 * the marker scan CANNOT see (the Option B boundary).
 *
 * The grandchild ignores SIGHUP and `exec`s, so killing the wrapper cannot kill
 * it indirectly — a survival assertion then honestly measures the MARKER
 * boundary, not shell job-control side effects. Writes the grandchild pid to
 * `<dir>/grandchild.pid`; `fn` receives that path plus the wrapper script path
 * (so a caller can spawn the wrapper directly without `runSubagent`).
 */
async function withGrandchildWrapper<T>(
	fn: (pidFile: string, script: string) => Promise<T>,
	stripMarker = false,
): Promise<T> {
	return withTempPiBin(
		"brl-grandchild-",
		(dir) => {
			const script = path.join(dir, "grandchild.sh");
			const pidFile = path.join(dir, "grandchild.pid");
			// The inner bash writes its OWN pid (`$$`): `$!` in the outer shell can name
			// a subshell rather than the process carrying the (possibly stripped)
			// environment. `exec sleep` keeps that pid. `trap "" HUP` keeps the
			// grandchild alive when the wrapper dies, so a survival assertion measures
			// the MARKER boundary, not shell job-control. stdio goes to /dev/null as a
			// daemonized process would, so it does not hold the conductor's pipes open.
			const launcher =
				`${stripMarker ? `env -u ${CHILD_MARKER_ENV_KEY} ` : ""}` +
				`bash -c 'echo $$ > ${JSON.stringify(pidFile)}; trap "" HUP; exec sleep 300' >/dev/null 2>&1 &`;
			fs.writeFileSync(script, `#!/bin/sh\n${launcher}\nwait\n`, { mode: 0o755 });
			return script;
		},
		(dir) => fn(path.join(dir, "grandchild.pid"), path.join(dir, "grandchild.sh")),
	);
}

/** Wait for the wrapper's readiness (grandchild pid) file and return its pid. */
async function readGrandchildPid(pidFile: string): Promise<number> {
	await waitUntil(() => fs.existsSync(pidFile), 5000);
	const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad grandchild pid in ${pidFile}`);
	strayPids.add(pid);
	return pid;
}

/**
 * Field 5 of `/proc/<pid>/stat` — the process group id. Parsed after the LAST
 * `)` so a `(comm)` containing spaces or parens cannot shift the fields.
 */
function readProcessGroup(pid: number): number {
	const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
	const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
	return Number(rest[2]);
}

/**
 * Spy on `process.kill`, recording every PROCESS-GROUP dispatch (negative pid).
 * `groupTarget`/`killProcessGroup` reach groups via `kill(-pgid)`, so this is
 * the exact observation of group signaling; direct pid signals stay positive.
 * The mock calls through, so direct signals and `kill -0` liveness still work.
 */
function spyOnProcessKillGroups(): { groupPids: number[]; restore: () => void } {
	const groupPids: number[] = [];
	const original = process.kill;
	const spy = vi.spyOn(process, "kill").mockImplementation(((
		pid: number,
		signal?: NodeJS.Signals | number,
	) => {
		if (typeof pid === "number" && pid < 0) groupPids.push(pid);
		return original(pid, signal as NodeJS.Signals);
	}) as typeof process.kill);
	return { groupPids, restore: () => spy.mockRestore() };
}

/**
 * A DETACHED leader that spawns a member IGNORING SIGTERM and then EXITS, while
 * the member stays alive in the leader's group. The member writes `readyFile`
 * AFTER installing its SIGTERM handler (the #303 handshake), so a group SIGTERM
 * cannot kill it by Node's default disposition before it is actually stubborn.
 *
 * Leader already dead + TERM-stubborn member still alive is exactly the D5
 * case: `verifyDeath()` is true from the start, so the survivor `forceKill` can
 * never run — only the UNCONDITIONAL final group SIGKILL can end the member.
 */
function spawnStubbornGroup(memberPidFile: string, readyFile: string): ChildProcess {
	const memberCode =
		`const fs=require('node:fs');` +
		`process.on('SIGTERM',()=>{});` +
		`fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');` +
		`setInterval(()=>{},1000)`;
	const leaderCode =
		`const {spawn}=require('node:child_process');const fs=require('node:fs');` +
		`const m=spawn(process.execPath,['-e',${JSON.stringify(memberCode)}],{stdio:'ignore'});` +
		`fs.writeFileSync(${JSON.stringify(memberPidFile)}, String(m.pid));` +
		// The member refs the leader's event loop; exit explicitly so the leader is
		// gone while the member keeps the group alive.
		`process.exit(0);`;
	return spawn(process.execPath, ["-e", leaderCode], { stdio: "ignore", detached: true });
}

/**
 * A DETACHED leader that spawns a member which handles SIGTERM with a
 * `cleanupMs` delay, writes `doneFile` when finished, then exits. The leader
 * dies on SIGTERM (default disposition). Models the #299 review Major 2 case:
 * the leader exits fast while a same-group member is still cleaning up — a
 * leader-only death check would SIGKILL the member mid-cleanup. `env` carries
 * the run marker so the production signal-time verifier accepts the leader.
 */
function spawnGracefulGroup(
	memberPidFile: string,
	readyFile: string,
	doneFile: string,
	cleanupMs: number,
	env: NodeJS.ProcessEnv,
): ChildProcess {
	const memberCode =
		`const fs=require('node:fs');` +
		`process.on('SIGTERM',()=>{` +
		`setTimeout(()=>{fs.writeFileSync(${JSON.stringify(doneFile)}, String(Date.now()));process.exit(0);}, ${cleanupMs});` +
		`});` +
		`fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');` +
		`setInterval(()=>{},1000)`;
	const leaderCode =
		`const {spawn}=require('node:child_process');const fs=require('node:fs');` +
		`const m=spawn(process.execPath,['-e',${JSON.stringify(memberCode)}],{stdio:'ignore'});` +
		`fs.writeFileSync(${JSON.stringify(memberPidFile)}, String(m.pid));` +
		`setInterval(()=>{},1000)`;
	return spawn(process.execPath, ["-e", leaderCode], { stdio: "ignore", detached: true, env });
}

/**
 * The production recovery deps with the `kill`/`killGroup` primitives wrapped by
 * recorders that call through — the exact observation of signal dispatch for the
 * #299 review A1/A2 tests.
 */
function recordingDeps(overrides: Partial<RecoveryDeps> = {}) {
	const base = defaultRecoveryDeps();
	const killCalls: Array<[number, NodeJS.Signals]> = [];
	const groupCalls: Array<[number, NodeJS.Signals]> = [];
	const deps: RecoveryDeps = {
		...base,
		kill: (pid, signal) => {
			killCalls.push([pid, signal]);
			base.kill(pid, signal);
		},
		killGroup: base.killGroup
			? (pgid, signal) => {
					groupCalls.push([pgid, signal]);
					base.killGroup!(pgid, signal);
				}
			: undefined,
		...overrides,
	};
	return { deps, killCalls, groupCalls };
}

/** Launch one wrapper child with a per-run marker (and optional abort signal). */
function launchForeground(marker: string, timeout?: number, signal?: AbortSignal) {
	return runSubagent(
		process.cwd(),
		"",
		{ provider: "test", id: "test/model" },
		"off",
		"noop",
		signal,
		undefined,
		undefined,
		timeout,
		() => "",
		undefined,
		0,
		undefined,
		undefined,
		marker,
	);
}

/**
 * A single-process wrapper that IGNORES SIGTERM and stays alive (issue #303).
 * A Node shebang script, not a shell script wrapping `sleep`: the SIGKILL the
 * escalation sends lands on the one process, so the test leaves no orphan.
 *
 * The script writes `readyFile` AFTER installing its SIGTERM handler, so the
 * test can wait for the handler to be live before triggering the escalation —
 * otherwise SIGTERM could land during Node startup and kill the child by the
 * default disposition, faking a pass/fail for the wrong reason.
 */
async function withIgnoreTermWrapper<T>(fn: (readyFile: string) => Promise<T>): Promise<T> {
	return withTempPiBin(
		"brl-ignore-term-",
		(dir) => {
			const script = path.join(dir, "ignore-term.js");
			fs.writeFileSync(
				script,
				`#!/usr/bin/env node\n` +
					`const fs = require("node:fs");\n` +
					`process.on("SIGTERM", () => {});\n` +
					`fs.writeFileSync(${JSON.stringify(path.join(dir, "ready"))}, "ready");\n` +
					`setInterval(() => {}, 1000);\n`,
				{ mode: 0o755 },
			);
			return script;
		},
		(dir) => fn(path.join(dir, "ready")),
	);
}

/**
 * Record every signal `ChildProcess.prototype.kill` receives (with the target
 * pid), then call through. The runner's kill paths go through `proc.kill(...)`,
 * so this is an exact observation of SIGTERM/SIGKILL delivery — issue #303's
 * "force-kill spy".
 */
/** One recorded `kill()` call: the signal, the target pid, and when it landed. */
interface KillCall {
	signal: string;
	pid: number | undefined;
	at: number;
}

function spyOnChildKill(): { calls: KillCall[] } {
	const calls: KillCall[] = [];
	const original = ChildProcess.prototype.kill;
	vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (
		this: ChildProcess,
		signal?: NodeJS.Signals | number,
	) {
		calls.push({ signal: String(signal), pid: this.pid, at: Date.now() });
		return original.call(this, signal as NodeJS.Signals);
	});
	return { calls };
}

/** The pid carried by the first recorded SIGKILL, or undefined. */
function sigkillPid(calls: KillCall[]): number | undefined {
	return calls.find((c) => c.signal === "SIGKILL")?.pid;
}

/**
 * Elapsed ms from the first SIGTERM to the first SIGKILL in a kill-spy trace.
 * The stubborn-child tests run with a 100 ms grace; a regression back to the
 * full 5 s `SIGKILL_GRACE_MS` would blow the upper bound asserted on this (the
 * probe measured ~101 ms SIGTERM→SIGKILL).
 */
function escalationElapsedMs(calls: KillCall[]): number {
	const sigterm = calls.find((c) => c.signal === "SIGTERM");
	const sigkill = calls.find((c) => c.signal === "SIGKILL");
	if (!sigterm || !sigkill) {
		throw new Error("kill trace is missing its SIGTERM or SIGKILL");
	}
	return sigkill.at - sigterm.at;
}

describe("shutdown reap", () => {
	it("kills a registered in-flight child", async () => {
		await withSleepWrapper(async () => {
			const marker = `reap-${crypto.randomUUID()}`;
			const promise = launchForeground(marker);
			await waitUntil(() => activeChildCount() === 1, 5000);
			const pids = await reapActiveChildren();
			await promise;
			expect(pids).toHaveLength(1);
			expect(pidAlive(pids[0])).toBe(false);
			expect(activeChildCount()).toBe(0);
		});
	}, 20000);

	it("B4: reaps a 300ms-timeout child without the old fixed 5s wait", async () => {
		await withSleepWrapper(async () => {
			const started = Date.now();
			const marker = `reap-b4-${crypto.randomUUID()}`;
			const promise = launchForeground(marker, 300);
			await waitUntil(() => activeChildCount() === 1, 5000);
			const pids = await reapActiveChildren();
			await promise;
			const elapsed = Date.now() - started;
			expect(pids).toHaveLength(1);
			expect(pidAlive(pids[0])).toBe(false);
			// Early exit: SIGTERM kills the wrapper promptly. The old implementation
			// always awaited the full 5s SIGKILL_GRACE_MS here.
			expect(elapsed).toBeLessThan(3000);
		});
	}, 20000);

	it("B5: two concurrent children sharing a marker stay independently tracked", async () => {
		await withSleepWrapper(async () => {
			const marker = `collide-${crypto.randomUUID()}`;
			const first = launchForeground(marker);
			await waitUntil(() => activeChildCount() === 1, 5000);
			const second = launchForeground(marker);
			await waitUntil(() => activeChildCount() === 2, 5000);
			await waitUntil(() => findByMarker(marker).length === 2, 5000);

			// Kill ONE child directly: only its registry entry may be removed. Before
			// B5 the marker-keyed map collapsed both, so this close untracked the
			// still-live second child and the reap below missed it.
			process.kill(findByMarker(marker)[0], "SIGKILL");
			await waitUntil(() => activeChildCount() === 1, 5000);

			const reaped = await reapActiveChildren();
			await Promise.allSettled([first, second]);
			expect(reaped).toHaveLength(1);
			expect(pidAlive(reaped[0])).toBe(false);
			expect(activeChildCount()).toBe(0);
		});
	}, 20000);

	it("#299 Option A: reaps a marker-carrying GRANDCHILD alongside the tracked child", async () => {
		if (!isProcAvailable()) return;
		await withGrandchildWrapper(async (pidFile) => {
			const marker = `grandchild-reap-${crypto.randomUUID()}`;
			const promise = launchForeground(marker);
			await waitUntil(() => activeChildCount() === 1, 5000);
			const grandchildPid = await readGrandchildPid(pidFile);
			// One marker now spans TWO pids: the tracked direct child and the grandchild.
			await waitUntil(() => findByMarker(marker).includes(grandchildPid), 5000);
			expect(findByMarker(marker).length).toBeGreaterThanOrEqual(2);
			const before = findByMarker(marker).sort((a, b) => a - b);

			const reaped = await reapActiveChildren();

			// #322: this is an END-TO-END ACCOUNTING case, NOT shutdown isolation.
			// The tracked wrapper is a real `runSubagent` child, so killing it fires
			// the run's own exit sweep (runner.ts:955), which targets the SAME marker
			// tree and can kill the grandchild before these pre-settle checks run. A
			// grandchild death here is therefore NOT attributable to the shutdown
			// reap. The attribution test is the isolated #322 case below (no
			// `runSubagent`). These checks only pin that the shutdown result
			// enumerates the pid and that the tree is gone by run settle.
			expect(reaped).toContain(grandchildPid);
			await waitUntil(() => !pidAlive(grandchildPid), 5000);
			expect(pidAlive(grandchildPid)).toBe(false);
			await waitUntil(() => findByMarker(marker).length === 0, 5000);
			expect(findByMarker(marker)).toEqual([]);

			await promise;

			// One escalation window ended the whole inherited tree (probe 1b).
			expect(reaped).toContain(grandchildPid);
			await waitUntil(() => findByMarker(marker).length === 0, 5000);
			expect(findByMarker(marker)).toEqual([]);
			expect(pidAlive(grandchildPid)).toBe(false);
			expect(activeChildCount()).toBe(0);
			// Evidence: record the pids observed before/after for the PR body.
			console.log(`#299-A reapActiveChildren pids BEFORE=${JSON.stringify(before)} REAPED=${JSON.stringify(reaped)} grandchildAliveAfter=${pidAlive(grandchildPid)}`);
		});
	}, 20000);

	it("#322 isolation: reapActiveChildren ALONE reaps the child AND its marker grandchild", async () => {
		if (!isProcAvailable()) return;
		await withGrandchildWrapper(async (pidFile, script) => {
			const marker = `isolated-reap-${crypto.randomUUID()}`;
			// Launch the wrapper DIRECTLY — no `runSubagent`, so the run's exit sweep
			// (runner.ts:955) is never in the picture. The only kill path in play is
			// `reapActiveChildren`'s own tracked-child + marker union, which makes the
			// grandchild death assertion attributable to the shutdown reap.
			const wrapper = track(
				spawn(script, [], {
					stdio: "ignore",
					env: { ...process.env, [CHILD_MARKER_ENV_KEY]: marker },
				}),
			);
			const wrapperPid = await waitForSpawn(wrapper);
			const deregister = __registerActiveChildForTest(wrapper, marker);
			try {
				const grandchildPid = await readGrandchildPid(pidFile);
				await waitUntil(() => findByMarker(marker).includes(grandchildPid), 5000);
				const before = findByMarker(marker).sort((a, b) => a - b);

				const reaped = await reapActiveChildren();

				// The reaped set enumerates BOTH pids: the tracked wrapper (ChildProcess
				// target) and the marker-only grandchild (marker sweep).
				expect(reaped).toContain(wrapperPid);
				expect(reaped).toContain(grandchildPid);
				// No run is awaited here, so nothing else can have killed the grandchild.
				// The settle window below only grants /proc a tick to drop the entry; the
				// ASSERTION is the tripwire (a no-op marker target must fail here).
				await waitUntil(
					() => !pidAlive(wrapperPid) && !pidAlive(grandchildPid),
					5000,
					false,
				);
				expect(pidAlive(wrapperPid)).toBe(false);
				expect(pidAlive(grandchildPid)).toBe(false);
				console.log(
					`#322 isolation BEFORE=${JSON.stringify(before)} REAPED=${JSON.stringify(reaped)} wrapperPid=${wrapperPid} grandchildPid=${grandchildPid}`,
				);
			} finally {
				deregister();
			}
		});
	}, 20000);

	it("#299 Option B: reapActiveChildren group-kills a marker-STRIPPED grandchild", async () => {
		if (!isProcAvailable()) return;
		await withGrandchildWrapper(async (pidFile) => {
			const marker = `boundary-${crypto.randomUUID()}`;
			const promise = launchForeground(marker);
			await waitUntil(() => activeChildCount() === 1, 5000);
			const grandchildPid = await readGrandchildPid(pidFile);
			// The tracked child carries the marker; the scrubbed grandchild does not.
			await waitUntil(() => findByMarker(marker).length >= 1, 5000);
			expect(findByMarker(marker)).not.toContain(grandchildPid);

			const reaped = await reapActiveChildren();
			await promise;

			// Option A could not see a grandchild that scrubbed the marker. Under
			// Option B the tracked child is its own group leader (detached, D1), so the
			// group signal reaches that scrubbed descendant anyway — the residual is
			// closed. This is an END-TO-END case (the run's own exit sweep may share
			// the kill); T2 is the seam-isolated, attributable version.
			expect(reaped).not.toContain(grandchildPid); // accounting is still pid/marker-based
			await waitUntil(() => !pidAlive(grandchildPid), 5000);
			expect(pidAlive(grandchildPid)).toBe(false);
			console.log(`#299-B boundary grandchild=${grandchildPid} aliveAfterShutdownReap=${pidAlive(grandchildPid)} markerVisible=${findByMarker(marker).includes(grandchildPid)}`);
		}, true);
	}, 20000);

	it("#299 T1: a runSubagent child is its own process-group leader (detached)", async () => {
		if (!isProcAvailable()) return;
		await withSleepWrapper(async () => {
			const marker = `pgrp-${crypto.randomUUID()}`;
			const promise = launchForeground(marker);
			await waitUntil(() => findByMarker(marker).length >= 1, 5000);
			const childPid = findByMarker(marker)[0];
			// Safety net: if an assertion below fails before the reap, afterEach still
			// SIGKILLs this runSubagent child (it is not a `spawned` ChildProcess here).
			strayPids.add(childPid);
			// `detached: true` made the child a session/group leader — the invariant
			// every group kill path (`kill(-pid)`) depends on.
			expect(readProcessGroup(childPid)).toBe(childPid);
			await reapActiveChildren();
			await promise;
			expect(pidAlive(childPid)).toBe(false);
		});
	}, 20000);

	it("#299 T2: reapActiveChildren group-kills an env-SCRUBBED grandchild (seam-isolated)", async () => {
		if (!isProcAvailable()) return;
		await withGrandchildWrapper(async (pidFile, script) => {
			const marker = `scrub-reap-${crypto.randomUUID()}`;
			// Spawn the wrapper DETACHED — models a real runSubagent child (D1) so its
			// group id is its own pid — then register it via the #322 seam. No
			// `runSubagent` is awaited, so only `reapActiveChildren` can have killed the
			// scrubbed grandchild: the death assertion is attributable.
			const wrapper = track(
				spawn(script, [], {
					stdio: "ignore",
					env: { ...process.env, [CHILD_MARKER_ENV_KEY]: marker },
					detached: true,
				}),
			);
			const wrapperPid = await waitForSpawn(wrapper);
			const deregister = __registerActiveChildForTest(wrapper, marker);
			try {
				const grandchildPid = await readGrandchildPid(pidFile);
				// Same group as the wrapper, but NO marker: invisible to the scan.
				expect(readProcessGroup(grandchildPid)).toBe(wrapperPid);
				expect(findByMarker(marker)).not.toContain(grandchildPid);

				const reaped = await reapActiveChildren();
				expect(reaped).toContain(wrapperPid);
				await waitUntil(() => !pidAlive(wrapperPid) && !pidAlive(grandchildPid), 5000);
				expect(pidAlive(wrapperPid)).toBe(false);
				expect(pidAlive(grandchildPid)).toBe(false);
				console.log(`#299-B T2 wrapper=${wrapperPid} scrubbedGrandchild=${grandchildPid} aliveAfter=${pidAlive(grandchildPid)}`);
			} finally {
				deregister();
			}
		}, true);
	}, 20000);

	it("#299 T4: a TERM-stubborn group member is SIGKILLed after its leader exits (D5)", async () => {
		if (!isProcAvailable()) return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-stubborn-"));
		try {
			const memberPidFile = path.join(dir, "member.pid");
			const readyFile = path.join(dir, "ready");
			const leader = track(spawnStubbornGroup(memberPidFile, readyFile));
			const leaderPid = await waitForSpawn(leader);
			await once(leader, "exit"); // leader gone; the group persists via the member
			await waitUntil(() => !pidAlive(leaderPid), 2000);
			await waitUntil(() => fs.existsSync(memberPidFile) && fs.existsSync(readyFile), 5000);
			const memberPid = Number(fs.readFileSync(memberPidFile, "utf-8").trim());
			strayPids.add(memberPid);
			await waitUntil(() => pidAlive(memberPid), 5000);
			expect(pidAlive(leaderPid)).toBe(false); // verifyDeath is already true

			// The leader is already dead (so the leader-based survivor `forceKill` is
			// skipped) and the member ignores SIGTERM. Only the UNCONDITIONAL final
			// group SIGKILL (D5) can end it.
			const deps = { ...defaultRecoveryDeps(), graceMs: 1000, pollMs: 20 };
			const survivors = await reapPids([leaderPid], deps);
			await waitUntil(() => !pidAlive(memberPid), 5000);
			expect(pidAlive(memberPid)).toBe(false);
			expect(survivors).toEqual([]);
			console.log(`#299-B T4 leader=${leaderPid} stubbornMember=${memberPid} aliveAfter=${pidAlive(memberPid)}`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);

	it("#299 T5: the platform gate disables group dispatch (Windows fallback)", async () => {
		if (!isProcAvailable()) return;
		const spy = spyOnProcessKillGroups();
		try {
			__setProcessGroupKillSupportedForTest(false);
			expect(supportsProcessGroupKill()).toBe(false);
			const deps = defaultRecoveryDeps();
			// The capability gate is the presence of the group primitive: on win32 it
			// is simply not wired, so `reapPids` selects direct-only pid targets.
			expect(deps.killGroup).toBeUndefined();
			const sleeper = track(spawnSleeper());
			const pid = await waitForSpawn(sleeper);
			await reapPids([pid], { ...deps, graceMs: 100, pollMs: 10 });
			await waitUntil(() => !pidAlive(pid), 2000);
			expect(pidAlive(pid)).toBe(false);
			expect(spy.groupPids).toEqual([]);
			console.log(`#299-B T5 platformGate=false directReap=true groupPids=${JSON.stringify(spy.groupPids)}`);
		} finally {
			spy.restore();
			__setProcessGroupKillSupportedForTest(undefined);
		}
	}, 20000);

	it("#299 T6: a pid with no marker is never group-signaled", async () => {
		if (!isProcAvailable()) return;
		// A detached process that carries NO run marker: it belongs to no run tree.
		const foreign = track(
			spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				stdio: "ignore",
				detached: true,
			}),
		);
		const foreignPid = await waitForSpawn(foreign);
		const spy = spyOnProcessKillGroups();
		try {
			const marker = `absent-${crypto.randomUUID()}`;
			const deps = { ...defaultRecoveryDeps(), graceMs: 100, pollMs: 10 };
			const summary = await runBootScan({
				records: [
					record({
						id: "t6-no-marker",
						owner: { pid: DEAD_PID, start: "100" },
						childMarker: marker,
					}),
				],
				deps,
				mark: () => true,
			});
			expect(summary.reaped).toBe(0);
			// Identity is enforced by the marker: no match → no target → no signal,
			// group or direct, for the foreign leader.
			expect(spy.groupPids).toEqual([]);
			await waitUntil(() => pidAlive(foreignPid), 500);
			expect(pidAlive(foreignPid)).toBe(true);
			console.log(`#299-B T6 foreign=${foreignPid} groupPids=${JSON.stringify(spy.groupPids)}`);
		} finally {
			spy.restore();
		}
	}, 20000);
});

// ---------------------------------------------------------------------------
// #299 review fix — A1 signal-time marker verification, A2 group-empty grace
// ---------------------------------------------------------------------------

describe("#299 review A1: signal-time marker verification", () => {
	it("does NOT signal an alive pid that no longer carries the marker (reused pid)", async () => {
		if (!isProcAvailable()) return;
		// A detached, marker-free foreign process is exactly the state a reused pid
		// is in. The scan-time match is stubbed via `markerOfPid`; the PRODUCTION
		// `pidHasMarker` verifier then reads no marker at signal time. Removing the
		// signal-time gate lets the stale SIGTERM/SIGKILL reach this process.
		const foreign = track(
			spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				stdio: "ignore",
				detached: true,
			}),
		);
		const foreignPid = await waitForSpawn(foreign);
		const marker = `reused-${crypto.randomUUID()}`;
		const { deps, killCalls, groupCalls } = recordingDeps({ graceMs: 200, pollMs: 20 });

		const survivors = await reapPids([foreignPid], deps, () => marker);

		// No signal, group or direct, reaches the foreign process/group.
		expect(killCalls).toEqual([]);
		expect(groupCalls).toEqual([]);
		expect(survivors).toEqual([]);
		expect(pidAlive(foreignPid)).toBe(true);
		console.log(
			`#299-A1 reused foreign=${foreignPid} killCalls=${JSON.stringify(killCalls)} groupCalls=${JSON.stringify(groupCalls)} aliveAfter=${pidAlive(foreignPid)}`,
		);
	}, 20000);

	it("still signals a live marker pid — group AND direct (positive path)", async () => {
		if (!isProcAvailable()) return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-guard-"));
		try {
			const marker = `guarded-${crypto.randomUUID()}`;
			const readyFile = path.join(dir, "ready");
			// A SIGTERM-IGNORING process, spawned WITHOUT `detached` so it is NOT a
			// group leader: `kill(-pid)` names no group (ESRCH, swallowed) and the
			// DIRECT TERM/KILL are the effective signals. That makes the positive path
			// deterministic — a real group leader would die on the group SIGKILL and
			// the (redundant) direct SIGKILL would be correctly skipped by the guard.
			const code =
				`const fs=require('node:fs');` +
				`process.on('SIGTERM',()=>{});` +
				`fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');` +
				`setInterval(()=>{},1000)`;
			const child = track(
				spawn(process.execPath, ["-e", code], {
					stdio: "ignore",
					env: { ...process.env, [CHILD_MARKER_ENV_KEY]: marker },
				}),
			);
			const childPid = await waitForSpawn(child);
			await waitUntil(() => fs.existsSync(readyFile) && findByMarker(marker).includes(childPid), 5000);
			const { deps, killCalls, groupCalls } = recordingDeps({ graceMs: 300, pollMs: 20 });

			const survivors = await reapPids([childPid], deps, () => marker);

			// The guard ALLOWED the signals while the marker was present: the direct TERM
			// was dispatched (the process survived it), and the after-grace direct KILL
			// ended it. The group signals were dispatched too (ESRCH here).
			expect(killCalls).toContainEqual([childPid, "SIGTERM"]);
			expect(killCalls).toContainEqual([childPid, "SIGKILL"]);
			expect(groupCalls).toContainEqual([childPid, "SIGTERM"]);
			expect(groupCalls).toContainEqual([childPid, "SIGKILL"]);
			expect(survivors).toEqual([]);
			await waitUntil(() => !pidAlive(childPid), 2000);
			expect(pidAlive(childPid)).toBe(false);
			console.log(
				`#299-A1 positive child=${childPid} killCalls=${JSON.stringify(killCalls)} groupCalls=${JSON.stringify(groupCalls)} aliveAfter=${pidAlive(childPid)}`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
});

// ---------------------------------------------------------------------------
// #299 re-review A.1 — the pidGone two-read race and honest survivor reporting
// ---------------------------------------------------------------------------

describe("#299 re-review A.1: reaped-pid classification + honest reporting", () => {
	it("T1: positive liveness then stat ENOENT is GONE; the live group member is still killed", async () => {
		if (!isProcAvailable()) return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-reap-race-"));
		try {
			const memberPidFile = path.join(dir, "member.pid");
			const readyFile = path.join(dir, "ready");
			const marker = `race-${crypto.randomUUID()}`;
			// A DETACHED leader that exits, leaving a TERM-stubborn member alive in its
			// group — the reaped-leader + live-member fixture (the D5 shape).
			const leader = track(spawnStubbornGroup(memberPidFile, readyFile));
			const leaderPid = await waitForSpawn(leader);
			await once(leader, "exit");
			await waitUntil(() => !pidAlive(leaderPid), 2000);
			await waitUntil(() => fs.existsSync(memberPidFile) && fs.existsSync(readyFile), 5000);
			const memberPid = Number(fs.readFileSync(memberPidFile, "utf-8").trim());
			strayPids.add(memberPid);
			await waitUntil(() => pidAlive(memberPid), 5000);
			expect(pidAlive(leaderPid)).toBe(false);
			expect(readProcessGroup(memberPid)).toBe(leaderPid);

			// Deterministic interleaving: the liveness sample reports the leader alive
			// while its `/proc/<leaderPid>/stat` is gone — a leader REAPED between the
			// two `pidGone` reads. Only the sample is forced; the stat read, the marker
			// read and every signal are REAL.
			const originalKill = process.kill;
			const killSpy = vi.spyOn(process, "kill").mockImplementation(((
				pid: number,
				signal?: NodeJS.Signals | number,
			) => {
				if (pid === leaderPid && signal === 0) return true;
				return originalKill(pid, signal as NodeJS.Signals);
			}) as typeof process.kill);
			try {
				// The classification fix (M-a tripwire: reverting it fails here).
				expect(pidGone(leaderPid)).toBe(true);

				const { deps, killCalls, groupCalls } = recordingDeps({ graceMs: 300, pollMs: 20 });
				const survivors = await reapPids([leaderPid], deps, () => marker);

				// The guard ALLOWED the group dispatch: a reaped leader does not make its
				// group foreign, so both the group SIGTERM and the final group SIGKILL were
				// sent. The DIRECT signals are correctly skipped (the leader itself is gone).
				expect(groupCalls).toContainEqual([leaderPid, "SIGTERM"]);
				expect(groupCalls).toContainEqual([leaderPid, "SIGKILL"]);
				expect(killCalls).toEqual([]);
				// Only the unconditional final group SIGKILL can end the TERM-stubborn
				// member; it must actually die.
				await waitUntil(() => !pidAlive(memberPid), 5000);
				expect(pidAlive(memberPid)).toBe(false);
				// Empty because it was KILLED, not because it was skipped.
				expect(survivors).toEqual([]);
				console.log(
					`#299-A1 T1 leader=${leaderPid} member=${memberPid} groupCalls=${JSON.stringify(groupCalls)} survivors=${JSON.stringify(survivors)}`,
				);
			} finally {
				killSpy.mockRestore();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);

	it("T2: a refused final group SIGKILL over a live group is reported as a survivor", async () => {
		const pid = 4242;
		const marker = `refused-${crypto.randomUUID()}`;
		const killGroup = vi.fn();
		const deps: RecoveryDeps = {
			pidAlive: (p) => p !== DEAD_PID,
			startTokenOf: () => "100",
			findByMarker: () => [pid],
			kill: vi.fn(),
			killGroup,
			// Alive but no longer ours (the reuse case): the guard refuses every signal.
			verifyMarker: () => false,
			pidGone: () => false,
			// ...but the targeted group still has live members.
			groupHasMembers: () => true,
			sleep: async () => {},
			graceMs: 0,
		};
		const warns: Array<{ message: string; data: Record<string, unknown> }> = [];
		const log = {
			warn: (message: string, data?: Record<string, unknown>) => warns.push({ message, data: data ?? {} }),
		};

		const outcome = await recoverRecord(
			record({ id: "t2-refused", owner: { pid: DEAD_PID, start: "100" }, childMarker: marker }),
			deps,
			log,
		);
		expect(outcome.decision).toBe("mark");
		expect(outcome.reaped).toEqual([pid]);
		// M-b tripwire: making the report unconditionally clean fails HERE.
		expect(outcome.survived).toEqual([pid]);
		// The refusal is still logged, and no unverified signal was sent.
		expect(warns.some((w) => w.data.pid === pid)).toBe(true);
		expect(killGroup).not.toHaveBeenCalled();
		console.log(`#299-A1 T2 refused pid=${pid} survived=${JSON.stringify(outcome.survived)}`);
	});
});

describe("#299 fix A.2: three-state group membership (unknown is never empty)", () => {
	it("T-new: a failed membership inspection is never read as empty (no early-exit; refused group is a survivor)", async () => {
		if (!isProcAvailable()) return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-unknown-members-"));
		try {
			const memberPidFile = path.join(dir, "member.pid");
			const readyFile = path.join(dir, "ready");
			// A live, DETACHED leader (its own pgid) with a live same-group member. The
			// leader carries NO run marker, so the signal guard — which refuses a signal
			// to a LIVE pid that is not ours — refuses every group signal, leaving a live
			// group we targeted.
			const leaderCode =
				`const {spawn}=require('node:child_process');const fs=require('node:fs');` +
				`const m=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
				`fs.writeFileSync(${JSON.stringify(memberPidFile)}, String(m.pid));` +
				`fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');` +
				`setInterval(()=>{},1000)`;
			const leader = track(spawn(process.execPath, ["-e", leaderCode], { stdio: "ignore", detached: true }));
			const leaderPid = await waitForSpawn(leader);
			strayPids.add(leaderPid);
			await waitUntil(() => fs.existsSync(readyFile) && fs.existsSync(memberPidFile), 5000);
			const memberPid = Number(fs.readFileSync(memberPidFile, "utf-8").trim());
			strayPids.add(memberPid);
			await waitUntil(() => pidAlive(memberPid), 5000);
			// The fixture really has a live same-PGID member the real scan observes.
			expect(readProcessGroup(memberPid)).toBe(leaderPid);
			expect(groupHasMembers(leaderPid)).toBe(true);

			// Force the REAL `/proc` listing to fail for the duration of the reap: the
			// production `groupHasMembers` must then answer UNKNOWN (`undefined`), never
			// "positively empty". Every signal and every liveness read below stays real.
			// M-c tripwire: reverting `groupHasMembers` to false-on-unknown fails HERE
			// (both the graceful wait and the survivor report).
			const marker = `unknown-${crypto.randomUUID()}`;
			const { deps, killCalls, groupCalls } = recordingDeps({ graceMs: 200, pollMs: 20 });
			const scanError = new Error("EACCES") as NodeJS.ErrnoException;
			scanError.code = "EACCES";
			groupScanControl.readdirError = scanError;
			const started = Date.now();
			const survivors = await reapPids([leaderPid], deps, () => marker).finally(() => {
				groupScanControl.readdirError = undefined;
			});
			const elapsed = Date.now() - started;

			// Half 1 — UNKNOWN is NOT dead: the escalation ran to at least the grace
			// boundary instead of early-exiting. A false-on-unknown reading would have
			// exited almost immediately. (soft: so M-c reports BOTH halves, not just the
			// first.)
			expect.soft(elapsed).toBeGreaterThanOrEqual(180);
			// Half 2 — the refused final group SIGKILL over a still-unknown group is a
			// survivor; never a clean `[]`.
			expect.soft(survivors).toEqual([leaderPid]);
			// Every guard check refused, so nothing was signaled and the member is alive.
			expect(groupCalls).toEqual([]);
			expect(killCalls).toEqual([]);
			expect(pidAlive(memberPid)).toBe(true);
			console.log(
				`#299-A2 unknown leader=${leaderPid} member=${memberPid} elapsedMs=${elapsed} survivors=${JSON.stringify(survivors)}`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);

	it("T-new-truncated: a truncated member record is PARTIAL, never empty (no early-exit; refused group is a survivor)", async () => {
		if (!isProcAvailable()) return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-truncated-members-"));
		try {
			const memberPidFile = path.join(dir, "member.pid");
			const readyFile = path.join(dir, "ready");
			const leaderCode =
				`const {spawn}=require('node:child_process');const fs=require('node:fs');` +
				`const m=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
				`fs.writeFileSync(${JSON.stringify(memberPidFile)}, String(m.pid));` +
				`fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');` +
				`setInterval(()=>{},1000)`;
			const leader = track(spawn(process.execPath, ["-e", leaderCode], { stdio: "ignore", detached: true }));
			const leaderPid = await waitForSpawn(leader);
			strayPids.add(leaderPid);
			await waitUntil(() => fs.existsSync(readyFile) && fs.existsSync(memberPidFile), 5000);
			const memberPid = Number(fs.readFileSync(memberPidFile, "utf-8").trim());
			strayPids.add(memberPid);
			await waitUntil(() => pidAlive(memberPid), 5000);
			// The fixture really has a live same-PGID member the real scan observes.
			expect(readProcessGroup(memberPid)).toBe(leaderPid);
			expect(groupHasMembers(leaderPid)).toBe(true);

			// Force ONLY the live member's `/proc/<pid>/stat` to a truncated record:
			// a valid `)` but too few fields. The production `groupHasMembers` must
			// answer UNKNOWN (`undefined`), never a positively-empty `false`. Every
			// signal and every liveness read below stays real.
			// M-d tripwire: reverting the A.3 numericity/truncation guard fails HERE
			// (both the graceful wait and the survivor report).
			const marker = `truncated-${crypto.randomUUID()}`;
			const { deps, killCalls, groupCalls } = recordingDeps({ graceMs: 200, pollMs: 20 });
			groupScanControl.statContents.set(`/proc/${memberPid}/stat`, `${memberPid} (node) S 1`);
			const started = Date.now();
			const survivors = await reapPids([leaderPid], deps, () => marker).finally(() => {
				groupScanControl.statContents.clear();
			});
			const elapsed = Date.now() - started;

			// Half 1 — UNKNOWN is NOT dead: the escalation honours the full grace
			// window instead of early-exiting on a false-on-truncation reading.
			expect.soft(elapsed).toBeGreaterThanOrEqual(180);
			// Half 2 — the refused final group SIGKILL over the still-unknown group is
			// a survivor; never a clean `[]`.
			expect.soft(survivors).toEqual([leaderPid]);
			// Every guard check refused, so nothing was signaled and the member is alive.
			expect(groupCalls).toEqual([]);
			expect(killCalls).toEqual([]);
			expect(pidAlive(memberPid)).toBe(true);
			console.log(
				`#299-A3 truncated leader=${leaderPid} member=${memberPid} elapsedMs=${elapsed} survivors=${JSON.stringify(survivors)}`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
});

describe("#299 review A2: group-empty grace window", () => {
	it("a same-group member completes its SIGTERM cleanup inside the grace window", async () => {
		if (!isProcAvailable()) return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-grace-"));
		try {
			const memberPidFile = path.join(dir, "member.pid");
			const readyFile = path.join(dir, "ready");
			const doneFile = path.join(dir, "done");
			const marker = `grace-${crypto.randomUUID()}`;
			const leader = track(
				spawnGracefulGroup(memberPidFile, readyFile, doneFile, 350, {
					...process.env,
					[CHILD_MARKER_ENV_KEY]: marker,
				}),
			);
			const leaderPid = await waitForSpawn(leader);
			strayPids.add(leaderPid);
			await waitUntil(() => fs.existsSync(readyFile) && fs.existsSync(memberPidFile), 5000);
			const memberPid = Number(fs.readFileSync(memberPidFile, "utf-8").trim());
			strayPids.add(memberPid);
			expect(readProcessGroup(memberPid)).toBe(leaderPid);

			const { deps } = recordingDeps({ graceMs: 1000, pollMs: 20 });
			const started = Date.now();
			const survivors = await reapPids([leaderPid], deps, () => marker);
			const elapsed = Date.now() - started;

			// The member was NOT SIGKILLed mid-cleanup: it wrote its completion marker.
			await waitUntil(() => fs.existsSync(doneFile), 1000, false);
			expect(fs.existsSync(doneFile)).toBe(true);
			await waitUntil(() => !pidAlive(memberPid), 2000);
			expect(pidAlive(memberPid)).toBe(false);
			expect(survivors).toEqual([]);
			// Group emptied → early exit, well before the 1000 ms grace.
			expect(elapsed).toBeLessThan(1000);
			console.log(
				`#299-A2 cleanup leader=${leaderPid} member=${memberPid} elapsedMs=${elapsed} done=${fs.existsSync(doneFile)}`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);

	it("group-empty fast path exits early when the group is truly empty", async () => {
		if (!isProcAvailable()) return;
		const marker = `empty-${crypto.randomUUID()}`;
		const leader = track(
			spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				stdio: "ignore",
				detached: true,
				env: { ...process.env, [CHILD_MARKER_ENV_KEY]: marker },
			}),
		);
		const leaderPid = await waitForSpawn(leader);
		const { deps } = recordingDeps({ graceMs: 1000, pollMs: 20 });
		const started = Date.now();
		const survivors = await reapPids([leaderPid], deps, () => marker);
		const elapsed = Date.now() - started;
		expect(survivors).toEqual([]);
		expect(elapsed).toBeLessThan(500);
		console.log(`#299-A2 fastpath leader=${leaderPid} elapsedMs=${elapsed}`);
	}, 20000);
});

// ---------------------------------------------------------------------------
// #299 Option B T3: boot scan group reap via the real production entry
// ---------------------------------------------------------------------------

describe("#299 Option B boot group reap (recoverProduction)", () => {
	it("T3: boot scan group-kills an env-scrubbed grandchild", async () => {
		if (!isProcAvailable()) return;
		await withGrandchildWrapper(async (pidFile, script) => {
			const marker = `boot-scrub-${crypto.randomUUID()}`;
			// A live, DETACHED wrapper (group leader) + a marker-STRIPPED grandchild in
			// its group: exactly the probe's non-inheriting tree. The marker scan finds
			// the wrapper; the boot reap's group target reaches the grandchild.
			const wrapper = track(
				spawn(script, [], {
					stdio: "ignore",
					env: { ...process.env, [CHILD_MARKER_ENV_KEY]: marker },
					detached: true,
				}),
			);
			const wrapperPid = await waitForSpawn(wrapper);
			const grandchildPid = await readGrandchildPid(pidFile);
			expect(readProcessGroup(grandchildPid)).toBe(wrapperPid);
			expect(findByMarker(marker)).not.toContain(grandchildPid);

			const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brl-bootreg-"));
			const previousRegistry = registryDir();
			__setRegistryDir(registryRoot);
			try {
				// Fabricated registry entry: dead owner, live marker child — the fresh
				// conductor's crash-recovery candidate.
				registerInflightRun({
					id: crypto.randomUUID(),
					kind: "foreground",
					owner: { pid: DEAD_PID, start: "100" },
					childMarker: marker,
					startedAt: new Date().toISOString(),
				});
				const deps = { ...defaultRecoveryDeps(), graceMs: 1000, pollMs: 20 };
				const summary = await recoverProduction({ deps, mark: () => true });
				expect(summary.reaped).toBeGreaterThanOrEqual(1);
				await waitUntil(() => !pidAlive(wrapperPid) && !pidAlive(grandchildPid), 5000);
				expect(pidAlive(wrapperPid)).toBe(false);
				expect(pidAlive(grandchildPid)).toBe(false);
				console.log(`#299-B T3 summary=${JSON.stringify(summary)} wrapper=${wrapperPid} scrubbedGrandchild=${grandchildPid} aliveAfter=${pidAlive(grandchildPid)}`);
			} finally {
				__setRegistryDir(previousRegistry);
				fs.rmSync(registryRoot, { recursive: true, force: true });
			}
		}, true);
	}, 20000);
});

// ---------------------------------------------------------------------------
// #299 Option A item 4: boot-scan reap early exit
// ---------------------------------------------------------------------------

describe("#299 Option A item 4: reapPids early exit (no full-grace stall)", () => {
	it("returns as soon as instant-dying targets are dead, well under the grace window", async () => {
		if (!isProcAvailable()) return;
		const a = track(spawnSleeper());
		const b = track(spawnSleeper());
		const pidA = await waitForSpawn(a);
		const pidB = await waitForSpawn(b);
		const graceMs = 5000;
		const deps = { ...defaultRecoveryDeps(), graceMs };

		const started = Date.now();
		const survivors = await reapPids([pidA, pidB], deps);
		const elapsed = Date.now() - started;

		expect(survivors).toEqual([]);
		await waitUntil(() => !pidAlive(pidA) && !pidAlive(pidB), 2000);
		expect(pidAlive(pidA)).toBe(false);
		expect(pidAlive(pidB)).toBe(false);
		// Item 4: the old wait-once shape blocked the full SIGKILL_GRACE_MS even when
		// both targets die on SIGTERM in ms (the observed ~5 s session_start during a
		// boot reap). The poll exits after one interval; assert well under half grace.
		expect(elapsed).toBeLessThan(graceMs / 2);
		console.log(`#299-A item4 reapPids elapsedMs=${elapsed} (grace=${graceMs}) survivors=${JSON.stringify(survivors)}`);
	}, 20000);
});

// ---------------------------------------------------------------------------
// 5. Abort/timeout escalation must force-kill a SIGTERM-ignoring child (#303)
// ---------------------------------------------------------------------------

describe("escalation timing seam is test-only (issue #306 nit 2)", () => {
	it("throws instead of mutating production timing outside the test environment", () => {
		// Simulate a production process: neither vitest marker is set. The setter
		// must refuse rather than move the process-wide SIGTERM→SIGKILL timing.
		const nodeEnv = process.env.NODE_ENV;
		const vitestEnv = process.env.VITEST;
		delete process.env.NODE_ENV;
		delete process.env.VITEST;
		try {
			expect(() => __setEscalationTimingForTest({ graceMs: 1, pollMs: 1 })).toThrow(/test-only/);
		} finally {
			if (nodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = nodeEnv;
			if (vitestEnv === undefined) delete process.env.VITEST;
			else process.env.VITEST = vitestEnv;
		}
	});
});

describe("active-child registration seam is test-only (#322)", () => {
	it("throws instead of exposing the registry outside the test environment", () => {
		// Mirror the escalation-timing guard: simulate production by clearing both
		// vitest markers, then the seam must refuse before touching the registry.
		const nodeEnv = process.env.NODE_ENV;
		const vitestEnv = process.env.VITEST;
		delete process.env.NODE_ENV;
		delete process.env.VITEST;
		try {
			expect(() => __registerActiveChildForTest(track(spawnSleeper()))).toThrow(/test-only/);
		} finally {
			if (nodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = nodeEnv;
			if (vitestEnv === undefined) delete process.env.VITEST;
			else process.env.VITEST = vitestEnv;
		}
	});
});

describe("abort/timeout escalation force-kill (issue #303)", () => {
	afterEach(() => {
		__setEscalationTimingForTest(); // restore production timing
		vi.restoreAllMocks();
	});

	it("timeout path: SIGKILLs a child that ignores SIGTERM", async () => {
		// Timeout is long enough that the child's SIGTERM handler is installed
		// (readiness-gated below) before the timer fires; grace/poll are short.
		__setEscalationTimingForTest({ graceMs: 100, pollMs: 10 });
		const spy = spyOnChildKill();
		await withIgnoreTermWrapper(async (readyFile) => {
			const marker = `timeout-ignore-${crypto.randomUUID()}`;
			const promise = launchForeground(marker, 2500);
			await waitUntil(() => fs.existsSync(readyFile), 5000);
			const result = await promise;

			// The child ignored SIGTERM, so only a real SIGKILL can have ended it.
			const pid = sigkillPid(spy.calls);
			expect(pid).toBeDefined();
			// Issue #306 nit 1: bound the SIGTERM→SIGKILL wait. Grace is 100 ms; 1.5 s
			// is well under the 5 s production grace but ~15x the measured escalation,
			// so a regression to the old full grace would fail this.
			expect(escalationElapsedMs(spy.calls)).toBeLessThan(1500);
			expect(result.exitCode).toBe(-1);
			await waitUntil(() => !pidAlive(pid!), 2000);
			expect(pidAlive(pid!)).toBe(false);
			expect(activeChildCount()).toBe(0);
		});
	}, 20000);

	it("abort path: SIGKILLs a child that ignores SIGTERM", async () => {
		__setEscalationTimingForTest({ graceMs: 100, pollMs: 10 });
		const spy = spyOnChildKill();
		await withIgnoreTermWrapper(async (readyFile) => {
			const marker = `abort-ignore-${crypto.randomUUID()}`;
			const controller = new AbortController();
			const promise = launchForeground(marker, undefined, controller.signal);
			await waitUntil(() => fs.existsSync(readyFile), 5000);
			controller.abort();
			const result = await promise;

			const pid = sigkillPid(spy.calls);
			expect(pid).toBeDefined();
			// Issue #306 nit 1: same elapsed bound as the timeout path — the abort
			// path must also force-kill at the short grace, not the full 5 s.
			expect(escalationElapsedMs(spy.calls)).toBeLessThan(1500);
			expect(result.errorCategory).toBe("aborted");
			await waitUntil(() => !pidAlive(pid!), 2000);
			expect(pidAlive(pid!)).toBe(false);
			expect(activeChildCount()).toBe(0);
		});
	}, 20000);

	it("#299 Option A timeout: sweeps a marker-carrying grandchild before the run settles", async () => {
		if (!isProcAvailable()) return;
		__setEscalationTimingForTest({ graceMs: 1000, pollMs: 10 });
		await withGrandchildWrapper(async (pidFile) => {
			const marker = `timeout-grandchild-${crypto.randomUUID()}`;
			const promise = launchForeground(marker, 2500);
			const grandchildPid = await readGrandchildPid(pidFile);
			await waitUntil(() => findByMarker(marker).includes(grandchildPid), 5000);
			const before = findByMarker(marker).sort((a, b) => a - b);

			const result = await promise;

			// Result semantics untouched; the grandchild is gone by the time the run settles.
			expect(result.errorCategory).toBe("timeout");
			expect(result.exitCode).toBe(-1);
			expect(findByMarker(marker)).toEqual([]);
			expect(pidAlive(grandchildPid)).toBe(false);
			console.log(`#299-A timeout pids BEFORE=${JSON.stringify(before)} aliveAfterRun=${pidAlive(grandchildPid)}`);
		});
	}, 20000);

	it("#299 Option A abort: sweeps a marker-carrying grandchild before the run settles", async () => {
		if (!isProcAvailable()) return;
		__setEscalationTimingForTest({ graceMs: 1000, pollMs: 10 });
		await withGrandchildWrapper(async (pidFile) => {
			const marker = `abort-grandchild-${crypto.randomUUID()}`;
			const controller = new AbortController();
			const promise = launchForeground(marker, undefined, controller.signal);
			const grandchildPid = await readGrandchildPid(pidFile);
			await waitUntil(() => findByMarker(marker).includes(grandchildPid), 5000);
			const before = findByMarker(marker).sort((a, b) => a - b);

			controller.abort();
			const result = await promise;

			expect(result.errorCategory).toBe("aborted");
			expect(findByMarker(marker)).toEqual([]);
			expect(pidAlive(grandchildPid)).toBe(false);
			console.log(`#299-A abort pids BEFORE=${JSON.stringify(before)} aliveAfterRun=${pidAlive(grandchildPid)}`);
		});
	}, 20000);

	it("cooperative timeout path: completes early with NO SIGKILL sent", async () => {
		// Grace far larger than the child needs: a SIGKILL here would prove the
		// early-exit poll is broken, not that the child was slow.
		__setEscalationTimingForTest({ graceMs: 3000, pollMs: 10 });
		const spy = spyOnChildKill();
		await withSleepWrapper(async () => {
			const started = Date.now();
			const marker = `timeout-coop-${crypto.randomUUID()}`;
			const promise = launchForeground(marker, 50);
			const result = await promise;
			const elapsed = Date.now() - started;
			const pid = spy.calls.find((c) => c.signal === "SIGTERM")?.pid;

			expect(spy.calls.some((c) => c.signal === "SIGKILL")).toBe(false);
			expect(result.exitCode).toBe(-1);
			if (pid !== undefined) {
				await waitUntil(() => !pidAlive(pid), 2000);
				expect(pidAlive(pid)).toBe(false);
			}
			// Early exit: `sleep` dies on SIGTERM well inside the 3s grace.
			expect(elapsed).toBeLessThan(2000);
		});
	}, 20000);
});
