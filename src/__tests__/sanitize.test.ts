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
	assertSafeAgentId,
	sanitizeErrorMessage,
	buildCrashResult,
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

	it("rejects empty and whitespace strings", () => {
		expect(sanitizeTask("").ok).toBe(false);
		expect(sanitizeTask("   ").ok).toBe(false);
	});

	it("accepts newlines and shell characters that are safe in non-shell spawn", () => {
		const safe = [
			"task; rm -rf /",
			"task && echo hacked",
			"task | cat /etc/passwd",
			"task $(whoami)",
			"task`whoami`",
			"code in `backticks`",
			"`cat /etc/passwd`",
			`line1\nline2\nline3`,
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

// ---------------------------------------------------------------------------
// sanitizeErrorMessage (F7 / issue #30)
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage", () => {
	const cwd = "/home/testuser/project";

	it("replaces the cwd absolute prefix with <cwd>", () => {
		const msg = "Cannot read file /home/testuser/project/src/foo.ts: No such file";
		expect(sanitizeErrorMessage(msg, cwd)).toBe(
			"Cannot read file <cwd>/src/foo.ts: No such file"
		);
	});

	it("replaces the parent (home) prefix with <home>", () => {
		const msg = "Cannot read file /home/testuser/other-project/bar.ts";
		expect(sanitizeErrorMessage(msg, cwd)).toBe(
			"Cannot read file <home>/other-project/bar.ts"
		);
	});

	it("replaces a bare cwd-equal message with <cwd>", () => {
		expect(sanitizeErrorMessage("/home/testuser/project", cwd)).toBe("<cwd>");
	});

	it("strips ANSI escape sequences before path neutralization", () => {
		const msg = "\u001B[31mboom\u001B[0m at /home/testuser/project/x.ts";
		expect(sanitizeErrorMessage(msg, cwd)).toBe("boom at <cwd>/x.ts");
	});

	it("caps length with an ellipsis marker", () => {
		const long = "verbose error ".repeat(500); // 3500 chars
		const out = sanitizeErrorMessage(long);
		expect(out.length).toBeLessThan(long.length);
		expect(out).toContain("…[truncated]");
		// First 2000 chars preserved for debugging.
		expect(out.startsWith(long.slice(0, 2000))).toBe(true);
	});

	it("leaves short clean messages unchanged", () => {
		const msg = "auth failed: invalid API key";
		expect(sanitizeErrorMessage(msg, cwd)).toBe(msg);
	});

	it("handles empty strings safely", () => {
		expect(sanitizeErrorMessage("")).toBe("");
	});

	it("uses process.cwd() when no cwd is passed", () => {
		const msg = `Cannot open ${process.cwd()}/src/index.ts`;
		expect(sanitizeErrorMessage(msg)).toBe("Cannot open <cwd>/src/index.ts");
	});

	it("does not clobber sibling directories sharing the cwd prefix", () => {
		const msg = "Error in /home/testuser/project2/src/x.ts";
		expect(sanitizeErrorMessage(msg, cwd)).toBe("Error in <home>/project2/src/x.ts");
	});

	it("does not destroy the message when cwd is the filesystem root", () => {
		const msg = "failed near /usr/bin/node";
		expect(sanitizeErrorMessage(msg, "/")).toBe(msg);
	});

	it("strips a trailing slash from the cwd so the boundary still matches mid-string (Fix 1)", () => {
		// path.normalize preserves a trailing separator, so `/home/u/project/`
		// used to fall through to the parent pass and leak as `<home>/project/...`.
		const out = sanitizeErrorMessage("Error at /home/u/project/src/x.ts", "/home/u/project/");
		expect(out).toContain("<cwd>");
		expect(out).not.toContain("/project/src");
		expect(out).toBe("Error at <cwd>/src/x.ts");
	});

	it("neutralizes Windows-style cwd paths mid-string (Fix 2)", () => {
		// Boundary class must match both `\` and `/` — with only `/` the
		// backslash after `project` never matched and the raw cwd leaked.
		const out = sanitizeErrorMessage(
			"Error: ENOENT at C:\\Users\\me\\project\\node_modules\\x",
			"C:\\Users\\me\\project"
		);
		expect(out).not.toContain("C:\\Users\\me\\project");
		expect(out).toContain("<cwd>");
	});

	it("leaves non-cwd absolute paths as-is (documented policy)", () => {
		const msg = "cannot stat /etc/passwd after /home/testuser/project/build failed";
		expect(sanitizeErrorMessage(msg, cwd)).toBe(
			"cannot stat /etc/passwd after <cwd>/build failed"
		);
	});
});


describe("assertSafeAgentId", () => {
	it("accepts valid UUIDs", () => {
		expect(() => assertSafeAgentId("05b8b0d9-4a1e-4f2a-9c3d-6e7f8a9b0c1d")).not.toThrow();
		expect(() => assertSafeAgentId("05B8B0D9-4A1E-4F2A-9C3D-6E7F8A9B0C1D")).not.toThrow();
	});

	it("rejects path traversal", () => {
		expect(() => assertSafeAgentId("../../etc/passwd")).toThrow();
		expect(() => assertSafeAgentId("..\\..\\etc\\passwd")).toThrow();
	});

	it("rejects absolute paths", () => {
		expect(() => assertSafeAgentId("/tmp/foo")).toThrow();
	});

	it("rejects non-uuid ids", () => {
		expect(() => assertSafeAgentId("foo")).toThrow();
		expect(() => assertSafeAgentId("agent-123")).toThrow();
		expect(() => assertSafeAgentId("")).toThrow();
	});
});

// ---------------------------------------------------------------------------
// buildCrashResult (DRY extraction, issue #68)
// ---------------------------------------------------------------------------

describe("buildCrashResult", () => {
	const cwd = "/home/testuser/project";

	it("builds the crash envelope with sanitized content and raw stderr", () => {
		const err = new Error(`config load failed: ${cwd}/.pi/settings.json`);
		const result = buildCrashResult("Chain mode", err, cwd);

		expect(result.isError).toBe(true);
		// Content is what pi serializes into the LLM context — cwd masked.
		expect(result.content).toEqual([{ type: "text", text: "Chain mode crashed: config load failed: <cwd>/.pi/settings.json" }]);
		expect(result.content[0].text).not.toContain(cwd);

		// Details shape matches the pre-extraction inline construction exactly.
		expect(result.details.messages).toEqual([]);
		expect(result.details.usage).toEqual({
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0,
		});
		expect(result.details.exitCode).toBe(1);
		// stderr stays RAW (issue #68 framing) — only errorMessage is sanitized.
		expect(result.details.stderr).toBe(`Error: config load failed: ${cwd}/.pi/settings.json`);
		expect(result.details.stderr).toContain(cwd);
		expect(result.details.errorMessage).toBe("config load failed: <cwd>/.pi/settings.json");
	});

	it("keeps the mode prefix and sanitizes non-Error throws", () => {
		const result = buildCrashResult("Graph mode", `boom at ${cwd}/src/x.ts`, cwd);

		expect(result.content[0].text).toBe("Graph mode crashed: boom at <cwd>/src/x.ts");
		expect(result.details.stderr).toBe(`boom at ${cwd}/src/x.ts`);
		expect(result.details.errorMessage).toBe("boom at <cwd>/src/x.ts");
	});

	it("preserves the exact mode strings used by the three call sites", () => {
		expect(buildCrashResult("Subagent", "x", cwd).content[0].text).toBe("Subagent crashed: x");
	});
});
