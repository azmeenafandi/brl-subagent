/**
 * Tests for file-backed task templates (issue #66) — loadCustomTemplates,
 * validateTemplate, and writeTemplateFile. Mirrors the custom-preset file
 * pattern (src/presets.ts:loadCustomPresets + writePresetFile).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCustomTemplates, writeTemplateFile, validateTemplate } from "../templates";
import type { Logger } from "../logging";
import type { TaskTemplate } from "../types";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-subagent-template-file-"));
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

const VALID_TEMPLATE_BODY = [
	"Audit ${file} for security issues.",
	"",
	"Focus on:",
	"- injection and authz flaws",
	"- secrets in logs",
	"Write findings to ${out}.",
].join("\n");

function writeProjectTemplate(cwd: string, fileName: string, content: string): void {
	const dir = path.join(cwd, ".pi", "brl-subagent", "templates");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, fileName), content, "utf-8");
}

// ---------------------------------------------------------------------------
// loadCustomTemplates
// ---------------------------------------------------------------------------

describe("loadCustomTemplates", () => {
	it("loads a valid file with the markdown body as the task", () => {
		const cwd = makeTempDir();
		writeProjectTemplate(
			cwd,
			"code-review.md",
			[
				"---",
				"name: code-review",
				"description: Review a PR",
				"preset: code-reviewer",
				"thinkingLevel: medium",
				"outputFile: review-${pr}.md",
				"timeout: 120000",
				"tools:",
				"  - read",
				"  - bash",
				"excludeTools:",
				"  - write",
				"noBuiltinTools: \"true\"",
				"inheritSystemPrompt: \"false\"",
				"---",
				VALID_TEMPLATE_BODY,
			].join("\n"),
		);

		const templates = loadCustomTemplates(cwd);
		expect(templates).toHaveLength(1);
		const t = templates[0];
		expect(t.name).toBe("code-review");
		expect(t.description).toBe("Review a PR");
		expect(t.task).toBe(VALID_TEMPLATE_BODY);
		expect(t.preset).toBe("code-reviewer");
		expect(t.thinkingLevel).toBe("medium");
		expect(t.outputFile).toBe("review-${pr}.md");
		expect(t.timeout).toBe(120000); // numeric coercion from frontmatter string
		expect(t.tools).toEqual(["read", "bash"]);
		expect(t.excludeTools).toEqual(["write"]);
		expect(t.noBuiltinTools).toBe(true);
		expect(t.inheritSystemPrompt).toBe(false);
	});

	it("maps defaulted fields to undefined (noBuiltinTools true-only, inheritSystemPrompt false-only)", () => {
		const cwd = makeTempDir();
		writeProjectTemplate(
			cwd,
			"minimal.md",
			["---", "name: minimal", "---", "Just a task."].join("\n"),
		);

		const templates = loadCustomTemplates(cwd);
		expect(templates).toHaveLength(1);
		const t = templates[0];
		expect(t.description).toBeUndefined();
		expect(t.preset).toBeUndefined();
		expect(t.thinkingLevel).toBeUndefined();
		expect(t.outputFile).toBeUndefined();
		expect(t.timeout).toBeUndefined();
		expect(t.tools).toBeUndefined();
		expect(t.excludeTools).toBeUndefined();
		expect(t.noBuiltinTools).toBeUndefined();
		expect(t.inheritSystemPrompt).toBeUndefined();
	});

	it("skips invalid files (bad thinkingLevel) with a warning", () => {
		const cwd = makeTempDir();
		writeProjectTemplate(
			cwd,
			"good.md",
			["---", "name: good", "---", "A fine task."].join("\n"),
		);
		writeProjectTemplate(
			cwd,
			"bad.md",
			["---", "name: bad", "thinkingLevel: turbo", "---", "A task."].join("\n"),
		);

		const log = { warn: vi.fn() } as unknown as Logger;
		const templates = loadCustomTemplates(cwd, log);
		expect(templates).toHaveLength(1);
		expect(templates[0].name).toBe("good");
		expect(log.warn).toHaveBeenCalled();
		const call = log.warn.mock.calls.find((c) => c[0] === "Custom template validation failed");
		expect(call).toBeDefined();
		expect((call as unknown[])[1]).toMatchObject({ file: "bad.md" });
	});

	it("skips files missing the required name field", () => {
		const cwd = makeTempDir();
		writeProjectTemplate(
			cwd,
			"unnamed.md",
			["---", "description: no name here", "---", "A task."].join("\n"),
		);

		const log = { warn: vi.fn() } as unknown as Logger;
		const templates = loadCustomTemplates(cwd, log);
		expect(templates).toHaveLength(0);
		expect(log.warn).toHaveBeenCalledWith("Custom template validation failed", expect.anything());
	});

	it("skips empty-bodied templates with a warning (no empty task tripping mode-detection later)", () => {
		const cwd = makeTempDir();
		writeProjectTemplate(
			cwd,
			"empty.md",
			["---", "name: empty", "---", "", "   "].join("\n"),
		);
		writeProjectTemplate(
			cwd,
			"whitespace-only.md",
			["---", "name: ws", "---", "\n\t \n"].join("\n"),
		);

		const log = { warn: vi.fn() } as unknown as Logger;
		const templates = loadCustomTemplates(cwd, log);
		expect(templates).toHaveLength(0);
		expect(log.warn).toHaveBeenCalledWith("Custom template validation failed", expect.anything());
		const calls = log.warn.mock.calls.filter((c) => c[0] === "Custom template validation failed");
		expect(calls).toHaveLength(2);
		const errors = calls.map((c) => (c[1] as { error: string }).error);
		expect(errors).toEqual([
			'Template "empty" has empty task body',
			'Template "ws" has empty task body',
		]);
	});

	it("skips non-.md files", () => {
		const cwd = makeTempDir();
		writeProjectTemplate(
			cwd,
			"notes.txt",
			["---", "name: not-a-template", "---", "task"].join("\n"),
		);

		expect(loadCustomTemplates(cwd)).toHaveLength(0);
	});

	it("returns an empty list when the templates directory is missing", () => {
		const cwd = makeTempDir(); // no .pi dir at all
		expect(loadCustomTemplates(cwd)).toEqual([]);
	});

	it("merges global (~/.pi/agent/...) and project dirs", () => {
		const home = makeTempDir();
		const cwd = makeTempDir();

		const globalDir = path.join(home, ".pi", "agent", "brl-subagent", "templates");
		fs.mkdirSync(globalDir, { recursive: true });
		fs.writeFileSync(
			path.join(globalDir, "global-one.md"),
			["---", "name: global-one", "---", "Global task."].join("\n"),
			"utf-8",
		);

		writeProjectTemplate(
			cwd,
			"project-one.md",
			["---", "name: project-one", "---", "Project task."].join("\n"),
		);

		let templates: ReturnType<typeof loadCustomTemplates> = [];
		withHome(home, () => {
			templates = loadCustomTemplates(cwd);
		});

		expect(templates.map((t) => t.name).sort()).toEqual(["global-one", "project-one"]);
	});

	it("duplicate names: GLOBAL (~/.pi/agent/...) wins over project-local (homedir scanned first, no dedup)", () => {
		const home = makeTempDir();
		const cwd = makeTempDir();

		const globalDir = path.join(home, ".pi", "agent", "brl-subagent", "templates");
		fs.mkdirSync(globalDir, { recursive: true });
		fs.writeFileSync(
			path.join(globalDir, "dupe.md"),
			["---", "name: dupe", "---", "Global version."].join("\n"),
			"utf-8",
		);

		writeProjectTemplate(
			cwd,
			"dupe.md",
			["---", "name: dupe", "---", "Project version."].join("\n"),
		);

		let templates: ReturnType<typeof loadCustomTemplates> = [];
		withHome(home, () => {
			templates = loadCustomTemplates(cwd);
		});

		// No dedup: BOTH files load, and the homedir dir is scanned FIRST — so
		// the lookup site's .find() (first match) returns the GLOBAL entry,
		// despite any "project-local, highest priority" framing. Presets have
		// the same first-wins reality (src/presets.ts).
		expect(templates).toHaveLength(2);
		expect(templates.filter((t) => t.name === "dupe")).toHaveLength(2);
		expect(templates[0].name).toBe("dupe");
		expect(templates[0].task).toBe("Global version.");
		expect(templates[1].task).toBe("Project version.");
	});
});

// ---------------------------------------------------------------------------
// validateTemplate
// ---------------------------------------------------------------------------

describe("validateTemplate", () => {
	it("returns no errors for a valid template", () => {
		expect(validateTemplate({ name: "ok", thinkingLevel: "high" }, "ok.md")).toEqual([]);
	});

	it("requires the name field", () => {
		expect(validateTemplate({ thinkingLevel: "high" }, "no-name.md").length).toBeGreaterThan(0);
		expect(validateTemplate({ name: 42 }, "num-name.md").length).toBeGreaterThan(0);
	});

	it("rejects invalid thinkingLevel", () => {
		const errors = validateTemplate({ name: "t", thinkingLevel: "turbo" }, "t.md");
		expect(errors.some((e) => e.includes("thinkingLevel"))).toBe(true);
	});

	it("rejects non-boolean inheritSystemPrompt/noBuiltinTools values", () => {
		expect(validateTemplate({ name: "t", inheritSystemPrompt: "yes" }, "t.md").length).toBeGreaterThan(0);
		expect(validateTemplate({ name: "t", noBuiltinTools: "maybe" }, "t.md").length).toBeGreaterThan(0);
	});

	it("rejects non-numeric timeout", () => {
		const errors = validateTemplate({ name: "t", timeout: "soon" }, "t.md");
		expect(errors.some((e) => e.includes("timeout"))).toBe(true);
	});

	it("rejects non-list tools/excludeTools", () => {
		expect(validateTemplate({ name: "t", tools: "read" }, "t.md").length).toBeGreaterThan(0);
		expect(validateTemplate({ name: "t", excludeTools: "write" }, "t.md").length).toBeGreaterThan(0);
	});

	it("rejects non-string preset", () => {
		expect(validateTemplate({ name: "t", preset: 42 }, "t.md").length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// writeTemplateFile round-trip
// ---------------------------------------------------------------------------

describe("writeTemplateFile", () => {
	it("round-trips a fully-populated template through loadCustomTemplates", () => {
		const cwd = makeTempDir();
		const template: TaskTemplate = {
			name: "owasp-audit",
			description: "Full-stack audit with all fields set",
			task: VALID_TEMPLATE_BODY,
			preset: "security-auditor",
			thinkingLevel: "high",
			outputFile: "audit-${file}.md",
			timeout: 60000,
			tools: ["read", "grep"],
			excludeTools: ["write"],
			noBuiltinTools: true,
			inheritSystemPrompt: false,
		};

		writeTemplateFile(template, path.join(cwd, ".pi", "brl-subagent", "templates"));

		const templates = loadCustomTemplates(cwd);
		expect(templates).toHaveLength(1);
		const t = templates[0];
		expect(t.name).toBe(template.name);
		expect(t.description).toBe(template.description);
		expect(t.task).toBe(template.task);
		expect(t.preset).toBe(template.preset);
		expect(t.thinkingLevel).toBe(template.thinkingLevel);
		expect(t.outputFile).toBe(template.outputFile);
		expect(t.timeout).toBe(template.timeout);
		expect(t.tools).toEqual(template.tools);
		expect(t.excludeTools).toEqual(template.excludeTools);
		expect(t.noBuiltinTools).toBe(true);
		expect(t.inheritSystemPrompt).toBe(false);
	});

	it("sanitizes the file name and creates the directory", () => {
		const cwd = makeTempDir();
		const dir = path.join(cwd, ".pi", "brl-subagent", "templates");
		const filePath = writeTemplateFile(
			{ name: "my:weird/name?", task: "task" },
			dir,
		);
		expect(path.basename(filePath)).toBe("my-weird-name-.md");
		expect(fs.existsSync(filePath)).toBe(true);
		expect(loadCustomTemplates(cwd)[0].name).toBe("my:weird/name?");
	});

	it("omits undefined fields from the frontmatter", () => {
		const cwd = makeTempDir();
		const template: TaskTemplate = {
			name: "sparse",
			task: "Sparse task",
		};
		writeTemplateFile(template, path.join(cwd, ".pi", "brl-subagent", "templates"));
		const content = fs.readFileSync(
			path.join(cwd, ".pi", "brl-subagent", "templates", "sparse.md"),
			"utf-8",
		);
		expect(content).not.toContain("description:");
		expect(content).not.toContain("preset:");
		expect(content).not.toContain("thinkingLevel:");
		expect(content).not.toContain("outputFile:");
		expect(content).not.toContain("timeout:");
		expect(content).not.toContain("noBuiltinTools:");
		expect(content).not.toContain("inheritSystemPrompt:");
		expect(content).toContain("---\nname: sparse\n---\nSparse task\n");
	});
});
