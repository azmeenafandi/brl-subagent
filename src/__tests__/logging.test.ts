/**
 * brl-subagent — Logging level + output-routing tests (issues #235, #265)
 *
 * #235: BRL_LOG_LEVEL was never wired, so `minLevel` was hardcoded to "info" and
 * the `log.debug()` call sites were permanently suppressed with no runtime or
 * env way to turn them on.
 *
 * #265: the terminal mirror is opt-in via BRL_LOG_CONSOLE. File-only is the
 * default so a logger call can never corrupt pi's TUI renderer; the previous
 * unconditional console.* mirror wrote wherever the renderer's cursor sat.
 *
 * Both knobs are module-level state resolved at import, so each case re-imports
 * the module with `vi.resetModules()` after setting the env vars.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_LEVEL = process.env.BRL_LOG_LEVEL;
const ORIGINAL_CONSOLE = process.env.BRL_LOG_CONSOLE;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

describe("logging configuration (issues #235, #265)", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.resetModules();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		restoreEnv("BRL_LOG_LEVEL", ORIGINAL_LEVEL);
		restoreEnv("BRL_LOG_CONSOLE", ORIGINAL_CONSOLE);
		vi.resetModules();
	});

	/**
	 * Import a fresh copy of logging.ts with the given env, and return a logger.
	 * Pass "1" for `consoleEnv` to observe emitted entries through the opt-in
	 * console mirror; pass `undefined` to assert the file-only default.
	 */
	async function freshLogger(level: string | undefined, consoleEnv: string | undefined) {
		restoreEnv("BRL_LOG_LEVEL", level);
		restoreEnv("BRL_LOG_CONSOLE", consoleEnv);
		// Re-import per call: minLevel/consoleOutput are module state, so a second
		// import in the same test would reuse the already-evaluated module.
		vi.resetModules();
		// No cwd passed: file output is skipped, so console output (when enabled) is
		// what we assert on.
		const mod = await import("../logging");
		return { mod, log: mod.createLogger("test") };
	}

	it("defaults to info — debug is suppressed, info is emitted", async () => {
		const { log } = await freshLogger(undefined, "1");

		log.debug("hidden debug line");
		expect(logSpy).not.toHaveBeenCalled();

		log.info("visible info line");
		expect(logSpy).toHaveBeenCalledWith("[test] INFO: visible info line");
	});

	it("emits debug when BRL_LOG_LEVEL=debug", async () => {
		const { log } = await freshLogger("debug", "1");

		log.debug("verbose debug line");
		expect(logSpy).toHaveBeenCalledWith("[test] DEBUG: verbose debug line");
	});

	it("falls back to info for an unrecognised BRL_LOG_LEVEL", async () => {
		const { log } = await freshLogger("verbose", "1");

		log.debug("still hidden");
		expect(logSpy).not.toHaveBeenCalled();

		log.info("info still shown");
		expect(logSpy).toHaveBeenCalledWith("[test] INFO: info still shown");
	});

	it("accepts every documented level", async () => {
		for (const level of ["debug", "info", "warn", "error"] as const) {
			logSpy.mockClear();
			const { log } = await freshLogger(level, "1");
			log.debug("probe");
			const expectedCalls = level === "debug" ? 1 : 0;
			expect(logSpy, `level ${level}`).toHaveBeenCalledTimes(expectedCalls);
		}
	});

	it("setLogLevel overrides the env-derived level after import", async () => {
		const { mod, log } = await freshLogger(undefined, "1");

		log.debug("suppressed before override");
		expect(logSpy).not.toHaveBeenCalled();

		mod.setLogLevel("debug");

		log.debug("emitted after override");
		expect(logSpy).toHaveBeenCalledWith("[test] DEBUG: emitted after override");
	});

	it("writes NOTHING to the terminal by default (BRL_LOG_CONSOLE unset)", async () => {
		const { log } = await freshLogger("debug", undefined);

		log.debug("a");
		log.info("b");
		log.warn("c");
		log.error("d");

		expect(logSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("mirrors every passing level to the console when BRL_LOG_CONSOLE=1", async () => {
		const { log } = await freshLogger("debug", "1");

		log.debug("a");
		log.info("b");
		log.warn("c");
		log.error("d");

		expect(logSpy).toHaveBeenCalledWith("[test] DEBUG: a");
		expect(logSpy).toHaveBeenCalledWith("[test] INFO: b");
		expect(warnSpy).toHaveBeenCalledWith("[test] WARN: c");
		expect(errorSpy).toHaveBeenCalledWith("[test] ERROR: d");
	});

	it("accepts true|yes (case-insensitive, trimmed) for BRL_LOG_CONSOLE", async () => {
		for (const value of ["true", "TRUE", " yes "]) {
			logSpy.mockClear();
			const { log } = await freshLogger(undefined, value);
			log.info(`probe ${value}`);
			expect(logSpy, `BRL_LOG_CONSOLE=${JSON.stringify(value)}`).toHaveBeenCalledWith(`[test] INFO: probe ${value}`);
		}
	});

	it("treats any other BRL_LOG_CONSOLE value as off", async () => {
		for (const value of ["0", "false", "no", "verbose", ""]) {
			errorSpy.mockClear();
			const { log } = await freshLogger("debug", value);
			log.error("must not print");
			expect(errorSpy, `BRL_LOG_CONSOLE=${JSON.stringify(value)}`).not.toHaveBeenCalled();
		}
	});

	it("setConsoleOutput overrides the env-derived setting after import", async () => {
		const { mod, log } = await freshLogger(undefined, undefined);

		log.info("silent before override");
		expect(logSpy).not.toHaveBeenCalled();

		mod.setConsoleOutput(true);
		log.info("visible after override");
		expect(logSpy).toHaveBeenCalledWith("[test] INFO: visible after override");

		mod.setConsoleOutput(false);
		log.info("silent again");
		expect(logSpy).toHaveBeenCalledTimes(1);
	});
});
