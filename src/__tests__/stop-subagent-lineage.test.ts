/**
 * Issue #616 — `stop_subagent`'s DISPATCH contract.
 *
 * The observed failure: a background dispatch died on a transport error and was
 * auto-retried once under the same label but a DIFFERENT agent id. Stopping the
 * id the conductor had been given stopped the corpse, printed
 * `Stopped agent <id> (<description>).` — and the live retry kept writing (it
 * produced a merge-gating review record nine seconds before it was killed by
 * hand).
 *
 * The contract these tests pin (see `briefs/stop-lineage-contract.md`):
 *
 *   - resolve with `resolveAgentId` (full id or a unique 8-hex prefix; an
 *     ambiguous prefix stops nothing);
 *   - expand to the dispatch family, keep the named attempt plus every family
 *     member whose recorded `retryCause` is `transport`, and leave a `manual`
 *     retry alone (naming it stops it);
 *   - never stop an attempt whose cause is ABSENT — absent is unknown;
 *   - honour the armed-retry marker at the spawn's pre-prompt gate;
 *   - verify TERMINAL from the re-read record before the word "Stopped" is used;
 *   - never print a universal claim over an armed retry, an unknown cause, a
 *     live out-of-scope attempt, or a truncated scan — each gets its own line.
 *
 * Mutation targets (each test names the one it kills):
 *
 *   - live set = `[found]` (today's behaviour)            → "stops the retry"
 *   - drop the `retryCause` filter                        → "manual retry untouched"
 *   - treat absent cause as transport                     → "cause unknown"
 *   - ignore the armed marker                             → "spawn window"
 *   - skip the post-stop re-read                          → "verify from records"
 *   - resolve with `getAgent` instead of `resolveAgentId` → "prefix"
 *   - drop the disclosure lines                           → "truncated"
 *
 * IDS ARE FRESH PER TEST. `session-manager`'s in-memory agent map is module state
 * that survives a test (only the stores are re-pointed), so reusing one id for
 * "live" in one case and "stopped" in the next makes `getAgent` — memory-first —
 * answer from the wrong test. `freshId()` keeps every case self-contained.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

// The pi SDK is stubbed for BOTH surfaces this suite drives: `initExtension`
// (which only needs the two renderer symbols) and a REAL
// `spawnBackgroundSession` (which needs a session factory) — two cases below must
// observe an actual `_sessionRef` and an actual prompt call.
const piMock = vi.hoisted(() => ({
	createAgentSession: vi.fn(),
	session: {
		sessionId: "sess-616",
		setSessionName: vi.fn(),
		prompt: vi.fn(),
		abort: vi.fn().mockResolvedValue(undefined),
		steer: vi.fn().mockResolvedValue(undefined),
		getSessionStats: vi.fn(() => ({ tokens: { input: 0, output: 0 } })),
		messages: [] as unknown[],
	},
	reload: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
	class MockDefaultResourceLoader {
		options: Record<string, unknown>;
		reload = piMock.reload;
		constructor(options: Record<string, unknown>) {
			this.options = options;
		}
	}
	class DynamicBorder {}
	const getMarkdownTheme = () => ({});
	return {
		DynamicBorder,
		getMarkdownTheme,
		getAgentDir: () => "/tmp/brl-616-agentdir",
		createAgentSession: piMock.createAgentSession,
		SessionManager: { create: () => ({ getSessionFile: () => undefined }) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: MockDefaultResourceLoader,
	};
});

vi.mock("@earendil-works/pi-tui", () => {
	class Container {}
	class SelectList {}
	class Spacer {}
	class Text {}
	class Markdown {}
	return { Container, SelectList, Spacer, Text, Markdown };
});

vi.mock("../runner", () => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
	reapActiveChildren: vi.fn().mockResolvedValue(0),
}));

import initExtension from "../index";
import { getAgent, spawnBackgroundSession } from "../session-manager";
import { listInflightRuns, registerInflightRun } from "../run-registry";
import { newDispatchIdentity } from "../recovery-engine";
import { armRetry, cancelArmedRetry, clearArmedRetry, readArmedRetry } from "../retry-armed";
import { isSubagentRunShape, CANCELLED_RETRY_MESSAGE, type SubagentRun } from "../types";
import { createTempEnv } from "./fixtures/temp-lifecycle";

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
}

interface ToolEntry {
	name: string;
	description: string;
	execute: (
		callId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<ToolResult>;
}

const env = createTempEnv("brl-616-stop");

/** Every run record the extension appended — the run history's only source. */
const appendedEntries: Array<{ type: string; data: unknown }> = [];

let stopTool: ToolEntry;

beforeAll(() => {
	const registered = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (tool: ToolEntry) => registered.set(tool.name, tool),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: (entry: { type: string; data: unknown }) => {
			appendedEntries.push(entry);
		},
		sendMessage: () => {},
		ctx: { getState: () => undefined, setState: () => {} },
	};
	initExtension(mockPi as never);
	const tool = registered.get("stop_subagent");
	if (!tool) throw new Error("stop_subagent tool not registered");
	stopTool = tool;
	// The real spawn path needs a session; `prompt` never settles unless a test
	// says otherwise, so a spawned run stays `running` exactly like the probe.
	piMock.createAgentSession.mockResolvedValue({ session: piMock.session });
});

/** Permission tests must not leak a read-only directory into the next setUp. */
function restoreWritable(): void {
	for (const dir of [
		env.storageDir,
		path.join(env.baseDir, "run-registry"),
		path.join(env.baseDir, "run-registry", "armed"),
	]) {
		try {
			fs.chmodSync(dir, 0o700);
		} catch {
			// absent — nothing to restore
		}
	}
}

beforeEach(() => {
	env.setUp();
	appendedEntries.length = 0;
	piMock.session.prompt.mockReset();
	piMock.session.prompt.mockReturnValue(new Promise(() => {}));
	piMock.session.abort.mockClear();
	piMock.session.messages = [];
});
afterAll(async () => await env.tearDown());
afterEach(() => {
	restoreWritable();
	vi.restoreAllMocks();
});

const STARTED = Date.parse("2026-11-28T10:00:00.000Z");

/** A fresh uuid — see the file header for why no test may share one. */
function freshId(): string {
	return randomUUID();
}

const AMBIGUOUS_PREFIX = "abcdef12";
const AMBIGUOUS_A = `${AMBIGUOUS_PREFIX}-1111-4111-8111-111111111111`;
const AMBIGUOUS_B = `${AMBIGUOUS_PREFIX}-2222-4222-8222-222222222222`;

/** Write one agent record; `startedAt` is epoch ms, as the store writes it. */
function writeAgent(
	id: string,
	overrides: Record<string, unknown> = {},
	mtime?: Date,
): void {
	fs.mkdirSync(env.storageDir, { recursive: true });
	const file = path.join(env.storageDir, `${id}.json`);
	fs.writeFileSync(
		file,
		JSON.stringify({
			id,
			sessionId: `sess-${id.slice(0, 8)}`,
			type: "general-purpose",
			description: `agent ${id.slice(0, 8)}`,
			status: "completed",
			startedAt: STARTED,
			task: "do the thing",
			model: "test/model",
			thinkingLevel: "medium",
			...overrides,
		}),
	);
	if (mtime) fs.utimesSync(file, mtime, mtime);
}

interface DeadSource {
	sourceId: string;
	dispatchId: string;
}

/** Attempt 1 of a dispatch that died on a transport error. */
function deadTransportSource(overrides: Record<string, unknown> = {}): DeadSource {
	const sourceId = freshId();
	const dispatchId = freshId();
	writeAgent(sourceId, {
		status: "failed",
		error: "Connection error.",
		attempt: 1,
		dispatchId,
		startedAt: STARTED,
		...overrides,
	});
	return { sourceId, dispatchId };
}

/** A live attempt of `source`'s dispatch; `cause` omitted writes NO field. */
function writeRetry(
	source: DeadSource,
	attempt: number,
	cause: "transport" | "manual" | undefined,
	status = "running",
): string {
	const id = freshId();
	writeAgent(id, {
		status,
		attempt,
		dispatchId: source.dispatchId,
		resumeOf: source.sourceId,
		...(cause === undefined ? {} : { retryCause: cause }),
	});
	return id;
}

async function invoke(agentId: string): Promise<ToolResult> {
	return stopTool.execute("call-616", { agent_id: agentId }, undefined, undefined, {});
}

/** Spawn a REAL background run and return its agent id (the live attempt). */
async function spawnLive(overrides: Record<string, unknown> = {}): Promise<string> {
	const agent = await spawnBackgroundSession(
		{ appendEntry: (entry: { type: string; data: unknown }) => appendedEntries.push(entry) } as never,
		{
			cwd: env.testCwd,
			modelRegistry: { find: () => ({ provider: "test", id: "model" }) },
			getSystemPrompt: () => "SYSTEM",
		} as never,
		{
			task: "review the diff",
			description: "review",
			model: "test/model",
			thinkingLevel: "medium",
			cwd: env.testCwd,
			...overrides,
		} as never,
	);
	return agent.id;
}

// ---------------------------------------------------------------------------
// The discriminator — one mint site states the cause (issue #616, Q2)
// ---------------------------------------------------------------------------

describe("retryCause is stated at the mint site, never inferred", () => {
	it("stamps the cause the mint site names and omits it for a fresh dispatch", () => {
		const source = { id: "orig", dispatchId: "disp-1", attempt: 1 } as SubagentRun;

		expect(newDispatchIdentity(source, "transport")).toEqual({
			dispatchId: "disp-1",
			resumeOf: "orig",
			attempt: 2,
			retryCause: "transport",
		});
		expect(newDispatchIdentity(source, "manual").retryCause).toBe("manual");

		// A cause without a source would describe a retry with no origin, and a
		// retry with no stated cause stays UNKNOWN — never `transport`.
		expect(newDispatchIdentity(undefined, "transport").retryCause).toBeUndefined();
		expect(newDispatchIdentity(source).retryCause).toBeUndefined();
	});

	it("round-trips the cause through the in-flight registry", () => {
		const retryId = freshId();
		expect(
			registerInflightRun({
				id: retryId,
				kind: "background",
				attempt: 2,
				retryCause: "transport",
				startedAt: new Date(STARTED).toISOString(),
			}),
		).toBe(true);
		expect(listInflightRuns().find((run) => run.id === retryId)?.retryCause).toBe("transport");

		// A mistyped cause is DROPPED on read (absent ⇒ unknown), never coerced to
		// the stop-scoped value.
		const mistyped = freshId();
		fs.mkdirSync(path.join(env.baseDir, "run-registry"), { recursive: true });
		fs.writeFileSync(
			path.join(env.baseDir, "run-registry", `${mistyped}.json`),
			JSON.stringify({
				id: mistyped,
				kind: "background",
				startedAt: new Date(STARTED).toISOString(),
				retryCause: "automatic",
			}),
		);
		expect(listInflightRuns().find((run) => run.id === mistyped)?.retryCause).toBeUndefined();
	});

	it("rejects a mistyped cause on a run record and accepts an absent one", () => {
		const base = { id: "r", task: "t", status: "running" as const };
		expect(isSubagentRunShape({ ...base, retryCause: "transport" })).toBe(true);
		expect(isSubagentRunShape(base)).toBe(true);
		expect(isSubagentRunShape({ ...base, retryCause: "automatic" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The dispatch-scoped stop
// ---------------------------------------------------------------------------

describe("stop_subagent stops the dispatch, not the id (issue #616, F1)", () => {
	it("stops a live transport retry when the caller names the dead attempt 1", async () => {
		const source = deadTransportSource();
		const liveId = await spawnLive({
			dispatchId: source.dispatchId,
			resumeOf: source.sourceId,
			attempt: 2,
			retryCause: "transport",
		});
		expect(piMock.session.prompt).toHaveBeenCalledTimes(1);
		expect(getAgent(liveId)?.status).toBe("running");

		// The caller holds the 8-hex id of the DEAD attempt — all a notice renders.
		const result = await invoke(source.sourceId.slice(0, 8));

		// Mutation killed: live set = `[found]` (today's behaviour) — attempt 2
		// would keep running and the text would name attempt 1.
		expect(piMock.session.abort).toHaveBeenCalledTimes(1);
		expect(getAgent(liveId)?.status).toBe("stopped");
		expect(result.content[0].text).toContain(
			`Stopped agent ${liveId} (attempt 2, cause transport, review).`,
		);
		expect(result.content[0].text).not.toContain(`Stopped agent ${source.sourceId}`);
		expect(result.content[0].text).toContain(
			`Nothing of this dispatch (${source.dispatchId}) is running.`,
		);
		expect(result.content[0].text).not.toContain("Lineage not fully checked");
		expect(result.isError).toBeFalsy();
	});
});

describe("an all-terminal dispatch is a no-op success (F2, F9)", () => {
	it("names the terminal status and never says Stopped", async () => {
		const source = deadTransportSource({ retryCause: "transport" });
		writeRetry(source, 2, "transport", "completed");

		const result = await invoke(source.sourceId);

		expect(result.content[0].text).toBe(
			`Agent ${source.sourceId} is already failed (attempt 1, cause transport) — nothing stopped.\n` +
				`Nothing of this dispatch (${source.dispatchId}) is running.`,
		);
		expect(result.content[0].text).not.toContain("Stopped");
		expect(result.isError).toBeFalsy();
	});

	it("aborts nothing and stays a success on the second stop", async () => {
		const lone = freshId();
		writeAgent(lone, { status: "running", attempt: 1 });

		const first = await invoke(lone);
		expect(getAgent(lone)?.status).toBe("stopped");
		expect(first.content[0].text).toContain(`Stopped agent ${lone} (attempt 1, cause unknown,`);

		const second = await invoke(lone);
		// Mutation killed: skipping the post-stop re-read would report "Stopped"
		// twice — and the second call must not error (idempotence).
		expect(second.content[0].text).toBe(
			`Agent ${lone} is already stopped (attempt 1, cause unknown) — nothing stopped.\n` +
				`Nothing of this dispatch (${lone}) is running.`,
		);
		expect(second.content[0].text).not.toContain("Stopped agent");
		expect(second.isError).toBeFalsy();
	});
});

describe("a manual retry is a scope filter, not an immunity (F3, F4)", () => {
	it("leaves a live manual retry running and names it as residue", async () => {
		const source = deadTransportSource();
		const manualId = writeRetry(source, 2, "manual");

		const result = await invoke(source.sourceId);

		// Mutation killed: dropping the `retryCause` filter would stop it.
		expect(getAgent(manualId)?.status).toBe("running");
		expect(result.content[0].text).toContain(
			`Left running: ${manualId} (attempt 2, cause manual) — a manual retry is not stopped by a stop aimed at another attempt; name it to stop it.`,
		);
		// A live attempt of the same dispatch exists, so the universal claim is
		// suppressed even though it is out of scope.
		expect(result.content[0].text).not.toContain("Nothing of this dispatch");
		expect(result.content[0].text).not.toContain("Stopped agent");
		expect(result.isError).toBeFalsy();
	});

	it("stops the manual retry when its own id is named", async () => {
		const source = deadTransportSource();
		const manualId = writeRetry(source, 2, "manual");

		const result = await invoke(manualId);

		expect(getAgent(manualId)?.status).toBe("stopped");
		expect(result.content[0].text).toContain(
			`Stopped agent ${manualId} (attempt 2, cause manual,`,
		);
		expect(result.isError).toBeFalsy();
	});
});

describe("an unknown retry cause is disclosed, never stopped (F6)", () => {
	it("leaves the attempt alone and says the cause could not be established", async () => {
		const source = deadTransportSource();
		const unknownId = writeRetry(source, 2, undefined);

		const result = await invoke(source.sourceId);

		// Mutation killed: treating an absent cause as `transport` would stop it.
		expect(getAgent(unknownId)?.status).toBe("running");
		expect(result.content[0].text).toContain(
			`Left running: ${unknownId} (attempt 2, cause unknown) — the retry cause could not be established, so this dispatch-scoped stop leaves it alone.`,
		);
		expect(result.content[0].text).not.toContain("Nothing of this dispatch");
		expect(result.isError).toBeFalsy();
	});
});

describe("the armed-retry marker closes the spawn window (F5, Q3)", () => {
	it("cancels the retry, and the spawn honours it instead of prompting", async () => {
		const source = deadTransportSource();
		expect(
			armRetry({ parentId: source.sourceId, attempt: 2, armedAt: new Date().toISOString() }),
		).toBe(true);

		const result = await invoke(source.sourceId);

		// Mutation killed: ignoring the armed marker would report the dispatch as
		// quiet (or as a plain no-op) while the retry was about to prompt.
		expect(result.content[0].text).toBe(
			`Cancelled transport retry for ${source.sourceId} (attempt 2, cause transport) before it prompted — the dispatch is not claimed quiescent until it settles.`,
		);
		expect(result.isError).toBeFalsy();
		expect(readArmedRetry(source.sourceId)?.cancelRequested).toBe(true);

		// The retry now starts. The pre-prompt gate must see the cancel.
		piMock.session.prompt.mockClear();
		const retryId = await spawnLive({
			dispatchId: source.dispatchId,
			resumeOf: source.sourceId,
			attempt: 2,
			retryCause: "transport",
		});

		expect(piMock.session.prompt).not.toHaveBeenCalled();
		expect(getAgent(retryId)?.status).toBe("stopped");
		expect(getAgent(retryId)?.error).toBe(CANCELLED_RETRY_MESSAGE);
		expect(getAgent(retryId)?.completedAt).toBeTypeOf("number");
		// The marker's job is done: it must not outlive the spawn it described.
		expect(readArmedRetry(source.sourceId)).toBeNull();
	});

	it("is an INTENT, not a run: no registry entry, no run record, no agent record", async () => {
		const source = deadTransportSource();
		expect(
			armRetry({ parentId: source.sourceId, attempt: 2, armedAt: new Date().toISOString() }),
		).toBe(true);

		// `listInflightRuns` is the registry read the boot scan and every
		// run-shaped surface enumerate; the marker must be invisible to it.
		expect(listInflightRuns()).toEqual([]);
		expect(appendedEntries.filter((entry) => JSON.stringify(entry).includes("armed"))).toEqual([]);
		expect(fs.readdirSync(env.storageDir)).toEqual([`${source.sourceId}.json`]);

		// It lives in its own file kind, outside every `*.json` run enumeration.
		expect(
			fs.existsSync(path.join(env.baseDir, "run-registry", "armed", `${source.sourceId}.json`)),
		).toBe(true);
	});

	it("reports a marker it could not cancel as an error", async () => {
		const source = deadTransportSource();
		expect(
			armRetry({ parentId: source.sourceId, attempt: 2, armedAt: new Date().toISOString() }),
		).toBe(true);
		// The retry may still prompt: the intent exists and cannot be written.
		fs.chmodSync(path.join(env.baseDir, "run-registry", "armed"), 0o500);
		let result: ToolResult;
		try {
			result = await invoke(source.sourceId);
		} finally {
			restoreWritable();
		}

		expect(result.content[0].text).toContain(
			`An armed transport retry for ${source.sourceId} (attempt 2, cause transport) could not be cancelled`,
		);
		expect(result.isError).toBe(true);
	});

	it("clears the marker once the retry is durable, so no later stop sees a phantom", async () => {
		const source = deadTransportSource();
		expect(
			armRetry({ parentId: source.sourceId, attempt: 2, armedAt: new Date().toISOString() }),
		).toBe(true);

		const retryId = await spawnLive({
			dispatchId: source.dispatchId,
			resumeOf: source.sourceId,
			attempt: 2,
			retryCause: "transport",
		});

		expect(piMock.session.prompt).toHaveBeenCalledTimes(1);
		expect(readArmedRetry(source.sourceId)).toBeNull();

		const result = await invoke(source.sourceId);
		expect(result.content[0].text).toContain(
			`Stopped agent ${retryId} (attempt 2, cause transport, review).`,
		);
		expect(getAgent(retryId)?.status).toBe("stopped");
	});
});

describe("addressing: a unique prefix resolves, an ambiguous one stops nothing (F7)", () => {
	it("resolves the 8-hex prefix the notices render", async () => {
		const lone = freshId();
		writeAgent(lone, { status: "running", attempt: 1 });

		const result = await invoke(lone.slice(0, 8));

		expect(result.content[0].text).toContain(`Stopped agent ${lone} (attempt 1,`);
		expect(getAgent(lone)?.status).toBe("stopped");
		expect(result.isError).toBeFalsy();
	});

	it("refuses an ambiguous prefix and stops nothing", async () => {
		writeAgent(AMBIGUOUS_A, { status: "running", attempt: 1 });
		writeAgent(AMBIGUOUS_B, { status: "running", attempt: 1 });

		const result = await invoke(AMBIGUOUS_PREFIX);

		// Mutation killed: `getAgent` instead of `resolveAgentId` would answer
		// "not found" for the prefix — or stop a guessed member.
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(`Agent id prefix "${AMBIGUOUS_PREFIX}" is ambiguous`);
		expect(result.content[0].text).toContain(AMBIGUOUS_A);
		expect(result.content[0].text).toContain(AMBIGUOUS_B);
		expect(result.content[0].text).toContain("Nothing was stopped.");
		expect(getAgent(AMBIGUOUS_A)?.status).toBe("running");
		expect(getAgent(AMBIGUOUS_B)?.status).toBe("running");
	});

	it("keeps the not-found answer for an id no store knows", async () => {
		const unknown = freshId();
		const result = await invoke(unknown);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe(`Agent ${unknown} not found`);
	});
});

describe("a truncated lineage scan is disclosed, never claimed quiet (F8, Q7)", () => {
	it("discloses a requested record older than the scan window", async () => {
		const source = deadTransportSource({
			startedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
		});
		const retryId = writeRetry(source, 2, "transport");

		const result = await invoke(source.sourceId);

		// Mutation killed: dropping the disclosure lines would let the universal
		// claim ride on a scan that provably could not see the whole dispatch.
		expect(result.content[0].text).toContain(
			`Lineage not fully checked: ${source.sourceId} started more than 7 days ago, outside the retry scan window.`,
		);
		expect(result.content[0].text).not.toContain("Nothing of this dispatch");
		// The retry was still stopped — disclosure is not a failure.
		expect(getAgent(retryId)?.status).toBe("stopped");
		expect(result.isError).toBeFalsy();
	});

	it("discloses a scan that hit its record cap", async () => {
		const older = new Date(Date.now() - 60_000);
		for (let i = 0; i < 205; i += 1) {
			writeAgent(
				`10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
				{ dispatchId: `10000000-0000-4000-9000-${String(i).padStart(12, "0")}` },
				older,
			);
		}
		const source = deadTransportSource({ startedAt: Date.now() - 5_000 });
		writeRetry(source, 2, "transport");

		const result = await invoke(source.sourceId);

		expect(result.content[0].text).toContain(
			"Lineage not fully checked: the agent-store scan hit its record cap (only the newest records were read).",
		);
		expect(result.content[0].text).not.toContain("Nothing of this dispatch");
		expect(result.isError).toBeFalsy();
	});
});

describe("the verdict is the store's, not the primitive's return value (F2)", () => {
	it("refuses the word Stopped when the record never reaches a terminal status", async () => {
		const lone = freshId();
		writeAgent(lone, { status: "running", attempt: 1 });
		// `stopAgent` flips memory, then persists. A store it cannot write leaves
		// the DISK record running — the only evidence that matters here.
		fs.chmodSync(env.storageDir, 0o500);
		let result: ToolResult;
		try {
			result = await invoke(lone);
		} finally {
			restoreWritable();
		}

		// Mutation killed: skipping the post-stop re-read would print
		// "Stopped agent …" for a record that is still `running` on disk.
		expect(result.content[0].text).toContain(
			`Attempt ${lone} (attempt 1, cause unknown) did not reach a terminal status (store says: status running) — it may still be running.`,
		);
		expect(result.content[0].text).not.toContain("Stopped agent");
		expect(result.isError).toBe(true);
	});
});

describe("a single live agent keeps the documented stop shape (F10)", () => {
	it("prints one Stopped line with the description, and the quiescence line", async () => {
		const lone = freshId();
		writeAgent(lone, { status: "running", attempt: 1, description: "audit" });

		const result = await invoke(lone);

		expect(result.content[0].text).toBe(
			`Stopped agent ${lone} (attempt 1, cause unknown, audit).\n` +
				`Nothing of this dispatch (${lone}) is running.`,
		);
		expect(result.isError).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------
// The marker's own contract
// ---------------------------------------------------------------------------

describe("armed-marker primitives", () => {
	it("reports three cancel outcomes and never throws", () => {
		const parent = freshId();
		expect(cancelArmedRetry(parent, 2)).toBe("gone");
		expect(armRetry({ parentId: parent, attempt: 2, armedAt: new Date().toISOString() })).toBe(true);
		// A marker for a DIFFERENT attempt is not this retry's intent.
		expect(cancelArmedRetry(parent, 3)).toBe("gone");
		expect(cancelArmedRetry(parent, 2)).toBe("cancelled");
		expect(readArmedRetry(parent)?.cancelRequested).toBe(true);
		// Re-arming keeps the cancel: a second arming must not un-cancel a stop.
		expect(armRetry({ parentId: parent, attempt: 2, armedAt: new Date().toISOString() })).toBe(true);
		expect(readArmedRetry(parent)?.cancelRequested).toBe(true);
		expect(clearArmedRetry(parent, 2)).toBe(true);
		expect(readArmedRetry(parent)).toBeNull();
	});
});

describe("stop_subagent description (issue #616)", () => {
	it("documents the dispatch scope and the residue disclosure", () => {
		expect(stopTool.description).toContain("DISPATCH-scoped");
		expect(stopTool.description).toContain("automatic transport retry");
		expect(stopTool.description).toContain("manual retry");
		expect(stopTool.description).toContain("attempt, cause");
		expect(stopTool.description).toContain("already-terminal dispatch is a no-op success");
	});
});
