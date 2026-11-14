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
