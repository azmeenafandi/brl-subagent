/**
 * Issue #606 (§3a) — how the block reaches a rendered task.
 *
 * `applyTemplate` REPLACES a supplied task (template-wins), so a caller cannot
 * inject the block: the template's frontmatter is the only place it can come
 * from, and the renderer is where it is composed.
 *
 * T9a: the renderer prepends `dispatch: <kind>`.
 * T9b: a template with no `dispatch:` field is refused at render — ONLY where
 *      the dispatch cwd opted in (P13 pins the fail-open direction).
 * T11: an unknown/misspelled frontmatter value is an ERROR naming the field and
 *      the allowed set, at load AND at render (a silently ignored key would
 *      disable the gate with no warning).
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveTemplate, validateTemplate } from "../templates";
import { DISPATCH_KINDS } from "../dispatch-header";
import type { TaskTemplate } from "../types";

const dirs: string[] = [];

function cwd(optedIn: boolean): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-606-template-"));
	dirs.push(dir);
	if (optedIn) {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "fixture", "brl-subagent": { processChecks: true } }),
			"utf8",
		);
	}
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function template(over: Partial<TaskTemplate> = {}): TaskTemplate {
	return { name: "fixture-template", task: "Do ${file}.", ...over };
}

describe("T9a — the renderer prepends the declaration", () => {
	it("T9a — a template renders `dispatch: <kind>` as the first line", () => {
		const rendered = resolveTemplate(template({ dispatch: "review" }), { file: "src/x.ts" });
		expect(rendered.ok).toBe(true);
		if (!rendered.ok) return;
		expect(rendered.value.task.split("\n")[0]).toBe("dispatch: review");
		expect(rendered.value.task).toContain("Do src/x.ts.");
	});

	it("T9a — the body's own declaration is not duplicated", () => {
		const body = "dispatch: probe\n\nDo ${file}.";
		const rendered = resolveTemplate(template({ dispatch: "probe", task: body }), { file: "x" });
		expect(rendered.ok).toBe(true);
		if (!rendered.ok) return;
		expect(rendered.value.task.split("\n").filter((line) => line.startsWith("dispatch:"))).toHaveLength(1);
	});
});

describe("T9b — a template with no dispatch field", () => {
	it("T9b — is refused at render when the dispatch cwd opted in, naming the field", () => {
		const rendered = resolveTemplate(template(), { file: "x" }, { cwd: cwd(true) });
		expect(rendered.ok).toBe(false);
		if (rendered.ok) return;
		expect(rendered.error).toContain('no "dispatch" field');
		expect(rendered.error).toContain(DISPATCH_KINDS.join(", "));
	});

	it("T9b — renders untouched when the dispatch cwd did not opt in (fail-open)", () => {
		const rendered = resolveTemplate(template(), { file: "x" }, { cwd: cwd(false) });
		expect(rendered.ok).toBe(true);
		if (!rendered.ok) return;
		expect(rendered.value.task).toBe("Do x.");
		expect(rendered.value.task).not.toContain("dispatch:");
	});
});

describe("T11 — an unknown frontmatter value is an error, never ignored", () => {
	it("T11 — the render refuses a misspelled kind, naming the field and the allowed set", () => {
		const rendered = resolveTemplate(
			template({ dispatch: "reveiw" as never }),
			{ file: "x" },
			{ cwd: cwd(true) },
		);
		expect(rendered.ok).toBe(false);
		if (rendered.ok) return;
		expect(rendered.error).toContain('"dispatch"');
		expect(rendered.error).toContain(DISPATCH_KINDS.join(", "));
		expect(rendered.error).toContain("reveiw");
	});

	it("T11 — load-time validation reports the same error (the key is not silently dropped)", () => {
		const errors = validateTemplate({ name: "t", dispatch: "reveiw" }, "t.md");
		expect(errors.join(" ")).toContain('invalid "dispatch" value "reveiw"');
		expect(errors.join(" ")).toContain(DISPATCH_KINDS.join(", "));
		expect(validateTemplate({ name: "t", dispatch: "impl" }, "t.md")).toEqual([]);
	});
});

describe("an impl template names the brief it needs", () => {
	it("refuses `impl` with no brief param, naming what is missing", () => {
		const rendered = resolveTemplate(template({ dispatch: "impl" }), { file: "x" }, { cwd: cwd(true) });
		expect(rendered.ok).toBe(false);
		if (rendered.ok) return;
		expect(rendered.error).toContain("dispatch: impl");
		expect(rendered.error).toContain("brief");
		expect(rendered.error).toMatch(/none — <reason>/);
	});

	it("composes `brief: <slug>` beneath the kind", () => {
		const rendered = resolveTemplate(template({ dispatch: "impl" }), { file: "x", brief: "consider-tax" }, { cwd: cwd(true) });
		expect(rendered.ok).toBe(true);
		if (!rendered.ok) return;
		expect(rendered.value.task.split("\n").slice(0, 2)).toEqual(["dispatch: impl", "brief: consider-tax"]);
	});

	it("accepts the caller's stated escape as the brief param", () => {
		const rendered = resolveTemplate(
			template({ dispatch: "impl" }),
			{ file: "x", brief: "none — the human was unreachable" },
			{ cwd: cwd(true) },
		);
		expect(rendered.ok).toBe(true);
		if (!rendered.ok) return;
		expect(rendered.value.task).toContain("brief: none — the human was unreachable");
	});

	it("refuses a brief param that is not a slug or an escape reason", () => {
		const rendered = resolveTemplate(template({ dispatch: "impl" }), { file: "x", brief: "../x" }, { cwd: cwd(true) });
		expect(rendered.ok).toBe(false);
		if (rendered.ok) return;
		expect(rendered.error).toMatch(/invalid brief slug|invalid dispatch block/);
	});
});
