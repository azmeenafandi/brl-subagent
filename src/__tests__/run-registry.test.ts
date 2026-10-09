/**
 * Option B U1 — durable in-flight run registry.
 *
 * Two layers are covered here:
 *   1. the registry module itself (register → update → clear, malformed-entry
 *      tolerance, atomic/owner-only writes); and
 *   2. the boot scan's REGISTRY-SOURCED path (`recoverInflightRuns`) — the
 *      missing P2(b) acceptance: a fresh process with ZERO session entries must
 *      still reap a dead conductor's orphaned foreground child and mark the run,
 *      because the registry (not the crashed session) is the candidate source.
 *
 * Plus the two regression guards from the adversarial review: the scan must not
 * full-parse `.pi/subagents/`, and N orphans must cost ONE grace window.
 */

import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	registerInflightRun,
	updateInflightRun,
	clearInflightRun,
	listInflightRuns,
	markInterrupted,
	persistRunRecord,
	registryDir,
	type InflightRun,
	type InflightRunKind,
} from "../run-registry";
import {
	recoverInflightRuns,
	recoverProduction,
	runBootScan,
	defaultRecoveryDeps,
	readStartToken,
	pidAlive,
	findByMarker,
	isProcAvailable,
	type RecoveryDeps,
	type RecoveryRecord,
} from "../recovery";
import { __setProcAvailableForTest } from "../proc";
import { CHILD_MARKER_ENV_KEY } from "../sanitize";
import { SessionState } from "../state";
import { createUnitRun } from "../unit-run";
import * as sessionManager from "../session-manager";
import type { SubagentRun } from "../types";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const env = createTempEnv("brl-registry", { withCwd: false });
const ISO = "2026-10-09T00:00:00.000Z";
const DEAD_OWNER = { pid: 999_999_999, start: "100" };

beforeEach(() => env.setUp());
afterAll(async () => {
	await env.tearDown();
});

function entryFile(id: string): string {
	return path.join(registryDir(), `${id}.json`);
}

function readEntry(id: string): InflightRun | null {
	const file = entryFile(id);
	if (!fs.existsSync(file)) return null;
	return JSON.parse(fs.readFileSync(file, "utf-8")) as InflightRun;
}

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: crypto.randomUUID(),
		task: "t",
		status: "running",
		model: "p/m",
		thinkingLevel: "off",
		startedAt: ISO,
		owner: DEAD_OWNER,
		childMarker: "marker",
		...overrides,
	};
}

function spawnSleeper(extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
	return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
		env: { ...process.env, ...extraEnv },
	});
}

const spawned: ChildProcess[] = [];
function track(child: ChildProcess): ChildProcess {
	spawned.push(child);
	return child;
}

afterEach(() => {
	for (const child of spawned.splice(0)) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
});

async function waitForPid(child: ChildProcess): Promise<number> {
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

// ---------------------------------------------------------------------------
// 2. Registry lifecycle (all three kinds) + malformed tolerance
// ---------------------------------------------------------------------------

describe("registry lifecycle", () => {
	const KINDS: InflightRunKind[] = ["foreground", "unit", "background"];

	it("register → update → clear for every kind (atomic, owner-only)", () => {
		for (const kind of KINDS) {
			const id = crypto.randomUUID();
			expect(
				registerInflightRun({
					id,
					kind,
					dispatchId: "d-1",
					attempt: 1,
					owner: DEAD_OWNER,
					childMarker: "m",
					startedAt: ISO,
				}),
			).toBe(true);

			const created = readEntry(id);
			expect(created?.kind).toBe(kind);
			expect(created?.owner).toEqual(DEAD_OWNER);
			expect(created?.dispatchId).toBe("d-1");
			expect(created?.cwd).toBe(process.cwd());
			// F6 discipline: the entry is owner-only.
			expect(fs.statSync(entryFile(id)).mode & 0o777).toBe(0o600);
			// No temp file is left behind by the atomic rename.
			expect(fs.readdirSync(registryDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);

			// update: patched fields land, a prior interruptedAt survives.
			markInterrupted(id, "2026-10-09T01:00:00.000Z");
			expect(updateInflightRun({ id, kind, attempt: 2, startedAt: ISO })).toBe(true);
			const updated = readEntry(id);
			expect(updated?.attempt).toBe(2);
			expect(updated?.interruptedAt).toBe("2026-10-09T01:00:00.000Z");

			clearInflightRun(id);
			expect(readEntry(id)).toBeNull();
		}
	});

	it("update never resurrects a cleared entry", () => {
		const id = crypto.randomUUID();
		registerInflightRun({ id, kind: "unit", startedAt: ISO });
		clearInflightRun(id);
		expect(updateInflightRun({ id, kind: "unit", startedAt: ISO })).toBe(false);
		expect(readEntry(id)).toBeNull();
	});

	it("tolerates malformed and unsafe entries without throwing", () => {
		fs.mkdirSync(registryDir(), { recursive: true });
		fs.writeFileSync(path.join(registryDir(), "garbage.json"), "{not json");
		fs.writeFileSync(path.join(registryDir(), "wrong-shape.json"), JSON.stringify({ id: "x", kind: "nope" }));
		// An unsafe id cannot resolve to a path — the write is refused, no throw.
		expect(registerInflightRun({ id: "../../escape", kind: "unit", startedAt: ISO })).toBe(false);
		expect(markInterrupted("../../escape", ISO)).toBe(false);
		clearInflightRun("../../escape");

		const good = crypto.randomUUID();
		registerInflightRun({ id: good, kind: "foreground", startedAt: ISO });
		const listed = listInflightRuns();
		expect(listed.map((e) => e.id)).toEqual([good]);
		expect(markInterrupted(crypto.randomUUID(), ISO)).toBe(false);
	});

	it("lists nothing when the registry directory is absent", () => {
		fs.rmSync(registryDir(), { recursive: true, force: true });
		expect(listInflightRuns()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2b. Three-kind wiring: the real persist paths each mirror into the registry
// ---------------------------------------------------------------------------

describe("three-kind registry wiring", () => {
	it("a foreground run, a unit run, and a background run each produce an entry", () => {
		const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
		const state = new SessionState();

		// Foreground: index.ts's single-dispatch site (state.persistRun ..., "foreground").
		const foreground = makeRun();
		state.persistRun(pi, foreground, "foreground");

		// Unit: chain/parallel/graph sites createUnitRun + persistRun(..., "unit").
		const { run: unit } = createUnitRun(
			{ task: "u", inheritSP: false, thinkingLevel: "off", effectiveCwd: process.cwd() } as never,
			{ provider: "p", id: "m" },
			"off" as never,
		);
		state.persistRun(pi, unit, "unit");

		// Background: session-manager's spawn path persists through the same choke point.
		const background = makeRun();
		persistRunRecord(pi, background, "background");

		const listed = listInflightRuns();
		expect(listed.find((e) => e.id === foreground.id)?.kind).toBe("foreground");
		expect(listed.find((e) => e.id === unit.id)?.kind).toBe("unit");
		expect(listed.find((e) => e.id === background.id)?.kind).toBe("background");
		// The session entry is still appended (the choke point mirrors, it does not replace).
		expect(pi.appendEntry).toHaveBeenCalledTimes(3);
	});

	it("a terminal write clears the registry entry", () => {
		const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
		const state = new SessionState();
		const run = makeRun();
		state.persistRun(pi, run, "foreground");
		expect(readEntry(run.id)).not.toBeNull();
		state.persistRun(pi, { ...run, status: "done" });
		expect(readEntry(run.id)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 1. THE MISSING ACCEPTANCE TEST (P2b)
// ---------------------------------------------------------------------------

describe("P2b acceptance: fresh boot with ZERO session entries", () => {
	it("reaps a dead conductor's foreground orphan and marks the registry entry", async () => {
		if (!isProcAvailable()) return;

		// Orphan child carrying the run's marker.
		const marker = `marker-${crypto.randomUUID()}`;
		const orphan = track(spawnSleeper({ [CHILD_MARKER_ENV_KEY]: marker }));
		const orphanPid = await waitForPid(orphan);
		await waitUntil(() => findByMarker(marker).includes(orphanPid));

		const runId = crypto.randomUUID();
		registerInflightRun({
			id: runId,
			kind: "foreground",
			owner: DEAD_OWNER,
			childMarker: marker,
			startedAt: ISO,
		});

		// FRESH context: candidates come ONLY from the registry. The old code
		// sourced state.getRunEntries(ctx) (empty on default startup) plus the
		// agent store — it would find nothing here.
		const marked: string[] = [];
		const deps = { ...defaultRecoveryDeps(), sleep: async () => {}, graceMs: 0 };
		const summary = await recoverInflightRuns({
			deps,
			mark: (record, at) => {
				marked.push(`${record.kind}:${record.id}`);
				markInterrupted(record.id, at);
			},
		});

		expect(summary.marked).toBe(1);
		expect(marked).toEqual([`run:${runId}`]);
		await waitUntil(() => !pidAlive(orphanPid));
		expect(pidAlive(orphanPid)).toBe(false);
		expect(typeof readEntry(runId)?.interruptedAt).toBe("string");
	});

	it("marks the background agent record as well as the registry entry", async () => {
		if (!isProcAvailable()) return;

		const id = crypto.randomUUID();
		fs.mkdirSync(env.storageDir, { recursive: true });
		fs.writeFileSync(
			path.join(env.storageDir, `${id}.json`),
			JSON.stringify({
				id,
				sessionId: id,
				type: "general-purpose",
				description: "bg",
				status: "running",
				startedAt: Date.now(),
				task: "t",
				model: "m",
				thinkingLevel: "medium",
				owner: DEAD_OWNER,
			}),
		);
		registerInflightRun({ id, kind: "background", owner: DEAD_OWNER, startedAt: ISO });

		const deps = { ...defaultRecoveryDeps(), sleep: async () => {}, graceMs: 0 };
		const summary = await recoverInflightRuns({
			deps,
			readAgentRecord: (rid) => sessionManager.getAgent(rid),
			mark: (record, at) => {
				markInterrupted(record.id, at);
				if (record.kind === "agent") sessionManager.markAgentInterrupted(record.id, at);
			},
		});

		expect(summary.marked).toBe(1);
		expect(typeof readEntry(id)?.interruptedAt).toBe("string");
		const agent = JSON.parse(fs.readFileSync(path.join(env.storageDir, `${id}.json`), "utf-8"));
		expect(typeof agent.interruptedAt).toBe("string");
	});

	it("drops a stale background entry whose agent record is already terminal", async () => {
		const id = crypto.randomUUID();
		registerInflightRun({ id, kind: "background", owner: DEAD_OWNER, startedAt: ISO });
		const deps = { ...defaultRecoveryDeps(), sleep: async () => {}, graceMs: 0 };
		const summary = await recoverInflightRuns({
			deps,
			readAgentRecord: () => ({ status: "done" }),
			mark: () => {
				throw new Error("must not mark a settled background run");
			},
		});
		expect(summary.marked).toBe(0);
		expect(summary.scanned).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 3. PERF REGRESSION GUARD
// ---------------------------------------------------------------------------

describe("boot scan cost guard", () => {
	it("never touches the full agent store — only the one agent record named", async () => {
		// A large unrelated store that a full parse would sweep.
		fs.mkdirSync(env.storageDir, { recursive: true });
		for (let i = 0; i < 50; i++) {
			fs.writeFileSync(
				path.join(env.storageDir, `${crypto.randomUUID()}.json`),
				JSON.stringify({ id: `unrelated-${i}`, status: "running", task: "x", model: "m" }),
			);
		}
		const named = crypto.randomUUID();
		fs.writeFileSync(
			path.join(env.storageDir, `${named}.json`),
			JSON.stringify({ id: named, status: "running", owner: DEAD_OWNER, task: "t", model: "m" }),
		);
		registerInflightRun({ id: named, kind: "background", owner: DEAD_OWNER, startedAt: ISO });

		const fullStore = vi.spyOn(sessionManager, "listPersistedAgents");
		let singleReads = 0;
		const deps = { ...defaultRecoveryDeps(), sleep: async () => {}, graceMs: 0 };
		await recoverInflightRuns({
			deps,
			readAgentRecord: (rid) => {
				singleReads++;
				return sessionManager.getAgent(rid);
			},
			mark: () => {},
		});

		expect(fullStore).not.toHaveBeenCalled();
		// Exactly the one named record was read, not the 50 unrelated files.
		expect(singleReads).toBe(1);
		// Static tripwire: the scan module must never reference the full-store reader.
		const recoverySource = fs.readFileSync(path.join(__dirname, "..", "recovery.ts"), "utf-8");
		expect(recoverySource).not.toMatch(/listPersistedAgents/);
		fullStore.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// 4. WAIT-ONCE
// ---------------------------------------------------------------------------

describe("boot scan wait-once", () => {
	function orphanRecords(count: number): RecoveryRecord[] {
		return Array.from({ length: count }, (_, i) => ({
			id: `orphan-${i}`,
			kind: "run" as const,
			status: "running",
			owner: DEAD_OWNER,
			childMarker: `m-${i}`,
		}));
	}

	it("N orphans cost ONE grace window, not N", async () => {
		const sleep = vi.fn(async () => {});
		const deps: RecoveryDeps = {
			pidAlive: (pid) => pid >= 100 && pid < 100 + 5,
			startTokenOf: () => undefined,
			findByMarker: (marker) => [100 + Number(marker.slice(2))],
			kill: vi.fn(),
			sleep,
			graceMs: 50,
		};
		const summary = await runBootScan({ records: orphanRecords(5), deps, mark: () => {} });
		expect(summary.marked).toBe(5);
		expect(summary.reaped).toBe(5);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(50);
	});

	it("bounds elapsed time to ~one grace window", async () => {
		const count = 5;
		const graceMs = 100;
		const deps: RecoveryDeps = {
			pidAlive: (pid) => pid >= 100 && pid < 100 + count,
			startTokenOf: () => undefined,
			findByMarker: (marker) => [100 + Number(marker.slice(2))],
			kill: vi.fn(),
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			graceMs,
		};
		const started = Date.now();
		await runBootScan({ records: orphanRecords(count), deps, mark: () => {} });
		const elapsed = Date.now() - started;
		// Per-record sleeping would be ~5 × 100ms = 500ms; one window is ~100ms.
		expect(elapsed).toBeLessThan(graceMs * 3);
	});
});

// ---------------------------------------------------------------------------
// 5. PRODUCTION /proc GUARD (B8)
// ---------------------------------------------------------------------------

describe("production /proc guard", () => {
	it("marks and kills NOTHING when /proc is unavailable", async () => {
		// A candidate that WOULD be marked on a /proc host (dead owner + marker).
		const id = crypto.randomUUID();
		registerInflightRun({
			id,
			kind: "foreground",
			owner: DEAD_OWNER,
			childMarker: "b8-marker",
			startedAt: ISO,
		});

		const kill = vi.fn();
		const marked: string[] = [];
		__setProcAvailableForTest(false);
		try {
			const summary = await recoverProduction({
				deps: { ...defaultRecoveryDeps(), kill, sleep: async () => {}, graceMs: 0 },
				mark: (record) => marked.push(record.id),
			});
			expect(summary).toMatchObject({ scanned: 0, marked: 0, reaped: 0, revisited: 0 });
			expect(marked).toEqual([]);
			expect(kill).not.toHaveBeenCalled();
		} finally {
			__setProcAvailableForTest(undefined);
		}
		// The registry entry is untouched, so a capable host can still recover it.
		expect(readEntry(id)?.interruptedAt).toBeUndefined();
	});
});
