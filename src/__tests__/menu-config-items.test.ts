// Purpose: Pins the menu-polish U2 (umbrella #345) presentation contract — the 17 config rows,
// the one `(current)` marker syntax, the six choice-screen titles, and the five canonical input
// prompts. Presentation-only: nothing here asserts behavior, keys, actions, or row order.
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionState } from "../state";
import {
	CONFIG_MENU_VIEWPORT,
	getApprovalModeItems,
	getCompletionNotifyItems,
	getConfigMenuItems,
	getModelSelectorItems,
	getRecoveryItems,
	getSLAEnableItems,
	getThinkingSelectorItems,
	showApprovalModeSelector,
	showCompletionNotifySelector,
	showConcurrencyInput,
	showConfigMenu,
	showCostLimitInput,
	showDepthInput,
	showHistoryEntriesInput,
	showModelSelector,
	showRecoverySelector,
	showSLAConfig,
	showThinkingSelector,
	withCurrentMarker,
} from "../tui";
import type { SubagentPreset, TaskTemplate } from "../types";

// ---------------------------------------------------------------------------
// Fixtures — structural state built from the REAL SessionState constructor
// (same shape the other state-driven tests use), then mutated per scenario.
// ---------------------------------------------------------------------------

/** The pinned row order / value set of the config menu (U2/U3 contract). */
const CONFIG_VALUES = [
	"model",
	"thinking",
	"concurrency",
	"depth",
	"approval",
	"completionnotify",
	"recovery",
	"historyentries",
	"costlimit",
	"history",
	"monitor",
	"dashboard",
	"retry",
	"preset",
	"templates",
	"reset",
	"sla",
] as const;

/** The two U3 section headers, in order, with their expected divider values. */
const DIVIDERS = [
	{ label: "Run Activity", value: "__divider__:run-activity" },
	{ label: "Presets & Templates", value: "__divider__:presets-templates" },
] as const;

function configValues(items: Array<{ value: string }>): string[] {
	return items.filter((i) => !i.value.startsWith("__divider__:")).map((i) => i.value);
}

/** Fixture 1: untouched SessionState defaults. */
function defaultsState(): SessionState {
	return new SessionState();
}

/** Fixture 2: every config surface populated (non-zero, non-default). */
function fullyConfiguredState(): SessionState {
	const state = new SessionState();
	state.config.model = { provider: "anthropic", id: "claude-sonnet-4" };
	state.config.maxThinkingLevel = "high";
	state.config.maxParallel = 4;
	state.config.maxSubagentDepth = 2;
	state.config.approvalMode = "auto";
	state.config.completionNotify = "failed";
	state.config.recovery = "off";
	state.config.maxHistoryEntries = 250;
	state.config.sessionCostLimit = 2.5;
	state.config.slaTrackingEnabled = true;
	state.config.slaWindowSize = 100;
	state.builtinPresets = [preset("code-reviewer")];
	state.customPresets = [preset("house-style"), preset("release-notes")];
	// Builtin template objects are shared by reference with the merged stack
	// (getAllTemplates), so this fixture also exercises the builtin/custom split.
	const builtin = template("build");
	state.builtinTemplates = [builtin];
	state.config.templates = [template("house-style"), template("release-notes"), builtin];
	return state;
}

/** Fixture 3: every zero-means-unlimited/off surface at its zero. */
function zeroUnlimitedState(): SessionState {
	const state = new SessionState();
	state.config.model = undefined;
	state.config.maxThinkingLevel = "off";
	state.config.maxParallel = 0;
	state.config.maxSubagentDepth = 0;
	state.config.approvalMode = "writes";
	state.config.completionNotify = "off";
	state.config.recovery = "offer";
	state.config.maxHistoryEntries = 0;
	state.config.sessionCostLimit = 0;
	state.config.slaTrackingEnabled = false;
	return state;
}

function preset(name: string): SubagentPreset {
	return { name, description: `${name} preset` };
}

function template(name: string): TaskTemplate {
	return { name, description: `${name} template`, task: `do ${name}` };
}

/** value → description map for one state (order-independent assertions). */
function descriptions(state: SessionState): Record<string, string> {
	const map: Record<string, string> = {};
	for (const item of getConfigMenuItems(state)) {
		if (item.value.startsWith("__divider__:")) continue;
		map[item.value] = item.description ?? "";
	}
	return map;
}

// ---------------------------------------------------------------------------
// Mock UI — captures prompts and renders every custom screen headlessly
// ---------------------------------------------------------------------------

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const availableModels = [
	{
		provider: "anthropic",
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		contextWindow: 200_000,
	},
	{ provider: "openai", id: "gpt-5", name: "GPT-5", contextWindow: 400_000 },
];

interface UiCapture {
	/** Every prompt string passed to `ctx.ui.input`, in call order. */
	prompts: string[];
	/** Rendered lines of every `ctx.ui.custom` screen, in call order. */
	screenLines: string[];
	ctx: ExtensionContext;
}

/**
 * Build a fake ExtensionContext. `select` is what every select list resolves
 * to; `input` is what every text prompt resolves to. Screens are rendered at
 * width 120 so their titles and row labels are observable without a terminal.
 */
function makeUi(options: { select?: string | null; input?: string | null } = {}): UiCapture {
	const prompts: string[] = [];
	const screenLines: string[] = [];
	const ctx = {
		ui: {
			theme,
			notify: vi.fn(),
			setStatus: vi.fn(),
			input: vi.fn(async (prompt: string) => {
				prompts.push(prompt);
				return options.input ?? null;
			}),
			custom: vi.fn((factory: (...args: unknown[]) => { render: (w: number) => string[] }) => {
				const component = factory({ requestRender: () => {} }, theme, {}, () => {});
				screenLines.push(...component.render(120));
				return Promise.resolve(options.select ?? null);
			}),
		},
		modelRegistry: { getAvailable: async () => availableModels },
		cwd: "/tmp/project",
	} as unknown as ExtensionContext;
	return { prompts, screenLines, ctx };
}

const noop = () => {};

// ---------------------------------------------------------------------------
// 1. Value-set pin (17 rows, frozen order) across 3 fixture states
// ---------------------------------------------------------------------------

describe("getConfigMenuItems — value-set pin", () => {
	const states: Array<[string, () => SessionState]> = [
		["defaults", defaultsState],
		["fully configured", fullyConfiguredState],
		["zero/unlimited", zeroUnlimitedState],
	];

	for (const [name, build] of states) {
		it(`pins the 17 handler values and their order (${name})`, () => {
			expect(configValues(getConfigMenuItems(build()))).toEqual([...CONFIG_VALUES]);
		});
	}

	it("pins exactly 17 handler values plus 2 dividers", () => {
		const items = getConfigMenuItems(defaultsState());
		expect(items).toHaveLength(19);
		expect(configValues(items)).toHaveLength(17);
		expect(items.filter((i) => i.value.startsWith("__divider__:"))).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// 1b. U3 divider invariants + positions
// ---------------------------------------------------------------------------

describe("config menu section dividers", () => {
	it("emits exactly 2 dividers with the pinned shape and labels", () => {
		const dividers = getConfigMenuItems(defaultsState()).filter((i) =>
			i.value.startsWith("__divider__:"),
		);
		expect(dividers).toHaveLength(2);
		expect(dividers.map((d) => d.value)).toEqual(DIVIDERS.map((d) => d.value));
		for (const [index, divider] of dividers.entries()) {
			expect(divider.value.startsWith("__divider__:")).toBe(true);
			expect(divider.label).toMatch(/^─── .+ ───$/);
			expect(divider.label).toBe(`─── ${DIVIDERS[index].label} ───`);
			expect(divider.description).toBe("");
		}
	});

	it("positions the dividers before history and preset, with reset after templates", () => {
		const items = getConfigMenuItems(defaultsState());
		const values = items.map((i) => i.value);

		const historyDivider = values.indexOf(DIVIDERS[0].value);
		expect(values[historyDivider + 1]).toBe("history");

		const presetDivider = values.indexOf(DIVIDERS[1].value);
		expect(values[presetDivider + 1]).toBe("preset");

		expect(values.indexOf("reset")).toBeGreaterThan(values.indexOf("templates"));
	});

	it("never dispatches: divider values are absent from the 17 handler values", () => {
		const dividers = getConfigMenuItems(defaultsState()).filter((i) =>
			i.value.startsWith("__divider__:"),
		);
		for (const divider of dividers) {
			expect(CONFIG_VALUES).not.toContain(divider.value);
		}
	});
});

// ---------------------------------------------------------------------------
// 1c. U3 render structure + viewport
// ---------------------------------------------------------------------------

/** Render the real config menu (heading + list + footer) headlessly at a width. */
async function renderConfigMenu(width: number, state = defaultsState()): Promise<string[]> {
	const lines: string[] = [];
	const ctx = {
		ui: {
			theme,
			notify: vi.fn(),
			setStatus: vi.fn(),
			input: vi.fn(async () => null),
			custom: vi.fn((factory: (...args: unknown[]) => { render: (w: number) => string[] }) => {
				const component = factory({ requestRender: () => {} }, theme, {}, () => {});
				lines.push(...component.render(width));
				return Promise.resolve("__done__");
			}),
		},
		modelRegistry: { getAvailable: async () => availableModels },
		cwd: "/tmp/project",
	} as unknown as ExtensionContext;
	await showConfigMenu(ctx, state, {});
	return lines;
}

describe("showConfigMenu render structure", () => {
	it("uses the exported 15-row viewport cap", async () => {
		expect(CONFIG_MENU_VIEWPORT).toBe(15);
		const text = (await renderConfigMenu(120)).join("\n");
		// Item 15 (index 14) is the second divider; item 16 ("Browse Presets")
		// stays off-screen at selected index 0, pinning the exact cap.
		expect(text).toContain("─── Presets & Templates ───");
		expect(text).not.toContain("Browse Presets");
	});

	it("deletes the duplicated summary header", async () => {
		const text = (await renderConfigMenu(120)).join("\n");
		expect(text).toContain("brl-subagent Configuration");
		expect(text).not.toMatch(/Model: |Max Thinking: |Max parallel: |Cost limit: /);
	});

	it("fits every rendered line at 60/80/120 columns", async () => {
		for (const width of [60, 80, 120]) {
			const lines = await renderConfigMenu(width);
			expect(lines.length, `width ${width}: lines rendered`).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line), `width ${width}: "${line}"`).toBeLessThanOrEqual(width);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 2. Label grammar — verb-led, ≤ 30 visible chars, pinned verbatim
// ---------------------------------------------------------------------------

const PINNED_LABELS: Record<string, string> = {
	model: "Set Model",
	thinking: "Set Max Thinking Level",
	concurrency: "Set Max Parallel Subagents",
	depth: "Set Max Recursion Depth",
	approval: "Set Change Approval Mode",
	completionnotify: "Set Completion Notify Mode",
	recovery: "Set Recovery Posture",
	historyentries: "Set Max History Entries",
	costlimit: "Set Session Cost Limit",
	reset: "Reset Configuration",
	history: "View Run History",
	monitor: "View Live Monitor",
	dashboard: "View Observability Dashboard",
	preset: "Browse Presets",
	templates: "Browse Templates",
	retry: "Retry Failed Run",
	sla: "Set SLA Tracking",
};

describe("config row labels", () => {
	it("uses the pinned label table", () => {
		const labels: Record<string, string> = {};
		for (const item of getConfigMenuItems(defaultsState())) {
			if (item.value.startsWith("__divider__:")) continue;
			labels[item.value] = item.label;
		}
		expect(labels).toEqual(PINNED_LABELS);
	});

	it("every label is verb-led and ≤ 30 visible chars (all fixtures)", () => {
		const grammar = /^(Set|View|Browse|Retry|Reset) [A-Z]/;
		for (const build of [defaultsState, fullyConfiguredState, zeroUnlimitedState]) {
			for (const item of getConfigMenuItems(build())) {
				if (item.value.startsWith("__divider__:")) continue;
				expect(item.label, `label "${item.label}"`).toMatch(grammar);
				expect([...item.label].length, `label "${item.label}" length`).toBeLessThanOrEqual(30);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Token adoption — descriptions equal the canonical formatMenuValue token
// ---------------------------------------------------------------------------

describe("config row descriptions use the canonical menu tokens", () => {
	const expected: Array<[string, () => SessionState, Record<string, string>]> = [
		[
			"defaults",
			defaultsState,
			{
				model: "Not set",
				thinking: "off",
				concurrency: "Unlimited",
				depth: "3 levels",
				approval: "Ask on writes",
				completionnotify: "Every run",
				recovery: "On",
				historyentries: "500 entries",
				costlimit: "Unlimited",
				reset: "Clear subagent configuration",
				history: "Browse past subagent runs",
				monitor: "Watch running subagents in real-time",
				dashboard: "Real-time metrics, SLA, errors, and cost trends",
				preset: "0 built-in, 0 custom",
				templates: "0 built-in, 0 custom",
				retry: "Select a failed subagent to retry",
				sla: "Off",
			},
		],
		[
			"fully configured",
			fullyConfiguredState,
			{
				model: "anthropic/claude-sonnet-4",
				thinking: "high",
				concurrency: "4",
				depth: "2 levels",
				approval: "Never ask",
				completionnotify: "Failed only",
				recovery: "Off",
				historyentries: "250 entries",
				costlimit: "$2.50",
				reset: "Clear subagent configuration",
				history: "Browse past subagent runs",
				monitor: "Watch running subagents in real-time",
				dashboard: "Real-time metrics, SLA, errors, and cost trends",
				preset: "1 built-in, 2 custom",
				templates: "1 built-in, 2 custom",
				retry: "Select a failed subagent to retry",
				sla: "On (window 100)",
			},
		],
		[
			"zero/unlimited",
			zeroUnlimitedState,
			{
				model: "Not set",
				thinking: "off",
				concurrency: "Unlimited",
				depth: "Off",
				approval: "Ask on writes",
				completionnotify: "Off",
				recovery: "On",
				historyentries: "Unlimited",
				costlimit: "Unlimited",
				reset: "Clear subagent configuration",
				history: "Browse past subagent runs",
				monitor: "Watch running subagents in real-time",
				dashboard: "Real-time metrics, SLA, errors, and cost trends",
				preset: "0 built-in, 0 custom",
				templates: "0 built-in, 0 custom",
				retry: "Select a failed subagent to retry",
				sla: "Off",
			},
		],
	];

	for (const [name, build, tokens] of expected) {
		it(`adopts the canonical token for every row (${name})`, () => {
			expect(descriptions(build())).toEqual(tokens);
		});
	}

	it("formats the singular history-entries token", () => {
		const state = defaultsState();
		state.config.maxHistoryEntries = 1;
		expect(descriptions(state).historyentries).toBe("1 entry");
	});

	it("formats the singular recursion-depth token", () => {
		const state = defaultsState();
		state.config.maxSubagentDepth = 1;
		expect(descriptions(state).depth).toBe("1 level");
	});
});

// ---------------------------------------------------------------------------
// 4. One `(current)` marker syntax across the six choice lists
// ---------------------------------------------------------------------------

/** Labels carrying the canonical marker. */
function marked(labels: string[]): string[] {
	return labels.filter((label) => label.endsWith(" (current)"));
}

describe("choice-list current markers", () => {
	it("only ever appends the single canonical ` (current)` suffix", () => {
		expect(withCurrentMarker("high", true)).toBe("high (current)");
		expect(withCurrentMarker("high", false)).toBe("high");
	});

	it("model: marks the configured provider/id and nothing when unset", () => {
		const configured = fullyConfiguredState();
		const items = getModelSelectorItems(availableModels, configured);
		expect(marked(items.map((i) => i.label))).toEqual(["anthropic/claude-sonnet-4 (current)"]);

		const unset = getModelSelectorItems(availableModels, zeroUnlimitedState());
		expect(marked(unset.map((i) => i.label))).toEqual([]);
	});

	it("thinking: replaces `(current - ceiling)` with one `(current)`", () => {
		const labels = getThinkingSelectorItems(fullyConfiguredState()).map((i) => i.label);
		expect(marked(labels)).toEqual(["high (current)"]);
		expect(labels.some((label) => label.includes("current - ceiling"))).toBe(false);
	});

	it("approval: exactly one marker per list", () => {
		const labels = getApprovalModeItems(fullyConfiguredState()).map((i) => i.label);
		expect(marked(labels)).toEqual(["auto (current)"]);
		expect(labels).toEqual(["auto (current)", "writes", "always"]);
	});

	it("completionnotify: exactly one marker per list", () => {
		const labels = getCompletionNotifyItems(fullyConfiguredState()).map((i) => i.label);
		expect(marked(labels)).toEqual(["failed (current)"]);
		expect(labels).toEqual(["all", "failed (current)", "off"]);
	});

	it("recovery: exactly one marker per list", () => {
		const labels = getRecoveryItems(defaultsState()).map((i) => i.label);
		expect(marked(labels)).toEqual(["offer (current)"]);
		expect(getRecoveryItems(fullyConfiguredState()).map((i) => i.label)).toEqual([
			"offer",
			"off (current)",
		]);
	});

	it("sla enable: exactly one of Enabled/Disabled is marked", () => {
		expect(getSLAEnableItems(fullyConfiguredState()).map((i) => i.label)).toEqual([
			"Disabled",
			"Enabled (current)",
		]);
		expect(getSLAEnableItems(zeroUnlimitedState()).map((i) => i.label)).toEqual([
			"Disabled (current)",
			"Enabled",
		]);
	});

	it("never renders a second marker variant", () => {
		const allLabels = [
			...getThinkingSelectorItems(fullyConfiguredState()),
			...getApprovalModeItems(fullyConfiguredState()),
			...getCompletionNotifyItems(fullyConfiguredState()),
			...getRecoveryItems(fullyConfiguredState()),
			...getSLAEnableItems(fullyConfiguredState()),
			...getModelSelectorItems(availableModels, fullyConfiguredState()),
		].map((i) => i.label);
		for (const label of allLabels) {
			const occurrences = label.split("(current").length - 1;
			expect(occurrences).toBeLessThanOrEqual(1);
			if (occurrences === 1) expect(label).toMatch(/ \(current\)$/);
		}
	});
});

// ---------------------------------------------------------------------------
// 5. Six verb-led choice/config screen titles
// ---------------------------------------------------------------------------

describe("choice/config screen titles", () => {
	async function titleOf(
		run: (ctx: ExtensionContext, state: SessionState) => Promise<void>,
		state: SessionState,
	): Promise<string[]> {
		const ui = makeUi();
		await run(ui.ctx, state);
		return ui.screenLines;
	}

	it("Select Subagent Model", async () => {
		const lines = await titleOf(showModelSelector, fullyConfiguredState());
		expect(lines.some((line) => line.includes("Select Subagent Model"))).toBe(true);
	});

	it("Select Max Thinking Level", async () => {
		const lines = await titleOf(showThinkingSelector, fullyConfiguredState());
		expect(lines.some((line) => line.includes("Select Max Thinking Level"))).toBe(true);
	});

	it("Select Change Approval Mode", async () => {
		const lines = await titleOf(showApprovalModeSelector, fullyConfiguredState());
		expect(lines.some((line) => line.includes("Select Change Approval Mode"))).toBe(true);
	});

	it("Select Completion Notify Mode", async () => {
		const lines = await titleOf(showCompletionNotifySelector, fullyConfiguredState());
		expect(lines.some((line) => line.includes("Select Completion Notify Mode"))).toBe(true);
	});

	it("Select Recovery Posture", async () => {
		const lines = await titleOf(showRecoverySelector, fullyConfiguredState());
		expect(lines.some((line) => line.includes("Select Recovery Posture"))).toBe(true);
	});

	it("Configure SLA Tracking", async () => {
		const lines = await titleOf(showSLAConfig, fullyConfiguredState());
		expect(lines.some((line) => line.includes("Configure SLA Tracking"))).toBe(true);
	});

	it("renders the marker inside the screen body", async () => {
		const lines = await titleOf(showThinkingSelector, fullyConfiguredState());
		expect(lines.join("\n")).toContain("high (current)");
	});
});

// ---------------------------------------------------------------------------
// 6. Five input prompts — `… (<hints> · current: <token>)`
// ---------------------------------------------------------------------------

const PROMPT_SHAPE = /^.+ \(.+ · current: .+\):$/;

describe("input prompts — one separator, canonical current token", () => {
	it("concurrency prompt", async () => {
		const ui = makeUi();
		await showConcurrencyInput(ui.ctx, defaultsState(), noop);
		expect(ui.prompts[0]).toMatch(PROMPT_SHAPE);
		expect(ui.prompts[0]).toContain("current: Unlimited");

		const configured = makeUi();
		await showConcurrencyInput(configured.ctx, fullyConfiguredState(), noop);
		expect(configured.prompts[0]).toContain("current: 4");
	});

	it("recursion-depth prompt", async () => {
		const ui = makeUi();
		await showDepthInput(ui.ctx, defaultsState(), noop);
		expect(ui.prompts[0]).toMatch(PROMPT_SHAPE);
		expect(ui.prompts[0]).toContain("current: 3 levels");

		const zero = makeUi();
		await showDepthInput(zero.ctx, zeroUnlimitedState(), noop);
		expect(zero.prompts[0]).toContain("current: Off");
	});

	it("history-entries prompt", async () => {
		const ui = makeUi();
		await showHistoryEntriesInput(ui.ctx, defaultsState(), noop);
		expect(ui.prompts[0]).toMatch(PROMPT_SHAPE);
		expect(ui.prompts[0]).toContain("current: 500 entries");

		const zero = makeUi();
		await showHistoryEntriesInput(zero.ctx, zeroUnlimitedState(), noop);
		expect(zero.prompts[0]).toContain("current: Unlimited");
	});

	it("cost-limit prompt", async () => {
		const ui = makeUi();
		await showCostLimitInput(ui.ctx, fullyConfiguredState(), noop);
		expect(ui.prompts[0]).toMatch(PROMPT_SHAPE);
		expect(ui.prompts[0]).toContain("current: $2.50");

		const zero = makeUi();
		await showCostLimitInput(zero.ctx, zeroUnlimitedState(), noop);
		expect(zero.prompts[0]).toContain("current: Unlimited");
	});

	it("SLA window prompt keeps the raw number", async () => {
		const ui = makeUi({ select: "enabled" });
		await showSLAConfig(ui.ctx, fullyConfiguredState(), noop);
		expect(ui.prompts[0]).toMatch(PROMPT_SHAPE);
		expect(ui.prompts[0]).toContain("current: 100");
	});
});

// ---------------------------------------------------------------------------
// 7. Negative list — the legacy prose must never come back
// ---------------------------------------------------------------------------

describe("banned legacy phrases", () => {
	const banned = [
		"will use main agent",
		"no pruning",
		"passive delivery",
		"No delegation from subagents",
		"None saved",
	];

	/** Every in-scope surface string: config descriptions + the five prompts. */
	async function inScopeSurfaces(): Promise<Array<[string, string]>> {
		const surfaces: Array<[string, string]> = [];
		for (const [name, build] of [
			["defaults", defaultsState],
			["fully configured", fullyConfiguredState],
			["zero/unlimited", zeroUnlimitedState],
		] as Array<[string, () => SessionState]>) {
			for (const [value, description] of Object.entries(descriptions(build()))) {
				surfaces.push([`${name}/${value}`, description]);
			}
		}

		const runners: Array<[(ctx: ExtensionContext, s: SessionState) => Promise<void>, string]> = [
			[showConcurrencyInput, "concurrency"],
			[showDepthInput, "depth"],
			[showHistoryEntriesInput, "historyentries"],
			[showCostLimitInput, "costlimit"],
		];
		for (const [run, name] of runners) {
			for (const build of [defaultsState, fullyConfiguredState, zeroUnlimitedState]) {
				const ui = makeUi();
				await run(ui.ctx, build());
				surfaces.push([`prompt/${name}`, ui.prompts[0]]);
			}
		}

		const sla = makeUi({ select: "enabled" });
		await showSLAConfig(sla.ctx, defaultsState(), noop);
		surfaces.push(["prompt/slaWindow", sla.prompts[0]]);
		return surfaces;
	}

	it("contains no legacy phrase in any in-scope description or prompt", async () => {
		for (const [where, text] of await inScopeSurfaces()) {
			for (const phrase of banned) {
				expect(text.toLowerCase(), `${where}: banned phrase "${phrase}"`).not.toContain(
					phrase.toLowerCase(),
				);
			}
			// The canonical zero token is capitalised everywhere; lowercase
			// `unlimited` is the legacy spelling.
			expect(text, `${where}: lowercase "unlimited"`).not.toMatch(/unlimited/);
		}
	});

	it("never renders the legacy `(current - ceiling)` marker", async () => {
		for (const build of [defaultsState, fullyConfiguredState, zeroUnlimitedState]) {
			for (const item of getThinkingSelectorItems(build())) {
				expect(item.label).not.toContain("ceiling");
			}
		}
	});
});
