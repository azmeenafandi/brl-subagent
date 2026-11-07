/**
 * Issue #442 — REAL background proof: `tools: []` still means zero tools.
 *
 * The background path never went through `buildSubagentArgs`; it hands the
 * resolved allowlist straight to the SDK session (`createAgentSession`), so the
 * question here is different from the foreground one: does `[]` survive as an
 * EMPTY tool set all the way to the model, and does the existing
 * `noExtensions`/`noSkills` contract still start nothing?
 *
 * This drives the REAL `spawnBackgroundSession` (only `pi.appendEntry` and the
 * caller's `ctx` are fakes — the SDK session, the resource loader, the session
 * manager and the HTTP round-trip are real) against the shared canary harness:
 * a scratch HOME carrying a direct extension tool and three stdio MCP servers,
 * and a scripted loopback provider that records which tools each request
 * DECLARED.
 *
 * Evidence, per run:
 *   - the provider's declared-tool list (the model's actual toolset),
 *   - the canary log (extension load / MCP start are the background contract's
 *     business — they must NOT happen, with or without `tools`),
 *   - the scratch project (a forced `bash` call leaves a file only if it ran).
 *
 * The omitted-tools control deliberately does NOT assert that the background
 * default set equals the foreground default set: background has its own default
 * list (read/bash/grep/find/ls/write/edit) and #442 leaves it alone.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { getAgent, spawnBackgroundSession } from "../session-manager";
import * as eventBus from "../event-bus";
import { resolvePiOnPath } from "../preflight";
import { createTempEnv } from "./fixtures/temp-lifecycle";
import {
	canaryLines,
	startScriptedProvider,
	TASK_MARKER_PREFIX,
	writeCanaryScratch,
	type ScriptedProvider,
	type Scratch,
} from "./fixtures/tool-canary";
import type { SubagentEventListener, SubagentToolOptions } from "../types";

const REAL_PI = resolvePiOnPath();
const SKIP = REAL_PI === undefined ? "real pi binary not found on PATH" : false;

function piVersion(bin: string): string | undefined {
	try {
		return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
	} catch {
		return undefined;
	}
}

/** Storage/transcript redirects: the repo's real `.pi/` is never touched. */
const env = createTempEnv("brl-442-bg", { withCwd: true });

// ---------------------------------------------------------------------------
// Real model registry over the scratch HOME's models.json
// ---------------------------------------------------------------------------

/**
 * The SDK resolves request auth through the runtime it builds from the agent
 * dir, so the model must come from THAT file rather than a hand-built object —
 * otherwise the round-trip would be unauthenticated and prove nothing.
 */
async function makeRegistry(agentDir: string) {
	const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	const registry = new ModelRegistry(runtime);
	await registry.refresh();
	return registry;
}

/**
 * Wait for the REAL terminal bus event for one agent.
 *
 * `agent.completedAt` is NOT the end of the run: the completion handler sets it
 * first and only then awaits git info and calls `persistAgent` +
 * `transcript.completeTranscript`. Polling `completedAt` therefore returns while
 * those writes are still in flight, and — because the test's `tearDown` removes
 * the scratch dirs — the late writes RE-CREATE them (observed: six orphaned
 * `/tmp/brl-442-bg-pi-*` dirs, one per run). The bus emit is the handler's last
 * statement, so it is the only signal that the run has stopped touching disk.
 */
function terminalWatcher(): {
	seen: Set<string>;
	wait(id: string, timeoutMs?: number): Promise<void>;
	dispose(): void;
} {
	const seen = new Set<string>();
	const waiters = new Map<string, () => void>();
	const types = ["subagent:completed", "subagent:failed", "subagent:stopped"] as const;
	const listeners: Array<{ type: (typeof types)[number]; fn: SubagentEventListener }> = [];
	for (const type of types) {
		const fn: SubagentEventListener = (event) => {
			if (event.type !== type) return;
			seen.add(event.agentId);
			waiters.get(event.agentId)?.();
		};
		listeners.push({ type, fn });
		eventBus.on(type, fn);
	}
	return {
		seen,
		wait: (id, timeoutMs = 30_000) => {
			if (seen.has(id)) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(id);
					reject(new Error(`timed out waiting for a terminal event for ${id}`));
				}, timeoutMs);
				waiters.set(id, () => {
					clearTimeout(timer);
					waiters.delete(id);
					resolve();
				});
			});
		},
		dispose: () => {
			for (const { type, fn } of listeners) eventBus.off(type, fn);
		},
	};
}

describe.skipIf(SKIP)("real background session — tools: [] means zero active tools (issue #442)", () => {
	let provider: ScriptedProvider;
	const scratches: Scratch[] = [];
	let previousHome: string | undefined;

	beforeAll(async () => {
		provider = await startScriptedProvider();
	});

	afterAll(async () => {
		await provider.close();
	});

	// `tearDown` awaits a `setImmediate` before removing the dirs, so NOT awaiting
	// it here lets the next test's `setUp` run first: `tearDown` would then read the
	// already-reassigned module-level `baseDir`, delete the NEXT test's dirs and
	// clobber the state (observed as two orphaned /tmp dirs per three-test run).
	afterEach(async () => {
		await env.tearDown();
		for (const scratch of scratches.splice(0)) scratch.dispose();
	});

	/**
	 * Spawn a real background session with the given tool options, wait until its
	 * scripted conversation ends, and return the evidence.
	 */
	async function runBackground(
		marker: string,
		toolOptions: SubagentToolOptions | undefined,
	): Promise<{ declared: string[]; canary: string[]; project: string; status: string }> {
		env.setUp();
		const scratch = writeCanaryScratch(provider.baseUrl, `brl-442-bg-${marker}`);
		scratches.push(scratch);
		previousHome = process.env.HOME;
		process.env.HOME = scratch.home;
		// Registered BEFORE the spawn so a fast run cannot emit before we listen.
		const terminal = terminalWatcher();
		try {
			const registry = await makeRegistry(scratch.agentDir);
			const model = registry.find("deepseek", "scripted-model");
			expect(model, "the scratch models.json must yield the scripted model").toBeDefined();

			const ctx = {
				cwd: scratch.project,
				model,
				modelRegistry: registry,
				getSystemPrompt: () => "You are a default coding assistant.",
				ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t } },
				sessionManager: { getEntries: () => [], appendCustomEntry: () => {} },
			};
			const pi = { appendEntry: () => {} };

			const agent = await spawnBackgroundSession(pi as never, ctx as never, {
				task: `${TASK_MARKER_PREFIX}${marker} say hello`,
				cwd: scratch.project,
				model: "deepseek/scripted-model",
				thinkingLevel: "off",
				toolOptions,
			});

			// Wait for the run to fully settle — the terminal event, not just
			// `completedAt` — so "no tool executed" is a measurement of a finished
			// run and no late write outlives this test's teardown.
			await terminal.wait(agent.id);
			const settled = getAgent(agent.id);
			expect(settled, `the agent record for ${agent.id} must still exist`).not.toBeNull();

			const requests = provider.forMarker(marker);
			expect(requests.length, `the scripted provider saw no request for ${marker}`).toBeGreaterThan(0);
			return {
				// The FIRST request is the toolset the session actually started with.
				declared: requests[0].tools,
				canary: canaryLines(scratch.logPath),
				project: scratch.project,
				status: settled!.status,
			};
		} finally {
			terminal.dispose();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	}

	it("control (omitted tools): the background default toolset is declared, canaries are not", async () => {
		const { declared, canary } = await runBackground("bg-omitted", undefined);

		// The background default list is its own (unchanged by #442): built-ins.
		expect(declared).toEqual(expect.arrayContaining(["read", "bash", "write", "edit"]));
		// ...and NOT the canaries: background loads no extensions, no MCP servers.
		expect(declared).not.toContain("extension_canary");
		expect(declared.some((t) => t.startsWith("mcp__"))).toBe(false);
		expect(canary).toEqual([]);
	}, 120_000);

	it("tools: [] — the session starts with zero active tools", async () => {
		const { declared, canary, project } = await runBackground("bg-empty", { tools: [] });

		// Zero tools reached the model.
		expect(declared).toEqual([]);

		// The existing noExtensions/noSkills contract holds: no extension load, no
		// MCP server started (not even the ones the scratch mcp.json configures).
		expect(canary).toEqual([]);

		// And the forced built-in call did not execute.
		expect(existsSync(join(project, "builtin-canary.txt"))).toBe(false);
	}, 120_000);

	it("a non-empty allowlist is still honoured verbatim (no regression)", async () => {
		const { declared } = await runBackground("bg-readonly", { tools: ["read", "grep"] });
		expect(declared).toEqual(["read", "grep"]);
	}, 120_000);
});
