/**
 * Issue #421 — the engineering bar is INJECTED at the spawn seam, never selected.
 *
 * The bar lived in the repo-local `project-implementer`/`project-reviewer`
 * presets, so four dispatches (#411, #412, #415, #419) ran on the shipped
 * `dev-agent` preset and silently lost it. The fix is structural: one builder
 * (`src/engineering-bar.ts`) is called at BOTH spawn seams — the background
 * `appendSystemPrompt` array and the foreground `--append-system-prompt` file —
 * gated by the project's `processChecks` flag (ADR 0019).
 *
 * The pins here are the acceptance criteria, in both directions:
 *
 *   (a) enabled + reference present  → the child's system prompt carries the
 *       `<engineering-bar>` section and the file's text (both paths);
 *   (b) disabled                     → no section AND no read of the file;
 *   (c) missing reference            → no section, one warning, no throw;
 *   (d) the reference itself         → still tracked and still carries the three
 *       required sections (a deletion cannot be silent);
 *   (e) the packed tarball           → carries neither the file nor the bar's
 *       text (`.pi/**` is outside package.json.files).
 *
 * `node:fs` is the shared transparent double (`./fixtures/fs-mock`), extended
 * with a read log: "the file was never read" is otherwise unobservable.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fsMockControl, resetFsMock } from "./fixtures/fs-mock";
import { createTempEnv } from "./fixtures/temp-lifecycle";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const { buildFsMock } = await import("./fixtures/fs-mock");
	return buildFsMock(actual);
});

const mocks = vi.hoisted(() => ({
	createAgentSession: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: mocks.spawn };
});

const reloadImpl = vi.hoisted(() => ({ reload: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@earendil-works/pi-coding-agent", () => {
	class MockDefaultResourceLoader {
		options: Record<string, unknown>;
		reload = reloadImpl.reload;
		constructor(options: Record<string, unknown>) {
			this.options = options;
		}
	}
	return {
		getAgentDir: () => "/tmp/brl-test-agentdir",
		createAgentSession: mocks.createAgentSession,
		SessionManager: { create: () => ({ getSessionFile: () => undefined }) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: MockDefaultResourceLoader,
		// runner.ts writes its temp system-prompt file through the SDK's queue.
		withFileMutationQueue: async (_path: string, fn: () => Promise<void>) => fn(),
	};
});

import { buildEngineeringBarSection, ENGINEERING_BAR_PATH } from "../engineering-bar";
import { runSubagent } from "../runner";
import { spawnBackgroundSession } from "../session-manager";
import type { Logger } from "../logging";

const REPO_ROOT = join(__dirname, "..", "..");
const TRACKED_BAR = join(REPO_ROOT, ENGINEERING_BAR_PATH);

/** The repo's OWN process flag is on (package.json), so the real path is testable. */
const BAR_MARKER = "BAR-MARKER-421";
const PLANTED_BAR = `# Engineering bar\n\n${BAR_MARKER} — implementation bar, review addendum, checklist.\n`;

const fakePi = { appendEntry: vi.fn() };
const fakeCtx = {
	cwd: "/tmp/brl-test-cwd",
	modelRegistry: { find: vi.fn().mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5" }) },
};

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

const env = createTempEnv("brl-engineering-bar-test");

/** A throwaway project: `processChecks` per the caller, with a planted bar file. */
function tempProject(processChecks: boolean, barBody: string | null): string {
	const cwd = env.testCwd;
	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify({ name: "bar-fixture", "brl-subagent": { processChecks } }),
		"utf8",
	);
	const barFile = join(cwd, ENGINEERING_BAR_PATH);
	if (barBody !== null) {
		mkdirSync(join(barFile, ".."), { recursive: true });
		writeFileSync(barFile, barBody, "utf8");
	}
	return cwd;
}

/** The `appendSystemPrompt` array the background seam handed to the SDK. */
async function spawnBackground(cwd: string, extra: Record<string, unknown> = {}): Promise<string[] | undefined> {
	await spawnBackgroundSession(fakePi as never, fakeCtx as never, {
		task: "do the thing",
		cwd,
		...extra,
	});
	const options = mocks.createAgentSession.mock.calls.at(-1)?.[0] as
		| { resourceLoader: { options: { appendSystemPrompt?: string[] } } }
		| undefined;
	return options?.resourceLoader.options.appendSystemPrompt;
}

/** Foreground: the content of the `--append-system-prompt` file, captured before it is cleaned up. */
let capturedPrompt: string | undefined;

function fakeProc() {
	const proc = {
		stdout: { on: vi.fn() },
		stderr: { on: vi.fn() },
		on: vi.fn((event: string, cb: (code?: number) => void) => {
			if (event === "close") cb(0);
			return proc;
		}),
		kill: vi.fn(),
	};
	return proc as never;
}

async function runForeground(cwd: string, systemPrompt: string): Promise<void> {
	await runSubagent(
		cwd,
		systemPrompt,
		{ provider: "test", id: "model" },
		"medium",
		"Review the auth flow",
		undefined,
		undefined,
		undefined,
		undefined,
		() => "",
	);
}

/** The engineering-bar reads the double actually served. */
function barReads(): string[] {
	return fsMockControl.readPaths.filter((p) => p.endsWith(ENGINEERING_BAR_PATH));
}

beforeEach(() => {
	env.setUp();
	resetFsMock();
	capturedPrompt = undefined;
	fakePi.appendEntry.mockClear();
	mocks.createAgentSession.mockReset();
	mocks.createAgentSession.mockImplementation(async () => ({ session: { sessionId: "s", setSessionName: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined), steer: vi.fn() } }));
	reloadImpl.reload.mockReset();
	reloadImpl.reload.mockResolvedValue(undefined);
	mocks.spawn.mockReset();
	mocks.spawn.mockImplementation((_command: string, args: string[]) => {
		const idx = args.indexOf("--append-system-prompt");
		capturedPrompt = idx >= 0 ? readFileSync(args[idx + 1], "utf8") : undefined;
		return fakeProc();
	});
});

afterAll(async () => {
	await env.tearDown();
});

// ---------------------------------------------------------------------------
// (a) enabled + reference present → the section reaches the child
// ---------------------------------------------------------------------------

describe("(a) enabled: the bar reaches the child's system prompt", () => {
	it("background: appends <engineering-bar> with the file's text, AFTER <resume-context>", async () => {
		const cwd = tempProject(true, PLANTED_BAR);

		const sections = await spawnBackground(cwd, {
			systemPrompt: "## Preset Guidance\n\nFor security audits.",
			resumeContext: "[attempt 2 — continue from what exists.]",
		});

		expect(sections).toHaveLength(3);
		// Ordering: system-prompt, then the retry preamble, then the bar — the bar
		// is process context, never adjacent to the task fence.
		expect(sections?.[0]).toContain("<system-prompt>");
		expect(sections?.[1]).toContain("<resume-context>");
		expect(sections?.[2]).toBe(`\n<engineering-bar>\n${PLANTED_BAR.trim()}\n</engineering-bar>\n`);
		expect(sections?.[2]).toContain(BAR_MARKER);
	});

	it("background: a dispatch with NO systemPrompt still gets the bar (that is the point)", async () => {
		const cwd = tempProject(true, PLANTED_BAR);

		const sections = await spawnBackground(cwd);

		expect(sections).toHaveLength(1);
		expect(sections?.[0]).toContain(`<engineering-bar>`);
		expect(sections?.[0]).toContain(BAR_MARKER);
	});

	it("foreground: the --append-system-prompt file carries the section and the file's text", async () => {
		const cwd = tempProject(true, PLANTED_BAR);

		await runForeground(cwd, "SYSTEM PROMPT CONTENT");

		expect(capturedPrompt).toBeDefined();
		expect(capturedPrompt).toContain("SYSTEM PROMPT CONTENT");
		expect(capturedPrompt).toContain("\n<engineering-bar>\n");
		expect(capturedPrompt).toContain("</engineering-bar>");
		expect(capturedPrompt).toContain(BAR_MARKER);
	});

	it("foreground: a dispatch with an EMPTY systemPrompt still gets the bar", async () => {
		const cwd = tempProject(true, PLANTED_BAR);

		await runForeground(cwd, "");

		expect(capturedPrompt).toContain(`<engineering-bar>`);
		expect(capturedPrompt).toContain(BAR_MARKER);
	});

	it("reads the TRACKED reference at the real path in this repo (the constant is not decorative)", () => {
		const log = fakeLogger();
		const section = buildEngineeringBarSection(REPO_ROOT, log);

		expect(log.warn).not.toHaveBeenCalled();
		expect(section).toContain("## Implementation bar");
		expect(section).toContain("## Review addendum");
		expect(section).toContain("## Design assumptions checklist");
		// Exactly the tracked file's body, framed.
		expect(section).toBe(`\n<engineering-bar>\n${readFileSync(TRACKED_BAR, "utf8").trim()}\n</engineering-bar>\n`);
	});
});

// ---------------------------------------------------------------------------
// (b) disabled → no section AND no read
// ---------------------------------------------------------------------------

describe("(b) disabled (a user's project): neither the section nor the read happens", () => {
	it("background: no <engineering-bar> section and the reference is never read", async () => {
		const cwd = tempProject(false, PLANTED_BAR);
		resetFsMock();

		const sections = await spawnBackground(cwd, { systemPrompt: "SYSTEM" });

		expect(sections).toEqual(["\n<system-prompt>\nSYSTEM\n</system-prompt>\n"]);
		expect(barReads()).toEqual([]);
	});

	it("foreground: the child's prompt file holds the caller's prompt only", async () => {
		const cwd = tempProject(false, PLANTED_BAR);
		resetFsMock();

		await runForeground(cwd, "SYSTEM PROMPT CONTENT");

		expect(capturedPrompt).toBe("SYSTEM PROMPT CONTENT");
		expect(barReads()).toEqual([]);
	});

	it("a project with NO manifest reads as disabled — no section, no read, no spawn failure", async () => {
		const cwd = env.testCwd; // no package.json written
		resetFsMock();

		const log = fakeLogger();
		expect(buildEngineeringBarSection(cwd, log)).toBeNull();
		expect(log.warn).not.toHaveBeenCalled();
		expect(barReads()).toEqual([]);
	});

	it("no cwd at all is disabled (fail-open), not a throw", () => {
		const log = fakeLogger();
		expect(buildEngineeringBarSection(undefined, log)).toBeNull();
		expect(log.warn).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// (c) missing / empty reference → one warning, never a throw
// ---------------------------------------------------------------------------

describe("(c) the reference is missing or empty: one warning, no section, no throw", () => {
	it("a missing reference logs exactly one warning naming the path", () => {
		const cwd = tempProject(true, null);
		const log = fakeLogger();

		expect(buildEngineeringBarSection(cwd, log)).toBeNull();

		expect(log.warn).toHaveBeenCalledTimes(1);
		const [message, data] = log.warn.mock.calls[0] as [string, Record<string, unknown>];
		expect(message).toContain("engineering bar");
		expect(message).toContain("unreadable");
		expect(String(data.path)).toContain("engineering-bar.md");
	});

	it("an EMPTY reference is the same failure mode (never a silently unenforced bar)", () => {
		const cwd = tempProject(true, "   \n\t\n");
		const log = fakeLogger();

		expect(buildEngineeringBarSection(cwd, log)).toBeNull();
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect((log.warn.mock.calls[0] as [string])[0]).toContain("empty");
	});

	it("a spawn with a missing reference still runs: no section, no throw", async () => {
		const cwd = tempProject(true, null);

		const sections = await spawnBackground(cwd, { systemPrompt: "SYSTEM" });

		expect(sections).toEqual(["\n<system-prompt>\nSYSTEM\n</system-prompt>\n"]);
	});
});

// ---------------------------------------------------------------------------
// (d) the reference file itself — deletion cannot be silent
// ---------------------------------------------------------------------------

describe("(d) the tracked reference still carries the three required sections", () => {
	it("is tracked by git (a disk-only file would pass locally and vanish in CI)", () => {
		const tracked = execFileSync("git", ["ls-files", "--error-unmatch", ENGINEERING_BAR_PATH], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		expect(tracked.trim()).toBe(ENGINEERING_BAR_PATH);
	});

	it("carries the implementation bar, the review addendum and the checklist", () => {
		const text = readFileSync(TRACKED_BAR, "utf8");

		expect(text).toContain("## Implementation bar");
		expect(text).toContain("## Review addendum");
		expect(text).toContain("## Design assumptions checklist");

		// The load-bearing clauses, not just the headings: Liskov is named, the
		// DRY threshold is the two-occurrence one, flag-never-fix survives, the
		// review addendum keeps Gate A + the counter + structural closure, and the
		// checklist still says where its answers go.
		expect(text).toContain("Liskov");
		expect(text).toContain("two occurrences is the threshold, not one");
		expect(text).toContain("flag it in your report");
		expect(text).toContain("Gate A");
		expect(text).toContain("SOLID/DRY violations flagged:");
		expect(text).toContain("Structural closure:");
		expect(text).toContain("Paste the answers into the PR description");
	});

	it("is role-aware (it reaches every dispatch, not just implementation runs)", () => {
		const text = readFileSync(TRACKED_BAR, "utf8");
		expect(text).toContain("When implementing");
		expect(text).toContain("When reviewing");
	});
});

// ---------------------------------------------------------------------------
// (e) the packed tarball — `.pi/**` never ships
// ---------------------------------------------------------------------------

describe("(e) the packed tarball carries neither the file nor the bar's text", () => {
	interface PackFile {
		path: string;
	}
	interface PackReport {
		files: PackFile[];
	}

	/** `npm pack --dry-run --json` — the real file set npm would publish. */
	const report: PackReport = JSON.parse(
		execFileSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}),
	)[0];

	it("no packed path is the reference or anything under .pi/", () => {
		const paths = report.files.map((f) => f.path);
		expect(paths.length).toBeGreaterThan(20); // guard the guard: a real listing
		expect(paths).not.toContain(ENGINEERING_BAR_PATH);
		expect(paths.filter((p) => p.startsWith(".pi/") || p.includes(`${sep}.pi${sep}`))).toEqual([]);
	});

	it("no packed file contains the bar's text", () => {
		// A phrase unique to the reference body (absent from src/presets/templates/
		// README/AGENT.md before #421). If the bar ever ships by another route, this
		// fails even though the path check above passed.
		const PHRASE = "two occurrences is the threshold, not one";
		const carriers = report.files
			.map((f) => f.path)
			.filter((p) => !p.endsWith(".tgz"))
			.filter((p) => {
				try {
					return readFileSync(join(REPO_ROOT, p), "utf8").includes(PHRASE);
				} catch {
					return false;
				}
			});
		expect(carriers).toEqual([]);
	});
});
