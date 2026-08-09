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
import type { Logger } from "../logging";
import type { SubagentPreset } from "../types";

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
