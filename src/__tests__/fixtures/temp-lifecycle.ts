/**
 * Shared temp-dir + log-cwd lifecycle for suites that redirect the transcript
 * output dir, the session-manager storage dir, the run registry, the durable
 * head-state store and the logger's file sink into per-test throwaway
 * directories.
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
import { __setHeadStateDir } from "../../headstate";
import { __setScratchRoot } from "../../scratch-spawn";
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
	/** Issue #466: the durable head-state store (never the repo's real .pi/). */
	readonly headStateDir: string;
	/** Only meaningful when the env was created with `withCwd` (the default). */
	readonly testCwd: string;
	/**
	 * Issue #511 (U2): the throwaway scratch root every spawn in this test
	 * resolves under. It is NOT under `os.tmpdir()`: `/tmp` is `1777`, so the
	 * shipped resolver warns about a writable ancestor on every resolve — the
	 * root lives inside the repository's gitignored `.tmp/` chain instead.
	 */
	readonly scratchRoot: string;
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

/** A per-process counter so two fixtures in one tick never share a scratch root. */
let counter = 0;

/**
 * The repository-local root the scratch directories hang off. Created at 0700
 * and reused across fixtures: `.tmp/` is gitignored, and every ancestor above it
 * (the repo root, the home directory, `/`) is a non-group/other-writable
 * directory owned by this user or root — so a fixture here resolves with no
 * advisory at all (a writable ancestor is warned about, not refused).
 */
function repoTmp(): string {
	const dir = path.join(process.cwd(), ".tmp");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function createTempEnv(prefix: string, opts: TempEnvOptions = {}): TempEnv {
	const withCwd = opts.withCwd ?? true;

	let baseDir: string | undefined;
	let outputDir: string | undefined;
	let storageDir: string | undefined;
	let registryDir: string | undefined;
	let headStateDir: string | undefined;
	let testCwd: string | undefined;
	let scratchRoot: string | undefined;

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
			remove(scratchRoot);
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-pi-`));
			testCwd = withCwd
				? fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
				: undefined;
			outputDir = path.join(baseDir, "output");
			storageDir = path.join(baseDir, "subagents");
			registryDir = path.join(baseDir, "run-registry");
			headStateDir = path.join(baseDir, "head-state");
			__setOutputDir(outputDir);
			__setStorageDir(storageDir);
			__setRegistryDir(registryDir);
			__setHeadStateDir(headStateDir);
			// Issue #511 (U2): a spawn resolves + creates its run's scratch
			// directory, so the root is redirected too — otherwise a suite would
			// write into the developer's real `~/.cache/brl-subagent`. `.tmp/` is
			// gitignored and its chain passes the resolver's ancestor rule.
			scratchRoot = path.join(repoTmp(), `scratch-${process.pid}-${Date.now()}-${(counter += 1)}`);
			__setScratchRoot(scratchRoot);
		},
		async tearDown(): Promise<void> {
			// Same order as setUp's crossing: clear -> drain -> remove.
			setLogCwd(undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			remove(baseDir);
			remove(testCwd);
			remove(scratchRoot);
			// The redirect is deliberately NOT reset here: the global setup file
			// points it at the run's base, and `setUp()` replaces it again for the
			// next test. Resetting to `undefined` would let the gap between two
			// tests resolve the DEVELOPER's real cache root.
			baseDir = undefined;
			outputDir = undefined;
			storageDir = undefined;
			registryDir = undefined;
			headStateDir = undefined;
			testCwd = undefined;
			scratchRoot = undefined;
		},
		get scratchRoot(): string {
			return requireDir(`prefix "${prefix}"`, "scratchRoot", scratchRoot);
		},
		get baseDir(): string {
			return requireDir(`prefix "${prefix}"`, "baseDir", baseDir);
		},
		get outputDir(): string {
			return requireDir(`prefix "${prefix}"`, "outputDir", outputDir);
		},
		get headStateDir(): string {
			return requireDir(`prefix "${prefix}"`, "headStateDir", headStateDir);
		},
		get storageDir(): string {
			return requireDir(`prefix "${prefix}"`, "storageDir", storageDir);
		},
		get testCwd(): string {
			return requireDir(`prefix "${prefix}"`, "testCwd", testCwd);
		},
	};
}
