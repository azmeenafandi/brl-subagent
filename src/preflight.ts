// Purpose: Pre-spawn environment checks: pi binary, scratch-root writability, cwd readability.
/**
 * brl-subagent — Pre-flight Checks (R3)
 *
 * Validates the execution environment before spawning a subagent.
 * Checks: pi binary availability, **shipped scratch-root** writability (issue
 * #511, U4 — the last probe of a system-temp path), and project cwd
 * readability.
 *
 * THE THIRD CHECK IS AN EARLY WARNING, NOT THE AUTHORITY. It resolves the same
 * root the spawn uses and proves a file can be created where the root lives or
 * would be created; `prepareRunScratch` then re-resolves, re-validates the chain
 * and creates `<root>/runs/<id>` at 0700 on every spawn. This check exists so a
 * human learns before the dispatch does — never as the only place a bad root is
 * caught.
 *
 * LIMITS, stated rather than implied: the probe CREATES nothing durable — a
 * missing root stays missing (the spawn creates it), so a probe that passes on
 * a writable ancestor says "the root can be created here", not "the root is
 * sound"; a process killed between the write and the unlink leaves one 0600
 * `.brl-preflight-probe-<pid>-<n>` file in the root or its nearest existing
 * ancestor, recognisable and inert (nothing reads it, and no validation looks
 * at it); and no system-temp
 * path is probed, used as a fallback, or advised in a message any more
 * (`src/__tests__/no-temp-paths` is the guard).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getPiInvocation } from "./runner";
import { FILE_MODE, resolveRoot, type RootOptions } from "./scratch-root";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreflightResult = { ok: true } | { ok: false; error: string };

/** What a caller may inject. Production passes nothing. */
export interface PreflightOptions {
	/**
	 * Root-resolution inputs (U1's seam), injected by tests only — `home` is the
	 * one that moves the layout. Production lets `resolveRoot` read the real
	 * environment.
	 */
	root?: RootOptions;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Walk PATH for an executable `pi`, returning the first match.
 *
 * Mirrors the spawn-time fallback in `getPiInvocation` (the bare `"pi"`
 * case). Shared with the Tier-2 e2e harness (issue #271) so the preflight
 * check and the harness resolve the real binary identically.
 */
export function resolvePiOnPath(): string | undefined {
	const pathDirs = (process.env.PATH || "").split(path.delimiter);
	const isWindows = process.platform === "win32";
	const piNames = isWindows ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];

	for (const dir of pathDirs) {
		for (const name of piNames) {
			const fullPath = path.join(dir, name);
			try {
				fs.accessSync(fullPath, fs.constants.X_OK);
				return fullPath;
			} catch {
				// Not found in this directory — continue searching
			}
		}
	}

	return undefined;
}

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
	if (resolvePiOnPath()) {
		return { ok: true };
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

/** The probe's one name, so a leftover from a killed process is recognisable as ours. */
const PROBE_PREFIX = ".brl-preflight-probe";

/**
 * A per-process sequence, appended to the probe's name.
 *
 * The pid alone is not enough: `preflightCheck` runs BEFORE the concurrency slot
 * is taken, so two overlapping dispatches in one process can probe at the same
 * moment — and both would then write and unlink the SAME path, letting one
 * call's unlink make the other report "not writable" for a directory that is
 * perfectly writable. A distinct name per call removes the race without a lock.
 */
let probeSequence = 0;

/**
 * The nearest ancestor of `target` that exists — the directory a root that is
 * not there yet would be CREATED in, and therefore the one that must be
 * writable.
 *
 * `access` rather than `existsSync`: a directory we may not even look at is not
 * a directory we can create in, and treating it as "missing" would walk past it
 * and blame the wrong path. `dirname` is separator-agnostic and terminates at
 * the filesystem root, which is returned as-is when nothing above exists.
 */
function nearestExistingAncestor(target: string): string {
	let current = target;
	for (;;) {
		try {
			fs.accessSync(current, fs.constants.F_OK);
			return current;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return current;
			current = parent;
		}
	}
}

/**
 * Verify the shipped scratch root is writable, by creating and removing a
 * 0600 probe file (issue #511, U4 — the replacement for the `os.tmpdir()`
 * probe).
 *
 * WHERE it lands: inside the root when the root exists, otherwise in its
 * nearest existing ancestor, because that is where the root would be created.
 * A missing root is NOT a failure — the spawn creates it at 0700.
 *
 * WHERE the root comes from: `resolveRoot` (U1) with this module's injected
 * inputs. PRODUCTION passes none, so the resolver reads the real environment;
 * TESTS inject `{ home }`, the one input that moves the layout, which is why no
 * test here reads or writes the developer's real cache root. There is
 * deliberately NO module-level test redirect (the pattern `scratch-spawn.ts`
 * uses): a global setup file that imported this module would load it BEFORE a
 * suite registers `vi.mock("../runner")`, leaving this module bound to the real
 * runner and silently defeating every suite whose preflight is supposed to see a
 * mocked binary. The injected seam has no such ordering hazard.
 *
 * A refusal names the RESOLVED root, not the probe directory alone, so the line
 * a human reads is the path the spawn would use. There is no "set TMPDIR"
 * advice here: that advice belonged to the temp-dir probe this replaces, and the
 * root is not configurable by an environment variable.
 */
function checkScratchRootWritable(options: PreflightOptions): PreflightResult {
	const resolved = resolveRoot(options.root);
	if (!resolved.ok) {
		// A resolver refusal (no home, a root that is a symlink, a foreign owner, a
		// writable ancestor, a mode that is not 0700) IS a preflight failure, and
		// the resolver's code travels with it: one taxonomy, no re-wording.
		return {
			ok: false,
			error: `Scratch root could not be resolved (${resolved.code}): ${resolved.message}`,
		};
	}

	const probeDir = nearestExistingAncestor(resolved.root);
	probeSequence += 1;
	const probeFile = path.join(probeDir, `${PROBE_PREFIX}-${process.pid}-${probeSequence}`);

	try {
		fs.writeFileSync(probeFile, "ok", { encoding: "utf-8", mode: FILE_MODE });
		fs.unlinkSync(probeFile);
		return { ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `Scratch root (${resolved.root}) is not writable: ${message}. ` +
				`brl-subagent banks each run's progress under this root, so ${probeDir} must be writable by you.`,
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
export function preflightCheck(cwd: string, options: PreflightOptions = {}): PreflightResult {
	const piResult = checkPiBinary();
	if (!piResult.ok) return piResult;

	const cwdResult = checkCwdReadable(cwd);
	if (!cwdResult.ok) return cwdResult;

	const scratchResult = checkScratchRootWritable(options);
	if (!scratchResult.ok) return scratchResult;

	return { ok: true };
}
