// Purpose: The spawn seam for the shipped scratch root — resolves, creates, prunes and settles one run's directory.
/**
 * brl-subagent — the scratch root at the spawn seam (issue #511, U2)
 *
 * WHY THIS MODULE EXISTS. `scratch-root.ts` (U1) decides WHERE a scratch path is
 * allowed to live and how one is created safely; it creates nothing on its own.
 * This module is the one caller that turns that verdict into a run's directory
 * on the way to a spawn, so the two execution surfaces cannot disagree about
 * the shape of a run's scratch:
 *
 *   - FOREGROUND — `runner.ts` (`runSubagent`), the chokepoint every blocking
 *     dispatch passes through: single, chain, parallel, graph, and the timeout
 *     retry. The child is a real `pi` subprocess, so the directory rides its
 *     environment as `BRL_SCRATCH` (an `envOverrides` entry, which `getSafeEnv`
 *     applies LAST — so a value inherited from the parent process is replaced,
 *     never trusted).
 *   - BACKGROUND — `session-manager.ts` (`spawnBackgroundSession`), the single
 *     place a background agent record and run entry are created: single,
 *     fan-out and the transport retry all funnel through it. A background agent
 *     is an IN-PROCESS SDK session, not a subprocess — there is no per-run child
 *     environment to set (the SDK builds the shell env from `process.env` at
 *     command time, so a per-run value there would be process-global and racy).
 *     The directory and the run record's `scratchDir` are therefore the whole
 *     carrier on that surface.
 *
 * WHY THE SEAM IS NOT IN THE PREFLIGHT OR A BACKGROUND-ONLY TAIL. The
 * foreground path deliberately skips the preflight, so a decision made there
 * would miss every blocking dispatch; and resolving inside the background tail
 * would miss the foreground one. Both surfaces call THIS module at their own
 * spawn point instead.
 *
 * THE INVARIANT, stated once: by the time a child starts, `<root>/runs/<runId>`
 * exists at 0700 and the child's environment carries that absolute path as
 * `BRL_SCRATCH`. A refusal is named and PRE-SPAWN: the caller gets the code and
 * message and no child starts (`runner.ts` returns the refusal as a failed
 * result; `session-manager.ts` throws before the agent record exists, and its
 * callers translate that into their ordinary spawn-failure shape).
 *
 * THE RESOLVER NEVER READS `BRL_SCRATCH`. `resolveRoot` reads `HOME` /
 * `LOCALAPPDATA` only, so a child cannot steer its own root — and because
 * `BRL_SCRATCH` is deliberately NOT in `getSafeEnv`'s allowlist, a nested child
 * resolves its OWN root instead of inheriting its parent's (the parent's value
 * is a path the parent chose; the grandchild's run is a different directory).
 *
 * BEST-EFFORT, NAMED AS SUCH. Two operations here can fail without failing the
 * spawn: the retention prune (`pruneRuns` reports, never throws) and the settle
 * marker (`markRunDone`); both log and continue. Resolution and creation are the
 * opposite — they are named refusals that stop the spawn.
 */

import { createLogger, type Logger } from "./logging";
import {
	ensureRunDir,
	markRunDone,
	pruneRuns,
	resolveRoot,
	type RootOptions,
	type RootWarningKind,
	type ScratchRootCode,
} from "./scratch-root";

/**
 * The child environment key carrying the run's scratch directory. Set through
 * `envOverrides` (applied last by `getSafeEnv`), never allowlisted: an
 * inherited value must be REPLACED, and a grandchild must resolve its own.
 */
export const SCRATCH_ENV_KEY = "BRL_SCRATCH";

/**
 * The logger for a seam whose caller has none to pass (`createUnitRun` writes a
 * run record before any mode's logger is threaded through). Mirrors
 * `runner.ts`'s `fallbackLog`: a diagnostic the caller could not instrument
 * still has somewhere to land, and it is never dropped silently.
 */
const fallbackLog = createLogger("scratch");

/**
 * `prepareRunScratch`'s verdict: the run's directory, or the resolver's named
 * refusal. The `ok: false` arm carries the U1 code verbatim — one taxonomy, so
 * the caller, the message and the tests cannot drift.
 */
export type RunScratch =
	| { ok: true; root: string; runDir: string }
	| { ok: false; code: ScratchRootCode; message: string };

/** What a caller may inject. Production passes nothing but the logger. */
export interface PrepareScratchOptions {
	/** The seam's own sink. Absent falls back to the module logger. */
	log?: Logger;
	/**
	 * Root-resolution inputs, injected by tests only (`home` is the one that
	 * moves the layout). Production lets `resolveRoot` read the real environment.
	 */
	root?: RootOptions;
	/**
	 * The retention sweep, injected by tests only. Production uses `pruneRuns`;
	 * the injection exists so the containment below (a throwing sweep must not
	 * fail a spawn) is asserted against a sweep that really throws, rather than
	 * claimed from `pruneRuns`'s own best-effort contract.
	 */
	prune?: typeof pruneRuns;
}

// ---------------------------------------------------------------------------
// Test-only redirects (mirroring __setStorageDir / __setRegistryDir)
// ---------------------------------------------------------------------------

/**
 * A test-only root redirect. The suites that exercise a spawn cannot thread
 * `RootOptions` through `runSubagent`/`spawnBackgroundSession`, and they must
 * not write into the developer's real cache root. When set, the root is used
 * AS GIVEN — `ensureRunDir` still validates the chain and creates at 0700, so
 * the seam's guarantees are unchanged; only the platform map is bypassed.
 *
 * `createTempEnv` points this at a throwaway directory per test, so no suite
 * creates anything under the real `$HOME`.
 */
let rootRedirect: string | undefined;

/** TEST-ONLY: resolve every run's scratch under `root` instead of the platform cache. */
export function __setScratchRoot(root: string | undefined): void {
	rootRedirect = root;
}

/** TEST-ONLY: forget the once-per-process root advisory. */
export function __resetScratchWarning(): void {
	warnedRoot.clear();
}

// ---------------------------------------------------------------------------
// The root advisory — once per process, never once per run
// ---------------------------------------------------------------------------

/**
 * The advisory KINDS already emitted, not one boolean. The resolver can carry two different warnings
 * (a `tmpfs` mount and a group/other-writable ancestor, or both joined into one string), and a single
 * flag would let the first kind swallow the second: the process would learn about the writable parent
 * only if it happened to be resolved first. Keyed by kind rather than by text, because the mount
 * sentence legitimately changes wording once the root exists (see `ROOT_WARNING_KINDS`).
 */
const warnedRoot = new Set<RootWarningKind>();

/**
 * One line per advisory KIND per process: a fan-out of twenty units prints one line, never twenty. A
 * report can carry both kinds at once, and then that ONE line carries both sentences; a kind already
 * reported never re-logs on its own, which is the whole point of keying on kinds rather than on one
 * boolean — a single flag would let the first kind swallow the second.
 */
function warnRootOnce(warning: string, kinds: readonly RootWarningKind[], log: Logger): void {
	const fresh = kinds.filter((kind) => !warnedRoot.has(kind));
	if (fresh.length === 0) return;
	for (const kind of fresh) warnedRoot.add(kind);
	log.warn(`scratch root: ${warning}`);
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/**
 * Resolve the root, create `<root>/runs/<runId>` at 0700, and prune settled
 * runs — the one call both spawn surfaces make.
 *
 * Order matters. Resolution comes first (a refusal there means nothing is
 * created), then creation (`ensureRunDir` validates the chain before and after),
 * then the sweep (which must never see the current run as prunable, hence
 * `exclude`). Pruning AFTER creation is what makes `exclude` meaningful: the
 * directory it protects is the one that was just made.
 *
 * A prune failure is contained here, not by the caller: a retention sweep that
 * cannot delete a directory is a cache that grows, never a spawn that fails.
 */
export function prepareRunScratch(runId: string, options: PrepareScratchOptions = {}): RunScratch {
	const log = options.log ?? fallbackLog;
	// Precedence, stated once: an EXPLICIT injection wins (the module's own
	// tests), then the suite-level redirect (`createTempEnv`, the global test
	// setup), then the resolver's real defaults — the production path.
	const resolved =
		options.root !== undefined
			? resolveRoot(options.root)
			: rootRedirect !== undefined
				? { ok: true as const, root: rootRedirect }
				: resolveRoot();
	if (!resolved.ok) {
		log.warn(`scratch root: refusing the spawn (${resolved.code}) — ${resolved.message}`);
		return { ok: false, code: resolved.code, message: resolved.message };
	}
	if (resolved.warning !== undefined) warnRootOnce(resolved.warning, resolved.warningKinds ?? [], log);

	const run = ensureRunDir(resolved.root, runId, options.root?.platform ? { platform: options.root.platform } : {});
	if (!run.ok) {
		log.warn(`scratch run dir: refusing the spawn (${run.code}) — ${run.message}`);
		return { ok: false, code: run.code, message: run.message };
	}

	pruneSettled(run.root, run.runDir, log, options.prune ?? pruneRuns);
	return { ok: true, root: run.root, runDir: run.runDir };
}

/** The retention sweep: report what it removed, never throw, never fail the spawn. */
function pruneSettled(root: string, runDir: string, log: Logger, sweep: typeof pruneRuns): void {
	try {
		const pruned = sweep(root, { exclude: runDir });
		if (pruned.removed.length > 0) {
			log.debug("scratch root: pruned settled run directories", {
				root,
				removed: pruned.removed.length,
				kept: pruned.kept.length,
			});
		}
	} catch (error) {
		// `pruneRuns` reports rather than throws by construction; this belt covers
		// a future edit of that contract, because a sweep is never worth a run.
		log.warn("scratch root: prune failed — the spawn continues", {
			root,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// ---------------------------------------------------------------------------
// The settle marker
// ---------------------------------------------------------------------------

/**
 * Write the run's settle marker (`.done`) on a terminal path: done, failed or
 * killed. Best-effort by contract — a marker that cannot be written is logged
 * and the run's outcome is untouched, because retention is an optimization and
 * boundedness is not this function's business.
 *
 * A run without a `scratchDir` (a pre-U2 record, or one whose preparation was
 * refused before anything was created) is a no-op: there is no directory to
 * mark, and a `.done` written beside a directory that does not exist would be a
 * marker for nothing.
 */
export function markSettled(run: { id?: string; scratchDir?: string }, log?: Logger): void {
	if (run.scratchDir === undefined) return;
	const sink = log ?? fallbackLog;
	try {
		const marked = markRunDone(run.scratchDir);
		if (!marked.ok) {
			sink.warn("scratch root: settle marker not written — the run's outcome is unchanged", {
				runId: run.id,
				runDir: run.scratchDir,
				code: marked.code,
				error: marked.message,
			});
		}
	} catch (error) {
		sink.warn("scratch root: settle marker threw — the run's outcome is unchanged", {
			runId: run.id,
			runDir: run.scratchDir,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
