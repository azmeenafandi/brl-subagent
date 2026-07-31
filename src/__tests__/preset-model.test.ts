/**
 * Tests for per-preset model selection (PER_PRESET_MODEL.md).
 *
 * Covers the `model` field in presets.ts: frontmatter parsing,
 * loadBuiltinPresets/loadCustomPresets pickup, and file round-trip.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter, loadBuiltinPresets, buildPresetMarkdown, writePresetFile } from "../presets";
import type { SubagentPreset } from "../types";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-subagent-preset-model-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("parseFrontmatter model field", () => {
	it("parses model from frontmatter", () => {
		const content = [
			"---",
			"name: security-auditor",
			"model: anthropic/claude-opus-4-6",
			"thinkingLevel: high",
			"---",
			"",
			"You are a security auditor.",
		].join("\n");

		const { meta } = parseFrontmatter(content);
		expect(meta.model).toBe("anthropic/claude-opus-4-6");
	});

	it("leaves model undefined when absent", () => {
		const content = ["---", "name: plain-agent", "---", "body"].join("\n");
		const { meta } = parseFrontmatter(content);
		expect(meta.model).toBeUndefined();
	});
});

describe("loadBuiltinPresets model field", () => {
	it("picks up model from preset file", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			path.join(dir, "security-auditor.md"),
			[
				"---",
				"name: security-auditor",
				"description: Security review with a strong reasoning model",
				"model: anthropic/claude-opus-4-6",
				"thinking: high",
				"---",
				"You are a security auditor.",
			].join("\n"),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(dir, "plain.md"),
			["---", "name: plain-agent", "---", "body"].join("\n"),
			"utf-8",
		);

		const presets = loadBuiltinPresets(dir);
		const auditor = presets.find((p) => p.name === "security-auditor");
		expect(auditor?.model).toBe("anthropic/claude-opus-4-6");

		const plain = presets.find((p) => p.name === "plain-agent");
		expect(plain?.model).toBeUndefined();
	});

	it("handles invalid model strings literally (validated at resolution time)", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			path.join(dir, "bad.md"),
			["---", "name: bad-model-agent", "model: no-slash-here", "---", "body"].join("\n"),
			"utf-8",
		);

		const presets = loadBuiltinPresets(dir);
		expect(presets.find((p) => p.name === "bad-model-agent")?.model).toBe("no-slash-here");
	});
});

describe("model round-trip via preset files", () => {
	it("buildPresetMarkdown includes model field", () => {
		const preset: SubagentPreset = {
			name: "rapid-prototyper",
			model: "deepseek-v4-flash",
			thinkingLevel: "minimal",
		};
		const md = buildPresetMarkdown(preset);
		expect(md).toContain("model: deepseek-v4-flash");
		expect(md).toContain("thinkingLevel: minimal");
	});

	it("writePresetFile preserves model on reload", () => {
		const dir = makeTempDir();
		const preset: SubagentPreset = {
			name: "tech-writer",
			description: "Mid-tier model docs writer",
			model: "anthropic/claude-sonnet-4",
			thinkingLevel: "low",
			systemPrompt: "You write docs.",
		};
		writePresetFile(preset, dir);

		const reloaded = loadBuiltinPresets(dir);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0].model).toBe("anthropic/claude-sonnet-4");
		expect(reloaded[0].name).toBe("tech-writer");
	});
});
