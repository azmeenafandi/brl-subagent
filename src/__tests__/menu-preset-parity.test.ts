// Purpose: Pins the menu-polish U6 (umbrella #345) contract — the Presets manager adopts the
// Templates manager's explicit empty state, its divider comes from the shared `menuSection`
// factory (`__divider__:<slug>`) and selecting it is a no-op RE-RENDER (never a close), the preset
// detail carries the same `(built-in)`/`(project)`/`(global)` title suffix as the template detail,
// and both detail views share ONE unset-field policy (`Inherit:` — a real default — always renders;
// every other optional field is omitted when unset).
import { describe, expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SessionState } from "../state";
import {
	detailFieldLines,
	showPresetManager,
	showTemplateManager,
	showViewPreset,
	showViewTemplate,
	tierDetailSuffix,
} from "../tui";
import { menuSection } from "../tui-format";
import { writePresetFile } from "../presets";
import { writeTemplateFile } from "../templates";
import type { SubagentPreset, TaskTemplate } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** The divider value the presets manager must feed into the list (factory shape, not a literal). */
const DIVIDER_VALUE = "__divider__:custom-presets";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A scratch root holding a fake project cwd and a fake HOME (both tiers hermetic). */
function makeRoot(): { cwd: string; home: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "brl-subagent-menu-u6-"));
	tempDirs.push(root);
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	return { cwd, home };
}

function projectPresetsDir(cwd: string): string {
	return path.join(cwd, ".pi", "brl-subagent", "presets");
}

function globalPresetsDir(home: string): string {
	return path.join(home, ".pi", "agent", "brl-subagent", "presets");
}

function projectTemplatesDir(cwd: string): string {
	return path.join(cwd, ".pi", "brl-subagent", "templates");
}

function globalTemplatesDir(home: string): string {
	return path.join(home, ".pi", "agent", "brl-subagent", "templates");
}

function preset(name: string, extra: Partial<SubagentPreset> = {}): SubagentPreset {
	return { name, ...extra };
}

function template(name: string, extra: Partial<TaskTemplate> = {}): TaskTemplate {
	return { name, task: `do ${name}`, ...extra };
}

/** A custom preset that owns its canonical file in the given tier dir. */
function writeCustomPreset(dir: string, name: string, extra: Partial<SubagentPreset> = {}): void {
	writePresetFile(preset(name, extra), dir);
}

/** A custom template that owns its canonical file in the given tier dir. */
function writeCustomTemplate(dir: string, name: string, extra: Partial<TaskTemplate> = {}): void {
	writeTemplateFile(template(name, extra), dir);
}

/**
 * Mock `ctx.ui` in the U2/U5 shape: each `custom` call renders the component
 * headlessly (120 cols) and then resolves with the next scripted selection.
 */
function makeCtx(
	cwd: string,
	onScreen: (lines: string[]) => void,
	selections: Array<string | null> = [],
): { ctx: ExtensionContext; notify: ReturnType<typeof vi.fn>; custom: ReturnType<typeof vi.fn> } {
	const notify = vi.fn();
	const custom = vi.fn(
		(factory: (...args: unknown[]) => { render: (w: number) => string[] }) => {
			const component = factory({ requestRender: () => {} }, THEME, {}, () => {});
			onScreen(component.render(120));
			return Promise.resolve(selections.shift() ?? null);
		},
	);
	const ctx = {
		ui: {
			theme: THEME,
			notify,
			setStatus: vi.fn(),
			input: vi.fn(async () => null),
			custom,
		},
		modelRegistry: { getAvailable: async () => [] },
		cwd,
	} as unknown as ExtensionContext;
	return { ctx, notify, custom };
}

/** Render one detail view (or any surface) headlessly and return its screen. */
async function renderScreen(
	cwd: string,
	run: (ctx: ExtensionContext) => Promise<void>,
	selections: Array<string | null> = [],
): Promise<string[]> {
	const screens: string[][] = [];
	const { ctx } = makeCtx(cwd, (lines) => screens.push(lines), selections);
	await run(ctx);
	return screens[0] ?? [];
}

/** Render every screen a surface produced (for multi-step flows). */
async function renderScreens(
	cwd: string,
	run: (ctx: ExtensionContext) => Promise<void>,
	selections: Array<string | null> = [],
): Promise<string[][]> {
	const screens: string[][] = [];
	const { ctx } = makeCtx(cwd, (lines) => screens.push(lines), selections);
	await run(ctx);
	return screens;
}

function screen(lines: string[]): string {
	return lines.join("\n");
}

/** The rendered line carrying `needle`, trimmed of the Text padding ("" when absent). */
function titleLine(rendered: string, needle: string): string {
	return rendered
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.includes(needle)) ?? "";
}

// ---------------------------------------------------------------------------
// 1. Empty state (mirrors the Templates manager)
// ---------------------------------------------------------------------------

describe("Presets manager empty state", () => {
	it("notifies instead of opening an empty list", async () => {
		const { ctx, notify, custom } = makeCtx("/tmp/project", () => {});

		await showPresetManager(ctx, new SessionState());

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("No presets loaded"),
			"info",
		);
		expect(custom).not.toHaveBeenCalled();
	});

	it("uses the same notify shape as the Templates manager", async () => {
		const { ctx, notify } = makeCtx("/tmp/project", () => {});
		await showTemplateManager(ctx, new SessionState());
		const templateMessage = notify.mock.calls[0][0] as string;

		const presets = makeCtx("/tmp/project", () => {});
		await showPresetManager(presets.ctx, new SessionState());
		const presetMessage = presets.notify.mock.calls[0][0] as string;

		// Same shape: `No <thing> loaded — ... present. Add custom .md files in
		// ~/.pi/agent/brl-subagent/<kind>/ or <project>/.pi/brl-subagent/<kind>/.`
		for (const message of [templateMessage, presetMessage]) {
			expect(message).toMatch(/^No .+ loaded — built-in .+ should always be present\./);
			expect(message).toContain("~/.pi/agent/brl-subagent/");
			expect(message).toContain("<project>/.pi/brl-subagent/");
		}
		expect(presets.notify.mock.calls[0][1]).toBe("info");
	});

	it("keeps the empty-state copy byte-identical (no drift)", async () => {
		// Templates: the exact string shipped by U5 (`git show HEAD~1:src/tui.ts`).
		// Presets: the empty state is NEW in U6, so there is no parent-commit preset
		// string; its canonical copy is pinned here from the same template shape.
		const EXPECTED_TEMPLATES =
			"No task templates loaded — built-in templates ship with the extension and " +
			"should always be present. Add custom .md files in " +
			"~/.pi/agent/brl-subagent/templates/ or <project>/.pi/brl-subagent/templates/.";
		const EXPECTED_PRESETS =
			"No presets loaded — built-in presets ship with the extension and " +
			"should always be present. Add custom .md files in " +
			"~/.pi/agent/brl-subagent/presets/ or <project>/.pi/brl-subagent/presets/.";

		const templates = makeCtx("/tmp/project", () => {});
		await showTemplateManager(templates.ctx, new SessionState());
		expect(templates.notify.mock.calls[0][0]).toBe(EXPECTED_TEMPLATES);

		const presets = makeCtx("/tmp/project", () => {});
		await showPresetManager(presets.ctx, new SessionState());
		expect(presets.notify.mock.calls[0][0]).toBe(EXPECTED_PRESETS);
	});
});

// ---------------------------------------------------------------------------
// 2. Divider: shared factory shape + no-op re-render
// ---------------------------------------------------------------------------

describe("Presets manager divider", () => {
	/** A state with one built-in and one project-local custom preset. */
	function presetState(cwd: string): SessionState {
		writeCustomPreset(projectPresetsDir(cwd), "House Style", { thinkingLevel: "low" });
		const state = new SessionState();
		state.builtinPresets = [preset("Reviewer", { thinkingLevel: "high" })];
		state.customPresets = [preset("House Style", { thinkingLevel: "low" })];
		return state;
	}

	it("renders the shared `menuSection` row (value prefix + exact label)", async () => {
		const { cwd } = makeRoot();
		const screens = await renderScreens(cwd, (ctx) =>
			showPresetManager(ctx, presetState(cwd)),
		);

		const [first] = screens;
		const text = screen(first);
		expect(text).toContain("\u2500\u2500\u2500 Custom Presets \u2500\u2500\u2500");
		// The exact factory shape the Templates manager (and U1) uses — the row is
		// `menuSection("Custom Presets")`, not a hand-written literal.
		expect(menuSection("Custom Presets").value).toBe(DIVIDER_VALUE);
		expect(menuSection("Custom Presets").label).toBe("\u2500\u2500\u2500 Custom Presets \u2500\u2500\u2500");
		expect(menuSection("Custom Presets").description).toBe("");
	});

	it("treats EVERY divider value as a re-render (no close-on-select literal left)", async () => {
		const { cwd } = makeRoot();
		// The pre-U6 literal is still a `__divider__` value: it must re-render too,
		// which is only possible if the close-on-select shortcut is gone.
		for (const divider of [DIVIDER_VALUE, "__divider__", "__divider__:anything"]) {
			const screens = await renderScreens(
				cwd,
				(ctx) => showPresetManager(ctx, presetState(cwd)),
				[divider, null],
			);
			expect(screens).toHaveLength(2);
			expect(screen(screens[1])).toContain("Presets (1 built-in, 1 custom)");
		}
	});

	it("re-renders on a divider selection instead of closing the manager", async () => {
		const { cwd } = makeRoot();
		// divider → a real row → cancel.
		const screens = await renderScreens(
			cwd,
			(ctx) => showPresetManager(ctx, presetState(cwd)),
			["__divider__:custom-presets", "__builtin__:Reviewer", null],
		);

		// Three screens: LIST, LIST (the divider re-rendered it), preset DETAIL.
		// A close-on-select divider would have stopped after the first one.
		expect(screens).toHaveLength(3);
		expect(screen(screens[1])).toContain("Presets (1 built-in, 1 custom)");
		expect(screen(screens[2])).toContain("Preset: Reviewer");
	});

	it("still exits on cancel and never opens a detail", async () => {
		const { cwd } = makeRoot();
		const screens = await renderScreens(cwd, (ctx) =>
			showPresetManager(ctx, presetState(cwd)),
		);

		expect(screens).toHaveLength(1);
		expect(screen(screens[0])).toContain("Presets (1 built-in, 1 custom)");
	});

	it("omits the divider when there are no custom presets", async () => {
		const state = new SessionState();
		state.builtinPresets = [preset("Reviewer")];
		const screens = await renderScreens("/tmp/project", (ctx) =>
			showPresetManager(ctx, state),
		);
		expect(screen(screens[0])).not.toContain("Custom Presets");
	});

	it("opens the custom row's detail (tier prefix stripped from the value)", async () => {
		const { cwd } = makeRoot();
		const screens = await renderScreens(
			cwd,
			(ctx) => showPresetManager(ctx, presetState(cwd)),
			["__custom__:House Style"],
		);
		expect(screens).toHaveLength(2);
		expect(screen(screens[1])).toContain("Preset: House Style");
		expect(screen(screens[1])).toContain("(project)");
	});
});

// ---------------------------------------------------------------------------
// 3. Tier suffix vocabulary on BOTH detail titles
// ---------------------------------------------------------------------------

describe("detail title tier suffix vocabulary", () => {
	it("maps all three tiers to one vocabulary", () => {
		expect(tierDetailSuffix("builtin")).toBe(" (built-in)");
		expect(tierDetailSuffix("project")).toBe(" (project)");
		expect(tierDetailSuffix("global")).toBe(" (global)");
	});

	/** Render both detail views for the same tier and return their titles. */
	async function titlesFor(
		tier: "builtin" | "project" | "global",
	): Promise<{ presetTitle: string; templateTitle: string }> {
		const { cwd, home } = makeRoot();
		const savedHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const state = new SessionState();
			const customPresets: SubagentPreset[] = [];
			const templates: TaskTemplate[] = [];

			if (tier === "builtin") {
				state.builtinPresets = [preset("Reviewer")];
				state.builtinTemplates = [template("Review")];
				templates.push(template("Review"));
			} else {
				const presetDir = tier === "project" ? projectPresetsDir(cwd) : globalPresetsDir(home);
				const templateDir = tier === "project" ? projectTemplatesDir(cwd) : globalTemplatesDir(home);
				writeCustomPreset(presetDir, "Reviewer");
				writeCustomTemplate(templateDir, "Review");
				customPresets.push(preset("Reviewer"));
				templates.push(template("Review"));
			}
			state.customPresets = customPresets;
			state.config.templates = templates;

			const presetScreen = screen(
				await renderScreen(cwd, (ctx) => showViewPreset(ctx, state, "Reviewer")),
			);
			const templateScreen = screen(
				await renderScreen(cwd, (ctx) => showViewTemplate(ctx, state, "Review")),
			);
			const presetTitle = titleLine(presetScreen, "Preset: Reviewer");
			const templateTitle = titleLine(templateScreen, "Template: Review");
			return { presetTitle, templateTitle };
		} finally {
			process.env.HOME = savedHome;
		}
	}

	const tierCases: Array<["builtin" | "project" | "global", string]> = [
		["builtin", " (built-in)"],
		["project", " (project)"],
		["global", " (global)"],
	];

	for (const [tier, suffix] of tierCases) {
		it(`suffixes both titles with ${JSON.stringify(suffix)} for the ${tier} tier`, async () => {
			const { presetTitle, templateTitle } = await titlesFor(tier);
			expect(presetTitle).toBe(`Preset: Reviewer${suffix}`);
			expect(templateTitle).toBe(`Template: Review${suffix}`);
		});
	}
});

// ---------------------------------------------------------------------------
// 4. The one unset-field policy, applied by both renderers
// ---------------------------------------------------------------------------

describe("detailFieldLines — the shared unset-field policy", () => {
	it("omits unset (undefined) and empty values, keeping declaration order", () => {
		expect(
			detailFieldLines(THEME, [
				{ label: "Thinking", value: undefined },
				{ label: "Inherit", value: "yes (default)" },
				{ label: "Tools", value: "" },
				{ label: "Exclude", value: "bash" },
			]),
		).toEqual(["Inherit: yes (default)", "Exclude: bash"]);
	});

	it("renders `Label: value` with a single space and no placeholder", () => {
		expect(detailFieldLines(THEME, [{ label: "Timeout", value: "30ms" }])).toEqual([
			"Timeout: 30ms",
		]);
	});
});

describe("unset-field policy table — both detail views", () => {
	it("omits every unset optional field in BOTH views (and keeps Inherit:)", async () => {
		const { cwd, home } = makeRoot();
		const savedHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const state = new SessionState();
			state.builtinPresets = [preset("Bare Preset")];
			state.config.templates = [template("Bare Template")];

			const presetText = screen(
				await renderScreen(cwd, (ctx) => showViewPreset(ctx, state, "Bare Preset")),
			);
			const templateText = screen(
				await renderScreen(cwd, (ctx) => showViewTemplate(ctx, state, "Bare Template")),
			);

			// Preset: only the real default survives.
			expect(presetText).toContain("Inherit: yes (default)");
			for (const label of ["Thinking:", "Tools:", "Exclude:", "System prompt:", "(not set)"]) {
				expect(presetText).not.toContain(label);
			}

			// Template: only the mandatory lead row survives.
			expect(templateText).toContain("Task: do Bare Template");
			for (const label of ["Parameters:", "Preset:", "Thinking:", "Output file:", "Timeout:"]) {
				expect(templateText).not.toContain(label);
			}
		} finally {
			process.env.HOME = savedHome;
		}
	});

	it("renders every SET field in BOTH views with the same label grammar", async () => {
		const { cwd, home } = makeRoot();
		const savedHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const state = new SessionState();
			state.builtinPresets = [
				preset("Full Preset", {
					thinkingLevel: "high",
					tools: ["read", "grep"],
					excludeTools: ["bash"],
					systemPrompt: "x".repeat(150),
				}),
			];
			state.config.templates = [
				template("Full Template", {
					task: "Review ${file}",
					preset: "code-review",
					thinkingLevel: "low",
					outputFile: "docs/${section}.md",
					timeout: 30000,
				}),
			];

			const presetText = screen(
				await renderScreen(cwd, (ctx) => showViewPreset(ctx, state, "Full Preset")),
			);
			const templateText = screen(
				await renderScreen(cwd, (ctx) => showViewTemplate(ctx, state, "Full Template")),
			);

			expect(presetText).toContain("Thinking: high");
			expect(presetText).toContain("Inherit: yes (default)");
			expect(presetText).toContain("Tools: read, grep");
			expect(presetText).toContain("Exclude: bash");
			expect(presetText).toContain(`System prompt: ${"x".repeat(100)}`);

			expect(templateText).toContain("Task: Review ${file}");
			expect(templateText).toContain("Parameters: file, section");
			expect(templateText).toContain("Preset: code-review");
			expect(templateText).toContain("Thinking: low");
			expect(templateText).toContain("Output file: docs/${section}.md");
			expect(templateText).toContain("Timeout: 30000ms");
		} finally {
			process.env.HOME = savedHome;
		}
	});

	it("honours Inherit: no when the preset disables inheritance", async () => {
		const state = new SessionState();
		state.builtinPresets = [preset("No Inherit", { inheritSystemPrompt: false })];
		const text = screen(await renderScreen("/tmp/project", (ctx) =>
			showViewPreset(ctx, state, "No Inherit"),
		));
		expect(text).toContain("Inherit: no");
	});

	it("keeps the shared footer in both views", async () => {
		const state = new SessionState();
		state.builtinPresets = [preset("Reviewer")];
		state.config.templates = [template("Review")];
		const presetText = screen(await renderScreen("/tmp/project", (ctx) =>
			showViewPreset(ctx, state, "Reviewer"),
		));
		const templateText = screen(await renderScreen("/tmp/project", (ctx) =>
			showViewTemplate(ctx, state, "Review"),
		));
		expect(presetText).toContain("Press any key to close");
		expect(templateText).toContain("Press any key to close");
	});
});
