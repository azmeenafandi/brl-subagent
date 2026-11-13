// Purpose: The shipped scratch root — platform cache resolution, the validated owner-only root, per-run directories, the settle marker, and retention pruning.

/**
 * brl-subagent — the shipped scratch root (issue #511, U1)
 *
 * WHY THIS MODULE EXISTS. The extension used to tell agents to bank progress in
 * `/tmp/brl-<label>-bank.md`. `/tmp` is world-writable (anyone can pre-create the path, and rename
 * authority over our file comes from write permission on its PARENT), ambiguous about who wrote it,
 * and on most Linux hosts a `tmpfs` — a bank that does not survive a reboot, which is the one
 * property a progress bank exists for. This module replaces the convention with one validated root
 * under the user's cache directory, and it is the only place a shipped scratch path is decided.
 *
 * MIRRORED, NOT IMPORTED. The tooling half (`scripts/lib/scratch-root.mjs`, #512/#516) owns the same
 * rules for the cockpit, but it is not shipped and it lives on a different surface (untyped `.mjs`
 * plus a CLI). The RULES are mirrored here: the two-zone chain predicate (every ancestor must be a
 * real directory owned by root or by us with no group/other write bit; the root itself must be ours
 * and exactly 0700), `lstat` and never a followed link, and an explicit `chmod` after `mkdir` so the
 * mode does not depend on the umask. Two DELIBERATE differences, both narrowing the shipped contract:
 *
 *   1. a Linux `tmpfs` root is a WARNING, not a refusal. A user may legitimately keep `$HOME` (and
 *      therefore `~/.cache`) on a `tmpfs` — a live session does exactly that — and refusing would
 *      break delegation for them. The bank is then announced as not surviving a reboot instead.
 *   2. the root is PLATFORM-SPECIFIC, because `~/.cache` is an XDG convention and not a portable
 *      one (see `rootLayout`). `XDG_CACHE_HOME` is deliberately ignored: a path from a user-writable
 *      environment variable is a path an attacker chooses, and this module's whole job is that the
 *      location is ours.
 *
 * NO TEMP FALLBACK, EVER. A root that cannot be placed is `home-unresolvable`, a named error. Falling
 * back to `os.tmpdir()` would reintroduce exactly the defect this module removes.
 *
 * THE POLARITY IS A NAMED RESULT, NEVER A THROW: `{ ok: true, … } | { ok: false, code, message }`.
 * `pruneRuns` is the one best-effort operation (a sweep must not break a run), so a removal failure is
 * reported in its return value and never thrown. `markRunDone`/`ensureRunDir` report their failures.
 *
 * LIMITS, stated rather than implied: a mount-namespace substitution by a user who already holds
 * privileges; NFS, where ownership and `chmod` semantics belong to the server; a root that becomes a
 * mount point, or is renamed by its owner, AFTER it was validated; and Windows, where `fs` reports no
 * meaningful `uid` and synthesized mode bits — the ownership and 0700 clauses are POSIX-only and are
 * skipped there (the symlink and directory clauses still hold).
 */

import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fchmodSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	rmdirSync,
	rmSync,
	statfsSync,
	type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The one directory below the root that holds per-run scratch directories. */
export const RUNS_DIR = "runs";

/** The progress-bank filename inside a run directory. One name, so the producer and the reader agree. */
export const BANK_FILENAME = "bank.md";

/** The settle marker: present means the run finished, so its directory is prunable once it ages out. */
export const DONE_MARKER = ".done";

/** Retention: a settled run directory older than this many days is pruned. */
export const KEEP_DAYS = 14;

/** The root's mode — owner-only, the confidentiality boundary for the bank's bytes. Every directory
 * this module creates is created at this mode too. */
export const ROOT_MODE = 0o700;

/** The settle marker's mode: owner-only read/write, no group or other bits. */
export const FILE_MODE = 0o600;

/**
 * Linux `TMPFS_MAGIC` — the `f_type` `statfs` reports for a `tmpfs` mount (`/tmp`, `/dev/shm`,
 * `/run/user/<uid>`). A magic number is a per-filesystem constant, never a portable one, which is why
 * the check that reads it runs on Linux alone.
 */
export const TMPFS_MAGIC = 0x01021994;

/** The named refusal codes. One spelling, so the caller, the messages and the tests cannot disagree. */
export const SCRATCH_ROOT_CODES = Object.freeze([
	"home-unresolvable",
	"root-symlink",
	"root-not-dir",
	"root-not-owned",
	"root-mode",
	"ancestor-writable",
	"ancestor-not-dir",
	"create-failed",
] as const);

/** The small, closed taxonomy: every refusal this module can produce is one of these spellings. */
export type ScratchRootCode = (typeof SCRATCH_ROOT_CODES)[number];

/** A refusal. `code` is the contract; `message` names the path and the clause that failed. */
export interface ScratchRootError {
	ok: false;
	code: ScratchRootCode;
	message: string;
}

/** `resolveRoot`: the root to use, plus the one advisory a valid root can carry (a `tmpfs` warning). */
export type ResolveRootResult =
	| { ok: true; root: string; warning?: string }
	| ScratchRootError;

/** `ensureRunDir`: the run's own directory, and what this call had to create to get there. */
export type EnsureRunDirResult =
	| { ok: true; root: string; runDir: string; created: string[] }
	| ScratchRootError;

/** `markRunDone`: the marker that was written. */
export type MarkRunDoneResult = { ok: true; path: string } | ScratchRootError;

/** Every seam `resolveRoot` needs, injected so the module is testable without the real home. */
export interface RootOptions {
	platform?: NodeJS.Platform;
	env?: Record<string, string | undefined>;
	/** Injectable; defaults to `os.homedir()` (which may itself fall back to the passwd entry). */
	home?: string;
	/** Injectable `statfs` (the mount-type probe). Defaults to `fs.statfsSync`. */
	statfs?: (path: string) => { type: number };
	/** Where the one advisory goes. No logger import: the caller decides. */
	warn?: (message: string) => void;
}

/** `pruneRuns`'s inputs. `now` is injected so the retention boundary is testable. */
export interface PruneOptions {
	now?: Date;
	keepDays?: number;
	/** The current run's directory — never pruned, whatever its age. */
	exclude?: string;
	/** Test seam for the one best-effort operation: the default is a recursive, forced remove. */
	remove?: (path: string) => void;
}

/** `pruneRuns` is best-effort: `failed` is the report, not an exception. */
export interface PruneResult {
	removed: string[];
	kept: string[];
	failed: { path: string; message: string }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function fail(code: ScratchRootCode, message: string): ScratchRootError {
	return { ok: false, code, message };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
	return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: "";
}

/**
 * A mode as the four octal digits that are ON DISK — `1777`, not `0777`. A refusal is the line a
 * reviewer reads as proof, and masking with `0o777` silently drops the sticky, setgid and setuid bits.
 */
export function formatMode(mode: number): string {
	return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** The current uid, or `null` on a host with no uid at all (Windows, and then no ownership clause). */
function currentUid(platform: NodeJS.Platform): number | null {
	if (platform === "win32") return null;
	const uid = process.getuid?.();
	return typeof uid === "number" ? uid : null;
}

// ---------------------------------------------------------------------------
// The platform map — where the root lives
// ---------------------------------------------------------------------------

/**
 * `<cache>/brl-subagent`, resolved per platform:
 *
 *   linux            `<home>/.cache/brl-subagent`      (and every other POSIX, as the documented default)
 *   darwin           `<home>/Library/Caches/brl-subagent`
 *   win32            `<env.LOCALAPPDATA>/brl-subagent`
 *
 * `XDG_CACHE_HOME` is IGNORED on purpose: it is an environment variable, so it is a path the caller's
 * environment chooses, and a root chosen by the environment is the class of defect this module exists
 * to remove. Path arithmetic uses `node:path`, so on a real Windows host the separators are Windows'.
 */
function rootLayout(options: {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	home: string | undefined;
}): { ok: true; root: string } | ScratchRootError {
	const { platform, env } = options;
	if (platform === "win32") {
		const localAppData = env.LOCALAPPDATA;
		if (typeof localAppData !== "string" || localAppData.trim() === "") {
			return fail(
				"home-unresolvable",
				"LOCALAPPDATA is not set — the Windows scratch root is <LOCALAPPDATA>/brl-subagent, and there is no passwd fallback and no system-temp fallback (a temp root is the defect this module removes)",
			);
		}
		return { ok: true, root: resolve(localAppData, "brl-subagent") };
	}
	const home = options.home;
	if (typeof home !== "string" || home.trim() === "") {
		return fail(
			"home-unresolvable",
			"the home directory could not be resolved — the scratch root is <home>/.cache/brl-subagent (POSIX) or <home>/Library/Caches/brl-subagent (macOS), and there is no system-temp fallback (a temp root is the defect this module removes)",
		);
	}
	if (platform === "darwin") return { ok: true, root: resolve(home, "Library", "Caches", "brl-subagent") };
	return { ok: true, root: resolve(home, ".cache", "brl-subagent") };
}

// ---------------------------------------------------------------------------
// The chain predicate — one component rule, three zones
// ---------------------------------------------------------------------------

/**
 * `/a/b/c` → [`/`, `/a`, `/a/b`, `/a/b/c`] by repeated `dirname`, which is separator-agnostic (a
 * `split(sep)` would need to know whether the host is POSIX or Windows and would still get a drive
 * letter wrong).
 */
function directoryChain(absolute: string): string[] {
	const chain = [absolute];
	let current = absolute;
	for (;;) {
		const parent = dirname(current);
		if (parent === current) break;
		chain.push(parent);
		current = parent;
	}
	return chain.reverse();
}

type Zone = "ancestor" | "root" | "below";

type Verdict = { ok: true } | ScratchRootError;

type Inspection = { kind: "found"; stats: Stats } | { kind: "missing" } | { kind: "unreadable"; error: unknown };

/** `lstat` without throwing: found, missing (`ENOENT`), or unreadable for another reason. */
function inspect(path: string): Inspection {
	try {
		return { kind: "found", stats: lstatSync(path) };
	} catch (error) {
		return codeOf(error) === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", error };
	}
}

/**
 * One component's verdict. The symlink and non-directory clauses come first in every zone, because
 * every later clause is a statement about a REAL directory.
 */
function checkComponent(path: string, stats: Stats, zone: Zone, uid: number | null): Verdict {
	if (stats.isSymbolicLink()) {
		return zone === "root"
			? fail(
					"root-symlink",
					`${path} is a symlink — the root is inspected with lstat and never followed (and never chmod-ed through: a chmod on a link retargets the link's target, which is someone else's choice of where the bank lands)`,
				)
			: fail(
					"ancestor-not-dir",
					`${path} is a symlink — the chain is validated with lstat and never followed, because whoever chose the link's target also chose where the bytes would land`,
				);
	}
	if (!stats.isDirectory()) {
		return zone === "root" ? fail("root-not-dir", `${path} is not a directory`) : fail("ancestor-not-dir", `${path} is not a directory`);
	}
	// No uid means no ownership model to judge (Windows). The directory and symlink clauses above are
	// the whole predicate there; `fs` synthesizes mode bits on Windows, so a mode clause would be noise.
	if (uid === null) return { ok: true };
	if (zone === "root") {
		if (stats.uid !== uid) {
			return fail(
				"root-not-owned",
				`${path} is owned by uid ${stats.uid}, not by you (uid ${uid}) — the root and everything below it must be yours`,
			);
		}
		if ((stats.mode & 0o7777) !== ROOT_MODE) {
			return fail(
				"root-mode",
				`${path} is mode ${formatMode(stats.mode)} — the root must be exactly ${formatMode(ROOT_MODE)}, the confidentiality boundary for the bank's bytes`,
			);
		}
		return { ok: true };
	}
	if (zone === "ancestor") {
		// Ownership is checked BEFORE the mode: a `0755` directory owned by a third party passes a
		// mode-only rule, and that owner can rename the validated root afterwards and substitute a
		// symlink. Write authority over a parent — by mode or by ownership — is rename authority.
		if (stats.uid !== 0 && stats.uid !== uid) {
			return fail(
				"ancestor-writable",
				`${path} is owned by uid ${stats.uid}, not by root or by you (uid ${uid}) — ownership of a parent is write (and therefore rename) authority over the root below it`,
			);
		}
		if ((stats.mode & 0o022) !== 0) {
			return fail(
				"ancestor-writable",
				`${path} is mode ${formatMode(stats.mode)} — group/other write on a parent is rename authority over the root below it`,
			);
		}
		return { ok: true };
	}
	// Below the root: no mode clause (a group-writable subdirectory is still only reachable through a
	// 0700 root, and refusing it would refuse `mktemp -d`-style directories for no gain).
	return stats.uid === uid ? { ok: true } : fail("root-not-owned", `${path} is owned by uid ${stats.uid}, not by you (uid ${uid})`);
}

/**
 * Walk from `/` down to `root`, applying the zone rule to every component. Never creates. A MISSING
 * component ends the judgement — everything below it is missing too, and a missing root is not a
 * failure here (creation is `ensureRunDir`'s job): what has been read is the part that exists, and the
 * part that exists is the part whose ownership and writability decide whether the rest is safe.
 */
function validateChain(root: string, uid: number | null): ScratchRootError | undefined {
	const chain = directoryChain(root);
	for (let index = 0; index < chain.length; index += 1) {
		const path = chain[index];
		const zone: Zone = index === chain.length - 1 ? "root" : "ancestor";
		const found = inspect(path);
		if (found.kind === "missing") return undefined;
		if (found.kind === "unreadable") {
			const error = codeOf(found.error) || describe(found.error);
			return zone === "root"
				? fail("root-not-dir", `cannot inspect ${path} (${error}) — the root must be a directory you own and can read`)
				: fail("ancestor-not-dir", `cannot inspect ${path} (${error})`);
		}
		const verdict = checkComponent(path, found.stats, zone, uid);
		if (!verdict.ok) return verdict;
	}
	return undefined;
}

/** `<root>/runs` and `<root>/runs/<runId>`, re-read after creation. */
function validateBelow(root: string, runId: string, uid: number | null): ScratchRootError | undefined {
	for (const path of [join(root, RUNS_DIR), join(root, RUNS_DIR, runId)]) {
		const found = inspect(path);
		if (found.kind === "missing") return fail("create-failed", `${path} does not exist after creation`);
		if (found.kind === "unreadable") {
			return fail("create-failed", `cannot inspect ${path} after creation (${codeOf(found.error) || describe(found.error)})`);
		}
		const verdict = checkComponent(path, found.stats, "below", uid);
		if (!verdict.ok) return verdict;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// The mount probe — advisory on the shipped surface
// ---------------------------------------------------------------------------

/**
 * The deepest existing REAL directory on `root`'s chain — the component whose filesystem a directory
 * we create would inherit. `null` means the chain holds something that is not a real directory (a
 * symlink, a file): the walk refuses it for its own reason, so there is no mount to report.
 */
function deepestExisting(root: string): string | null {
	let deepest: string | null = null;
	for (const path of directoryChain(root)) {
		const inspected = inspect(path);
		if (inspected.kind !== "found") break;
		if (inspected.stats.isSymbolicLink() || !inspected.stats.isDirectory()) return null;
		deepest = path;
	}
	return deepest;
}

/**
 * A `tmpfs` root is a WARNING on this surface, not a refusal (difference 1 in the header): the bank
 * does not survive a reboot, and the user is told so. The probe is the deepest existing component, so
 * a root that does not exist yet is judged by the ancestor it would be created in.
 *
 * LINUX ONLY, documented inline: `f_type` magic numbers are not portable and this module does not
 * guess another platform's. An unreadable mount type yields no warning either — the property is
 * advisory here, and a warning nobody can act on is noise (the tooling half refuses instead).
 */
function mountWarning(root: string, platform: NodeJS.Platform, statfs: (path: string) => { type: number }): string | undefined {
	if (platform !== "linux") return undefined;
	const probe = deepestExisting(root);
	if (probe === null) return undefined;
	let type: number;
	try {
		type = statfs(probe).type;
	} catch {
		return undefined;
	}
	if (type !== TMPFS_MAGIC) return undefined;
	const inherited =
		probe === resolve(root)
			? ""
			: ` (${resolve(root)} does not exist yet, and a directory created inside ${probe} inherits its filesystem)`;
	return `${probe} is on a tmpfs — the progress bank will not survive a reboot${inherited}`;
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/**
 * Resolve the root for this platform and validate its chain WITHOUT creating anything:
 * `{ ok: true, root }` (plus `warning` when it is on a `tmpfs`), or a named refusal.
 *
 * A root that does not exist yet is valid — `ensureRunDir` creates it — as long as the components that
 * DO exist pass the predicate.
 */
export function resolveRoot(options: RootOptions = {}): ResolveRootResult {
	const platform = options.platform ?? process.platform;
	const layout = rootLayout({
		platform,
		env: options.env ?? process.env,
		home: options.home ?? homedir(),
	});
	if (!layout.ok) return layout;
	const uid = currentUid(platform);
	const refusal = validateChain(layout.root, uid);
	if (refusal !== undefined) return refusal;
	const warning = mountWarning(layout.root, platform, options.statfs ?? statfsSync);
	if (warning === undefined) return { ok: true, root: layout.root };
	options.warn?.(warning);
	return { ok: true, root: layout.root, warning };
}

/** A run id is ONE path segment: no separators, no `.`/`..`, nothing that could name another path. */
function isSafeRunId(runId: unknown): runId is string {
	return (
		typeof runId === "string" &&
		runId !== "" &&
		runId !== "." &&
		runId !== ".." &&
		!runId.includes("\0") &&
		!runId.includes("/") &&
		!runId.includes("\\")
	);
}

/**
 * Remove what THIS call created, deepest first, and hand the refusal back. `rmdir` rather than a
 * recursive remove on purpose: only EMPTY directories go, so a directory another process has since
 * written into is left alone — "remove what we created" must not become "delete someone else's work".
 */
function rollback(created: string[], refusal: ScratchRootError): ScratchRootError {
	for (const path of [...created].reverse()) {
		try {
			rmdirSync(path);
		} catch {
			// Not empty, already gone, or not ours any more: leaving it is the safe half of best-effort.
		}
	}
	return refusal;
}

/**
 * Create one component at `ROOT_MODE`, validating every existing one on the way down. `mkdirSync`'s
 * mode is MASKED by the umask (a `0777` umask produces a `0000` directory), so the explicit `chmod` is
 * what makes `0700` true — and it runs only after `lstat` says a real directory is standing there,
 * because a `chmod` through a link would retarget the LINK's target instead.
 */
function createComponent(path: string, zone: Zone, uid: number | null, created: string[]): Verdict {
	const found = inspect(path);
	if (found.kind === "found") return checkComponent(path, found.stats, zone, uid);
	if (found.kind === "unreadable") {
		return fail("create-failed", `cannot inspect ${path} (${codeOf(found.error) || describe(found.error)})`);
	}
	try {
		mkdirSync(path, { mode: ROOT_MODE });
	} catch (error) {
		if (codeOf(error) !== "EEXIST") {
			return fail("create-failed", `cannot create ${path} (${codeOf(error) || describe(error)})`);
		}
		// Another process won the race: the directory exists, so it is VALIDATED, never chmod-ed — a
		// mode we did not set is not ours to repair.
		const raced = inspect(path);
		if (raced.kind !== "found") return fail("create-failed", `${path} vanished after mkdir`);
		return checkComponent(path, raced.stats, zone, uid);
	}
	created.push(path);
	const made = inspect(path);
	if (made.kind !== "found") return fail("create-failed", `${path} vanished after mkdir`);
	if (made.stats.isSymbolicLink()) {
		return fail("create-failed", `${path} is a symlink immediately after mkdir — refusing to chmod through it`);
	}
	try {
		chmodSync(path, ROOT_MODE);
	} catch (error) {
		return fail("create-failed", `cannot set mode ${formatMode(ROOT_MODE)} on ${path} (${codeOf(error) || describe(error)})`);
	}
	return { ok: true };
}

/**
 * Create `<root>`, `<root>/runs` and `<root>/runs/<runId>` at `0700` (umask-independent), validating
 * the chain BEFORE (nothing is created inside a directory that has not passed) and AFTER (the bytes on
 * disk are what the predicate is asked about). A failed check removes only what this call created.
 *
 * Missing components above `<root>` (`~/.cache`, for instance, on a fresh account) are created too —
 * they are part of the same chain, and a root cannot be created without them. An EXISTING component is
 * validated and never repaired: changing a mode we did not set would be a silent privilege grab.
 */
export function ensureRunDir(root: string, runId: string, options: { platform?: NodeJS.Platform } = {}): EnsureRunDirResult {
	if (!isSafeRunId(runId)) {
		return fail(
			"create-failed",
			`refusing run id ${JSON.stringify(runId)} — a run id is one path segment (no separators, no "." or ".."), because it is joined onto the root and must not be able to name anything outside it`,
		);
	}
	const base = resolve(root);
	const platform = options.platform ?? process.platform;
	const uid = currentUid(platform);
	const before = validateChain(base, uid);
	if (before !== undefined) return before;

	const created: string[] = [];
	const chain = directoryChain(base);
	for (let index = 0; index < chain.length; index += 1) {
		const verdict = createComponent(chain[index], index === chain.length - 1 ? "root" : "ancestor", uid, created);
		if (!verdict.ok) return rollback(created, verdict);
	}
	const runDir = join(base, RUNS_DIR, runId);
	for (const path of [join(base, RUNS_DIR), runDir]) {
		const verdict = createComponent(path, "below", uid, created);
		if (!verdict.ok) return rollback(created, verdict);
	}

	const after = validateChain(base, uid) ?? validateBelow(base, runId, uid);
	if (after !== undefined) return rollback(created, after);
	return { ok: true, root: base, runDir, created };
}

/**
 * Write the settle marker (`.done`, mode `0600`, empty — the content is irrelevant, its MTIME is the
 * retention clock). The flag set is explicit and carries `O_NOFOLLOW` where the host defines it, so a
 * planted link is never followed; `fchmod` on the open descriptor then makes `0600` true regardless of
 * the umask.
 */
export function markRunDone(runDir: string): MarkRunDoneResult {
	const path = join(runDir, DONE_MARKER);
	const flags = fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0);
	let fd: number;
	try {
		fd = openSync(path, flags, FILE_MODE);
	} catch (error) {
		return fail("create-failed", `cannot write ${path} (${codeOf(error) || describe(error)})`);
	}
	try {
		fchmodSync(fd, FILE_MODE);
		return { ok: true, path };
	} catch (error) {
		return fail("create-failed", `cannot set mode ${formatMode(FILE_MODE)} on ${path} (${codeOf(error) || describe(error)})`);
	} finally {
		closeSync(fd);
	}
}

/** The settle marker's mtime, or `undefined` when there is no marker (or it is a planted symlink). */
function settledAt(runDir: string): number | undefined {
	try {
		const stats = lstatSync(join(runDir, DONE_MARKER));
		return stats.isSymbolicLink() ? undefined : stats.mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * Prune settled run directories: only a directory that contains a `.done` marker whose MTIME is older
 * than `keepDays` is removed, and never `exclude` (the current run). An UNMARKED directory — live,
 * queued, or crashed — is never pruned: "no marker" is not evidence of death, and deleting a live
 * run's bank is worse than a cache that grows.
 *
 * Best effort by construction: a missing `runs` directory, an unreadable entry and a failed removal are
 * all reported, never thrown, because this sweep runs on the settle path where an exception would be a
 * failure unrelated to the user's task.
 */
export function pruneRuns(root: string, options: PruneOptions = {}): PruneResult {
	const now = options.now ?? new Date();
	const keepDays = options.keepDays ?? KEEP_DAYS;
	const cutoff = now.getTime() - keepDays * DAY_MS;
	const exclude = options.exclude === undefined ? undefined : resolve(options.exclude);
	const remove = options.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
	const runsDir = join(resolve(root), RUNS_DIR);
	const result: PruneResult = { removed: [], kept: [], failed: [] };
	let entries;
	try {
		// `withFileTypes`: a dirent never follows a link, so a symlink named like a run is not a run.
		entries = readdirSync(runsDir, { withFileTypes: true });
	} catch {
		return result;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const runDir = join(runsDir, entry.name);
		const settled = settledAt(runDir);
		if (settled === undefined || settled > cutoff || (exclude !== undefined && resolve(runDir) === exclude)) {
			result.kept.push(runDir);
			continue;
		}
		try {
			remove(runDir);
			result.removed.push(runDir);
		} catch (error) {
			result.failed.push({ path: runDir, message: codeOf(error) || describe(error) });
		}
	}
	return result;
}

/** The bank's path inside a run directory — one definition, so the writer and the reader cannot drift. */
export function bankPath(runDir: string): string {
	return join(runDir, BANK_FILENAME);
}
