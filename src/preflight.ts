/**
 * brl-subagent — Pre-flight Checks (R3)
 *
 * Validates the execution environment before spawning a subagent.
 * Checks: pi binary availability, temp directory writability,
 * and project cwd readability.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPiInvocation } from "./runner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreflightResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Verify the pi binary is accessible via the same resolution logic used
 * at spawn time. When `getPiInvocation` falls back to "pi" on PATH, we
 * walk PATH to confirm the binary exists. For absolute paths (e.g.
 * process.execPath), we verify the file is executable.
 */
function checkPiBinary(): PreflightResult {
	const { command } = getPiInvocation([]);

	if (command !== "pi") {
		// Absolute or relative path — verify it exists
		try {
			fs.accessSync(command, fs.constants.X_OK);
			return { ok: true };
		} catch {
			return {
				ok: false,
				error: `Subagent command '${command}' is not accessible or not executable.`,
			};
		}
	}

	// "pi" fallback — search PATH
	const pathDirs = (process.env.PATH || "").split(path.delimiter);
	const isWindows = process.platform === "win32";
	const piNames = isWindows ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];

	for (const dir of pathDirs) {
		for (const name of piNames) {
			const fullPath = path.join(dir, name);
			try {
				fs.accessSync(fullPath, fs.constants.X_OK);
				return { ok: true };
			} catch {
				// Not found in this directory — continue searching
			}
		}
	}

	return {
		ok: false,
		error:
			"pi binary not found in PATH. " +
			"Ensure pi is installed and accessible from the command line.",
	};
}

/**
 * Verify the project working directory exists and is readable.
 */
function checkCwdReadable(cwd: string): PreflightResult {
	try {
		fs.accessSync(cwd, fs.constants.R_OK);
	} catch {
		return {
			ok: false,
			error: `Project working directory is not readable: ${cwd}. ` +
				"Check that the directory exists and has read permissions.",
		};
	}

	// Double-check it's actually a directory
	try {
		const stat = fs.statSync(cwd);
		if (!stat.isDirectory()) {
			return {
				ok: false,
				error: `Project working directory is not a directory: ${cwd}.`,
			};
		}
	} catch {
		return {
			ok: false,
			error: `Cannot stat project working directory: ${cwd}.`,
		};
	}

	return { ok: true };
}

/**
 * Verify the system temp directory is writable by creating and
 * removing a small temporary file.
 */
function checkTempWritable(): PreflightResult {
	const tmpDir = os.tmpdir();
	const testFile = path.join(tmpDir, `.brl-subagent-pcheck-${process.pid}`);

	try {
		fs.writeFileSync(testFile, "ok", { encoding: "utf-8", mode: 0o600 });
		fs.unlinkSync(testFile);
		return { ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `System temp directory (${tmpDir}) is not writable: ${message}. ` +
				"Set TMPDIR or TEMP to a writable directory.",
		};
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all pre-flight checks for subagent execution.
 * Returns `{ ok: true }` if all checks pass,
 * or `{ ok: false, error: "..." }` with a human-readable description
 * of the first failure.
 *
 * Call this BEFORE acquiring a concurrency slot to avoid wasting
 * resources on a doomed spawn.
 */
export function preflightCheck(cwd: string): PreflightResult {
	const piResult = checkPiBinary();
	if (!piResult.ok) return piResult;

	const cwdResult = checkCwdReadable(cwd);
	if (!cwdResult.ok) return cwdResult;

	const tempResult = checkTempWritable();
	if (!tempResult.ok) return tempResult;

	return { ok: true };
}
