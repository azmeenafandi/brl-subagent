/**
 * brl-subagent — Logging level tests (issue #235)
 *
 * BRL_LOG_LEVEL was never wired: `minLevel` was hardcoded to "info", so the
 * three `log.debug()` call sites in the codebase were permanently suppressed
 * with no runtime or env way to turn them on.
 *
 * `minLevel` is module-level state, so each case re-imports the module with
 * `vi.resetModules()` after setting the env var.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("BRL_LOG_LEVEL (issue #235)", () => {
	const originalEnv = process.env.BRL_LOG_LEVEL;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.resetModules();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		if (originalEnv === undefined) {
			delete process.env.BRL_LOG_LEVEL;
		} else {
			process.env.BRL_LOG_LEVEL = originalEnv;
		}
		vi.resetModules();
	});

	/** Import a fresh copy of logging.ts with the given env, and return a logger. */
	async function freshLogger(envValue: string | undefined) {
		if (envValue === undefined) {
			delete process.env.BRL_LOG_LEVEL;
		} else {
			process.env.BRL_LOG_LEVEL = envValue;
		}
		// Re-import per call: minLevel is module state, so a second import in the
		// same test would reuse the already-evaluated module.
		vi.resetModules();
		// No cwd passed: file output is skipped, console output is what we assert on.
		const mod = await import("../logging");
		return { mod, log: mod.createLogger("test") };
	}

	it("defaults to info — debug is suppressed, info is emitted", async () => {
		const { log } = await freshLogger(undefined);

		log.debug("hidden debug line");
		expect(logSpy).not.toHaveBeenCalled();

		log.info("visible info line");
		expect(logSpy).toHaveBeenCalledWith("[test] INFO: visible info line");
	});

	it("emits debug when BRL_LOG_LEVEL=debug", async () => {
		const { log } = await freshLogger("debug");

		log.debug("verbose debug line");
		expect(logSpy).toHaveBeenCalledWith("[test] DEBUG: verbose debug line");
	});

	it("falls back to info for an unrecognised BRL_LOG_LEVEL", async () => {
		const { log } = await freshLogger("verbose");

		log.debug("still hidden");
		expect(logSpy).not.toHaveBeenCalled();

		log.info("info still shown");
		expect(logSpy).toHaveBeenCalledWith("[test] INFO: info still shown");
	});

	it("accepts every documented level", async () => {
		for (const level of ["debug", "info", "warn", "error"] as const) {
			logSpy.mockClear();
			const { log } = await freshLogger(level);
			log.debug("probe");
			const expectedCalls = level === "debug" ? 1 : 0;
			expect(logSpy, `level ${level}`).toHaveBeenCalledTimes(expectedCalls);
		}
	});

	it("setLogLevel overrides the env-derived level after import", async () => {
		const { mod, log } = await freshLogger(undefined);

		log.debug("suppressed before override");
		expect(logSpy).not.toHaveBeenCalled();

		mod.setLogLevel("debug");

		log.debug("emitted after override");
		expect(logSpy).toHaveBeenCalledWith("[test] DEBUG: emitted after override");
	});
});
