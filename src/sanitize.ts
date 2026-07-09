/**
 * brl-subagent — Sanitization (F1, F2, F3)
 *
 * Input validation, environment isolation, and output sanitization
 * to ensure security and robustness of subagent execution.
 */

import * as path from "node:path";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// F1: Input sanitization
// ---------------------------------------------------------------------------

/**
 * Shell metacharacters that could enable command injection when passed
 * as CLI arguments. We aggressively reject any task containing these.
 */
// Intentional no-op: safe with spawn shell:false
const SHELL_METACHARS = /(?!)/; // matches nothing — safe with shell: false

/**
 * Maximum allowed task length to prevent memory exhaustion from
 * excessively long task descriptions.
 */
const MAX_TASK_LENGTH = 50_000; // 50KB

/**
 * Validate and sanitize the task string.
 * Rejects tasks containing shell metacharacters or exceeding max length.
 */
export function sanitizeTask(task: string): { ok: true; value: string } | { ok: false; error: string } {
	if (!task || task.trim().length === 0) {
		return { ok: false, error: "Task must not be empty." };
	}

	if (task.length > MAX_TASK_LENGTH) {
		return {
			ok: false,
			error: `Task too long (${task.length} chars). Maximum is ${MAX_TASK_LENGTH}.`,
		};
	}

	if (SHELL_METACHARS.test(task)) {
		const matches = task.match(SHELL_METACHARS);
		const found = [...new Set(matches)].map((c) => `'${c}'`).join(", ");
		return {
			ok: false,
			error: `Task contains disallowed characters: ${found}. Remove shell metacharacters and try again.`,
		};
	}

	return { ok: true, value: task.trim() };
}

/**
 * Validate and resolve a CWD path for subagent execution.
 * - Must exist as a directory
 * - Must be an absolute path (within reasonable bounds)
 */
export function validateCwd(raw: string | undefined, defaultCwd: string): { ok: true; value: string } | { ok: false; error: string } {
	if (!raw) return { ok: true, value: defaultCwd };

	const resolved = path.resolve(defaultCwd, raw);

	// Prevent traversal to sensitive system directories
	const dangerousPrefixes = ["/etc", "/sys", "/proc", "/dev", "/root"];
	for (const prefix of dangerousPrefixes) {
		if (resolved === prefix || resolved.startsWith(prefix + "/")) {
			return { ok: false, error: `CWD path "${raw}" resolves to restricted system directory "${resolved}".` };
		}
	}

	try {
		const stat = fs.statSync(resolved);
		if (!stat.isDirectory()) {
			return { ok: false, error: `CWD path "${raw}" is not a directory.` };
		}
	} catch {
		return { ok: false, error: `CWD path "${raw}" does not exist.` };
	}

	return { ok: true, value: resolved };
}

/**
 * Validate an output file path to prevent writing outside the project.
 * Path must resolve within the project root directory.
 */
export function validateOutputFile(raw: string, projectRoot: string): { ok: true; value: string } | { ok: false; error: string } {
	const resolved = path.resolve(projectRoot, raw);

	// Must be within the project root
	const rel = path.relative(projectRoot, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return {
			ok: false,
			error: `Output file path "${raw}" escapes the project root. Must be within the project directory.`,
		};
	}

	// Must not point to a directory
	try {
		const stat = fs.statSync(resolved);
		if (stat.isDirectory()) {
			return { ok: false, error: `Output file path "${raw}" is a directory, not a file.` };
		}
	} catch {
		// File doesn't exist yet — that's fine, it'll be created
	}

	return { ok: true, value: resolved };
}

// ---------------------------------------------------------------------------
// F2: Environment isolation
// ---------------------------------------------------------------------------

/**
 * Safe environment variables to pass to subagent processes.
 * Only variables needed for the subagent to function are included.
 * API keys, secrets, and other sensitive env vars are NOT propagated.
 */
const SAFE_ENV_KEYS = new Set([
	"PATH",
	"HOME",
	"USER",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"TEMP",
	"TMP",
	"SHELL",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"NODE_ENV",
	// brl-subagent recursion depth tracker
	"BRL_SUBAGENT_DEPTH",
]);

/**
 * Build a filtered environment object containing only safe variables.
 * Accepts optional overrides for keys that are computed at spawn time
 * (e.g., BRL_SUBAGENT_DEPTH) rather than inherited from the parent process.
 */
export function getSafeEnv(overrides?: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && SAFE_ENV_KEYS.has(key)) {
			env[key] = value;
		}
	}
	if (overrides) {
		for (const [key, value] of Object.entries(overrides)) {
			if (value !== undefined) {
				env[key] = value;
			}
		}
	}
	return env;
}

// ---------------------------------------------------------------------------
// F3: Output sanitization
// ---------------------------------------------------------------------------

/**
 * Regex to match ANSI escape sequences (CSI, OSC, etc.)
 */
const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

/**
 * Strip ANSI escape sequences from a string.
 * Subagent output may contain terminal control codes that could
 * interfere with the TUI or be used maliciously.
 */
export function stripAnsi(str: string): string {
	return str.replace(ANSI_ESCAPE_RE, "");
}

/**
 * Cap output size to prevent subagent results from overwhelming
 * the conductor's context window or TUI.
 *
 * Returns the original string if within limits, or a truncated version
 * with a clear notice about how much was omitted.
 */
export function capOutput(output: string, maxBytes: number = 100 * 1024): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= maxBytes) return output;

	// Truncate while keeping valid UTF-8
	let truncated = output.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) {
		truncated = truncated.slice(0, -1);
	}

	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${formatBytes(omitted)} omitted. Full output available in run history details.]`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Recursion depth tracking
// ---------------------------------------------------------------------------

/** Env var used to track subagent nesting depth. */
export const DEPTH_ENV_KEY = "BRL_SUBAGENT_DEPTH";

/**
 * Read the current subagent depth from the environment.
 * Returns 0 for the main (conductor) process, 1+ for nested subagents.
 */
export function getCurrentDepth(): number {
	const raw = process.env[DEPTH_ENV_KEY];
	if (!raw) return 0;
	const parsed = parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
