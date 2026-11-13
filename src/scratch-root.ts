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
 * plus a CLI). The RULES are mirrored here: the two-zone chain predicate (every ancestor must be a real
 * directory owned by root or by us — a FOREIGN OWNER is refused — and the root itself must be ours and
 * exactly 0700), `lstat` as the first read with a link refused at the ROOT and resolved — then
 * validated — above it, and an explicit `chmod` after `mkdir` so the mode does not depend on the
 * umask. Three DELIBERATE differences: the first two narrow the shipped contract, the third relaxes one
 * clause and says why.
 *
 *   1. a Linux `tmpfs` root is a WARNING, not a refusal. A user may legitimately keep `$HOME` (and
 *      therefore `~/.cache`) on a `tmpfs` — a live session does exactly that — and refusing would
 *      break delegation for them. The bank is then announced as not surviving a reboot instead.
 *   2. the root is PLATFORM-SPECIFIC, because `~/.cache` is an XDG convention and not a portable
 *      one (see `rootLayout`). `XDG_CACHE_HOME` is deliberately ignored: a path from a user-writable
 *      environment variable is a path an attacker chooses, and this module's whole job is that the
 *      location is ours.
 *   3. a GROUP/OTHER-WRITABLE ANCESTOR is a WARNING, not a refusal (the tooling half still refuses it).
 *      A shipped extension must not refuse to run on a shared or corporate machine whose home — or
 *      whose `~/.cache` — is group-writable (`0775`/`0770`), and the bank is a CONVENIENCE: the tmpfs
 *      warning (difference 1) already accepts a stated risk rather than refusing to work. What is NOT
 *      relaxed is OWNERSHIP: an ancestor owned by a third uid is a different trust boundary (its owner
 *      can rename what is below it whatever the mode), so it keeps refusing under its own code,
 *      `ancestor-not-owned`.
 *
 * NO TEMP FALLBACK, EVER. A root that cannot be placed is `home-unresolvable`, a named error. Falling
 * back to `os.tmpdir()` would reintroduce exactly the defect this module removes.
 *
 * THE POLARITY IS A NAMED RESULT, NEVER A THROW: `{ ok: true, … } | { ok: false, code, message }`.
 * `pruneRuns` is the one best-effort operation (a sweep must not break a run), so a removal failure is
 * reported in its return value and never thrown. `markRunDone`/`ensureRunDir` report their failures.
 *
 * LIMITS, stated rather than implied: group/other write on an ancestor (WARNED here — difference 3 — and
 * refused by the tooling half, so a co-worker with write on that parent can still replace the run
 * directory, and the bank path with it; the warning names the path, the mode and that consequence); a
 * mount-namespace substitution by a user who already holds
 * privileges; NFS, where ownership and `chmod` semantics belong to the server; a root that becomes a
 * mount point, or is renamed by its owner, AFTER it was validated; a symlinked ancestor whose resolved
 * directory is renamed or re-pointed between the `realpath` and the `mkdir` (the TOCTOU window, one
 * link further out, and not closable without an `openat`-style primitive that holds the directory open
 * while it is judged); and Windows, where `fs` reports no meaningful `uid` and synthesized mode bits —
 * the ownership and 0700 clauses are POSIX-only and are skipped there (the symlink and directory
 * clauses still hold, above a resolved target's chain exactly as along the literal one).
 */

import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fchmodSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	readdirSync,
	rmdirSync,
	rmSync,
	statfsSync,
	statSync,
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
	// RETAINED, though this surface no longer produces it: the tooling half still refuses under this
	// spelling (difference 3 in the header), and the relaxed clause here is the warning KIND of the same
	// name. Dropping the spelling would split one vocabulary across two surfaces for no gain.
	"ancestor-writable",
	"ancestor-not-owned",
	"ancestor-not-dir",
	"bad-run-id",
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

/**
 * The kinds of advisory a valid root can carry. One kind is one sentence inside the joined `warning`
 * string — `tmpfs` (the bank does not survive a reboot) and `ancestor-writable` (a co-worker with write
 * on a parent can replace the run directory). A separate field because the SENTENCE is not a stable key:
 * the mount sentence gains a "does not exist yet" clause when the root is created between two calls, so
 * a log-once rule keyed on the text would print the same advisory twice under two spellings.
 */
export const ROOT_WARNING_KINDS = Object.freeze(["tmpfs", "ancestor-writable"] as const);

/** The kind of an advisory, as the caller dedupes it: one kind, one log line per process. */
export type RootWarningKind = (typeof ROOT_WARNING_KINDS)[number];

/**
 * `resolveRoot`: the root to use, plus the advisory a valid root can carry — a `tmpfs` mount warning, an
 * ancestor-writability warning, or both joined with `"; "`. One string, because a valid root has one
 * advisory report; the caller logs it, never parses it, and `warningKinds` names what is inside it so a
 * caller can dedupe by KIND rather than by wording.
 */
export type ResolveRootResult =
	| { ok: true; root: string; warning?: string; warningKinds?: RootWarningKind[] }
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
	/** Where the advisory goes (the same joined string the result carries). No logger import: the caller decides. */
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

/**
 * A component's (or a walk's) verdict. The `ok` arm can carry an ADVISORY: a chain can be safe to use
 * and still be worth a sentence (group/other write on a parent), so the warning travels with the verdict
 * that produced it rather than being re-derived by the caller — one place decides what a warning says.
 */
type Verdict = { ok: true; warning?: string } | ScratchRootError;

/** One warning string out of several sentences, or `undefined` when there are none. Never reorders. */
function combineWarnings(parts: (string | undefined)[]): string | undefined {
	const kept = parts.filter((part): part is string => part !== undefined && part !== "");
	return kept.length === 0 ? undefined : kept.join("; ");
}

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
 * The ANCESTOR's two clauses, shared by a real directory, by the directory a link resolves to, and by the
 * directories ABOVE that resolved target (`checkTargetAncestors`). `label` is how a message names the
 * component: the path itself, `<link> (a symlink to <target>)`, or `<link> (a symlink to <target>),
 * whose parent <dir>`, so the reader is never sent to a mode the link does not have.
 *
 * The two clauses have DIFFERENT polarities on purpose (difference 3 in the header). OWNERSHIP refuses:
 * a third-party owner can rename the validated root afterwards and substitute a symlink whatever the
 * mode, so a foreign owner is `ancestor-not-owned` — a different trust boundary, not a different mode.
 * WRITABILITY WARNS: a group/other write bit on a machine shared with co-workers is ordinary
 * (`0775`/`0770` homes, the `1777` `/tmp` shape), the bank is a convenience, and refusing would refuse to
 * run at all on such a host. The sentence names the path, the on-disk mode and the consequence — and the
 * consequence is stated per shape, because the sticky bit changes it.
 *
 * Ownership is still checked BEFORE the mode: a `0755` directory owned by a third party passes a
 * mode-only rule, and that owner can rename the validated root afterwards.
 */
function checkAncestorClauses(label: string, stats: Stats, uid: number): Verdict {
	if (stats.uid !== 0 && stats.uid !== uid) {
		return fail(
			"ancestor-not-owned",
			`${label} is owned by uid ${stats.uid}, not by root or by you (uid ${uid}) — ownership of a parent is write (and therefore rename) authority over the root below it`,
		);
	}
	if ((stats.mode & 0o022) !== 0) {
		// One consequence, stated per shape: on a plain writable parent the write bit IS rename authority
		// over our child, while the sticky bit (`1777`, the `/tmp` shape) stops a co-worker replacing what
		// we already own and leaves only pre-creation — which the root's own ownership and 0700 clauses
		// then refuse. A single sentence for both would over-claim on the sticky shape.
		const consequence =
			(stats.mode & 0o1000) !== 0
				? "group/other write on a parent lets a co-worker create that path before you do, though the sticky bit stops them replacing the run directory once you own it (and the bank path with it)"
				: "group/other write on a parent is rename authority: a co-worker with write on this parent can replace the run directory, and the bank path with it";
		return { ok: true, warning: `${label} is mode ${formatMode(stats.mode)} — ${consequence}` };
	}
	return { ok: true };
}

/**
 * A symlinked ANCESTOR is resolved, and the directory it lands on is judged by the SAME clause. The
 * rule is "follow it, then validate where it lands", not "never follow": a user who moved `~/.cache`
 * to another disk — a symlink to a real `0700` directory they own — must still be able to delegate,
 * and the question a parent is asked ("can someone else rename what is below you?") is answered by
 * the target exactly as a real directory in the same place would answer it.
 *
 * The ROOT is never resolved (see the `root-symlink` clause): there the link would carry the `chmod`
 * too, and a `chmod` through a link retargets the LINK's choice of where the bytes land.
 *
 * `realpathSync` walks the whole chain in one call, so a nested link or a LOOP is refused here rather
 * than walked component by component (`ELOOP` on `a -> b -> a`, `ENOENT` on a broken link): a link that
 * names no directory names no parent, and there is nothing for the clause below to be true of.
 *
 * THE TARGET IS NOT THE WHOLE STORY: the directories ABOVE the target carry the same rename authority
 * over it that the target carries over the root, so they are judged by the same clauses (see
 * `checkTargetAncestors`).
 */
function checkResolvedAncestor(link: string, uid: number | null): Verdict {
	let target: string;
	try {
		target = realpathSync(link);
	} catch (error) {
		return fail(
			"ancestor-not-dir",
			`${link} is a symlink that does not resolve to a directory (${codeOf(error) || describe(error)}) — a broken or looping link names nothing, so it cannot be the parent of the root`,
		);
	}
	let stats: Stats;
	try {
		stats = statSync(target);
	} catch (error) {
		return fail(
			"ancestor-not-dir",
			`${link} is a symlink to ${target}, which cannot be inspected (${codeOf(error) || describe(error)})`,
		);
	}
	if (!stats.isDirectory()) return fail("ancestor-not-dir", `${link} is a symlink to ${target}, which is not a directory`);
	// No uid means no ownership model to judge (Windows), exactly as for a real ancestor in this zone.
	if (uid === null) return { ok: true };
	const targetVerdict = checkAncestorClauses(`${link} (a symlink to ${target})`, stats, uid);
	if (!targetVerdict.ok) return targetVerdict;
	const aboveVerdict = checkTargetAncestors(link, target, uid);
	if (!aboveVerdict.ok) return aboveVerdict;
	// Both levels can be worth a sentence, and neither may swallow the other.
	return { ok: true, warning: combineWarnings([targetVerdict.warning, aboveVerdict.warning]) };
}

/**
 * The directories ABOVE a resolved target, judged by the ancestor clauses — the residual the target
 * clause alone does not see. A link into a non-sticky world-writable directory (`/srv/shared` at
 * `0777`) whose child is our own `0700` directory is re-pointable by any local user: write authority
 * over `shared` is rename authority over the child the link lands on, one hop past the resolution. On
 * this surface that is WARNED (difference 3), and a foreign owner here is refused as
 * `ancestor-not-owned`, exactly as along the literal chain.
 *
 * The target itself is EXCLUDED (its own clauses just ran, and its parents are what this walks). The
 * walk goes from the target's PARENT up to `/`, nearest first: the closest writable parent is the one
 * whose ordinary rename reaches the validated directory, so that is the name the message prints.
 *
 * `realpathSync` canonicalised the target, so every component of its chain is a real directory; the
 * clauses are still applied through `inspect` because the tree can change between that call and this
 * walk, and a component that has become a link (or vanished) is a change to fail closed on — the
 * resolved chain is not re-resolved here, since re-resolving it would judge a path the root is no
 * longer reached through.
 */
function checkTargetAncestors(link: string, target: string, uid: number): Verdict {
	const chain = directoryChain(target);
	const warnings: string[] = [];
	for (let index = chain.length - 2; index >= 0; index -= 1) {
		const path = chain[index];
		// One label for both clauses, so a message always names the LINK, the TARGET and the DIRECTORY.
		const label = `${link} (a symlink to ${target}), whose parent ${path}`;
		const found = inspect(path);
		if (found.kind === "missing") {
			return fail(
				"ancestor-not-dir",
				`${label} no longer exists — the target was canonicalised a moment ago, so the tree changed under this check (a chain that moved is not one to trust)`,
			);
		}
		if (found.kind === "unreadable") {
			return fail("ancestor-not-dir", `${label} cannot be inspected (${codeOf(found.error) || describe(found.error)})`);
		}
		if (found.stats.isSymbolicLink()) {
			return fail(
				"ancestor-not-dir",
				`${label} is a symlink — the target's chain was canonicalised, so a link here means it was re-pointed under this check, and the re-pointed chain is not the one the target was validated against`,
			);
		}
		if (!found.stats.isDirectory()) return fail("ancestor-not-dir", `${label} is not a directory`);
		const verdict = checkAncestorClauses(label, found.stats, uid);
		if (!verdict.ok) return verdict;
		if (verdict.warning !== undefined) warnings.push(verdict.warning);
	}
	return { ok: true, warning: combineWarnings(warnings) };
}

/**
 * One component's verdict. The symlink and non-directory clauses come first in every zone, because
 * every later clause is a statement about a REAL directory.
 */
function checkComponent(path: string, stats: Stats, zone: Zone, uid: number | null): Verdict {
	if (stats.isSymbolicLink()) {
		// Above the root a link is RESOLVED and its target judged; at and below it the link is refused,
		// because there the chmod (and the bank) would follow it.
		if (zone === "ancestor") return checkResolvedAncestor(path, uid);
		return zone === "root"
			? fail(
					"root-symlink",
					`${path} is a symlink — the root is inspected with lstat and never followed (and never chmod-ed through: a chmod on a link retargets the link's target, which is someone else's choice of where the bank lands)`,
				)
			: fail(
					"ancestor-not-dir",
					`${path} is a symlink — at and below the root nothing is followed (a chmod, a create or a marker write would land wherever the link points), so a link there is refused rather than resolved`,
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
	if (zone === "ancestor") return checkAncestorClauses(path, stats, uid);
	// Below the root: no mode clause (a group-writable subdirectory is still only reachable through a
	// 0700 root, and refusing it would refuse `mktemp -d`-style directories for no gain).
	return stats.uid === uid ? { ok: true } : fail("root-not-owned", `${path} is owned by uid ${stats.uid}, not by you (uid ${uid})`);
}

/**
 * Walk from `/` down to `root`, applying the zone rule to every component. Never creates. A MISSING
 * component ends the judgement — everything below it is missing too, and a missing root is not a
 * failure here (creation is `ensureRunDir`'s job): what has been read is the part that exists, and the
 * part that exists is the part whose ownership and writability decide whether the rest is safe.
 *
 * The walk COLLECTS advisories (one per group/other-writable ancestor, root-most first) instead of
 * dropping them, so a chain with two writable parents reports both. A refusal is returned, never joined
 * with a warning: what fails does not also get an advisory.
 */
type ChainWalk = { ok: true; warnings: string[] } | ScratchRootError;

function validateChain(root: string, uid: number | null): ChainWalk {
	const chain = directoryChain(root);
	const warnings: string[] = [];
	for (let index = 0; index < chain.length; index += 1) {
		const path = chain[index];
		const zone: Zone = index === chain.length - 1 ? "root" : "ancestor";
		const found = inspect(path);
		if (found.kind === "missing") return { ok: true, warnings };
		if (found.kind === "unreadable") {
			const error = codeOf(found.error) || describe(found.error);
			return zone === "root"
				? fail("root-not-dir", `cannot inspect ${path} (${error}) — the root must be a directory you own and can read`)
				: fail("ancestor-not-dir", `cannot inspect ${path} (${error})`);
		}
		const verdict = checkComponent(path, found.stats, zone, uid);
		if (!verdict.ok) return verdict;
		if (verdict.warning !== undefined) warnings.push(verdict.warning);
	}
	return { ok: true, warnings };
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

/** `realpathSync` without throwing: the canonical path, or `null` when it does not resolve. */
function canonical(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/**
 * The deepest existing component on `root`'s chain, CANONICALISED — the path whose filesystem a
 * directory we create would inherit. `null` means nothing on the chain resolves (the deepest existing
 * component is a broken link), and then there is no mount to name.
 *
 * A symlink is NOT a reason to stop: a cache directory reached through a link is exactly the setup the
 * link support exists for, and returning `null` there would silently drop the durability advisory for
 * those users. So the walk keeps the deepest component that EXISTS (link or not), and the answer is
 * resolved before it is returned: `statfs` must be asked about the canonical path, because that is the
 * directory the kernel will put a new child in, and the warning has to name the path the user can act
 * on rather than a link whose own mount is the link's parent's.
 *
 * A FILE component ends the walk without being recorded: a directory cannot be created inside it, so
 * the prefix above it is the deepest component whose filesystem a new directory would inherit.
 */
function deepestExisting(root: string): string | null {
	let deepest: string | null = null;
	for (const path of directoryChain(root)) {
		const inspected = inspect(path);
		if (inspected.kind !== "found") break;
		if (!inspected.stats.isSymbolicLink() && !inspected.stats.isDirectory()) break;
		deepest = path;
	}
	if (deepest === null) return null;
	return canonical(deepest);
}

/**
 * A `tmpfs` root is a WARNING on this surface, not a refusal (difference 1 in the header): the bank
 * does not survive a reboot, and the user is told so. The probe is the deepest existing component, so
 * a root that does not exist yet is judged by the ancestor it would be created in — and a root reached
 * through a symlinked ancestor is judged by the directory the link lands on, which is the filesystem
 * the refused-to-be-dropped advisory would otherwise be missing.
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
	// "Does the root exist yet" asked canonically: `probe` is canonical, so a root that resolves to it
	// exists (through a link or not) and there is nothing to explain. No new import, and no second read.
	const inherited =
		canonical(resolve(root)) === probe
			? ""
			: ` (${resolve(root)} does not exist yet, and a directory created inside ${probe} inherits its filesystem)`;
	return `${probe} is on a tmpfs — the progress bank will not survive a reboot${inherited}`;
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/**
 * Resolve the root for this platform and validate its chain WITHOUT creating anything:
 * `{ ok: true, root }` (plus `warning` for a `tmpfs` mount, a group/other-writable ancestor, or both), or
 * a named refusal.
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
	const chain = validateChain(layout.root, uid);
	if (!chain.ok) return chain;
	// Both kinds at once: a writable ancestor AND a tmpfs root is a real host shape, and the one string
	// carries both sentences (joined with "; ") so neither drops the other.
	const mount = mountWarning(layout.root, platform, options.statfs ?? statfsSync);
	const warning = combineWarnings([...chain.warnings, mount]);
	if (warning === undefined) return { ok: true, root: layout.root };
	const warningKinds: RootWarningKind[] = [];
	if (chain.warnings.length > 0) warningKinds.push("ancestor-writable");
	if (mount !== undefined) warningKinds.push("tmpfs");
	options.warn?.(warning);
	return { ok: true, root: layout.root, warning, warningKinds };
}

/**
 * WHY a run id is refused, or `undefined` when it is ONE path segment. The REASON is the message rather
 * than the value: the value is whatever bytes the caller sent, and a refusal line is not the place to
 * print a NUL or a newline. Nothing about the name's LENGTH is here on purpose — `NAME_MAX` (255 on
 * most filesystems, not on all of them) belongs to the filesystem, so a `mkdir` that fails
 * `ENAMETOOLONG` is the authority and reports `create-failed`; that is a real fs failure, not an
 * invalid id.
 */
function runIdDefect(runId: unknown): string | undefined {
	if (typeof runId !== "string") return `it is not a string (it is ${typeof runId})`;
	if (runId === "") return "it is empty";
	if (runId === "." || runId === "..") return `it is ${runId}, which names a directory rather than a run`;
	if (runId.includes("\0")) return "it contains a NUL byte";
	if (runId.includes("/") || runId.includes("\\")) return "it contains a path separator";
	return undefined;
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
 * validated and never repaired: changing a mode we did not set would be a silent privilege grab. A
 * validated symlink ANCESTOR is one such existing component — nothing is created inside a directory
 * that has not passed, and the directory a link resolves to has passed before `mkdir` runs through it.
 * The RETURNED paths are the caller's (the link's), because the preamble has to name what the user
 * sees, and `realpath` is not what they typed.
 *
 * THIS FUNCTION CARRIES NO ADVISORY, on purpose: its result type reports what it created, and the
 * advisory belongs to `resolveRoot` (the seam's one report per spawn, logged once per process). A
 * writable ancestor is therefore not re-derived here — the chain is validated for SAFETY, and the
 * sentence was already emitted by the call that resolved the root.
 */
export function ensureRunDir(root: string, runId: string, options: { platform?: NodeJS.Platform } = {}): EnsureRunDirResult {
	const defect = runIdDefect(runId);
	if (defect !== undefined) {
		return fail(
			"bad-run-id",
			`refusing the run id: ${defect} — a run id is one path segment joined onto the root, so it must not be able to name anything outside it`,
		);
	}
	const base = resolve(root);
	const platform = options.platform ?? process.platform;
	const uid = currentUid(platform);
	const before = validateChain(base, uid);
	if (!before.ok) return before;

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

	const revalidated = validateChain(base, uid);
	const after = revalidated.ok ? validateBelow(base, runId, uid) : revalidated;
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
