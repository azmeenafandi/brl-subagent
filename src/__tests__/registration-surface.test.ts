/**
 * The registration surface, pinned (ADR 0027 S5 / issue #483).
 *
 * The S5 refactor moved the command table, the `delegate_task` definition and the
 * three agent-tool definitions out of the `initExtension` closure into three
 * factories. A move of a *registration* is the one kind of move a unit test
 * cannot notice: drop a `pi.registerTool(...)` call at the new call site and
 * every existing suite still passes — one fourth of the extension's capability
 * set is simply gone from the model's tool list.
 *
 * So this suite pins the surface itself, from the OUTSIDE of the composition
 * root:
 *
 *   1. the exact set of registered names (a dropped or renamed registration
 *      reddens here and nowhere else);
 *   2. every definition field byte-for-byte against
 *      `fixtures/registration-surface-876bb5d.json`, captured from the
 *      pre-move tree at 876bb5d — so "a move, not an API change" is measured,
 *      not asserted in prose;
 *   3. `delegate_task`'s `parameters` is the imported `delegateTaskParamsSchema`
 *      itself (identity, not a structural copy), which is what makes the
 *      schema-single-source guarantee hold across the move.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// tui.ts pulls these at import time; index.ts imports tui.ts. Same stubs the
// other registration-driving suites use (dispatch-capability-guards pattern).
vi.mock("@earendil-works/pi-tui", () => {
	class Container {}
	class SelectList {}
	class Spacer {}
	class Text {}
	class Markdown {}
	return { Container, SelectList, Spacer, Text, Markdown };
});
vi.mock("@earendil-works/pi-coding-agent", () => {
	class DynamicBorder {}
	const getMarkdownTheme = () => ({});
	return { DynamicBorder, getMarkdownTheme };
});

import initExtension from "../index";
import { delegateTaskParamsSchema } from "../schema";

const repoRoot = join(__dirname, "..", "..");

/** The four tools the shipped extension registers, and the one command. */
const TOOL_NAMES = [
	"delegate_task",
	"get_subagent_result",
	"steer_subagent",
	"stop_subagent",
] as const;
const COMMAND_NAME = "brl-subagent";

interface ToolLike {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	execute?: unknown;
	renderCall?: unknown;
	renderResult?: unknown;
}

interface CommandLike {
	description?: string;
	getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
	handler?: unknown;
}

/**
 * Boot the real extension against a capture-only `pi`. This is the production
 * registration path — no factory is called directly here, so a registration
 * deleted at the S5 call site is invisible to this harness exactly as it would
 * be to pi.
 */
function boot(): { tools: Map<string, ToolLike>; commands: Map<string, CommandLike> } {
	const tools = new Map<string, ToolLike>();
	const commands = new Map<string, CommandLike>();
	const mockPi = {
		registerTool: (t: ToolLike) => tools.set(t.name, t),
		registerCommand: (name: string, c: CommandLike) => commands.set(name, c),
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		ctx: { getState: () => undefined, setState: () => {} },
	};
	initExtension(mockPi as never);
	return { tools, commands };
}

/** Replace the environment-dependent package root with the fixture's placeholder. */
function normalize(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value).split(repoRoot).join("<pkg>"));
}

const fixture = JSON.parse(
	readFileSync(join(__dirname, "fixtures", "registration-surface-876bb5d.json"), "utf8"),
) as {
	command: { name: string; description?: string };
	tools: Record<string, Record<string, unknown>>;
};

const { tools, commands } = boot();

describe("the registered tool set (issue #483)", () => {
	it("registers exactly the four tool names — no drift, no silent drop", () => {
		// Not `toContain` for each: a SET comparison, so a registration removed
		// from the composition root (or an extra one appearing) fails here.
		expect([...tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
		// And the fixture must agree, so the two halves of this pin cannot drift
		// apart silently.
		expect(Object.keys(fixture.tools).sort()).toEqual([...TOOL_NAMES].sort());
	});

	it("registers the /brl-subagent command exactly once", () => {
		expect([...commands.keys()]).toEqual([COMMAND_NAME]);
	});
});

describe("tool definitions are byte-identical to the pre-move literals (issue #483)", () => {
	for (const name of TOOL_NAMES) {
		it(`${name}: name/label/description/guidance/parameters match 876bb5d`, () => {
			const registered = tools.get(name);
			expect(registered, `${name} must be registered`).toBeDefined();
			const expected = fixture.tools[name];

			// Field-by-field (not toMatchObject) so a REMOVED optional field and a
			// changed one both fail: the surface the model sees is the whole object.
			const actual = normalize({
				name: registered!.name,
				label: registered!.label,
				description: registered!.description,
				promptSnippet: registered!.promptSnippet,
				promptGuidelines: registered!.promptGuidelines,
				parameters: registered!.parameters,
			}) as Record<string, unknown>;

			for (const key of Object.keys(expected)) {
				expect(actual[key], `${name}.${key} changed since 876bb5d`).toEqual(expected[key]);
			}
			expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
		});
	}

	it("delegate_task's parameters IS the imported schema (single source, not a copy)", () => {
		// The move must hand the same object to registerTool: a structural copy
		// would satisfy a deep-equal but break the schema<->types ratchet
		// (schema.ts documents Static<typeof delegateTaskParamsSchema> as the
		// source of DelegateTaskParams).
		expect(tools.get("delegate_task")?.parameters).toBe(delegateTaskParamsSchema);
	});

	it("every tool keeps its execute, and delegate_task keeps both renderers", () => {
		// The definitions are returned by factories now; a factory that returned
		// a definition stripped of its behaviour would pass the shape assertions
		// above. These three members are the behaviour.
		for (const name of TOOL_NAMES) {
			expect(typeof tools.get(name)?.execute, `${name}.execute`).toBe("function");
		}
		expect(typeof tools.get("delegate_task")?.renderCall).toBe("function");
		expect(typeof tools.get("delegate_task")?.renderResult).toBe("function");
	});
});

describe("the /brl-subagent command surface (issue #483)", () => {
	it("keeps its description and its completion contract", () => {
		const command = commands.get(COMMAND_NAME);
		expect(command?.description).toBe(fixture.command.description);
		expect(typeof command?.handler).toBe("function");

		// The completion list is part of the surface (it is what the user sees
		// after typing `/brl-subagent `), and it lives in the moved table.
		const completions = command?.getArgumentCompletions?.("") ?? [];
		expect(completions.map((c) => c.value)).toEqual(
			expect.arrayContaining([
				"history",
				"historyentries",
				"monitor",
				"dashboard",
				"preset",
				"templates",
				"retry",
				"completionnotify",
				"recovery",
			]),
		);
		// A prefix filters; a non-matching prefix yields null (the pre-move
		// contract: pi treats null as "no suggestions", not an empty list).
		expect(command?.getArgumentCompletions?.("zzz")).toBeNull();
		expect(command?.getArgumentCompletions?.("hist")?.map((c) => c.value).sort()).toEqual([
			"history",
			"historyentries",
		]);
	});
});
