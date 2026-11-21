/**
 * Issue #546 (major B) — the IMPORT-FAILURE HOLD, shipped.
 *
 * `boot-recovery.ts` builds its record-flip wiring inside the existing lazy
 * `await import("./session-manager")`. When that import fails, the scan must
 * still run over the run registry and must HOLD every `recordFlipPending`
 * marker: no never-started finalizer, no interrupted mark, no settlement — the
 * entry and the agent record are left byte-identical for a later boot that can
 * actually apply the flip.
 *
 * TWO FAILURES THIS FILE MUST NOT PERMIT AGAIN (r5):
 *
 *   1. A TEST THAT PASSES WITHOUT A SCAN. The r4 cases asserted only that
 *      nothing happened, so a mutant returning immediately after the failed
 *      import passed 2/2 (M21). Every case now plants a SAME-SCAN POSITIVE
 *      CONTROL — an ordinary accepted entry with a dead owner — that the
 *      registry-only scan MUST mark interrupted. If the scan never runs, the
 *      control is unmarked and the case fails.
 *   2. A VACUOUS NO-NOTICE ASSERTION. `boot()` calls only
 *      `performBootRecovery`; `maybeSendRecoveryNotice` is a separate method
 *      that the r4 cases never invoked, so "no notice" was a statement about a
 *      function that never ran. The case now invokes it, asserts the held marker
 *      is absent from the exact projection the notice surface consumes, and
 *      asserts the control IS the only run in it.
 *
 * The throwing `vi.mock` factory is why this file must not import
 * `session-manager` (or the temp-lifecycle fixture, which does): any static edge
 * would re-throw during collection instead of inside `performBootRecovery`. It
 * also means the notice surface degrades to `Recovery notice failed` here — the
 * delivered-notice half of the control is pinned in
 * `boot-recovery-factory.test.ts` (N3), where the module is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("../session-manager", () => {
	throw new Error("simulated: session-manager unavailable at boot");
});

import { createBootRecovery } from "../boot-recovery";
import { defaultRecoveryDeps, recoverInflightRuns } from "../recovery";
import { listInflightRuns, __setRegistryDir } from "../run-registry";
import { collectInterruptedRuns, offeredInterruptedRuns } from "../recovery-surface";
import { createRuntime } from "../runtime";
import { setLogCwd } from "../logging";

const MARKER = { status: "failed", error: "spawn preflight failure", at: "2026-11-21T00:00:02.000Z" };
const DEAD = { pid: 999999, start: "dead" };

let base = "";
let registry = "";
let agents = "";
let ID = "";
let CONTROL = "";

beforeEach(() => {
	base = fs.mkdtempSync(path.join(process.cwd(), ".tmp", "s546-r5-importfail-"));
	registry = path.join(base, "registry");
	agents = path.join(base, "agents");
	fs.mkdirSync(registry, { recursive: true });
	fs.mkdirSync(agents, { recursive: true });
	__setRegistryDir(registry);
	setLogCwd(base);
	ID = randomUUID();
	CONTROL = randomUUID();
});

afterEach(() => {
	setLogCwd(undefined);
	fs.rmSync(base, { recursive: true, force: true });
});

/** A minimal background entry + its `running` record, written straight to disk. */
function seed(id: string, extra: Record<string, unknown>, acceptedAt: string | null) {
	fs.writeFileSync(
		path.join(registry, `${id}.json`),
		JSON.stringify(
			{
				id,
				kind: "background",
				startedAt: "2026-11-21T00:00:00.000Z",
				label: `probe-${id.slice(0, 4)}`,
				task: `probe task ${id.slice(0, 4)}`,
				cwd: base,
				acceptedAt,
				recoveryPosture: "offer",
				owner: DEAD,
				...extra,
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(agents, `${id}.json`),
		JSON.stringify(
			{
				id,
				sessionId: id,
				type: "general-purpose",
				description: `probe-${id.slice(0, 4)}`,
				status: "running",
				startedAt: 1,
				task: `probe task ${id.slice(0, 4)}`,
				owner: DEAD,
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
}

function plant(acceptedAt: string | null) {
	seed(ID, { recordFlipPending: MARKER }, acceptedAt);
	return {
		entryBytes: fs.readFileSync(path.join(registry, `${ID}.json`), "utf8"),
		recordBytes: fs.readFileSync(path.join(agents, `${ID}.json`), "utf8"),
	};
}

/**
 * THE POSITIVE CONTROL: a plain ACCEPTED entry with a dead owner. The same
 * registry-only scan must mark it interrupted — that mark is the proof the scan
 * ran. Kept OUT of `plant()` so the half-wired cases (which must reach no
 * ordinary candidate at all) plant nothing the scan could act on.
 */
function plantControl(): { controlBytes: string } {
	seed(CONTROL, {}, "2026-11-21T00:00:01.000Z");
	return { controlBytes: fs.readFileSync(path.join(registry, `${CONTROL}.json`), "utf8") };
}

/** The production boot: the factory, its real runtime, the real scan + notice. */
async function boot() {
	const appended: unknown[] = [];
	const sent: unknown[] = [];
	const pi = {
		sendMessage: (message: unknown) => sent.push(message),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	};
	const boot = createBootRecovery(createRuntime(pi as never));
	await boot.performBootRecovery();
	// r5: the notice is a SEPARATE method — invoke it, or "no notice" is vacuous.
	await boot.maybeSendRecoveryNotice({
		cwd: base,
		model: { provider: "p", id: "m" },
		getSystemPrompt: () => "",
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
		sessionManager: { getEntries: () => [], appendCustomEntry: () => {} },
	} as never);
	const logFile = path.join(base, ".pi", "subagent-logs", "brl-subagent.log");
	const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
	return { appended, sent, log };
}

for (const [name, acceptedAt] of [
	["N1: `acceptedAt: null`", null],
	["N2: an ACCEPTED entry", "2026-11-21T00:00:01.000Z"],
] as Array<[string, string | null]>) {
	describe(`issue #546 r5 — import failure holds the marker (${name})`, () => {
		it(`${name} is HELD while the SAME scan marks the control`, async () => {
			const before = plant(acceptedAt);
			const { controlBytes } = plantControl();
			const { appended, sent, log } = await boot();

			// The fault really was the one under test: the lazy import failed and the
			// scan ran registry-only instead of falling over.
			expect(log).toContain("session-manager unavailable");
			expect(log).not.toContain("Boot recovery scan failed");

			// BYTE-IDENTICAL: no `interruptedAt`, no marker rewrite, nothing retired.
			expect(fs.readFileSync(path.join(registry, `${ID}.json`), "utf8")).toBe(before.entryBytes);
			// The record is untouched too: still `running`, never marked interrupted.
			expect(fs.readFileSync(path.join(agents, `${ID}.json`), "utf8")).toBe(before.recordBytes);

			// Read back through the real registry reader — the marker survives verbatim.
			const held = listInflightRuns().find((e) => e.id === ID);
			expect(held?.recordFlipPending).toMatchObject({ status: "failed" });
			expect(held?.interruptedAt ?? null).toBe(null);

			// NO never-started finalizer and NO notice for the held entry.
			expect(appended).toEqual([]);
			expect(sent).toEqual([]);

			// ---- THE POSITIVE CONTROL: the same scan acted on the plain entry ----
			// Its bytes CHANGED and it carries `interruptedAt`. A scan that never
			// runs leaves it untouched, so this assertion — not the silence around
			// the held marker — is what detects M21 (skip-after-import).
			expect(fs.readFileSync(path.join(registry, `${CONTROL}.json`), "utf8")).not.toBe(controlBytes);
			const control = listInflightRuns().find((e) => e.id === CONTROL);
			expect(control?.interruptedAt).toBeTruthy();
			const markLine = log
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
				.find((l) => /marked interrupted runs/.test(l.message ?? ""));
			expect(markLine?.data).toMatchObject({ marked: 1 });

			// The notice surface DID run (under the mocked module it degrades to a
			// warn, which is how we know it was invoked, not skipped), delivered
			// nothing, and — in the exact projection it consumes — lists the CONTROL
			// alone. The held marker is absent because the scan held it unmarked.
			expect(log).toContain("Recovery notice failed");
			const offered = offeredInterruptedRuns(
				collectInterruptedRuns({
					listInflight: () => listInflightRuns(),
					getAgent: () => null,
					findRun: () => undefined,
				}),
			);
			expect(offered.map((v) => v.id)).toEqual([CONTROL]);

			// NO ledger line: a hold is not a settlement.
			expect(log).not.toContain("settled pending record flips");
			expect(log).not.toContain("finalized never-started dispatches");
		});
	});
}

// =========================================================================
// Issue #546 r4 (§D7) — the HALF-WIRED hold, shipped. The production factory
// wires both flip dependencies or neither, so this shape is only reachable
// through `recoverInflightRuns` with one dependency explicitly absent. Both
// shapes must HOLD: no applier call, no fresh read, no finalizer, no mark, no
// settlement — the marker survives byte-identical, and all three flip counters
// stay at zero BY DESIGN (a hold is not a settlement failure).
// `mut-M20-halfwired-falls-through` (the `||` → `&&` guard) is killed by these.
// =========================================================================
for (const wired of ["applier", "reader"] as const) {
	describe(`issue #546 r4 — D7: a HALF-WIRED ${wired} is HELD (all flip counters zero)`, () => {
		it(`${wired}-only: both acceptance states keep entry and marker byte-identical`, async () => {
			for (const acceptedAt of [null, "2026-11-21T00:00:01.000Z"]) {
				// A fresh id and a fresh registry per state: the scan is global.
				ID = randomUUID();
				fs.rmSync(registry, { recursive: true, force: true });
				fs.mkdirSync(registry, { recursive: true });
				const before = plant(acceptedAt);

				let applies = 0;
				let reads = 0;
				const summary = await recoverInflightRuns({
					deps: defaultRecoveryDeps,
					mark: () => {
						throw new Error("a HELD marker must never be marked interrupted");
					},
					finalizeNeverStarted: () => {
						throw new Error("a HELD marker must never reach the never-started finalizer");
					},
					...(wired === "applier"
						? {
								applyRecordFlip: () => {
									applies++;
									throw new Error("a HALF-WIRED marker must not reach the applier");
								},
							}
						: {
								readFreshAgentRecord: () => {
									reads++;
									throw new Error("a HALF-WIRED marker must not reach the fresh reader");
								},
							}),
				});

				expect({ applies, reads }).toEqual({ applies: 0, reads: 0 });
				expect(fs.readFileSync(path.join(registry, `${ID}.json`), "utf8")).toBe(before.entryBytes);
				expect(fs.readFileSync(path.join(agents, `${ID}.json`), "utf8")).toBe(before.recordBytes);
				// ALL THREE flip counters are zero: a hold is not a settlement, and it is
				// not a failure either — `flipFailures` counts a settlement we TRIED and
				// could not prove, never a marker we deliberately did not touch.
				expect({
					repaired: summary.flipRepaired,
					retired: summary.flipRetired,
					failures: summary.flipFailures,
					marked: summary.marked,
				}).toEqual({ repaired: 0, retired: 0, failures: 0, marked: 0 });
			}
		});
	});
}
