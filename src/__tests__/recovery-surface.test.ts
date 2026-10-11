/**
 * Option B U3 — recovery surface unit tests (T1–T6).
 *
 * Pure/core coverage: the Run History projection (T1), the boot-notice
 * builder + delivery discipline (T2), the recovery posture config (T3), the
 * retry-surface candidate projection + offer text (T4), the per-run dispatch
 * snapshot (T5), and the abandon action core (T6). No SDK, no pi, no process
 * work — every effect is injected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	collapseRunsForHistory,
	retryableRuns,
	createSessionState,
	resolveTerminalRunEntry,
} from "../state";
import type { SubagentRun } from "../types";
import {
	DEFAULT_RECOVERY,
	RECOVERY_MODES,
	runRecoveryPosture,
	isSubagentRunShape,
	CUSTOM_ENTRY_TYPES,
} from "../types";
import {
	runHistoryStatus,
	runHistoryStatusLabel,
	buildRetryOfferMessage,
} from "../tui-format";
import {
	collectInterruptedRuns,
	offeredInterruptedRuns,
	buildRecoveryNotice,
	resolveRecoveryNoticeDelivery,
	formatRecoveryAge,
	abandonInterruptedRun,
	SUBAGENT_ABANDONED_MESSAGE,
	RECOVERY_NOTICE_CUSTOM_TYPE,
	type InterruptedRunView,
	type AbandonDeps,
} from "../recovery-surface";
import {
	persistRunRecord,
	listInflightRuns,
} from "../run-registry";
import { claimTerminalNotice, __resetTerminalClaims } from "../notify-completion";
import { createUnitRun } from "../unit-run";
import { createTempEnv } from "./fixtures/temp-lifecycle";
import type { Logger } from "../logging";

const ID_A = "11111111-2222-3333-4444-555555555555";
const ID_B = "66666666-7777-8888-9999-000000000000";
const ID_C = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeLog(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: ID_A,
		task: "do a thing",
		status: "running",
		model: "provider/model",
		thinkingLevel: "medium",
		startedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function view(overrides: Partial<InterruptedRunView> = {}): InterruptedRunView {
	return {
		id: ID_A,
		kind: "foreground",
		label: "Label A",
		task: "do a thing",
		startedAt: "2026-01-01T00:00:00.000Z",
		interruptedAt: "2026-01-01T00:00:00.000Z",
		recoveryPosture: "offer",
		...overrides,
	};
}

/** Build an {@link AbandonDeps} harness over an in-memory run store. */
function makeDeps(initial: SubagentRun[]): {
	deps: AbandonDeps;
	writes: SubagentRun[];
	markStopped: ReturnType<typeof vi.fn>;
	retire: ReturnType<typeof vi.fn>;
	prune: ReturnType<typeof vi.fn>;
	store: () => SubagentRun[];
} {
	let store = [...initial];
	const writes: SubagentRun[] = [];
	const markStopped = vi.fn();
	const retire = vi.fn();
	const prune = vi.fn();
	return {
		deps: {
			getRun: (id) => resolveTerminalRunEntry(store, id),
			writeRun: (run) => {
				writes.push(run);
				store = [...store, run];
			},
			markAgentStopped: markStopped,
			retireRegistry: retire,
			pruneSession: prune,
		},
		writes,
		markStopped,
		retire,
		prune,
		store: () => store,
	};
}

// ---------------------------------------------------------------------------
// T1 — Run History rendering keys on isInterruptedRun
// ---------------------------------------------------------------------------

describe("T1 — Run History projection (D1)", () => {
	const spawn = makeRun({ id: ID_A, status: "running" });
	const marked = makeRun({
		id: ID_A,
		status: "running",
		interruptedAt: "2026-01-01T01:00:00.000Z",
	});
	const terminal = makeRun({ id: ID_A, status: "done", finishedAt: "2026-01-01T02:00:00.000Z" });

	it("(a) surfaces an interrupted run (marked clone wins over the spawn entry)", () => {
		const rows = collapseRunsForHistory([spawn, marked]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe(marked);
		expect(runHistoryStatus(rows[0])).toBe("interrupted");
		expect(runHistoryStatusLabel(rows[0])).toBe("Interrupted");
	});

	it("(b) omits a plain running run (spawn entry with no mark, no terminal)", () => {
		expect(collapseRunsForHistory([spawn])).toEqual([]);
		expect(runHistoryStatus(spawn)).toBe("running");
	});

	it("(c) keeps a terminal run, and a terminal entry beats the mark", () => {
		const rows = collapseRunsForHistory([spawn, marked, terminal]);
		expect(rows).toEqual([terminal]);
		expect(runHistoryStatus(rows[0])).toBe("done");
		expect(runHistoryStatus(makeRun({ status: "failed" }))).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// T2 — boot notice
// ---------------------------------------------------------------------------

describe("T2 — boot notice (D2)", () => {
	const run = makeRun({ id: ID_A, label: "Alpha", task: "Summarize the incident report" });

	it("collects interrupted runs from the durable registry and enriches them", () => {
		const views = collectInterruptedRuns({
			listInflight: () => [
				{ id: ID_A, kind: "foreground", startedAt: "2026-01-01T00:00:00.000Z", cwd: "/x", interruptedAt: "2026-01-01T00:00:00.000Z" },
				{ id: ID_B, kind: "unit", startedAt: "2026-01-01T00:00:00.000Z", cwd: "/x" }, // not interrupted
			],
			getAgent: () => null,
			findRun: (id) => (id === ID_A ? run : undefined),
		});
		expect(views).toHaveLength(1);
		expect(views[0].label).toBe("Alpha");
		expect(views[0].task).toBe("Summarize the incident report");
		expect(views[0].recoveryPosture).toBe("offer");
	});

	it("falls back to the agent record for label/task when no session entry exists", () => {
		const views = collectInterruptedRuns({
			listInflight: () => [
				{ id: ID_A, kind: "background", startedAt: "2026-01-01T00:00:00.000Z", cwd: "/x", interruptedAt: "2026-01-01T00:00:00.000Z" },
			],
			getAgent: () => ({ description: "BG label", task: "BG task" }),
			findRun: () => undefined,
		});
		expect(views[0].label).toBe("BG label");
		expect(views[0].task).toBe("BG task");
	});

	// Fix B item 3: the durable registry snapshot is the authoritative posture.
	// The session run entry is only a fallback for pre-U3 registry entries that
	// never wrote the snapshot — a swap of this precedence must fail these cases.
	it("registry posture wins over the session run snapshot (off beats run offer)", () => {
		const views = collectInterruptedRuns({
			listInflight: () => [
				{ id: ID_A, kind: "background", startedAt: "2026-01-01T00:00:00.000Z", cwd: "/x", interruptedAt: "2026-01-01T00:00:00.000Z", recoveryPosture: "off" },
			],
			getAgent: () => null,
			findRun: () => makeRun({ id: ID_A, recoveryPosture: "offer" }),
		});
		expect(views[0].recoveryPosture).toBe("off");
	});

	it("registry posture wins over the session run snapshot (offer beats run off)", () => {
		const views = collectInterruptedRuns({
			listInflight: () => [
				{ id: ID_A, kind: "background", startedAt: "2026-01-01T00:00:00.000Z", cwd: "/x", interruptedAt: "2026-01-01T00:00:00.000Z", recoveryPosture: "offer" },
			],
			getAgent: () => null,
			findRun: () => makeRun({ id: ID_A, recoveryPosture: "off" }),
		});
		expect(views[0].recoveryPosture).toBe("offer");
	});

	it("falls back to the session run snapshot when the registry carries none", () => {
		const views = collectInterruptedRuns({
			listInflight: () => [
				{ id: ID_A, kind: "background", startedAt: "2026-01-01T00:00:00.000Z", cwd: "/x", interruptedAt: "2026-01-01T00:00:00.000Z" },
			],
			getAgent: () => null,
			findRun: () => makeRun({ id: ID_A, recoveryPosture: "off" }),
		});
		expect(views[0].recoveryPosture).toBe("off");
	});

	// Fix B item 8: enrichment reads are best-effort — a throwing agent-store
	// read must degrade to the missing-agent path, never abort the whole surface.
	it("a throwing agent-store read degrades to the missing-agent path", () => {
		const views = collectInterruptedRuns({
			listInflight: () => [
				{ id: ID_A, kind: "foreground", startedAt: "2026-01-01T00:00:00.000Z", cwd: "/x", interruptedAt: "2026-01-01T00:05:00.000Z" },
			],
			getAgent: () => {
				throw new Error("agent store exploded");
			},
			findRun: () => undefined,
		});
		expect(views).toHaveLength(1);
		expect(views[0].id).toBe(ID_A);
		expect(views[0].task).toBeUndefined();
	});

	it("builds ONE notice listing id8 · label · task excerpt · age", () => {
		const notice = buildRecoveryNotice(
			[view({ id: ID_A, label: "Alpha", task: "Summarize the incident report" })],
			new Date("2026-01-01T00:05:00.000Z"),
		);
		expect(notice.customType).toBe(RECOVERY_NOTICE_CUSTOM_TYPE);
		expect(notice.content).toContain(ID_A.slice(0, 8));
		expect(notice.content).toContain("Alpha");
		expect(notice.content).toContain("Summarize the incident report");
		expect(notice.content).toContain("interrupted 5m ago");
		expect(notice.details).toEqual({ count: 1, ids: [ID_A] });
	});

	it("hints that a task-less (foreground) row needs the task supplied to retry (Fix B item 7)", () => {
		const notice = buildRecoveryNotice([view({ task: undefined })], new Date("2026-01-01T00:05:00.000Z"));
		expect(notice.content).toContain("(task unavailable)");
		expect(notice.content).toContain("pass `task` explicitly");
	});

	it("delivers at a turn boundary — nextTurn, never steer", () => {
		expect(resolveRecoveryNoticeDelivery()).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
		expect(resolveRecoveryNoticeDelivery().deliverAs).not.toBe("steer");
	});

	it("is quiet when no interrupted run is offered", () => {
		expect(offeredInterruptedRuns([])).toEqual([]);
		const off = view({ recoveryPosture: "off" });
		expect(offeredInterruptedRuns([off])).toEqual([]);
		expect(offeredInterruptedRuns([view({ recoveryPosture: "offer" })])).toHaveLength(1);
	});

	it("formats ages compactly", () => {
		expect(formatRecoveryAge(30_000)).toBe("30s");
		expect(formatRecoveryAge(5 * 60_000)).toBe("5m");
		expect(formatRecoveryAge(3 * 3_600_000)).toBe("3h");
		expect(formatRecoveryAge(2 * 86_400_000)).toBe("2d");
	});
});

// ---------------------------------------------------------------------------
// T3 — recovery posture config
// ---------------------------------------------------------------------------

describe("T3 — recovery posture config (D4)", () => {
	function restoreCtx(data: unknown): ExtensionContext {
		return {
			sessionManager: {
				getEntries: () => [{ type: "custom", customType: CUSTOM_ENTRY_TYPES.state, data }],
			},
		} as unknown as ExtensionContext;
	}

	it("defaults to 'offer' and rejects 'auto' from the mode list", () => {
		expect(DEFAULT_RECOVERY).toBe("offer");
		expect(RECOVERY_MODES).toEqual(["offer", "off"]);
		expect(RECOVERY_MODES).not.toContain("auto");
		expect(createSessionState(makeLog()).config.recovery).toBe("offer");
	});

	it("restores a persisted posture and falls back to 'offer' on an invalid value", () => {
		const s1 = createSessionState(makeLog());
		expect(s1.restoreFromSession(restoreCtx({ recovery: "off" }))).toBe(true);
		expect(s1.config.recovery).toBe("off");

		const s2 = createSessionState(makeLog());
		// "auto" fails the shape guard → the WHOLE state entry is rejected.
		expect(s2.restoreFromSession(restoreCtx({ recovery: "auto" }))).toBe(false);
		expect(s2.config.recovery).toBe("offer");
	});

	it("persists the posture and resets to the default", () => {
		const state = createSessionState(makeLog());
		const appendEntry = vi.fn();
		state.config.recovery = "off";
		state.persistState({ appendEntry } as never);
		expect(appendEntry).toHaveBeenCalledWith(
			CUSTOM_ENTRY_TYPES.state,
			expect.objectContaining({ recovery: "off" }),
		);
		state.reset();
		expect(state.config.recovery).toBe("offer");
	});
});

// ---------------------------------------------------------------------------
// T4 — retry surface
// ---------------------------------------------------------------------------

describe("T4 — retry surface (D3)", () => {
	it("lists failed and interrupted runs, one row per id, excludes done", () => {
		const spawnA = makeRun({ id: ID_A, status: "running" });
		const markedA = makeRun({ id: ID_A, status: "running", interruptedAt: "2026-01-01T01:00:00.000Z" });
		const failedB = makeRun({ id: ID_B, status: "failed", errorMessage: "boom" });
		const doneC = makeRun({ id: ID_C, status: "done" });

		const candidates = retryableRuns([spawnA, markedA, failedB, doneC]);
		expect(candidates.map((r) => r.id)).toEqual([ID_A, ID_B]);
	});

	it("the offer names retryRunId and the recorded-params contract", () => {
		const interrupted = makeRun({ id: ID_A, status: "running", interruptedAt: "iso" });
		const msg = buildRetryOfferMessage(interrupted);
		expect(msg).toContain(`retryRunId: ${ID_A}`);
		expect(msg).toContain("interrupted");
		expect(msg).toContain("recorded params");

		const failed = makeRun({ id: ID_B, status: "failed" });
		expect(buildRetryOfferMessage(failed)).toContain("failed");
	});
});

// ---------------------------------------------------------------------------
// T5 — per-run dispatch snapshot
// ---------------------------------------------------------------------------

describe("T5 — per-run recovery posture snapshot (D4)", () => {
	const env = createTempEnv("brl-u3-snapshot");

	beforeEach(() => env.setUp());
	afterEach(async () => {
		await env.tearDown();
	});

	it("reads absent as 'offer' and honors an explicit 'off'", () => {
		expect(runRecoveryPosture({})).toBe("offer");
		expect(runRecoveryPosture({ recoveryPosture: "off" })).toBe("off");
		expect(runRecoveryPosture({ recoveryPosture: "offer" })).toBe("offer");
	});

	it("an old record (no snapshot) still passes the shape guard and reads as offer", () => {
		const old = { id: ID_A, task: "t", status: "running" as const };
		expect(isSubagentRunShape(old)).toBe(true);
		expect(runRecoveryPosture(old)).toBe("offer");
		// A malformed snapshot is rejected.
		expect(isSubagentRunShape({ ...old, recoveryPosture: "auto" })).toBe(false);
	});

	it("writes the snapshot onto a unit run and the registry entry", () => {
		const { run } = createUnitRun(
			{
				task: "unit task",
				inheritSP: false,
				thinkingLevel: "medium",
				effectiveCwd: env.testCwd,
			},
			{ provider: "test", id: "m" },
			"normal",
			undefined,
			"off",
		);
		expect(run.recoveryPosture).toBe("off");

		const appendEntry = vi.fn();
		persistRunRecord({ appendEntry } as never, run, "unit");
		expect(appendEntry).toHaveBeenCalledWith(
			CUSTOM_ENTRY_TYPES.run,
			expect.objectContaining({ id: run.id, recoveryPosture: "off" }),
		);
		const entry = listInflightRuns().find((r) => r.id === run.id);
		expect(entry?.recoveryPosture).toBe("off");

		// Default (4-arg) dispatch snapshots "offer".
		const { run: fresh } = createUnitRun(
			{ task: "fresh", inheritSP: false, thinkingLevel: "medium", effectiveCwd: env.testCwd },
			{ provider: "test", id: "m" },
			"normal",
		);
		expect(fresh.recoveryPosture).toBe("offer");
	});
});

// ---------------------------------------------------------------------------
// T6 — abandon
// ---------------------------------------------------------------------------

describe("T6 — abandon action (D5)", () => {
	it("finalizes the run as the terminal stopped outcome and prunes its session", () => {
		const interrupted = makeRun({
			id: ID_A,
			status: "running",
			interruptedAt: "2026-01-01T01:00:00.000Z",
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		const h = makeDeps([interrupted]);

		const abandoned = abandonInterruptedRun(ID_A, h.deps, new Date("2026-01-01T02:00:00.000Z"));

		expect(abandoned).toBe(true);
		expect(h.writes).toHaveLength(1);
		const terminal = h.writes[0];
		expect(terminal.status).toBe("failed");
		expect(terminal.stopReason).toBe("aborted");
		expect(terminal.errorCategory).toBe("aborted");
		expect(terminal.errorMessage).toBe(SUBAGENT_ABANDONED_MESSAGE);
		// No longer interrupted → it will no longer be offered.
		expect(runHistoryStatus(resolveTerminalRunEntry(h.store(), ID_A)!)).toBe("failed");
		expect(h.markStopped).toHaveBeenCalledWith(ID_A);
		expect(h.retire).toHaveBeenCalledWith(ID_A);
		expect(h.prune).toHaveBeenCalledWith(ID_A);
	});

	it("is idempotent and safe when the run is absent or not interrupted", () => {
		const interrupted = makeRun({ id: ID_A, status: "running", interruptedAt: "iso" });
		const h = makeDeps([interrupted]);
		abandonInterruptedRun(ID_A, h.deps);
		expect(h.prune).toHaveBeenCalledTimes(1);

		// Second call: the terminal record is now the resolved entry → no-op.
		expect(abandonInterruptedRun(ID_A, h.deps)).toBe(false);
		expect(h.prune).toHaveBeenCalledTimes(1);
		expect(h.writes).toHaveLength(1);

		// Not interrupted / absent → no-op, no prune.
		const plain = makeDeps([makeRun({ id: ID_B, status: "running" })]);
		expect(abandonInterruptedRun(ID_B, plain.deps)).toBe(false);
		expect(plain.prune).not.toHaveBeenCalled();

		const missing = makeDeps([]);
		expect(abandonInterruptedRun(ID_C, missing.deps)).toBe(false);
		expect(missing.prune).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Fix B (item 1) — abandon suppresses the completion wake
// ---------------------------------------------------------------------------

describe("Fix B — abandon suppresses the completion wake (item 1)", () => {
	// Mirrors index.ts's terminal-event subscriber (`deliverCompletionAlert`):
	// the FIRST terminal path to claim an id is the one that wakes the conductor.
	const wakes: string[] = [];
	const onTerminalEvent = (id: string): void => {
		if (claimTerminalNotice(id)) wakes.push(id);
	};

	beforeEach(() => {
		__resetTerminalClaims();
		wakes.length = 0;
	});
	afterEach(() => __resetTerminalClaims());

	it("an abandoned run does not wake the conductor", () => {
		const interrupted = makeRun({ id: ID_A, status: "running", interruptedAt: "iso" });
		const h = makeDeps([interrupted]);

		expect(abandonInterruptedRun(ID_A, h.deps)).toBe(true);
		// The production `markAgentStopped` emits `subagent:stopped` after this.
		onTerminalEvent(ID_A);
		expect(wakes).toEqual([]);
	});

	it("a normal stop still wakes (no pre-claim on the normal path)", () => {
		onTerminalEvent(ID_B);
		expect(wakes).toEqual([ID_B]);
	});

	it("a no-op abandon leaves the wake path untouched", () => {
		const plain = makeDeps([makeRun({ id: ID_B, status: "running" })]);
		expect(abandonInterruptedRun(ID_B, plain.deps)).toBe(false);
		onTerminalEvent(ID_B);
		expect(wakes).toEqual([ID_B]);
	});
});
