/**
 * Tests for file-backed custom presets — loadCustomPresets. Mirrors the
 * templates-files.test.ts pattern (issue #66/#84): temp dirs + HOME stubbing
 * so nothing touches the real ~/.pi.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCustomPresets, writePresetFile } from "../presets";
import { resolveSubagentParams } from "../params";
import type { ResolveInputParams } from "../params";
import { validatePreTask } from "../validate";
import { SessionState } from "../state";
import type { Logger } from "../logging";
import type { ResolvedParams, SubagentPreset } from "../types";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-subagent-preset-file-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** Point HOME at a scratch dir, run fn, restore the real HOME afterwards. */
function withHome(homeDir: string, fn: () => void): void {
	const savedHome = process.env.HOME;
	process.env.HOME = homeDir;
	try {
		fn();
	} finally {
		if (savedHome !== undefined) process.env.HOME = savedHome;
		else delete process.env.HOME;
	}
}

function writeProjectPreset(cwd: string, fileName: string, content: string): void {
	const dir = path.join(cwd, ".pi", "brl-subagent", "presets");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, fileName), content, "utf-8");
}

function writeGlobalPreset(home: string, fileName: string, content: string): void {
	const dir = path.join(home, ".pi", "agent", "brl-subagent", "presets");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, fileName), content, "utf-8");
}

// ---------------------------------------------------------------------------
// loadCustomPresets
// ---------------------------------------------------------------------------

describe("loadCustomPresets", () => {
	it("loads a valid preset with the markdown body as the systemPrompt", () => {
		const cwd = makeTempDir();
		writeProjectPreset(
			cwd,
			"code-reviewer.md",
			[
				"---",
				"name: code-reviewer",
				"description: Reviews PRs",
				"thinkingLevel: medium",
				"model: anthropic/claude-sonnet-4",
				"tools:",
				"  - read",
				"  - grep",
				"excludeTools:",
				"  - write",
				"noBuiltinTools: \"true\"",
				"inheritSystemPrompt: \"false\"",
				"---",
				"You are a careful code reviewer.",
			].join("\n"),
		);

		const presets = loadCustomPresets(cwd);
		expect(presets).toHaveLength(1);
		const p = presets[0];
		expect(p.name).toBe("code-reviewer");
		expect(p.description).toBe("Reviews PRs");
		expect(p.systemPrompt).toBe("You are a careful code reviewer.");
		expect(p.thinkingLevel).toBe("medium");
		expect(p.model).toBe("anthropic/claude-sonnet-4");
		expect(p.tools).toEqual(["read", "grep"]);
		expect(p.excludeTools).toEqual(["write"]);
		expect(p.noBuiltinTools).toBe(true);
		expect(p.inheritSystemPrompt).toBe(false);
	});

	it("duplicate names: PROJECT-LOCAL wins over global (~/.pi/agent/...) (project scanned first, dedup by name)", () => {
		const home = makeTempDir();
		const cwd = makeTempDir();

		writeGlobalPreset(
			home,
			"dupe.md",
			["---", "name: dupe", "---", "Global version."].join("\n"),
		);

		writeProjectPreset(
			cwd,
			"dupe.md",
			["---", "name: dupe", "---", "Project version."].join("\n"),
		);

		let presets: ReturnType<typeof loadCustomPresets> = [];
		withHome(home, () => {
			presets = loadCustomPresets(cwd);
		});

		// Dedup by name: only ONE entry loads, and the project dir is scanned
		// FIRST — so the project version wins and the global duplicate is
		// skipped (issue #84).
		expect(presets).toHaveLength(1);
		expect(presets[0].name).toBe("dupe");
		expect(presets[0].systemPrompt).toBe("Project version.");
	});

	it("precedence: same name in both dirs (different file names) → project's version wins, one entry", () => {
		const home = makeTempDir();
		const cwd = makeTempDir();

		writeGlobalPreset(
			home,
			"global-name.md",
			["---", "name: shared", "---", "Global system prompt."].join("\n"),
		);

		writeProjectPreset(
			cwd,
			"project-name.md",
			["---", "name: shared", "---", "Project system prompt."].join("\n"),
		);

		let presets: ReturnType<typeof loadCustomPresets> = [];
		withHome(home, () => {
			presets = loadCustomPresets(cwd);
		});

		// Dedup is by frontmatter name (not file name): the global file with
		// the same `name:` is skipped, the project version is the sole entry.
		expect(presets).toHaveLength(1);
		expect(presets[0].name).toBe("shared");
		expect(presets[0].systemPrompt).toBe("Project system prompt.");
	});

	it("distinct names in both dirs → all load (no over-dedup)", () => {
		const home = makeTempDir();
		const cwd = makeTempDir();

		writeGlobalPreset(
			home,
			"global-one.md",
			["---", "name: global-one", "---", "Global prompt."].join("\n"),
		);
		writeGlobalPreset(
			home,
			"global-two.md",
			["---", "name: global-two", "---", "Another global prompt."].join("\n"),
		);

		writeProjectPreset(
			cwd,
			"project-one.md",
			["---", "name: project-one", "---", "Project prompt."].join("\n"),
		);

		let presets: ReturnType<typeof loadCustomPresets> = [];
		withHome(home, () => {
			presets = loadCustomPresets(cwd);
		});

		// No name collisions → every file loads exactly once.
		expect(presets.map((p) => p.name).sort()).toEqual([
			"global-one",
			"global-two",
			"project-one",
		]);
	});

	it("skips invalid files (bad thinkingLevel) with a warning", () => {
		const cwd = makeTempDir();
		writeProjectPreset(
			cwd,
			"good.md",
			["---", "name: good", "---", "A fine prompt."].join("\n"),
		);
		writeProjectPreset(
			cwd,
			"bad.md",
			["---", "name: bad", "thinkingLevel: turbo", "---", "A prompt."].join("\n"),
		);

		const log = { warn: vi.fn() } as unknown as Logger;
		const presets = loadCustomPresets(cwd, log);
		expect(presets).toHaveLength(1);
		expect(presets[0].name).toBe("good");
		expect(log.warn).toHaveBeenCalled();
		const call = log.warn.mock.calls.find((c) => c[0] === "Custom preset validation failed");
		expect(call).toBeDefined();
		expect((call as unknown[])[1]).toMatchObject({ file: "bad.md" });
	});

	it("returns an empty list when no preset directories exist", () => {
		const home = makeTempDir();
		const cwd = makeTempDir(); // no .pi dir at all
		let presets: ReturnType<typeof loadCustomPresets> = [];
		withHome(home, () => {
			presets = loadCustomPresets(cwd);
		});
		expect(presets).toEqual([]);
	});

	it("skips non-.md files", () => {
		const cwd = makeTempDir();
		writeProjectPreset(
			cwd,
			"notes.txt",
			["---", "name: not-a-preset", "---", "prompt"].join("\n"),
		);

		expect(loadCustomPresets(cwd)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// ADR 0022 §6 — the preset-timeout invariant (issue #431 review nit 2)
// ---------------------------------------------------------------------------

/**
 * These tests are MECHANICAL PINS on a fact the pre-flight's `drop-timeout`
 * arm depends on but does not itself enforce — ADR 0022 §6, recorded in
 * `.development/decisions/0022-preflight-drop-timeout-arm.md`:
 *
 *   `params.timeout = undefined` does NOT mean "no deadline" downstream —
 *   `resolveSubagentParams` (src/params.ts) merges
 *   `params.timeout ?? preset?.timeout` before the run starts. The arm's
 *   guarantee ("foreground, and no clock kills the run") and the truth of
 *   `THINKING_TIMEOUT_DROP_NOTICE` (src/params.ts) therefore hold ONLY while
 *   no preset can carry a timeout at runtime.
 *
 * Today they cannot: `presetFromFrontmatter` (src/presets.ts) maps exactly ten
 * fields and `timeout` is not one of them, so `SubagentPreset.timeout`
 * (src/types.ts) is declared but unreachable for file-backed presets.
 *
 * IF YOU ARE ADDING preset-timeout support, these tests are SUPPOSED to fail.
 * Do not just update them: a preset timeout makes the `drop-timeout` arm
 * silently re-merge the value it thinks it dropped, and makes
 * `THINKING_TIMEOUT_DROP_NOTICE`'s "no clock kills it" sentence false — with
 * no other test failing. Before mapping the field, re-derive the arm's
 * guarantee (ADR 0022 §1/§6) and re-write its notice text (and the notice pin
 * in dispatch-preflight.test.ts) so both stay true for a preset-supplied
 * deadline.
 *
 * The first pin is the tripwire, not the second: a naive
 * `timeout: (meta.timeout as number) || undefined` maps the *string* YAML
 * leaves behind, and `normalizeTimeout` (src/validate.ts) then rejects it as
 * non-finite — so only the loader-level assertion fires. A mapping that
 * coerces (`Number(meta.timeout)`) fails both. Neither may ever pass.
 */
describe("ADR 0022 §6: the preset-tier timeout invariant", () => {
	const TIMEOUT_PRESET_NAME = "deep-auditor";

	/** A preset file that DECLARES `timeout: 600000` in its frontmatter. */
	function writeTimeoutDeclaringPreset(cwd: string): void {
		writeProjectPreset(
			cwd,
			"deep-auditor.md",
			[
				"---",
				`name: ${TIMEOUT_PRESET_NAME}`,
				"description: Declares a timeout the loader must not map",
				"thinkingLevel: high",
				"timeout: 600000",
				"---",
				"You audit deeply.",
			].join("\n"),
		);
	}

	function makeLogger(): Logger {
		return {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		} as unknown as Logger;
	}

	function makeCtx(): ExtensionContext {
		return { cwd: "/workspace/project", ui: { notify: vi.fn() } } as unknown as ExtensionContext;
	}

	it("presetFromFrontmatter does not map `timeout` — a declaring preset loads WITHOUT one", () => {
		const cwd = makeTempDir();
		writeTimeoutDeclaringPreset(cwd);

		const presets = loadCustomPresets(cwd);

		// Control: the file parses and validates — otherwise the assertion below
		// would pass for the wrong reason (a skipped file has no timeout either).
		expect(presets, "the fixture must load, or this pin proves nothing").toHaveLength(1);
		expect(presets[0].name).toBe(TIMEOUT_PRESET_NAME);
		expect(presets[0].thinkingLevel).toBe("high");

		// THE PIN. Adding `timeout: (meta.timeout as number) || undefined` to
		// presetFromFrontmatter fails exactly here — and with it the drop-timeout
		// arm's guarantee (ADR 0022 §6).
		expect(presets[0].timeout).toBeUndefined();
	});

	it("a dispatch through that preset resolves to NO timeout — the preset tier contributes nothing", () => {
		const cwd = makeTempDir();
		writeTimeoutDeclaringPreset(cwd);
		const presets = loadCustomPresets(cwd);

		const state = new SessionState();
		state.customPresets = presets;

		// No call-level timeout: this is the shape the `drop-timeout` arm leaves
		// behind after clearing `params.timeout`. The resolver's
		// `params.timeout ?? preset?.timeout` (src/params.ts) is the ONLY path a
		// preset deadline could take — assert the RESOLVED value, not the merge.
		const resolved = resolveSubagentParams(
			{ task: "audit the auth module", preset: TIMEOUT_PRESET_NAME },
			state,
			makeCtx(),
			makeLogger(),
		);

		expect(resolved.resolvedPreset?.name).toBe(TIMEOUT_PRESET_NAME);
		expect(resolved.timeout).toBeUndefined();
	});

	it("control: an in-memory preset WITH a timeout DOES reach the resolved value", () => {
		// Proves the fallback at src/params.ts (`params.timeout ?? preset?.timeout`)
		// is live — so the assertion above is about the file tier not supplying a
		// timeout, not about the merge being unreachable. A reader debugging a
		// future failure of the pin starts here.
		const state = new SessionState();
		state.customPresets = [
			{
				name: "in-memory-timeout",
				systemPrompt: "You audit deeply.",
				timeout: 600_000,
			} satisfies SubagentPreset,
		];

		const resolved = resolveSubagentParams(
			{ task: "audit the auth module", preset: "in-memory-timeout" },
			state,
			makeCtx(),
			makeLogger(),
		);

		expect(resolved.timeout).toBe(600_000);
	});
});

// ---------------------------------------------------------------------------
// writePresetFile round-trip through loadCustomPresets
// ---------------------------------------------------------------------------

describe("writePresetFile + loadCustomPresets", () => {
	it("round-trips a fully-populated preset", () => {
		const cwd = makeTempDir();
		const preset: SubagentPreset = {
			name: "owasp-auditor",
			description: "Full-stack audit preset",
			systemPrompt: "You audit for OWASP flaws.",
			thinkingLevel: "high",
			model: "anthropic/claude-opus-4-6",
			tools: ["read", "grep"],
			excludeTools: ["write"],
			noBuiltinTools: true,
			inheritSystemPrompt: false,
		};

		writePresetFile(preset, path.join(cwd, ".pi", "brl-subagent", "presets"));

		const presets = loadCustomPresets(cwd);
		expect(presets).toHaveLength(1);
		const p = presets[0];
		expect(p.name).toBe(preset.name);
		expect(p.description).toBe(preset.description);
		expect(p.systemPrompt).toBe(preset.systemPrompt);
		expect(p.thinkingLevel).toBe(preset.thinkingLevel);
		expect(p.model).toBe(preset.model);
		expect(p.tools).toEqual(preset.tools);
		expect(p.excludeTools).toEqual(preset.excludeTools);
		expect(p.noBuiltinTools).toBe(true);
		expect(p.inheritSystemPrompt).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// #436 — `outputFile` parity: a preset field reaches the resolved params
// ---------------------------------------------------------------------------

/**
 * `presetFromFrontmatter` re-stated the SubagentPreset field list by hand, so
 * `outputFile` was declared, merged by `resolveSubagentParams`, and dropped by
 * the loader in silence. These tests pin the three links: the load (T1), the
 * precedence (T3) and the pre-flight a preset value must NOT be able to skip
 * (T4). The `timeout` half of the omission is already pinned by the ADR 0022 §6
 * block above, which this change leaves untouched.
 */
describe("#436: a preset's `outputFile` reaches the load and the merged params", () => {
	const PRESET_NAME = "findings-writer";

	function makeCtx(): ExtensionContext {
		return { cwd: "/workspace/project", ui: { notify: vi.fn() } } as unknown as ExtensionContext;
	}

	function makeLogger(): Logger {
		return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
	}

	/** Write + load the fixture preset (plus `extra` frontmatter lines) and resolve a dispatch through it. */
	function dispatch(extra: string[] = [], params: Partial<ResolveInputParams> = {}) {
		const cwd = makeTempDir();
		writeProjectPreset(
			cwd,
			"findings-writer.md",
			[
				"---",
				`name: ${PRESET_NAME}`,
				"description: Writes findings to a file",
				"outputFile: findings.md",
				...extra,
				"---",
				"You write findings.",
			].join("\n"),
		);
		const loaded = loadCustomPresets(cwd);
		const state = new SessionState();
		state.customPresets = loaded;
		const resolved = resolveSubagentParams(
			{ task: "write up the findings", preset: PRESET_NAME, ...params },
			state,
			makeCtx(),
			makeLogger(),
		);
		return { loaded, resolved };
	}

	/** Resolve then validate, exactly as the dispatch chokepoint does. */
	function validate(resolved: ResolvedParams) {
		return validatePreTask({
			task: resolved.task,
			outputFile: resolved.outputFile,
			toolOptions: resolved.toolOptions,
			cwd: resolved.effectiveCwd,
		});
	}

	it("T1: loads `outputFile` from the preset frontmatter", () => {
		const { loaded } = dispatch();
		expect(loaded).toHaveLength(1);
		expect(loaded[0].outputFile).toBe("findings.md");
	});

	it("T3: the call param wins, and the preset supplies the value when the call omits it", () => {
		expect(dispatch().resolved.outputFile).toBe("findings.md");
		expect(dispatch([], { outputFile: "call.md" }).resolved.outputFile).toBe("call.md");
	});

	it("T4: a preset-derived outputFile hits validatePreTask's hard write conflict", () => {
		const rejected = validate(dispatch(["excludeTools:", "  - write"]).resolved);
		expect(rejected.valid).toBe(false);
		expect(rejected.errors.join("\n")).toMatch(
			/outputFile is set but the 'write' tool is not available/,
		);

		// Control: the same preset without the exclusion passes — the rejection is
		// the tool conflict, not "a preset with an outputFile is refused".
		expect(validate(dispatch().resolved).valid).toBe(true);
	});
});
