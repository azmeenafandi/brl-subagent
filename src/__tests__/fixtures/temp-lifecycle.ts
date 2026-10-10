/**
 * Shared temp-dir + log-cwd lifecycle for suites that redirect the transcript
 * output dir, the session-manager storage dir, and the logger's file sink into
 * per-test throwaway directories.
 *
 * ORDER MATTERS, and this helper enforces it so every suite gets it right:
 *
 *   clear log cwd  ->  drain the event loop  ->  rmSync the dirs
 *
 * `logging.ts` resolves its cwd per call and `mkdirSync`s the resulting path,
 * so a late/async write landing after a delete silently re-creates the
 * directory. That late write is exactly how issue #277 left `/tmp` litter
 * behind: one copy-pasted teardown had dropped the `setLogCwd(undefined)`
 * step. Clearing the sink FIRST, then yielding one `setImmediate` turn,
 * guarantees no in-flight write can resurrect a dir removed below.
 *
 * Every directory here is a per-test throwaway under `os.tmpdir()`:
 * `setUp()` creates fresh ones and disposes of the previous test's, so a
 * suite may call it repeatedly (once per test) without leaking.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __setOutputDir } from "../../transcript";
import { __setStorageDir } from "../../session-manager";
import { __setRegistryDir } from "../../run-registry";
import { setLogCwd } from "../../logging";

export interface TempEnvOptions {
	/** Also create a per-test `testCwd` (default: true). */
	withCwd?: boolean;
}

export interface TempEnv {
	/** Create fresh per-test dirs and point the module redirects at them. */
	setUp(): void;
	/** Clear the log sink, drain one event-loop turn, then remove the dirs. */
	tearDown(): Promise<void>;
	readonly baseDir: string;
	readonly outputDir: string;
	readonly storageDir: string;
	/** Only meaningful when the env was created with `withCwd` (the default). */
	readonly testCwd: string;
}

function requireDir(helper: string, name: string, value: string | undefined): string {
	if (value === undefined) {
		throw new Error(
			`temp-lifecycle: cannot read \`${name}\` before createTempEnv().setUp() ` +
				`(from ${helper}) — call setUp() in beforeEach first`,
		);
	}
	return value;
}

export function createTempEnv(prefix: string, opts: TempEnvOptions = {}): TempEnv {
	const withCwd = opts.withCwd ?? true;

	let baseDir: string | undefined;
	let outputDir: string | undefined;
	let storageDir: string | undefined;
	let registryDir: string | undefined;
	let testCwd: string | undefined;

	const remove = (dir: string | undefined): void => {
		if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
	};

	return {
		setUp(): void {
			// Clear the sink FIRST: the logger still points at the PREVIOUS
			// test's cwd until the next session_start re-points it, so an
			// async write landing here would re-create a dir we're deleting.
			setLogCwd(undefined);
			remove(baseDir);
			remove(testCwd);
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-pi-`));
			testCwd = withCwd
				? fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
				: undefined;
			outputDir = path.join(baseDir, "output");
			storageDir = path.join(baseDir, "subagents");
			registryDir = path.join(baseDir, "run-registry");
			__setOutputDir(outputDir);
			__setStorageDir(storageDir);
			__setRegistryDir(registryDir);
		},
		async tearDown(): Promise<void> {
			// Same order as setUp's crossing: clear -> drain -> remove.
			setLogCwd(undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			remove(baseDir);
			remove(testCwd);
			baseDir = undefined;
			outputDir = undefined;
			storageDir = undefined;
			registryDir = undefined;
			testCwd = undefined;
		},
		get baseDir(): string {
			return requireDir(`prefix "${prefix}"`, "baseDir", baseDir);
		},
		get outputDir(): string {
			return requireDir(`prefix "${prefix}"`, "outputDir", outputDir);
		},
		get storageDir(): string {
			return requireDir(`prefix "${prefix}"`, "storageDir", storageDir);
		},
		get testCwd(): string {
			return requireDir(`prefix "${prefix}"`, "testCwd", testCwd);
		},
	};
}
