// Purpose: Pins the menu-polish U4 (umbrella #345) tier classifier — the A1 regression: a custom
// template written by our own `writeTemplateFile` ("My Checklist.md") must classify as custom, not
// `builtin`. Also pins the project-over-global precedence and the accepted residual (a builtin-NAME
// override stored under a non-canonical filename classifies by the surface fallback).
import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	classifyTier,
	findPresetSource,
	findTemplateSource,
	type Tier,
	type TierDir,
} from "../tui";
import { writePresetFile } from "../presets";
import { writeTemplateFile } from "../templates";
import type { SubagentPreset, TaskTemplate } from "../types";

// ---------------------------------------------------------------------------
// Temp-dir fixture — mirrors templates-files.test.ts. Each fixture owns one
// scratch root holding a fake project cwd and a fake HOME, so both the
// project-local and the user-global tier are hermetic (never the real HOME).
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-subagent-menu-tier-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface Fixture {
	/** Fake project cwd (project-local tier root). */
	cwd: string;
	/** Fake HOME (user-global tier root). */
	home: string;
	/** Ordered lookup as the finders build it: project first, then global. */
	dirs: TierDir[];
	/** The project-local templates dir (where writeTemplateFile lands). */
	projectTemplatesDir: string;
	/** The user-global templates dir. */
	globalTemplatesDir: string;
}

function makeFixture(): Fixture {
	const root = makeTempDir();
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const projectTemplatesDir = path.join(cwd, ".pi", "brl-subagent", "templates");
	const globalTemplatesDir = path.join(home, ".pi", "agent", "brl-subagent", "templates");
	return {
		cwd,
		home,
		dirs: [
			{ tier: "project", dir: projectTemplatesDir },
			{ tier: "global", dir: globalTemplatesDir },
		],
		projectTemplatesDir,
		globalTemplatesDir,
	};
}

/** Point HOME at the fixture's fake home for the duration of fn (restores after). */
function withHome<T>(home: string, fn: () => T): T {
	const savedHome = process.env.HOME;
	process.env.HOME = home;
	try {
		return fn();
	} finally {
		if (savedHome !== undefined) process.env.HOME = savedHome;
		else delete process.env.HOME;
	}
}

function template(name: string): TaskTemplate {
	return { name, task: `Do the thing for \${target}.` };
}

/** classifyTier against a fixture with real fs, builtin-tier terminal fallback. */
function classifyInFixture(fixture: Fixture, name: string, fallback: Tier = "builtin"): Tier {
	return classifyTier(name, fixture.dirs, { fallback, exists: fs.existsSync });
}

// ---------------------------------------------------------------------------
// The classifier cases
// ---------------------------------------------------------------------------

describe("classifyTier (menu U4 tier classifier)", () => {
	it("canonical filename → the tier owning the directory (project, then global)", () => {
		const fixture = makeFixture();
		writeTemplateFile(template("Canonical Template"), fixture.projectTemplatesDir);

		// The writer's own normalizer is the canonical filename convention.
		expect(fs.existsSync(path.join(fixture.projectTemplatesDir, "Canonical Template.md"))).toBe(
			true,
		);
		expect(classifyInFixture(fixture, "Canonical Template")).toBe("project");

		// Same name written only to the global tier resolves as global.
		const globalFixture = makeFixture();
		writeTemplateFile(template("Canonical Template"), globalFixture.globalTemplatesDir);
		expect(classifyInFixture(globalFixture, "Canonical Template")).toBe("global");
	});

	it("A1 pin — `My Checklist` written by writeTemplateFile → project, NOT builtin", () => {
		const fixture = makeFixture();
		// The real writer round-trip: this is the file our own manager produces.
		writeTemplateFile(template("My Checklist"), fixture.projectTemplatesDir);

		expect(fs.existsSync(path.join(fixture.projectTemplatesDir, "My Checklist.md"))).toBe(true);
		// The pre-U4 finders derived `my_checklist.md` from the display name and
		// missed the file, so the custom template rendered `[B]`.
		expect(fs.existsSync(path.join(fixture.projectTemplatesDir, "my_checklist.md"))).toBe(false);

		const tier = classifyInFixture(fixture, "My Checklist");
		expect(tier).toBe("project");
		expect(tier).not.toBe("builtin");
	});

	it("global-only file → global", () => {
		const fixture = makeFixture();
		writeTemplateFile(template("Global Only"), fixture.globalTemplatesDir);

		expect(fs.existsSync(path.join(fixture.globalTemplatesDir, "Global Only.md"))).toBe(true);
		expect(fs.existsSync(path.join(fixture.projectTemplatesDir, "Global Only.md"))).toBe(false);
		expect(classifyInFixture(fixture, "Global Only")).toBe("global");
	});

	it("no canonical file → the surface fallback (templates: builtin, presets: project)", () => {
		const fixture = makeFixture();
		// A shipped built-in name has no file on disk: the template fallback decides.
		expect(classifyInFixture(fixture, "Review Changes")).toBe("builtin");
		// Any name with no file follows the same path — the name itself is irrelevant.
		expect(classifyInFixture(fixture, "Unknown Name")).toBe("builtin");
		// The preset surface's fallback is `project`.
		expect(classifyInFixture(fixture, "Unknown Name", "project")).toBe("project");
	});

	it("priority — canonical file in BOTH tiers → project (project dirs are scanned first)", () => {
		const fixture = makeFixture();
		writeTemplateFile(template("Both Tiers"), fixture.projectTemplatesDir);
		writeTemplateFile(template("Both Tiers"), fixture.globalTemplatesDir);
		expect(fs.existsSync(path.join(fixture.projectTemplatesDir, "Both Tiers.md"))).toBe(true);
		expect(fs.existsSync(path.join(fixture.globalTemplatesDir, "Both Tiers.md"))).toBe(true);
		expect(classifyInFixture(fixture, "Both Tiers")).toBe("project");

		// Same precedence for the preset surface's dir list.
		const projectPresetsDir = path.join(fixture.cwd, ".pi", "brl-subagent", "presets");
		const globalPresetsDir = path.join(fixture.home, ".pi", "agent", "brl-subagent", "presets");
		for (const dir of [projectPresetsDir, globalPresetsDir]) {
			writePresetFile({ name: "Both Tiers", systemPrompt: "Be brief." }, dir);
		}
		expect(fs.existsSync(path.join(projectPresetsDir, "Both Tiers.md"))).toBe(true);
		expect(fs.existsSync(path.join(globalPresetsDir, "Both Tiers.md"))).toBe(true);
		expect(classifyInFixture(fixture, "Both Tiers", "project")).toBe("project");
	});

	it("documented residual — builtin NAME at a non-canonical filename → surface fallback", () => {
		const fixture = makeFixture();
		// A hand-written file that intentionally overrides the shipped
		// "Review Changes" template, stored under the OLD (pre-U4) filename
		// convention — no canonical path match, so the fallback decides.
		fs.mkdirSync(fixture.projectTemplatesDir, { recursive: true });
		fs.writeFileSync(
			path.join(fixture.projectTemplatesDir, "review_changes.md"),
			"---\nname: Review Changes\n---\nHand-written override.\n",
			"utf-8",
		);
		expect(fs.existsSync(path.join(fixture.projectTemplatesDir, "Review Changes.md"))).toBe(false);

		// Accepted this cycle (the additive `source` field would fix it): the
		// template fallback labels it builtin. Asserted so it stays a decision.
		expect(classifyInFixture(fixture, "Review Changes")).toBe("builtin");
	});
});

// ---------------------------------------------------------------------------
// Finder wiring — the managers call these; A1 lived in this wiring, so the
// project/global dirs they pass to classifyTier are pinned here too.
// ---------------------------------------------------------------------------

describe("tier finders (manager wiring)", () => {
	const ctxFor = (cwd: string) => ({ cwd }) as ExtensionContext;

	it("findTemplateSource resolves the writeTemplateFile round-trip as project", () => {
		const fixture = makeFixture();
		writeTemplateFile(template("My Checklist"), fixture.projectTemplatesDir);

		expect(
			withHome(fixture.home, () => findTemplateSource("My Checklist", ctxFor(fixture.cwd))),
		).toBe("project");
	});

	it("findTemplateSource resolves a global-only template as global, and a shipped name as builtin", () => {
		const fixture = makeFixture();
		writeTemplateFile(template("Global Only"), fixture.globalTemplatesDir);

		withHome(fixture.home, () => {
			expect(findTemplateSource("Global Only", ctxFor(fixture.cwd))).toBe("global");
			// No file on disk → the template surface fallback.
			expect(findTemplateSource("Review Changes", ctxFor(fixture.cwd))).toBe("builtin");
		});
	});

	it("findPresetSource resolves a written preset as project, and keeps the project label for builtin names", () => {
		const fixture = makeFixture();
		const projectPresetsDir = path.join(fixture.cwd, ".pi", "brl-subagent", "presets");
		writePresetFile(
			{ name: "My Preset", systemPrompt: "Be brief." } satisfies SubagentPreset,
			projectPresetsDir,
		);

		withHome(fixture.home, () => {
			expect(findPresetSource("My Preset", ctxFor(fixture.cwd))).toBe("project");
			// Pre-U4 behavior preserved: a custom preset that shadows a builtin
			// name still renders as project (the preset fallback is `project`;
			// the manager has no [B] slot here).
			expect(findPresetSource("code-reviewer", ctxFor(fixture.cwd))).toBe("project");
		});
	});
});
