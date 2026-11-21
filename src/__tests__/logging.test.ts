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

	// --- #545: a cyclic/BigInt/hostile `data` payload must not throw out of `log.*` ---

	it("collapses a cyclic `data` payload to `[Circular]` and still logs it (#545)", async () => {
		const cwd = tempCwd();
		// The cycle is caller-side and self-referential — the shape the bare
		// `JSON.stringify` refused, which also suppressed the mirror and the write.
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		const { log } = await freshLogger(undefined, "1", cwd);

		expect(() => log.info("cyclic payload", cyclic)).not.toThrow();
		// The mirror is reached for a payload the replacer had to rewrite.
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalledWith("[test] INFO: cyclic payload");
		expect(readLog(cwd)).toContain('"data":{"a":1,"self":"[Circular]"}');
		expect(readLog(cwd)).toContain("cyclic payload");
	});

	it("encodes a `BigInt` in `data` as its decimal literal (#545)", async () => {
		const cwd = tempCwd();
		const { log } = await freshLogger(undefined, undefined, cwd);

		expect(() => log.info("bigint payload", { count: 10n, neg: -3n })).not.toThrow();
		expect(readLog(cwd)).toContain('"data":{"count":"10n","neg":"-3n"}');
		expect(readLog(cwd)).toContain("bigint payload");
	});

	it("emits a marker entry when a payload's own `toJSON` throws (#545)", async () => {
		const cwd = tempCwd();
		const hostile = {
			toJSON() {
				throw new Error("toJSON blew up");
			},
		};
		const { log } = await freshLogger(undefined, undefined, cwd);

		expect(() => log.info("toJSON payload", hostile)).not.toThrow();
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"toJSON blew up"}');
		expect(readLog(cwd)).toContain("toJSON payload");
	});

	it("emits a marker entry for a `data` Proxy whose `toJSON` get trap throws (#545)", async () => {
		const cwd = tempCwd();
		// A `get` trap alone: the `toJSON` lookup is the throw site here, a
		// distinct path from the `ownKeys` case below.
		const hostile = new Proxy(
			{ a: 1 },
			{
				get() {
					throw new Error("get trap blew up");
				},
			},
		);
		const { log } = await freshLogger(undefined, undefined, cwd);

		expect(() => log.info("get trap payload", hostile)).not.toThrow();
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"get trap blew up"}');
		expect(readLog(cwd)).toContain("get trap payload");
	});

	it("emits a marker entry for a `data` Proxy whose `ownKeys` trap throws (#545)", async () => {
		const cwd = tempCwd();
		// No `get` trap: the `toJSON` lookup succeeds (undefined) and the fault lands on
		// [[OwnPropertyKeys]] instead — a distinct path from the `get` case above.
		const hostile = new Proxy(
			{ a: 1 },
			{
				ownKeys() {
					throw new Error("ownKeys trap blew up");
				},
			},
		);
		const { log } = await freshLogger(undefined, undefined, cwd);

		expect(() => log.info("ownKeys payload", hostile as Record<string, unknown>)).not.toThrow();
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"ownKeys trap blew up"}');
		expect(readLog(cwd)).toContain("ownKeys payload");
	});

	it("falls back to `unknown fault` when the fault's own `.message` getter throws (#545)", async () => {
		const cwd = tempCwd();
		// The thrown value is not an Error: reading `.message` throws, so an unguarded
		// reason read would re-throw out of `log.*` from inside the fallback itself.
		const hostileFault = {
			get message(): string {
				throw new Error("message getter blew up");
			},
		};
		const { log } = await freshLogger(undefined, undefined, cwd);

		expect(() =>
			log.info("hostile fault", {
				toJSON() {
					throw hostileFault;
				},
			}),
		).not.toThrow();
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"unknown fault"}');
		expect(readLog(cwd)).toContain("hostile fault");
	});

	it("coerces a non-string prefix on the fallback path and keeps the line (#545)", async () => {
		const cwd = tempCwd();
		// `prefix` is typed `string`; a JS caller can still violate it. Without the
		// coercion the raw value is spread back into the marker entry, so a BigInt
		// prefix throws *inside* the fallback and the line is lost.
		const hostile = {
			get boom(): string {
				throw new Error("getter blew up");
			},
		};
		const { mod } = await freshLogger(undefined, undefined, cwd);
		const log = mod.createLogger(10n as unknown as string, cwd);

		expect(() => log.info("bad prefix", hostile)).not.toThrow();
		expect(readLog(cwd)).toContain('"prefix":"[unprintable prefix]"');
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"getter blew up"}');
	});

	it("keeps the exact entry shape and key order for serialisable `data` (#545)", async () => {
		const cwd = tempCwd();
		const { log } = await freshLogger(undefined, undefined, cwd);

		log.info("shape pinned", { agentId: "a1", task: "t" });

		// The replacer runs on EVERY entry: envelope and key order stay byte-identical.
		const line = readLog(cwd).trim();
		expect(line).toMatch(
			/^\{"timestamp":"[^"]+","level":"info","prefix":"test","message":"shape pinned","data":\{"agentId":"a1","task":"t"\}\}$/,
		);
		expect(JSON.parse(line)).toEqual({
			timestamp: expect.any(String),
			level: "info",
			prefix: "test",
			message: "shape pinned",
			data: { agentId: "a1", task: "t" },
		});
	});

	it("keeps a shared non-circular reference intact — ancestor tracking, not a seen-set (#545)", async () => {
		const cwd = tempCwd();
		// One object, two keys: a seen-set rewrites the second copy; tracking only
		// the current ancestor path keeps both.
		const shared = { id: 1 };
		const { log } = await freshLogger(undefined, undefined, cwd);

		log.info("shared reference", { left: shared, right: shared });
		expect(readLog(cwd)).toContain('"data":{"left":{"id":1},"right":{"id":1}}');
	});

	it("keeps logging after a swallowed payload fault — same module instance (#545)", async () => {
		const cwd = tempCwd();
		// A throwing getter, deliberately not a cycle: a cycle never reaches the
		// whole-stringify catch, so a latch planted there would be invisible.
		const hostile = {
			get boom(): string {
				throw new Error("getter blew up");
			},
		};
		const { log } = await freshLogger(undefined, "1", cwd);

		expect(() => log.warn("faulting payload", hostile)).not.toThrow();
		// r2: the getter path keeps its own byte-exact marker — a marker-text regression
		// on this path must be red here, not only on the `toJSON` case.
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"getter blew up"}');
		log.warn("healthy after fault");

		expect(warnSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenLastCalledWith("[test] WARN: healthy after fault");
		expect(readLog(cwd)).toContain("faulting payload");
		expect(readLog(cwd)).toContain("healthy after fault");
	});

	it("coerces a non-string message on the fallback path and keeps the line (#545)", async () => {
		const cwd = tempCwd();
		// `message` is typed `string`; a JS caller can still violate it. Without the
		// coercion the raw value is spread back into the marker entry, so a BigInt
		// message throws *inside* the fallback and the line is lost.
		const hostile = {
			get boom(): string {
				throw new Error("getter blew up");
			},
		};
		const { log } = await freshLogger(undefined, undefined, cwd);

		expect(() => log.info(10n as unknown as string, hostile)).not.toThrow();
		expect(readLog(cwd)).toContain('"message":"[unprintable message]"');
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"getter blew up"}');
	});
});
