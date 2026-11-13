/**
 * Tests for preflight.ts — pre-flight environment checks (R3, and U4 of #511).
 *
 * THE THIRD CHECK IS A SCRATCH-ROOT PROBE (issue #511, U4). It used to write a
 * file into `os.tmpdir()`; it now resolves the shipped scratch root (U1) and
 * probes where that root lives — inside the root when it exists, otherwise in
 * its nearest existing ancestor, which is where the root would be created.
 *
 * Every case here injects `{ root: { home } }` (the seam added for exactly
 * this), so no test reads or writes the developer's real cache root. Fixtures
 * live under the repository's gitignored `.tmp/` chain, never under `/tmp`:
 * `/tmp` is `1777`, and the resolver refuses an ancestor-writable parent.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock runner.getPiInvocation so tests don't depend on the actual
// pi binary being on PATH or the caller's argv.
const mockGetPiInvocation = vi.fn();

vi.mock("../runner", () => ({
	getPiInvocation: mockGetPiInvocation,
}));

// Import after mocks are set up
const { preflightCheck } = await import("../preflight");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const realCwd = process.cwd();
const nonExistentDir = join(process.cwd(), ".tmp", "__brl_pcheck_nonexistent__");
const notADir = "/dev/null";

/** Everything this file creates, removed after each case. */
const created: string[] = [];

/** A throwaway `$HOME` per test, mode 0700, inside the safe `.tmp` chain. */
function makeHome(): string {
	const work = mkdtempSync(join(process.cwd(), ".tmp", "preflight-"));
	created.push(work);
	const home = join(work, "home");
	mkdirSync(home, { mode: 0o700 });
	return home;
}

/** The root `resolveRoot` derives from a POSIX home, so an assertion can name it. */
function rootUnder(home: string): string {
	return join(home, ".cache", "brl-subagent");
}

/** Running as root defeats a mode-based permission denial, so those cases skip. */
const permissionDenialsApply = process.platform !== "win32" && process.getuid?.() !== 0;

afterEach(() => {
	vi.restoreAllMocks();
	while (created.length > 0) {
		const path = created.pop();
		if (path === undefined) continue;
		// Restore owner-write first: a case that made a fixture unwritable must not
		// make its own cleanup fail (and leave the tree dirty).
		try {
			chmodSync(path, 0o700);
			chmodSync(join(path, "home"), 0o700);
		} catch {
			// Already gone, or never created with that shape.
		}
		rmSync(path, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// preflightCheck
// ---------------------------------------------------------------------------

describe("preflightCheck", () => {
	let home: string;

	beforeEach(() => {
		home = makeHome();
		mockGetPiInvocation.mockReturnValue({
			command: process.execPath, // Always valid since we're running
			args: [],
		});
	});

	// ------------------------------------------------------------------
	// Pi binary checks
	// ------------------------------------------------------------------

	it("passes when pi binary is accessible via absolute path", () => {
		const result = preflightCheck(realCwd, { root: { home } });
		expect(result.ok).toBe(true);
	});

	it("fails when the pi binary path does not exist", () => {
		mockGetPiInvocation.mockReturnValue({
			command: "/usr/bin/this-does-not-exist-12345",
			args: [],
		});
		const result = preflightCheck(realCwd, { root: { home } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/not accessible|not executable/);
		}
	});

	it("fails when pi binary is 'pi' but not on PATH", () => {
		// Temporarily empty PATH so the lookup fails
		const originalPath = process.env.PATH;
		process.env.PATH = "/dev/null";

		mockGetPiInvocation.mockReturnValue({
			command: "pi",
			args: [],
		});

		try {
			const result = preflightCheck(realCwd, { root: { home } });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toMatch(/pi binary not found/);
			}
		} finally {
			process.env.PATH = originalPath;
		}
	});

	// ------------------------------------------------------------------
	// CWD readability checks
	// ------------------------------------------------------------------

	it("passes when cwd is readable and is a directory", () => {
		const result = preflightCheck(realCwd, { root: { home } });
		expect(result.ok).toBe(true);
	});

	it("fails when cwd is not a directory", () => {
		const result = preflightCheck(notADir, { root: { home } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/is not a directory/);
		}
	});

	it("fails when cwd does not exist", () => {
		const result = preflightCheck(nonExistentDir, { root: { home } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/not readable/);
		}
	});

	// ------------------------------------------------------------------
	// Scratch-root checks (issue #511, U4 — the probe that left /tmp)
	// ------------------------------------------------------------------

	it("passes when the scratch root exists and is writable", () => {
		const root = rootUnder(home);
		mkdirSync(join(home, ".cache"), { mode: 0o700 });
		mkdirSync(root, { mode: 0o700 });

		const result = preflightCheck(realCwd, { root: { home } });
		expect(result.ok).toBe(true);
	});

	it("passes when the root is absent but its nearest existing ancestor is writable", () => {
		// No `.cache` either: the root does not exist, so the probe targets `$HOME`
		// — the directory the root chain would be created in.
		const result = preflightCheck(realCwd, { root: { home } });
		expect(result.ok).toBe(true);
		// The probe creates NOTHING durable: the root chain is still absent.
		expect(() => statSync(join(home, ".cache"))).toThrow();
		expect(readdirSync(home)).toEqual([]);
	});

	it.skipIf(!permissionDenialsApply)(
		"fails with a named error when the nearest existing ancestor is not writable",
		() => {
			const root = rootUnder(home);
			chmodSync(home, 0o500); // no write: the root cannot be created here

			const result = preflightCheck(realCwd, { root: { home } });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				// The message names the RESOLVED root (the path the spawn would use) and
				// the directory that refused the probe — never a system temp directory,
				// and no "set TMPDIR" advice any more.
				expect(result.error).toContain(root);
				expect(result.error).toContain("is not writable");
				expect(result.error).toContain(home);
				expect(result.error).not.toContain("TMPDIR");
			}
		},
	);

	it("leaves no probe file behind in the root", () => {
		const root = rootUnder(home);
		mkdirSync(join(home, ".cache"), { mode: 0o700 });
		mkdirSync(root, { mode: 0o700 });

		expect(preflightCheck(realCwd, { root: { home } }).ok).toBe(true);
		expect(readdirSync(root)).toEqual([]);
	});

	it("surfaces a resolver refusal as a named preflight failure, with the code", () => {
		// An unresolvable home is the resolver's `home-unresolvable` refusal: the
		// preflight reports it rather than falling back to a system temp directory.
		const result = preflightCheck(realCwd, { root: { home: "" } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("home-unresolvable");
			expect(result.error).toContain("Scratch root could not be resolved");
			expect(result.error).not.toContain("TMPDIR");
		}
	});

	// ------------------------------------------------------------------
	// Short-circuit behaviour
	// ------------------------------------------------------------------

	it("short-circuits on first failure (pi binary before cwd before scratch root)", () => {
		// Make pi binary check fail, and the scratch root unwritable too: the pi
		// failure is the one that must reach the caller.
		mockGetPiInvocation.mockReturnValue({
			command: "/usr/bin/this-does-not-exist-12345",
			args: [],
		});
		const result = preflightCheck(realCwd, { root: { home: "" } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/not accessible|not executable/);
		}
	});
});

// ---------------------------------------------------------------------------
// BRL_PI_BIN override (issue #271) — exercise the REAL resolution, not the mock
// ---------------------------------------------------------------------------

describe("preflightCheck validates the BRL_PI_BIN override (issue #271)", () => {
	let home: string;

	beforeEach(() => {
		home = makeHome();
	});

	afterEach(() => {
		delete process.env.BRL_PI_BIN;
	});

	it("fails when BRL_PI_BIN points at a missing binary (real getPiInvocation)", async () => {
		// preflight imports getPiInvocation from the mocked module; point that mock
		// at the REAL implementation so the BRL_PI_BIN override decides the command.
		const actualRunner = await vi.importActual<typeof import("../runner")>("../runner");
		mockGetPiInvocation.mockImplementation(actualRunner.getPiInvocation);

		process.env.BRL_PI_BIN = "/nonexistent/brl-pi-bin-271";

		const result = preflightCheck(realCwd, { root: { home } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/not accessible|not executable/);
			expect(result.error).toContain("/nonexistent/brl-pi-bin-271");
		}
	});

	it("passes when BRL_PI_BIN points at an executable binary (real getPiInvocation)", async () => {
		const actualRunner = await vi.importActual<typeof import("../runner")>("../runner");
		mockGetPiInvocation.mockImplementation(actualRunner.getPiInvocation);

		process.env.BRL_PI_BIN = process.execPath;

		const result = preflightCheck(realCwd, { root: { home } });
		expect(result.ok).toBe(true);
	});
});
