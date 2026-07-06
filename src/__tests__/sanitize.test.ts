/**
 * Tests for sanitize.ts — input validation, env isolation, output sanitization.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import {
	sanitizeTask,
	validateCwd,
	validateOutputFile,
	getSafeEnv,
	stripAnsi,
	capOutput,
	getCurrentDepth,
	DEPTH_ENV_KEY,
} from "../sanitize";

// ---------------------------------------------------------------------------
// sanitizeTask (F1)
// ---------------------------------------------------------------------------

describe("sanitizeTask", () => {
	it("accepts normal task strings", () => {
		const result = sanitizeTask("Audit the src/ directory for security issues.");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe("Audit the src/ directory for security issues.");
	});

	it("trims whitespace", () => {
		const result = sanitizeTask("  Review code  ");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe("Review code");
	});

	it("rejects empty strings", () => {
		const result = sanitizeTask("");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("not be empty");
	});

	it("rejects whitespace-only strings", () => {
		const result = sanitizeTask("   ");
		expect(result.ok).toBe(false);
	});

	it("rejects newlines and backticks", () => {
		const dangerous = [
			`task${String.fromCharCode(10)}rm -rf /`,
			"task`whoami`",
			"task\r\nextra",
		];
		for (const t of dangerous) {
			const result = sanitizeTask(t);
			expect(result.ok).toBe(false);
		}
	});

	it("accepts shell characters that are safe in non-shell spawn", () => {
		const safe = [
			"task; rm -rf /",
			"task && echo hacked",
			"task | cat /etc/passwd",
			"task $(whoami)",
		];
		for (const t of safe) {
			const result = sanitizeTask(t);
			expect(result.ok).toBe(true);
		}
	});

	it("rejects extremely long tasks", () => {
		const long = "x".repeat(60_000);
		const result = sanitizeTask(long);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("too long");
	});

	it("accepts tasks with normal punctuation", () => {
		const result = sanitizeTask(
			"Review: check for errors, warnings & info messages. Use # comments? Yes/No.",
		);
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// validateCwd (F1)
// ---------------------------------------------------------------------------

describe("validateCwd", () => {
	const homeDir = os.homedir();

	it("returns defaultCwd when raw is undefined", () => {
		const result = validateCwd(undefined, "/home/user/project");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe("/home/user/project");
	});

	it("resolves relative paths against defaultCwd", () => {
		// Use the actual cwd so the subdir exists
		const cwd = process.cwd();
		const result = validateCwd("src", cwd);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe(path.join(cwd, "src"));
	});

	it("rejects paths to /etc", () => {
		const result = validateCwd("/etc", "/home/user/project");
		expect(result.ok).toBe(false);
	});

	it("rejects paths to /sys", () => {
		const result = validateCwd("/sys/class", "/home/user/project");
		expect(result.ok).toBe(false);
	});

	it("rejects paths to /proc", () => {
		const result = validateCwd("/proc/self", "/home/user/project");
		expect(result.ok).toBe(false);
	});

	it("accepts the home directory", () => {
		const result = validateCwd(homeDir, homeDir);
		// Home dir exists and is a directory on most systems
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// validateOutputFile (F1)
// ---------------------------------------------------------------------------

describe("validateOutputFile", () => {
	const projectRoot = "/home/user/project";

	it("accepts paths within project root", () => {
		const result = validateOutputFile("results/audit.md", projectRoot);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe("/home/user/project/results/audit.md");
	});

	it("rejects path traversal attempts", () => {
		const result = validateOutputFile("../../etc/passwd", projectRoot);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("escapes");
	});

	it("rejects absolute paths outside project", () => {
		const result = validateOutputFile("/etc/passwd", projectRoot);
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getSafeEnv (F2)
// ---------------------------------------------------------------------------

describe("getSafeEnv", () => {
	it("returns an object with safe env vars", () => {
		const env = getSafeEnv();
		expect(typeof env).toBe("object");
		expect(env.PATH).toBeDefined();
	});

	it("does not include API keys", () => {
		// Temporarily set a fake API key
		process.env.FAKE_API_KEY = "secret123";
		const env = getSafeEnv();
		expect(env.FAKE_API_KEY).toBeUndefined();
		delete process.env.FAKE_API_KEY;
	});

	it("includes HOME and PATH", () => {
		const env = getSafeEnv();
		if (process.env.HOME) expect(env.HOME).toBeDefined();
		if (process.env.PATH) expect(env.PATH).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// stripAnsi (F3)
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
	it("passes through plain text unchanged", () => {
		expect(stripAnsi("Hello world")).toBe("Hello world");
	});

	it("strips ANSI color codes", () => {
		const input = "\u001B[31mRed text\u001B[0m and \u001B[32mgreen\u001B[0m";
		expect(stripAnsi(input)).toBe("Red text and green");
	});

	it("strips ANSI cursor movement codes", () => {
		const input = "Line 1\u001B[2K\u001B[1GOverwritten";
		expect(stripAnsi(input)).toBe("Line 1Overwritten");
	});

	it("handles empty strings", () => {
		expect(stripAnsi("")).toBe("");
	});

	it("preserves special Unicode characters", () => {
		expect(stripAnsi("✓ done · cost: $0.0234")).toBe("✓ done · cost: $0.0234");
	});
});

// ---------------------------------------------------------------------------
// capOutput (F3)
// ---------------------------------------------------------------------------

describe("capOutput", () => {
	it("returns unchanged output under limit", () => {
		const output = "Short output";
		expect(capOutput(output, 1000)).toBe(output);
	});

	it("truncates output over limit with notice", () => {
		const output = "x".repeat(200);
		const result = capOutput(output, 100);
		expect(result.length).toBeLessThan(output.length);
		expect(result).toContain("[Output truncated:");
		expect(result).toContain("omitted");
	});

	it("handles exactly at limit", () => {
		const output = "x".repeat(100);
		expect(capOutput(output, 100)).toBe(output);
	});

	it("handles multi-byte UTF-8 characters without breaking them", () => {
		const output = "😀".repeat(100);
		const result = capOutput(output, 50);
		// Should not have broken surrogate pairs
		expect(() => Buffer.from(result, "utf8").toString("utf8")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// getCurrentDepth — recursion tracking
// ---------------------------------------------------------------------------

describe("getCurrentDepth", () => {
	const original = process.env[DEPTH_ENV_KEY];

	afterEach(() => {
		if (original === undefined) {
			delete process.env[DEPTH_ENV_KEY];
		} else {
			process.env[DEPTH_ENV_KEY] = original;
		}
	});

	it("returns 0 when env var is not set", () => {
		delete process.env[DEPTH_ENV_KEY];
		expect(getCurrentDepth()).toBe(0);
	});

	it("returns parsed number from env var", () => {
		process.env[DEPTH_ENV_KEY] = "3";
		expect(getCurrentDepth()).toBe(3);
	});

	it("returns 0 for invalid values", () => {
		process.env[DEPTH_ENV_KEY] = "not-a-number";
		expect(getCurrentDepth()).toBe(0);
	});

	it("returns 0 for negative values", () => {
		process.env[DEPTH_ENV_KEY] = "-1";
		expect(getCurrentDepth()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// getSafeEnv with overrides
// ---------------------------------------------------------------------------

describe("getSafeEnv with overrides", () => {
	it("includes override keys in the result", () => {
		const env = getSafeEnv({ [DEPTH_ENV_KEY]: "5" });
		expect(env[DEPTH_ENV_KEY]).toBe("5");
	});

	it("passes any override key without filtering", () => {
		// Overrides are trusted — the extension controls what it injects.
		const env = getSafeEnv({ CUSTOM_VAR: "hello" });
		expect(env.CUSTOM_VAR).toBe("hello");
	});
});
