/**
 * validateUnitPrePass — the shared per-unit pre-pass (#379 commit 3).
 *
 * chain/parallel/graph each CALL this helper at their own position (design
 * note IN8); the handler suites pin the position. These are the helper's own
 * contract: unit order, per-unit prefix, the graph task-text override, the
 * `force` passthrough, first-rejection-wins (nothing validated after a bad
 * unit), and warnings accumulated in unit order for the caller to surface.
 */

import { describe, expect, it, vi } from "vitest";
import { validateUnitPrePass, type UnitPrePassSource } from "../prelude";
import type { Logger } from "../logging";

const ctx = {
	cwd: process.cwd(),
} as unknown as Parameters<typeof validateUnitPrePass>[0]["ctx"];

function fakeLog(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface Unit {
	name: string;
	cwd?: string;
	task?: string;
	outputFile?: string;
	excludeTools?: string[];
}

function merge(unit: Unit): UnitPrePassSource & { name: string } {
	return {
		name: unit.name,
		task: unit.task ?? "plain work",
		effectiveCwd: unit.cwd ?? process.cwd(),
		outputFile: unit.outputFile,
		thinkingLevel: "medium",
		toolOptions: unit.excludeTools ? { excludeTools: unit.excludeTools } : undefined,
	};
}

function pass(units: Unit[], overrides: { force?: boolean; describeTask?: string } = {}) {
	return validateUnitPrePass({
		units,
		merge,
		describe: (unit) => ({
			prefix: `Unit ${unit.name}`,
			logContext: { unit: unit.name },
			task: overrides.describeTask,
		}),
		label: "Test",
		gitMode: "none",
		ctx,
		log: fakeLog(),
		force: overrides.force,
	});
}

describe("validateUnitPrePass", () => {
	it("returns every unit in input order with its resolved cwd", () => {
		const result = pass([{ name: "a" }, { name: "b" }, { name: "c" }]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.units.map((u) => u.unit.name)).toEqual(["a", "b", "c"]);
		expect(result.units.every((u) => u.cwd === process.cwd())).toBe(true);
		expect(result.warnings).toEqual([]);
	});

	it("collects warnings in unit order, prefixed with the unit", () => {
		const result = pass([
			{ name: "a", task: "commit the changes" },
			{ name: "b" },
			{ name: "c", task: "commit the changes" },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings[0]).toMatch(/^Unit a: Task involves git operations/);
		expect(result.warnings[1]).toMatch(/^Unit c: Task involves git operations/);
	});

	it("validates the describe-provided task text instead of merged.task", () => {
		// The graph pre-pass strips `{placeholder}` tokens before H1; the
		// helper must validate the text describe returns.
		const result = pass([{ name: "a", task: "commit the changes" }], { describeTask: "plain work" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.warnings).toEqual([]);
	});

	it("passes force through: a capability block degrades to a warning", () => {
		const unit: Unit = { name: "a", task: "run the tests", excludeTools: ["bash"] };
		const blocked = pass([unit]);
		expect(blocked.ok).toBe(false);

		const forced = pass([unit], { force: true });
		expect(forced.ok).toBe(true);
		if (!forced.ok) return;
		expect(forced.warnings.some((w) => w.startsWith("Unit a: Task involves running commands"))).toBe(true);
	});

	it("first rejection wins: the error is unit-prefixed and no later unit is merged", () => {
		const mergeSpy = vi.fn((unit: Unit) => merge(unit));
		const result = validateUnitPrePass({
			units: [{ name: "a" }, { name: "b", cwd: "/nonexistent/brl-379" }, { name: "c" }],
			merge: mergeSpy,
			describe: (unit) => ({ prefix: `Unit ${unit.name}`, logContext: { unit: unit.name } }),
			label: "Test",
			gitMode: "none",
			ctx,
			log: fakeLog(),
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.content[0].text).toContain('Unit b: Invalid cwd:');
		expect(mergeSpy).toHaveBeenCalledTimes(2);
	});
});
