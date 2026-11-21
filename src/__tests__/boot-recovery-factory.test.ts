/**
 * ADR 0027 S4 — the boot recovery factory: its per-instance latch (D5) and the
 * abandon action's injected deps.
 *
 * `src/boot-recovery.ts` owns `recoveryNoticeDelivered`, the once-per-boot latch
 * U3 introduced. D5's blocker is a latch that outlives its owner: module-private
 * (or composition-root-private) once-per-boot state is shared by two runtimes, so
 * one session's notice silences another's — and one session's shutdown re-arms
 * the wrong latch. This suite drives the factory DIRECTLY (no extension boot) and
 * pins:
 *
 *   1. the notice is once per factory instance, a SECOND factory still notifies,
 *      and `resetRecoveryNotice` is the re-arm the shutdown handler calls;
 *   2. `abandonProductionRun` finalizes an interrupted run through the deps it
 *      injects into `abandonInterruptedRun` — the run record is written terminal,
 *      the agent record is flipped, the registry entry is retired and the session
 *      directory is pruned — resolving the run through the visibility bridge with
 *      ZERO session entries (the fresh-boot case, Fix A).
 *
 * The durable stores are redirected into a per-test throwaway dir by the shared
 * temp-lifecycle fixture; only the two session-manager mutators the abandon path
 * reaches are stubbed, so their call is observable. Everything else is real.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const h = vi.hoisted(() => ({
	updateAgentStatus: vi.fn(),
	pruneBackgroundSession: vi.fn(),
}));

vi.mock("../session-manager", async (importOriginal) => ({
	...(await importOriginal<typeof import("../session-manager")>()),
	updateAgentStatus: h.updateAgentStatus,
	pruneBackgroundSession: h.pruneBackgroundSession,
}));

import { createBootRecovery } from "../boot-recovery";
import { listInflightRuns, markInterrupted, registerInflightRun } from "../run-registry";
import { createRuntime } from "../runtime";
import { RECOVERY_NOTICE_CUSTOM_TYPE, SUBAGENT_ABANDONED_MESSAGE } from "../recovery-surface";
import { CUSTOM_ENTRY_TYPES } from "../types";
import { setLogCwd } from "../logging";
import { createTempEnv } from "./fixtures/temp-lifecycle";

const env = createTempEnv("brl-s4-boot");
const ID = "11111111-2222-3333-4444-555555555555";

interface Captured {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

let captured: Captured[] = [];
let appended: Array<{ type: string; data: unknown }> = [];

function fakePi(): ExtensionAPI {
	return {
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			captured.push({ message, options });
		},
		appendEntry: (type: string, data: unknown) => {
			appended.push({ type, data });
		},
	} as unknown as ExtensionAPI;
}

/** A genuinely fresh session: the crashed run lives only in the durable stores. */
function freshCtx(): ExtensionContext {
	return {
		cwd: env.testCwd,
		model: { provider: "test", id: "model" },
		getSystemPrompt: () => "SYSTEM",
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
		sessionManager: { getEntries: () => [], appendCustomEntry: () => {} },
	} as unknown as ExtensionContext;
}

/** The durable state production leaves after a crash: registry mark + agent record. */
function seedInterruptedRun(): void {
	registerInflightRun({
		id: ID,
		kind: "background",
		startedAt: "2026-01-01T00:00:00.000Z",
		cwd: env.testCwd,
		recoveryPosture: "offer",
	});
	markInterrupted(ID, "2026-01-01T00:05:00.000Z");
	fs.mkdirSync(env.storageDir, { recursive: true });
	fs.writeFileSync(
		path.join(env.storageDir, `${ID}.json`),
		JSON.stringify({
			id: ID,
			sessionId: ID,
			type: "general-purpose",
			description: "Recoverable",
			status: "running",
			startedAt: 1_767_225_600_000,
			task: "recover me",
			model: "provider/model",
			thinkingLevel: "medium",
		}),
	);
}

function recoveryNotices(): Captured[] {
	return captured.filter((entry) => entry.message.customType === RECOVERY_NOTICE_CUSTOM_TYPE);
}

beforeEach(() => {
	env.setUp();
	captured = [];
	appended = [];
	h.updateAgentStatus.mockReset();
	h.updateAgentStatus.mockImplementation((id: string, status: string) => ({ id, status }));
	h.pruneBackgroundSession.mockReset();
});

afterEach(async () => {
	await env.tearDown();
});

describe("the boot-recovery factory's latch is per instance (ADR 0027 D5)", () => {
	it("notifies once per factory, a second factory still notifies, and the reset re-arms", async () => {
		seedInterruptedRun();
		const rt = createRuntime(fakePi());
		const first = createBootRecovery(rt);

		await first.maybeSendRecoveryNotice(freshCtx());
		expect(recoveryNotices()).toHaveLength(1);
		expect(recoveryNotices()[0].options).toMatchObject({ deliverAs: "nextTurn", triggerTurn: true });

		// Once per instance — the mutant is a per-call (or module-private) latch
		// that cannot tell one owner from another.
		await first.maybeSendRecoveryNotice(freshCtx());
		expect(recoveryNotices()).toHaveLength(1);

		// A second factory over the same runtime is a separate owner: it notifies.
		const second = createBootRecovery(rt);
		await second.maybeSendRecoveryNotice(freshCtx());
		expect(recoveryNotices()).toHaveLength(2);

		// `resetRecoveryNotice` is the shutdown re-arm: after it, the SAME
		// instance notifies again (the closure used to assign the flag inline).
		first.resetRecoveryNotice();
		await first.maybeSendRecoveryNotice(freshCtx());
		expect(recoveryNotices()).toHaveLength(3);
	});
});

// =========================================================================
// Issue #554 — the boot-time temp-residue sweep. A SIGKILL cannot run the
// atomic writer's cleanup, so `.tmp` siblings are bounded at boot. The age
// floor keeps a LIVE writer's temp alive.
// =========================================================================
describe("issue #554 — the boot sweeps stale agent-record temps", () => {
	it("removes a 2-hour-old temp, keeps a fresh one (even under another pid), and only logs when it swept", async () => {
		fs.mkdirSync(env.storageDir, { recursive: true });
		const oldTemp = path.join(env.storageDir, `${ID}.json.4242.aaaaaaaa.tmp`);
		const freshTemp = path.join(env.storageDir, `${ID}.json.9999.bbbbbbbb.tmp`);
		fs.writeFileSync(oldTemp, "partial");
		fs.writeFileSync(freshTemp, "partial");
		const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(oldTemp, twoHoursAgo, twoHoursAgo);

		setLogCwd(env.testCwd);
		await createBootRecovery(createRuntime(fakePi())).performBootRecovery();

		expect(fs.existsSync(oldTemp)).toBe(false);
		expect(fs.existsSync(freshTemp)).toBe(true);
		const log = fs.readFileSync(path.join(env.testCwd, ".pi", "subagent-logs", "brl-subagent.log"), "utf8");
		expect(log).toContain("swept stale agent-record temps");
		expect(log).toContain('"count":1');
	});
});

describe("abandonProductionRun resolves through the deps it injects (S4)", () => {
	it("writes the terminal record, flips the agent, retires the registry and prunes the session", async () => {
		seedInterruptedRun();
		const boot = createBootRecovery(createRuntime(fakePi()));

		await boot.abandonProductionRun(freshCtx(), ID);

		// writeRun: the terminal run record went through the session choke point.
		const written = appended
			.filter((entry) => entry.type === CUSTOM_ENTRY_TYPES.run)
			.map((entry) => entry.data as Record<string, unknown>);
		expect(written).toHaveLength(1);
		expect(written[0]).toMatchObject({
			id: ID,
			status: "failed",
			stopReason: "aborted",
			errorCategory: "aborted",
			errorMessage: SUBAGENT_ABANDONED_MESSAGE,
		});

		// markAgentStopped + pruneSession: the two session-manager mutators, called
		// with the run id — the injected capabilities, not an import from here.
		expect(h.updateAgentStatus).toHaveBeenCalledWith(ID, "stopped");
		expect(h.pruneBackgroundSession).toHaveBeenCalledWith(ID);

		// retireRegistry: the durable interruption mark is gone.
		expect(listInflightRuns().map((entry) => entry.id)).not.toContain(ID);
	});

	it("resolves the run through the visibility bridge — zero session entries", async () => {
		seedInterruptedRun();
		const rt = createRuntime(fakePi());
		const boot = createBootRecovery(rt);
		const ctx = freshCtx();

		// The bridge is the reason a fresh boot can abandon at all: the session has
		// never seen this run, so a session-sourced lookup finds nothing and only the
		// synthetic interrupted record (registry + agent store) resolves the id.
		expect(rt.state.getRunEntries(ctx)).toEqual([]);
		expect(boot.visibleRunsFor(ctx, () => null).map((run) => run.id)).toEqual([ID]);

		await boot.abandonProductionRun(ctx, ID);
		expect(h.updateAgentStatus).toHaveBeenCalledWith(ID, "stopped");
	});
});

// =========================================================================
// Issue #546 (r5 major 1 + major 2, r6 major) — N3: a CORRUPT agent record
// holds its marker and is never noticed, while the SAME scan marks and notices
// the control run. This is the P6/E23 residual as a shipped regression pin: a
// record torn by a kill inside `persistAgent` can never be repaired, so the
// marker must survive and the ledger must count a FAILED settlement — never a
// repair, never a retirement.
//
// THE CONTROL IS NOT PRE-MARKED (r6): an ordinary ACCEPTED entry with a dead
// owner and NO `interruptedAt`. The case asserts its persisted BYTES CHANGED and
// it became interrupted — the one observable a scan that skips ordinary
// candidates cannot fake (M22). A control seeded with `seedInterruptedRun()`
// satisfies the `interruptedAt` assertion by construction and passes M22 (E26).
//
// This case lives here, not in `boot-recovery-import-failure-546.test.ts`,
// because that file's `vi.mock` factory throws and makes the module unreal —
// and a DELIVERED notice (the notice names the control's id8, not the held
// marker's) needs the real module.
// =========================================================================
describe("issue #546 r6 — N3: a corrupt record is held; only the control is noticed", () => {
	it("keeps the marker, counts failures:1, marks the control, and the notice lists the control alone", async () => {
		setLogCwd(env.testCwd);
		const heldId = "aaaaaaaa-1111-4111-8111-111111111111";
		const controlId = "bbbbbbbb-2222-4222-8222-222222222222";
		const marker = { status: "failed", error: "spawn preflight failure", at: "2026-01-01T00:05:00.000Z" };
		const DEAD = { pid: 999999, start: "dead" };
		const registryDir = path.join(env.baseDir, "run-registry");

		// HELD: marker + a CORRUPT record (0 bytes = a torn in-place write).
		fs.mkdirSync(registryDir, { recursive: true });
		fs.mkdirSync(env.storageDir, { recursive: true });
		fs.writeFileSync(
			path.join(registryDir, `${heldId}.json`),
			JSON.stringify({ id: heldId, kind: "background", startedAt: "2026-01-01T00:00:00.000Z", cwd: env.testCwd, acceptedAt: "2026-01-01T00:00:01.000Z", recoveryPosture: "offer", owner: DEAD, recordFlipPending: marker }, null, 2),
		);
		fs.writeFileSync(path.join(env.storageDir, `${heldId}.json`), "");
		const heldEntryBefore = fs.readFileSync(path.join(registryDir, `${heldId}.json`), "utf8");

		// CONTROL: an ordinary ACCEPTED candidate with a dead owner, and NO
		// `interruptedAt` — the scan MUST mark it, and its bytes must change.
		registerInflightRun({
			id: controlId,
			kind: "background",
			startedAt: "2026-01-01T00:00:00.000Z",
			cwd: env.testCwd,
			recoveryPosture: "offer",
			acceptedAt: "2026-01-01T00:00:01.000Z",
			owner: DEAD,
		});
		fs.writeFileSync(
			path.join(env.storageDir, `${controlId}.json`),
			JSON.stringify({
				id: controlId, sessionId: controlId, type: "general-purpose", description: "Recoverable",
				status: "running", startedAt: 1_767_225_600_000, task: "recover me",
				model: "provider/model", thinkingLevel: "medium",
			}),
		);
		const controlBefore = fs.readFileSync(path.join(registryDir, `${controlId}.json`), "utf8");
		expect(listInflightRuns().find((e) => e.id === controlId)?.interruptedAt ?? null).toBe(null);

		const boot = createBootRecovery(createRuntime(fakePi()));
		await boot.performBootRecovery();
		await boot.maybeSendRecoveryNotice(freshCtx());

		// THE SCAN RAN: the control's bytes changed and it is interrupted.
		const controlAfter = fs.readFileSync(path.join(registryDir, `${controlId}.json`), "utf8");
		expect(controlAfter).not.toBe(controlBefore);
		expect(listInflightRuns().find((e) => e.id === controlId)?.interruptedAt).toBeTruthy();

		// The held marker is byte-identical and still carries the marker.
		expect(fs.readFileSync(path.join(registryDir, `${heldId}.json`), "utf8")).toBe(heldEntryBefore);
		const held = listInflightRuns().find((e) => e.id === heldId);
		expect(held?.recordFlipPending).toMatchObject({ status: "failed" });
		expect(held?.interruptedAt ?? null).toBe(null);

		// The ledger: a corrupt record is a FAILED settlement, never a repair.
		const logFile = path.join(env.testCwd, ".pi", "subagent-logs", "brl-subagent.log");
		const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const settle = lines.find((l) => /settled pending record flips/.test(l.message ?? ""));
		// Issue #554: the ledger NAMES the corrupt subset (this record is 0 bytes).
		expect(settle?.data).toMatchObject({ repaired: 0, retired: 0, failures: 1, corrupt: 1 });

		// The delivered notice lists the control alone — a real delivery, not a
		// projection.
		expect(recoveryNotices()).toHaveLength(1);
		const rendered = JSON.stringify(recoveryNotices()[0].message);
		expect(rendered).toContain(controlId.slice(0, 8));
		expect(rendered).not.toContain(heldId.slice(0, 8));
	});
});
