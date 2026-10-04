// Purpose: Leveled structured logging with file output and rotation under `.pi/subagent-logs/`.
/**
 * brl-subagent — Structured Logging (F10)
 *
 * Provides leveled, structured logging with file output and rotation.
 * Logs are written to .pi/subagent-logs/ in the project directory.
 *
 * Usage:
 *   const log = createLogger("runner", cwd);
 *   log.info("Subagent started", { model, thinkingLevel });
 *   log.error("Subagent failed", { error: err.message });
 *
 * Module-load callers pass no cwd; they call setLogCwd(ctx.cwd) once the
 * session starts and all loggers share <cwd>/.pi/subagent-logs/brl-subagent.log.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LogLevel } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum single log file size before rotation (5MB) */
const MAX_LOG_SIZE = 5 * 1024 * 1024;

/** Maximum number of rotated log files to keep */
const MAX_LOG_FILES = 5;

/**
 * The single log file every logger writes to (issue #179). The JSON entry body
 * already carries its `prefix`, so one shared file stays readable.
 */
const LOG_FILE_NAME = "brl-subagent.log";

/** Log levels in order of verbosity */
const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/** The level names BRL_LOG_LEVEL accepts (the keys of LOG_LEVELS). */
const LOG_LEVEL_NAMES: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Current minimum log level — can be changed at runtime */
let minLevel: LogLevel = resolveInitialLogLevel();

/**
 * Whether the console mirror is enabled — opt-in via BRL_LOG_CONSOLE (issue #265).
 * File-only is the default so extension logging never corrupts the pi TUI.
 */
let consoleOutput: boolean = resolveInitialConsoleOutput();

/**
 * Issue #235: the log verbosity knob was never wired, so the three `log.debug()`
 * call sites were permanently suppressed with no way to turn them on.
 * `BRL_LOG_LEVEL` is read ONCE at module load (logger call sites are spread
 * across the codebase, and re-reading env per call would be wasteful and
 * non-deterministic mid-run). `setLogLevel()` remains the programmatic override.
 * Anything outside debug|info|warn|error falls back to "info".
 */
function resolveInitialLogLevel(): LogLevel {
	const raw = process.env.BRL_LOG_LEVEL?.trim().toLowerCase();
	if (raw && (LOG_LEVEL_NAMES as readonly string[]).includes(raw)) {
		return raw as LogLevel;
	}
	return "info";
}

/**
 * Issue #265: extension code runs inside pi's TUI process, so a raw console
 * write lands wherever the renderer's cursor sits and corrupts the display.
 * File-only is the default; `BRL_LOG_CONSOLE` opts the terminal mirror back in.
 * Read ONCE at module load for the same reason as BRL_LOG_LEVEL — logger call
 * sites are spread across the codebase. Accepts `1|true|yes`; anything else is
 * off. `setConsoleOutput()` remains the programmatic override.
 *
 * Explicitly NOT gated on process.stdout.isTTY: in pi print mode stdout IS the
 * result channel, so that test is exactly backwards.
 */
function resolveInitialConsoleOutput(): boolean {
	const raw = process.env.BRL_LOG_CONSOLE?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface Logger {
	debug(message: string, data?: Record<string, unknown>): void;
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
}

export function setLogLevel(level: LogLevel): void {
	minLevel = level;
}

/**
 * Programmatic override for the console mirror (issue #265). Mirrors
 * setLogLevel: module-level state, so tests can toggle it without re-reading
 * the environment.
 */
export function setConsoleOutput(enabled: boolean): void {
	consoleOutput = enabled;
}

// Issue #179 (D6): createLogger() runs at MODULE LOAD (index.ts,
// session-manager.ts) where the session cwd does not exist yet. The cwd is set
// later from the session_start hook (ctx.cwd). All logger instances share this
// module-level value so every entry lands in ONE
// `<cwd>/.pi/subagent-logs/brl-subagent.log`.
let logCwd: string | undefined;

/**
 * Point file logging at a session cwd (or clear it with undefined). Called from
 * the session-start hook so module-load loggers can write once a cwd exists.
 */
export function setLogCwd(cwd: string | undefined): void {
	logCwd = cwd;
}

function resolveLogDir(): string | undefined {
	return logCwd ? path.join(logCwd, ".pi", "subagent-logs") : undefined;
}

/**
 * Create a logger for a specific module.
 * Logs are written to `<cwd>/.pi/subagent-logs/brl-subagent.log` relative to the
 * session cwd (set via setLogCwd or the optional `cwd` arg).
 */
export function createLogger(prefix: string, cwd?: string): Logger {
	// Compat: an explicit cwd argument still sets the shared location eagerly.
	if (cwd) logCwd = cwd;

	function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
		if (LOG_LEVELS[level] < LOG_LEVELS[minLevel]) return;

		const timestamp = new Date().toISOString();
		const entry = {
			timestamp,
			level,
			prefix,
			message,
			...(data ? { data } : {}),
		};

		const line = JSON.stringify(entry);

		// Console mirror — opt-in (issue #265). Off by default so a logger call
		// can never corrupt the pi TUI renderer; BRL_LOG_CONSOLE opts back in.
		if (consoleOutput) {
			const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
			consoleMethod(`[${prefix}] ${level.toUpperCase()}: ${message}`);
		}

		// File output — resolved on each call because the cwd may be set after
		// createLogger ran (module load) but before the first entry.
		const logDir = resolveLogDir();
		if (logDir) {
			try {
				// Owner-only (0o700) so other local users cannot list log files
				// (F6 / issue #29); the file writes below already use 0o600.
				fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
				const logFile = path.join(logDir, LOG_FILE_NAME);
				rotateIfNeeded(logFile);
				fs.appendFileSync(logFile, line + "\n", { encoding: "utf-8", mode: 0o600 });
			} catch {
				// Silently fail — logging should never crash the extension
			}
		}
	}

	return {
		debug: (m, d) => log("debug", m, d),
		info: (m, d) => log("info", m, d),
		warn: (m, d) => log("warn", m, d),
		error: (m, d) => log("error", m, d),
	};
}

// ---------------------------------------------------------------------------
// Log rotation
// ---------------------------------------------------------------------------

function rotateIfNeeded(logFile: string): void {
	try {
		const stat = fs.statSync(logFile);
		if (stat.size < MAX_LOG_SIZE) return;

		// Rotate: remove oldest, shift others, rename current
		for (let i = MAX_LOG_FILES - 1; i >= 0; i--) {
			const oldFile = i === 0 ? logFile : `${logFile}.${i}`;
			const newFile = `${logFile}.${i + 1}`;
			try {
				if (i === MAX_LOG_FILES - 1) {
					fs.unlinkSync(oldFile);
				} else {
					fs.renameSync(oldFile, newFile);
				}
			} catch {
				// File might not exist — that's fine
			}
		}
	} catch {
		// Log file doesn't exist yet — nothing to rotate
	}
}
