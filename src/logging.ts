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

/** Log levels in order of verbosity */
const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/** Current minimum log level — can be changed at runtime */
let minLevel: LogLevel = "info";

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
 * Create a logger for a specific module.
 * Logs are written to `.pi/subagent-logs/<prefix>.log` relative to `cwd`.
 */
export function createLogger(prefix: string, cwd?: string): Logger {
	const logDir = cwd ? path.join(cwd, ".pi", "subagent-logs") : undefined;

	// Ensure log directory exists
	if (logDir) {
		try {
			fs.mkdirSync(logDir, { recursive: true });
		} catch {
			// Can't create log dir — fall back to console-only logging
		}
	}

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

		// Console output
		const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
		consoleMethod(`[${prefix}] ${level.toUpperCase()}: ${message}`);

		// File output
		if (logDir) {
			try {
				const logFile = path.join(logDir, `${prefix}.log`);
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
