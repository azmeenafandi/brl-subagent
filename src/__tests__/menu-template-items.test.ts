// Purpose: Pins the menu-polish U5 (umbrella #345) headline contract — the Templates manager's
// partition/order (built-ins in shipped order → divider only when customs exist → customs in
// current order), the [B]/[P]/[G] prefixes, the `N built-in, M custom` title AND parent-row
// counts, the description fallback table, the empty-state notify, and divider-select = no-op
// re-render. Partition is by membership in the shipped built-ins, so an override by name is
// still custom.
import { describe, expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SessionState } from "../state";
import {
	buildTemplateMenuItems,
	getConfigMenuItems,
	showTemplateManager,
	type Tier,
} from "../tui";
import { formatMenuValue, formatTemplateSummary } from "../tui-format";
import type { TaskTemplate } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function template(name: string, extra: Partial<TaskTemplate> = {}): TaskTemplate {
	return { name, task: `do ${name}`, ...extra };
}

/** Shipped built-ins in their load order (what `state.builtinTemplates` holds). */
const BUILTINS: TaskTemplate[] = [
	template("Plan Feature"),
	template("Review Changes"),
];

/** Customs in their current (load) order. */
const CUSTOMS: TaskTemplate[] = [
	template("My Checklist", { preset: "preflight" }),
	template("Global Only", { thinkingLevel: "high" }),
];

/** The merged stack as `getAllTemplates` produces it: customs FIRST, then built-ins. */
const MERGED: TaskTemplate[] = [...CUSTOMS, ...BUILTINS];

/** Injected tier lookup (the builder takes `sourceOf`, so no filesystem is needed). */
const TIER_OF: Record<string, Tier> = { "My Checklist": "project", "Global Only": "global" };
const sourceOf = (name: string): Tier => TIER_OF[name] ?? "builtin";

/** Non-divider values, in row order. */
function rowValues(items: Array<{ value: string }>): string[] {
	return items.map((i) => i.value);
}

function isDivider(item: { value: string }): boolean {
	return item.value.startsWith("__divider__");
}

const THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** A state whose template stack is the merged builtin/custom stack above. */
function stateWith(
	builtinTemplates: TaskTemplate[],
	allTemplates: TaskTemplate[],
): SessionState {
	const state = new SessionState();
	state.builtinTemplates = builtinTemplates;
	state.config.templates = allTemplates;
	return state;
}

// ---------------------------------------------------------------------------
// 1. Partition + order
// ---------------------------------------------------------------------------

describe("buildTemplateMenuItems — partition and order", () => {
	it("orders built-ins (shipped order), then the divider, then customs (current order)", () => {
		const items = buildTemplateMenuItems(MERGED, sourceOf, BUILTINS);
		expect(rowValues(items)).toEqual([
			"Plan Feature",
			"Review Changes",
			"__divider__:custom-templates",
			"My Checklist",
			"Global Only",
		]);
	});

	it("keeps built-ins in SHIPPED order even though the merged stack lists them last", () => {
		// getAllTemplates returns customs first; the manager must reverse that for
		// built-ins only, without reordering the customs.
		const items = buildTemplateMenuItems(MERGED, sourceOf, BUILTINS);
		const builtinRows = rowValues(items).filter((v) => v === "Plan Feature" || v === "Review Changes");
		expect(builtinRows).toEqual(["Plan Feature", "Review Changes"]);
		expect(rowValues(items).slice(-2)).toEqual(["My Checklist", "Global Only"]);
	});

	it("omits the divider when there are no customs", () => {
		const items = buildTemplateMenuItems(BUILTINS, sourceOf, BUILTINS);
		expect(rowValues(items)).toEqual(["Plan Feature", "Review Changes"]);
		expect(items.some(isDivider)).toBe(false);
	});

	it("renders the divider with the frozen menuSection shape", () => {
		const [divider] = buildTemplateMenuItems(MERGED, sourceOf, BUILTINS).filter(isDivider);
		expect(divider.label).toBe("\u2500\u2500\u2500 Custom Templates \u2500\u2500\u2500");
		expect(divider.description).toBe("");
	});

	it("partitions by MEMBERSHIP, so a custom overriding a builtin name stays custom", () => {
		// A custom template named like a shipped one: getAllTemplates drops the
		// builtin OBJECT, so only the custom object is in the merged stack.
		const originalReview = template("Review Changes");
		const override = template("Review Changes", { description: "mine" });
		const shipped = [BUILTINS[0], originalReview];
		const merged = [override, BUILTINS[0]];
		const items = buildTemplateMenuItems(
			merged,
			(name) => (name === "Review Changes" ? "project" : "builtin"),
			shipped,
		);
		expect(rowValues(items)).toEqual([
			"Plan Feature",
			"__divider__:custom-templates",
			"Review Changes",
		]);
		expect(items[2].label).toBe("[P] Review Changes");
	});

	it("is pure — calling it twice yields equal rows and does not mutate the inputs", () => {
		const snapshot = JSON.stringify(MERGED);
		expect(buildTemplateMenuItems(MERGED, sourceOf, BUILTINS)).toEqual(
			buildTemplateMenuItems(MERGED, sourceOf, BUILTINS),
		);
		expect(JSON.stringify(MERGED)).toBe(snapshot);
	});
});

// ---------------------------------------------------------------------------
// 2. Prefixes
// ---------------------------------------------------------------------------

describe("buildTemplateMenuItems — tier prefixes", () => {
	it("labels built-ins [B] and customs [P]/[G] from the injected tier lookup", () => {
		const items = buildTemplateMenuItems(MERGED, sourceOf, BUILTINS);
		const labels = Object.fromEntries(items.map((i) => [i.value, i.label]));
		expect(labels["Plan Feature"]).toBe("[B] Plan Feature");
		expect(labels["Review Changes"]).toBe("[B] Review Changes");
		expect(labels["My Checklist"]).toBe("[P] My Checklist");
		expect(labels["Global Only"]).toBe("[G] Global Only");
	});

	it("never consults the tier lookup for a built-in row", () => {
		const spy = vi.fn(sourceOf);
		buildTemplateMenuItems(MERGED, spy, BUILTINS);
		expect(spy.mock.calls.map(([name]) => name)).toEqual(["My Checklist", "Global Only"]);
	});
});

// ---------------------------------------------------------------------------
// 3. Description fallback table
// ---------------------------------------------------------------------------

describe("formatTemplateSummary — description fallback", () => {
	const cases: Array<[string, TaskTemplate, string]> = [
		[
			"preset + thinking + slots",
			template("B", {
				preset: "code-review",
				thinkingLevel: "high",
				task: "Review ${file} with ${focus}, again ${file}",
			}),
			"preset:code-review \u00b7 thinking:high \u00b7 slots file, focus",
		],
		[
			"omits absent parts (preset only)",
			template("C", { preset: "pr" }),
			"preset:pr",
		],
		[
			"omits absent parts (thinking only)",
			template("D", { thinkingLevel: "low" }),
			"thinking:low",
		],
		[
			"omits absent parts (slots only), task + outputFile scanned",
			template("E", { task: "Write ${title}", outputFile: "docs/${section}.md" }),
			"slots section, title",
		],
		[
			"last resort: the task's first 60 characters",
			template("F", { task: "z".repeat(80) }),
			"z".repeat(60),
		],
	];

	for (const [name, t, expected] of cases) {
		it(name, () => {
			expect(formatTemplateSummary(t)).toBe(expected);
		});
	}

	it("feeds the manager row only when the template declares no description", () => {
		const merged = [
			template("With Description", { description: "hand written", preset: "pr" }),
			template("With Preset", { preset: "pr" }),
		];
		const rows = buildTemplateMenuItems(merged, () => "project", []);
		expect(rows[1].description).toBe("hand written");
		expect(rows[2].description).toBe("preset:pr");
	});
});

// ---------------------------------------------------------------------------
// 4. Title counts + the parent config row
// ---------------------------------------------------------------------------

/** Render the manager headlessly and return the first screen's lines. */
async function renderManager(state: SessionState, cwd: string): Promise<string[]> {
	const lines: string[] = [];
	const ctx = {
		ui: {
			theme: THEME,
			notify: vi.fn(),
			setStatus: vi.fn(),
			input: vi.fn(async () => null),
			custom: vi.fn((factory: (...args: unknown[]) => { render: (w: number) => string[] }) => {
				const component = factory({ requestRender: () => {} }, THEME, {}, () => {});
				lines.push(...component.render(120));
				return Promise.resolve(null);
			}),
		},
		modelRegistry: { getAvailable: async () => [] },
		cwd,
	} as unknown as ExtensionContext;
	await showTemplateManager(ctx, state);
	return lines;
}

describe("Templates manager title counts", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	/** A project cwd holding the canonical file for "My Checklist". */
	function projectWithChecklist(): string {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "brl-subagent-menu-u5-"));
		tempDirs.push(cwd);
		const dir = path.join(cwd, ".pi", "brl-subagent", "templates");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "My Checklist.md"), "---\nname: My Checklist\n---\nbody\n");
		return cwd;
	}

	it("titles the list `Templates (N built-in, M custom)` matching the partitions", async () => {
		const lines = await renderManager(
			stateWith(BUILTINS, [...CUSTOMS.slice(0, 1), ...BUILTINS]),
			projectWithChecklist(),
		);
		const screen = lines.join("\n");
		expect(screen).toContain("Templates (2 built-in, 1 custom)");
		// The real (filesystem) tier lookup labels the project custom [P].
		expect(screen).toContain("[B] Plan Feature");
		expect(screen).toContain("[P] My Checklist");
		expect(screen).toContain("\u2500\u2500\u2500 Custom Templates \u2500\u2500\u2500");
	});

	it("keeps the parent config row's counts equal to the manager's", async () => {
		const state = stateWith(BUILTINS, [...CUSTOMS.slice(0, 1), ...BUILTINS]);
		const row = getConfigMenuItems(state).find((i) => i.value === "templates");
		expect(row?.description).toBe("2 built-in, 1 custom");
		// Same canonical token the row vocabulary provides (U1/U2), same counts.
		expect(row?.description).toBe(
			formatMenuValue("templateCounts", { builtinCount: 2, customCount: 1 }),
		);

		const screen = (await renderManager(state, projectWithChecklist())).join("\n");
		expect(screen).toContain(`Templates (${row?.description})`);
	});

	it("counts an override as custom on both surfaces (no double count)", async () => {
		const originalReview = template("Review Changes");
		const override = template("Review Changes", { description: "mine" });
		const state = stateWith([BUILTINS[0], originalReview], [override, BUILTINS[0]]);
		const row = getConfigMenuItems(state).find((i) => i.value === "templates");
		expect(row?.description).toBe("1 built-in, 1 custom");

		const screen = (await renderManager(state, projectWithChecklist())).join("\n");
		expect(screen).toContain("Templates (1 built-in, 1 custom)");
	});
});

// ---------------------------------------------------------------------------
// 5. Empty state
// ---------------------------------------------------------------------------

describe("Templates manager empty state", () => {
	it("returns no rows from the builder", () => {
		expect(buildTemplateMenuItems([], sourceOf, [])).toEqual([]);
	});

	it("keeps the explicit notify and never opens the list", async () => {
		const notify = vi.fn();
		const custom = vi.fn();
		const ctx = {
			ui: { theme: THEME, notify, setStatus: vi.fn(), custom },
			modelRegistry: { getAvailable: async () => [] },
			cwd: "/tmp/project",
		} as unknown as ExtensionContext;

		await showTemplateManager(ctx, new SessionState());

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("No task templates loaded"),
			"info",
		);
		expect(custom).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 6. Divider selection = no-op re-render (never a close)
// ---------------------------------------------------------------------------

describe("Templates manager divider selection", () => {
	it("re-renders the list on a divider instead of closing the manager", async () => {
		const screens: string[][] = [];
		const selections: Array<string | null> = [
			"__divider__:custom-templates",
			"Plan Feature",
			null,
		];
		const ctx = {
			ui: {
				theme: THEME,
				notify: vi.fn(),
				setStatus: vi.fn(),
				custom: vi.fn((factory: (...args: unknown[]) => { render: (w: number) => string[] }) => {
					const component = factory({ requestRender: () => {} }, THEME, {}, () => {});
					screens.push(component.render(120));
					return Promise.resolve(selections.shift() ?? null);
				}),
			},
			modelRegistry: { getAvailable: async () => [] },
			cwd: "/tmp/project",
		} as unknown as ExtensionContext;

		await showTemplateManager(ctx, stateWith(BUILTINS, [...CUSTOMS, ...BUILTINS]));

		// Three screens: the LIST (the divider selection re-rendered it), the LIST
		// again (the custom row resolved), then the template DETAIL. A
		// close-on-select divider would have stopped after the first screen.
		expect(screens).toHaveLength(3);
		expect(screens[1].join("\n")).toContain("Templates (2 built-in, 2 custom)");
		expect(screens[2].join("\n")).toContain("Template: Plan Feature");
	});
});
