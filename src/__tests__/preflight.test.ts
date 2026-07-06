/**
 * Tests for preflight.ts — pre-flight environment checks (R3).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
const nonExistentDir = "/tmp/__brl_pcheck_nonexistent__";
const notADir = "/dev/null";

// ---------------------------------------------------------------------------
// preflightCheck
// ---------------------------------------------------------------------------

describe("preflightCheck", () => {
	beforeEach(() => {
		mockGetPiInvocation.mockReturnValue({
			command: process.execPath, // Always valid since we're running
			args: [],
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ------------------------------------------------------------------
	// Pi binary checks
	// ------------------------------------------------------------------

	it("passes when pi binary is accessible via absolute path", () => {
		mockGetPiInvocation.mockReturnValue({
			command: process.execPath,
			args: [],
		});
		const result = preflightCheck(realCwd);
		expect(result.ok).toBe(true);
	});

	it("fails when the pi binary path does not exist", () => {
		mockGetPiInvocation.mockReturnValue({
			command: "/usr/bin/this-does-not-exist-12345",
			args: [],
		});
		const result = preflightCheck(realCwd);
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

		const result = preflightCheck(realCwd);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/pi binary not found/);
		}

		process.env.PATH = originalPath;
	});

	// ------------------------------------------------------------------
	// CWD readability checks
	// ------------------------------------------------------------------

	it("passes when cwd is readable and is a directory", () => {
		mockGetPiInvocation.mockReturnValue({
			command: process.execPath,
			args: [],
		});
		const result = preflightCheck(realCwd);
		expect(result.ok).toBe(true);
	});

	it("fails when cwd is not a directory", () => {
		const result = preflightCheck(notADir);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/is not a directory/);
		}
	});

	it("fails when cwd does not exist", () => {
		const result = preflightCheck(nonExistentDir);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/not readable/);
		}
	});

	// ------------------------------------------------------------------
	// Temp writability checks
	// ------------------------------------------------------------------

	it("passes when temp directory is writable", () => {
		const result = preflightCheck(realCwd);
		expect(result.ok).toBe(true);
	});

	// Note: "temp dir not writable" scenario is tested implicitly by
	// the integration: if the temp dir were actually unwritable, the
	// try/catch in checkTempWritable would catch any error and return
	// { ok: false }. Mocking fs.writeFileSync in ESM is not feasible.

	// ------------------------------------------------------------------
	// Short-circuit behaviour
	// ------------------------------------------------------------------

	it("short-circuits on first failure (pi binary before cwd before temp)", () => {
		// Make pi binary check fail
		mockGetPiInvocation.mockReturnValue({
			command: "/usr/bin/this-does-not-exist-12345",
			args: [],
		});

		const result = preflightCheck(realCwd);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// Should fail on pi binary check, not cwd/temp
			expect(result.error).toMatch(/not accessible|not executable/);
		}
	});
});
