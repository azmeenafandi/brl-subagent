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
import {
	activeChildCount,
	reapActiveChildren,
	runSubagent,
	__setEscalationTimingForTest,
} from "../runner";
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
	// Any test that shortened the escalation timing must not leak it into the
	// next file-scoped test (idempotent reset to production timing).
	__setEscalationTimingForTest();
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
 * `<dir>/grandchild.pid`; `fn` receives that path.
 */
async function withGrandchildWrapper<T>(
	fn: (pidFile: string) => Promise<T>,
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
		(dir) => fn(path.join(dir, "grandchild.pid")),
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

	it("#299 Option A boundary: a marker-STRIPPED grandchild is NOT reaped (Option B)", async () => {
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

			// Pinned boundary: Option A cannot see a grandchild that scrubbed the
			// marker — it survives the shutdown reap. Only a process-group kill
			// (Option B, #299) closes this residual.
			expect(reaped).not.toContain(grandchildPid);
			await waitUntil(() => pidAlive(grandchildPid), 2000);
			expect(pidAlive(grandchildPid)).toBe(true);
			console.log(`#299-A boundary grandchild=${grandchildPid} aliveAfterShutdownReap=${pidAlive(grandchildPid)} markerVisible=${findByMarker(marker).includes(grandchildPid)}`);
		}, true);
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
