/**
 * Issue #396 — `get_subagent_result` reports the retry lineage.
 *
 * The observed failure (2026-10-27) was a conductor reading "Agent <id> not
 * found" as "the run is dead" after a session restart, then re-dispatching a
 * task that had already been auto-recovered as attempt 2. The same harm has a
 * second shape: a terminal source record (`failed`, `Connection error.`) was
 * real and found, but the completed retry that superseded it was never named.
 *
 * These tests drive the REAL `get_subagent_result` handler against temp agent /
 * registry stores. Each case is paired with a mutation target (see the
 * per-test comments):
 *
 *   - short id `99f4e815` -> descendant named      (remove prefix resolution)
 *   - full terminal id -> "Superseded by" line     (drop the found-path append)
 *   - ambiguous prefix -> refusal                  (remove the ambiguity branch)
 *   - no lineage -> registry text                  (drop the registry read)
 *   - dispatchId family -> attempt-3 grandchild    (match `resumeOf` only)
 *   - bounded read count + window                  (remove the window/cap)
 *   - malformed JSON skipped                       (remove the completeness guard)
 *   - unsafe id -> not found, no throw
 *   - found-and-latest -> unchanged output
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

// Count every file read session-manager performs during a lineage answer. The
// bound is the contract: stat-first + mtime window + K=200, not a full store
// parse. A partial module mock is the only way to observe the named import
// (`import { readFileSync } from "fs"`) — the ESM namespace is not spy-able.
const fsProbe = vi.hoisted(() => ({ readFileSync: 0 }));

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs");
	return {
		...actual,
		readFileSync: ((...args: unknown[]) => {
			fsProbe.readFileSync += 1;
			return (actual.readFileSync as (...inner: unknown[]) => unknown)(...args);
		}) as typeof actual.readFileSync,
	};
});

vi.mock("../runner", () => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
	reapActiveChildren: vi.fn().mockResolvedValue(0),
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
	class DynamicBorder {}
	const getMarkdownTheme = () => ({});
	return { DynamicBorder, getMarkdownTheme };
});

vi.mock("@earendil-works/pi-tui", () => {
	class Container {}
	class SelectList {}
	class Spacer {}
	class Text {}
	class Markdown {}
	return { Container, SelectList, Spacer, Text, Markdown };
});

import initExtension from "../index";
import { registerInflightRun } from "../run-registry";
import { createTempEnv } from "./fixtures/temp-lifecycle";

interface ToolEntry {
	name: string;
	description: string;
	execute: (
		callId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	}>;
}

const env = createTempEnv("brl-396-lineage");

let getResult: ToolEntry;

beforeAll(() => {
	const registered = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (tool: ToolEntry) => registered.set(tool.name, tool),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		ctx: { getState: () => undefined, setState: () => {} },
	};
	initExtension(mockPi as never);
	const tool = registered.get("get_subagent_result");
	if (!tool) throw new Error("get_subagent_result tool not registered");
	getResult = tool;
});

beforeEach(() => env.setUp());
afterAll(async () => await env.tearDown());
afterEach(() => vi.restoreAllMocks());

const SOURCE_ID = "99f4e815-9968-4554-a7b0-0cf646aa9e26";
const RETRY_ID = "f36f8413-0bb4-4752-918f-93ed19c31014";
const GRANDCHILD_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const DISPATCH_ID = "1662ba9e-1111-4222-8333-944455556666";
const UNKNOWN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AMBIGUOUS_A = "abcdef12-1111-4111-8111-111111111111";
const AMBIGUOUS_B = "abcdef12-2222-4222-8222-222222222222";
const MALFORMED_ID = "badbadba-dddd-4ddd-8ddd-dddddddddddd";
const ISO = "2026-10-28T10:00:00.000Z";

function startedMs(iso: string): number {
	return Date.parse(iso);
}

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
			startedAt: startedMs(ISO),
			task: "do the thing",
			model: "test/model",
			thinkingLevel: "medium",
			...overrides,
		}),
	);
	if (mtime) fs.utimesSync(file, mtime, mtime);
}

function retryPair(): void {
	writeAgent(SOURCE_ID, {
		status: "failed",
		error: "Connection error.",
		attempt: 1,
		dispatchId: DISPATCH_ID,
		startedAt: startedMs("2026-10-27T13:37:00.000Z"),
	});
	writeAgent(RETRY_ID, {
		status: "completed",
		attempt: 2,
		dispatchId: DISPATCH_ID,
		resumeOf: SOURCE_ID,
		startedAt: startedMs("2026-10-27T13:39:49.000Z"),
	});
}

async function invoke(agentId: string) {
	return getResult.execute("call-396", { agent_id: agentId }, undefined, undefined, {});
}

describe("get_subagent_result retry lineage (issue #396)", () => {
	it("resolves the notices' 8-hex id and names the descendant", async () => {
		retryPair();
		const result = await invoke("99f4e815");
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain(`Superseded by ${RETRY_ID}`);
		expect(result.content[0].text).toContain("attempt 2");
		expect(result.content[0].text).toContain("completed");
		expect(result.content[0].text).toContain("2026-10-27T13:39:49.000Z");
		// The source record itself is still the one being reported.
		expect(result.content[0].text).toContain("Status: failed");
	});

	it("appends the successor on the found path when a full-id source is terminal", async () => {
		retryPair();
		const result = await invoke(SOURCE_ID);
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain(`Superseded by ${RETRY_ID}`);
		expect(result.content[0].text).toContain("attempt 2");
	});

	it("refuses an ambiguous id prefix instead of guessing", async () => {
		writeAgent(AMBIGUOUS_A);
		writeAgent(AMBIGUOUS_B);
		const result = await invoke("abcdef12");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("ambiguous");
		expect(result.content[0].text).toContain(AMBIGUOUS_A);
		expect(result.content[0].text).toContain(AMBIGUOUS_B);
	});

	it("says the registry has no record when there is no lineage", async () => {
		const result = await invoke(UNKNOWN_ID);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(`Agent ${UNKNOWN_ID} not found`);
		expect(result.content[0].text).toContain("no registry record either");
	});

	it("reports an id the registry still lists when no lineage exists", async () => {
		registerInflightRun({ id: UNKNOWN_ID, kind: "background", attempt: 2, startedAt: ISO });
		const result = await invoke(UNKNOWN_ID);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(`registry still lists run ${UNKNOWN_ID}`);
		expect(result.content[0].text).toContain("attempt 2");
	});

	it("follows a dispatchId family to an attempt-3 grandchild", async () => {
		// No attempt-1 record: the family is discovered through attempt 2's
		// `resumeOf`, then completed by the shared `dispatchId`.
		writeAgent(RETRY_ID, {
			status: "failed",
			attempt: 2,
			dispatchId: DISPATCH_ID,
			resumeOf: SOURCE_ID,
			startedAt: startedMs("2026-10-27T13:39:49.000Z"),
		});
		writeAgent(GRANDCHILD_ID, {
			status: "completed",
			attempt: 3,
			dispatchId: DISPATCH_ID,
			resumeOf: RETRY_ID,
			startedAt: startedMs("2026-10-27T13:45:00.000Z"),
		});

		const result = await invoke(SOURCE_ID);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(`was retried as ${GRANDCHILD_ID}`);
		expect(result.content[0].text).toContain("attempt 3");
	});

	it("links an in-flight retry from the registry by dispatchId", async () => {
		writeAgent(SOURCE_ID, {
			status: "failed",
			attempt: 1,
			dispatchId: DISPATCH_ID,
		});
		registerInflightRun({
			id: RETRY_ID,
			kind: "background",
			attempt: 2,
			dispatchId: DISPATCH_ID,
			startedAt: ISO,
		});

		const result = await invoke(SOURCE_ID);
		expect(result.content[0].text).toContain(`Superseded by ${RETRY_ID}`);
		expect(result.content[0].text).toContain("attempt 2");
		expect(result.content[0].text).toContain("running");
	});

	it("does not read records outside the mtime window", async () => {
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		writeAgent(
			RETRY_ID,
			{
				status: "completed",
				attempt: 2,
				dispatchId: DISPATCH_ID,
				resumeOf: SOURCE_ID,
			},
			old,
		);
		for (let i = 0; i < 50; i += 1) {
			writeAgent(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, {
				dispatchId: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
			});
		}

		fsProbe.readFileSync = 0;
		const result = await invoke(SOURCE_ID);

		expect(result.content[0].text).toContain("no registry record either");
		expect(result.content[0].text).not.toContain(RETRY_ID);
		expect(fsProbe.readFileSync).toBeLessThanOrEqual(200);
		// The 50 in-window records are read; the old descendant is not.
		expect(fsProbe.readFileSync).toBe(50);
	});

	it("caps the number of records read at 200", async () => {
		// 205 in-window unrelated records + one newest descendant.
		for (let i = 0; i < 205; i += 1) {
			writeAgent(`10000000-0000-4000-8000-${String(i).padStart(12, "0")}`, {
				dispatchId: `10000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
			});
		}
		writeAgent(RETRY_ID, {
			status: "completed",
			attempt: 2,
			dispatchId: DISPATCH_ID,
			resumeOf: SOURCE_ID,
		});

		fsProbe.readFileSync = 0;
		const result = await invoke(SOURCE_ID);

		expect(result.content[0].text).toContain(`was retried as ${RETRY_ID}`);
		expect(fsProbe.readFileSync).toBeLessThanOrEqual(200);
	});

	it("skips a malformed record instead of failing the answer", async () => {
		fs.mkdirSync(env.storageDir, { recursive: true });
		fs.writeFileSync(
			path.join(env.storageDir, `${MALFORMED_ID}.json`),
			`{"id":"${MALFORMED_ID}","dispatchId":"${DISPATCH_ID}","resumeOf":"${SOURCE_ID}","attempt":3`,
		);
		writeAgent(RETRY_ID, {
			status: "completed",
			attempt: 2,
			dispatchId: DISPATCH_ID,
			resumeOf: SOURCE_ID,
		});

		const result = await invoke(SOURCE_ID);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(`was retried as ${RETRY_ID}`);
		expect(result.content[0].text).not.toContain(MALFORMED_ID);
	});

	it("keeps the not-found answer for an unsafe id without touching the store", async () => {
		const result = await invoke("../../etc/passwd");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Agent ../../etc/passwd not found");
	});

	it("leaves a found, latest run's output unchanged", async () => {
		writeAgent(SOURCE_ID, {
			status: "completed",
			attempt: 1,
			dispatchId: DISPATCH_ID,
		});
		const result = await invoke(SOURCE_ID);
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("Status: completed");
		expect(result.content[0].text).not.toContain("Superseded by");
	});
});

describe("get_subagent_result description (issue #396)", () => {
	it("names the accepted id forms and the lineage answer", () => {
		expect(getResult.description).toContain("unique 8-character id prefix");
		expect(getResult.description).toContain("latest attempt");
		expect(getResult.description).toContain("superseded");
	});
});
