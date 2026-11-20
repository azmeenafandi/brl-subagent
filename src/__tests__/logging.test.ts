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

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_LEVEL = process.env.BRL_LOG_LEVEL;
const ORIGINAL_CONSOLE = process.env.BRL_LOG_CONSOLE;

/** #543: per-test throwaway cwd so the file half of the contract is observable. */
const tempDirs: string[] = [];
function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "brl-log543-"));
	tempDirs.push(dir);
	return dir;
}
function readLog(cwd: string): string {
	try {
		return readFileSync(join(cwd, ".pi", "subagent-logs", "brl-subagent.log"), "utf-8");
	} catch {
		return "";
	}
}

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
		// Before resetModules: a later run must not resurrect a removed dir.
		// Before resetModules: a later write must not resurrect a removed dir.
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		restoreEnv("BRL_LOG_LEVEL", ORIGINAL_LEVEL);
		restoreEnv("BRL_LOG_CONSOLE", ORIGINAL_CONSOLE);
		vi.resetModules();
	});

	/**
	 * Import a fresh copy of logging.ts with the given env, and return a logger.
	 * Pass "1" for `consoleEnv` to observe emitted entries through the opt-in
	 * console mirror; pass `undefined` to assert the file-only default.
	 */
	async function freshLogger(level: string | undefined, consoleEnv: string | undefined, cwd?: string) {
		restoreEnv("BRL_LOG_LEVEL", level);
		restoreEnv("BRL_LOG_CONSOLE", consoleEnv);
		// Re-import per call: minLevel/consoleOutput are module state, so a second
		// import in the same test would reuse the already-evaluated module.
		vi.resetModules();
		// Without a cwd, file output is skipped and console output is what we assert on.
		const mod = await import("../logging");
		return { mod, log: mod.createLogger("test", cwd) };
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

	// --- #543: a mirror fault must not throw out of `log.*` NOR skip the file write (still attempted once per call). ---

	it("swallows a throwing console.warn and still appends the file entry (#543)", async () => {
		const cwd = tempCwd();
		warnSpy.mockImplementation(() => {
			throw new Error("console blew up");
		});
		const { log } = await freshLogger(undefined, "1", cwd);

		expect(() => log.warn("warn survived")).not.toThrow();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(readLog(cwd)).toContain('"level":"warn"');
		expect(readLog(cwd)).toContain("warn survived");
	});

	it("swallows a throwing console.error and still appends the file entry (#543)", async () => {
		const cwd = tempCwd();
		errorSpy.mockImplementation(() => {
			throw new Error("console blew up");
		});
		const { log } = await freshLogger(undefined, "1", cwd);

		expect(() => log.error("error survived")).not.toThrow();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(readLog(cwd)).toContain('"level":"error"');
		expect(readLog(cwd)).toContain("error survived");
	});

	it("swallows a throwing console.log and still appends the file entry (#543)", async () => {
		const cwd = tempCwd();
		logSpy.mockImplementation(() => {
			throw new Error("console blew up");
		});
		const { log } = await freshLogger(undefined, "1", cwd);

		expect(() => log.info("info survived")).not.toThrow();
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(readLog(cwd)).toContain('"level":"info"');
		expect(readLog(cwd)).toContain("info survived");
	});

	it("contains an absent console method (console.warn === undefined) (#543)", async () => {
		const cwd = tempCwd();
		// `realWarn` AFTER mockRestore — before it, console.warn IS the spy.
		warnSpy.mockRestore();
		const realWarn = console.warn;
		// @ts-expect-error — a console with no `warn` at all is the hostile shape
		console.warn = undefined;
		const { log } = await freshLogger(undefined, "1", cwd);
		try {
			expect(() => log.warn("absent method survived")).not.toThrow();
		} finally {
			console.warn = realWarn;
		}
		expect(readLog(cwd)).toContain("absent method survived");
	});

	it("contains a console whose property ACCESS throws — selection inside the guard (#543)", async () => {
		const cwd = tempCwd();
		const realConsole = globalThis.console;
		const { log } = await freshLogger(undefined, "1", cwd);
		globalThis.console = new Proxy(realConsole, {
			get(target, prop, receiver) {
				if (prop === "warn") throw new Error("get trap blew up");
				return Reflect.get(target, prop, receiver);
			},
		});
		try {
			expect(() => log.warn("proxy survived")).not.toThrow();
		} finally {
			globalThis.console = realConsole;
		}
		expect(readLog(cwd)).toContain("proxy survived");
	});

	it("leaves the disabled mirror unchanged under a throwing console (#543)", async () => {
		const cwd = tempCwd();
		warnSpy.mockImplementation(() => {
			throw new Error("console blew up");
		});
		const { log } = await freshLogger(undefined, undefined, cwd);

		expect(() => log.warn("mirror off")).not.toThrow();
		expect(warnSpy).not.toHaveBeenCalled();
		expect(readLog(cwd)).toContain("mirror off");
	});

	it("keeps mirroring after a swallowed fault — same module instance (#543)", async () => {
		const cwd = tempCwd();
		warnSpy.mockImplementationOnce(() => {
			throw new Error("console blew up");
		});
		const { log } = await freshLogger(undefined, "1", cwd);

		expect(() => log.warn("faulting call")).not.toThrow();
		log.warn("healthy after fault");

		// Once per call, every call: a transient fault must not disable the mirror
		// for the rest of the process (#543 review, G1).
		expect(warnSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenLastCalledWith("[test] WARN: healthy after fault");
		expect(readLog(cwd)).toContain("faulting call");
		expect(readLog(cwd)).toContain("healthy after fault");
	});
});
