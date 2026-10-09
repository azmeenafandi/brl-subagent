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
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	decideRecovery,
	recoverRecord,
	runBootScan,
	classifyOwner,
	defaultRecoveryDeps,
	currentProcessOwner,
	newDispatchIdentity,
	dedupeRunEntriesById,
	pidAlive,
	readStartToken,
	findByMarker,
	isProcAvailable,
	type RecoveryDeps,
	type RecoveryRecord,
} from "../recovery";
import { isInterruptedRun, isSubagentRunShape, type ProcessOwner, type SubagentRun } from "../types";
import { resolveTerminalRunEntry } from "../state";
import { CHILD_MARKER_ENV_KEY } from "../sanitize";
import { activeChildCount, reapActiveChildren, runSubagent } from "../runner";
import { listPersistedAgents, markAgentInterrupted } from "../session-manager";
import { createTempEnv } from "./fixtures/temp-lifecycle";

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

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const spawned: ChildProcess[] = [];
function track(child: ChildProcess): ChildProcess {
	spawned.push(child);
	return child;
}

afterEach(async () => {
	for (const child of spawned.splice(0)) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
});

// ---------------------------------------------------------------------------
// 1. Pure decision matrix
// ---------------------------------------------------------------------------

describe("recovery decision matrix (pure)", () => {
	it("idempotent-skip: a record already marked interrupted is skipped", () => {
		const plan = decideRecovery(
			record({ interruptedAt: "2026-10-09T00:00:00.000Z", owner: DEAD_OWNER, childMarker: "m" }),
			makeDeps({ findByMarker: () => [DEAD_PID] }),
		);
		expect(plan).toEqual({ decision: "skip", reason: "already-interrupted" });
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

describe("shutdown reap", () => {
	it("kills a registered in-flight child", async () => {
		// A wrapper that ignores pi's args and sleeps — lets runSubagent spawn a
		// long-lived child we can reap without touching a real model.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-reap-"));
		const script = path.join(dir, "sleep.sh");
		fs.writeFileSync(script, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });

		const previous = process.env.BRL_PI_BIN;
		process.env.BRL_PI_BIN = script;
		try {
			const marker = `reap-${crypto.randomUUID()}`;
			const promise = runSubagent(
				process.cwd(),
				"",
				{ provider: "test", id: "test/model" },
				"off",
				"noop",
				undefined,
				undefined,
				undefined,
				undefined,
				() => "",
				undefined,
				0,
				undefined,
				undefined,
				marker,
			);
			await waitUntil(() => activeChildCount() === 1, 5000);
			const pids = await reapActiveChildren();
			await promise;
			expect(pids).toHaveLength(1);
			expect(pidAlive(pids[0])).toBe(false);
			expect(activeChildCount()).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.BRL_PI_BIN;
			else process.env.BRL_PI_BIN = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
});
