// Purpose: The private scratch root's primitives — a validated root, no-follow create/append/read,
// an atomic replace, and an evidence-based lock (issue #512).
//
// Why this file exists: the review record used to live in `/tmp`, which is `tmpfs` (it does not
// survive a reboot), world-writable (anyone can pre-create the path, and rename authority over our
// file comes from write permission on its PARENT), and ambiguous about who wrote it. #512 replaces
// that with one private container under `~/.cache/brl-subagent`, and this module is the whole
// mechanism: the root predicate, the four file operations, and the lock that serializes the
// read-prior-then-replace window.
//
// THE ROOT PREDICATE — two zones, and trust is OWNERSHIP, not mode alone (round 3 of the #509
// critique). A `0755` directory owned by an untrusted user passes a mode check, but that owner can
// rename the validated root after inspection and substitute a symlink. So:
//
//   above the root   every component must be a REAL directory (`lstat`, never followed), owned by
//                    uid 0 or by us, with (mode & 0o022) === 0. Write permission on a parent is
//                    rename authority over the child, which is why the ownership clause is the fix.
//   the root         a real directory owned by US, with (mode & 0o077) === 0 — 0700, the
//                    confidentiality boundary for the bytes.
//   below the root   a real directory owned by US. No mode clause: a group-writable subdirectory is
//                    still only reachable through a 0700 root, and refusing it would refuse
//                    `mktemp -d`-style directories for no gain.
//
// A policy failure is a NAMED RESULT, never a throw: `{ ok: true, … } | { ok: false, code, message }`.
// The codes are the contract (the CLI prints them, the tests assert them):
//
//   not-absolute · too-shallow · not-directory · symlink-component · untrusted-owner ·
//   ancestor-writable · root-not-owner · root-mode · outside-root · target-outside-dir ·
//   already-exists · symlink-leaf · not-regular · missing · lock-held · lock-stale · no-lock ·
//   lock-changed · io · unresolvable · unsupported-platform
//
// The first eight are the brief's. `missing` is a *result*, not an error: a prior record that is not
// there yet is the normal first write.
//
// The flag sets are EXPLICIT numbers, never `"wx"` (which is `O_TRUNC|O_CREAT|O_WRONLY|O_EXCL` — no
// `O_NOFOLLOW`, so a no-follow claim would be an accident of `O_EXCL` rather than a stated intent).
//
// LIMITS, stated rather than implied: a mount-namespace substitution by a user who already holds
// privileges, NFS (where `O_NOFOLLOW`/`rename` semantics belong to the server), and a non-Linux host
// with no `/proc/sys/kernel/random/boot_id` (the lock then records `bootId: null`, and staleness
// rests on pid liveness plus the recorded start time alone). Documented limits, not coverage.
import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Named refusal codes. One spelling, so the CLI, the docs and the tests cannot disagree. */
export const CODES = Object.freeze({
	NOT_ABSOLUTE: "not-absolute",
	TOO_SHALLOW: "too-shallow",
	NOT_DIRECTORY: "not-directory",
	SYMLINK_COMPONENT: "symlink-component",
	UNTRUSTED_OWNER: "untrusted-owner",
	ANCESTOR_WRITABLE: "ancestor-writable",
	ROOT_NOT_OWNER: "root-not-owner",
	ROOT_MODE: "root-mode",
	OUTSIDE_ROOT: "outside-root",
	TARGET_OUTSIDE_DIR: "target-outside-dir",
	ALREADY_EXISTS: "already-exists",
	SYMLINK_LEAF: "symlink-leaf",
	NOT_REGULAR: "not-regular",
	MISSING: "missing",
	LOCK_HELD: "lock-held",
	LOCK_STALE: "lock-stale",
	NO_LOCK: "no-lock",
	LOCK_CHANGED: "lock-changed",
	IO: "io",
	UNRESOLVABLE: "unresolvable",
	UNSUPPORTED_PLATFORM: "unsupported-platform",
});

/** The root's own mode: 0700, owner-only. Also the mode of every directory this module creates. */
export const ROOT_DIR_MODE = 0o700;

/** Every file this module creates. Group/other bits are never granted, so the mode never widens. */
export const FILE_MODE = 0o600;

/** A root must sit at least this many components below `/` — a shared location is not a container. */
export const MIN_ROOT_DEPTH = 2;

/** `O_NOFOLLOW`, read once. A host without it gets no write at all: the leaf guarantee is the point. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

/** Lock polling, in ms — bounded, so a held lock is a refusal rather than a hang. */
export const LOCK_DEFAULTS = Object.freeze({ timeoutMs: 2000, intervalMs: 25 });

function fail(code, message) {
	return { ok: false, code, message };
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

function codeOf(error) {
	return typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : "";
}

/** The current uid, or `null` on a host that has no uid — and then no root can be trusted. */
export function currentUid() {
	return typeof process.getuid === "function" ? process.getuid() : null;
}

/** The default root: `~/.cache/brl-subagent`. POSIX only — there is no fallback to a temp directory. */
export function defaultRoot({ home = homedir() } = {}) {
	return join(home, ".cache", "brl-subagent");
}

/** The record path for a PR: `<root>/review-<pr>/REVIEW_<pr>.md` — keyed to the PR, not the run. */
export function recordPath(pr, { root = defaultRoot() } = {}) {
	return join(root, `review-${pr}`, `REVIEW_${pr}.md`);
}

// ---------------------------------------------------------------------------
// The root predicate — one component rule, three zones, two modes of the walker
// ---------------------------------------------------------------------------

/** `/a/b/c` → [`a`, `b`, `c`]. Absolute paths only; callers have already refused anything else. */
function componentsOf(absolute) {
	return absolute.split(sep).filter((part) => part !== "");
}

/** `/a/b/c` → [`/`, `/a`, `/a/b`, `/a/b/c`] — every directory the predicate must see, in order. */
function directoryChain(absolute) {
	const chain = [sep];
	let prefix = sep;
	for (const part of componentsOf(absolute)) {
		prefix = join(prefix, part);
		chain.push(prefix);
	}
	return chain;
}

/** `lstat` without throwing: `{ ok: true, stats }`, `{ ok: false, missing: true }` or a named failure. */
function statComponent(path, lstat) {
	try {
		return { ok: true, stats: lstat(path) };
	} catch (error) {
		if (codeOf(error) === "ENOENT") return { ok: false, missing: true };
		return fail(CODES.UNRESOLVABLE, `cannot inspect ${path} (${codeOf(error) || describe(error)})`);
	}
}

function notOurs(path, uid) {
	return fail(
		CODES.ROOT_NOT_OWNER,
		`${path} is owned by uid ${uid}, not by you — the root and everything below it must be yours`,
	);
}

/**
 * One component's verdict. The symlink and non-directory refusals come first in every zone, because
 * every later clause is a statement about a real directory.
 */
function checkComponent(path, stats, zone, uid) {
	if (stats.isSymbolicLink()) {
		return fail(
			CODES.SYMLINK_COMPONENT,
			`${path} is a symlink — the chain is validated with lstat and never followed, because whoever chose the link target also chose where the bytes land`,
		);
	}
	if (!stats.isDirectory()) {
		return fail(CODES.NOT_DIRECTORY, `${path} is not a directory`);
	}
	const mode = (stats.mode & 0o777).toString(8);
	if (zone === "above") {
		if (stats.uid !== 0 && stats.uid !== uid) {
			return fail(
				CODES.UNTRUSTED_OWNER,
				`${path} is owned by uid ${stats.uid}, not by you (uid ${uid}) or root — its owner can rename what is below it after we validate, so write permission there is the whole threat`,
			);
		}
		if ((stats.mode & 0o022) !== 0) {
			return fail(
				CODES.ANCESTOR_WRITABLE,
				`${path} is mode 0${mode} — group/other write is rename authority over the entries below it`,
			);
		}
		return { ok: true };
	}
	if (stats.uid !== uid) return notOurs(path, stats.uid);
	if (zone === "root" && (stats.mode & 0o077) !== 0) {
		return fail(
			CODES.ROOT_MODE,
			`${path} is mode 0${mode} — the root must be 0700 (group/other access to the record bytes is the boundary this root exists for)`,
		);
	}
	return { ok: true };
}

/** The cheap refusals, before anything touches the disk: platform, absolute, depth, and `$HOME`. */
function prepareRootPath(candidate, { home }) {
	if (process.platform === "win32") {
		return fail(
			CODES.UNSUPPORTED_PLATFORM,
			"the private scratch root is POSIX-only (it rests on O_NOFOLLOW, uid ownership and 0700 modes) — there is no Windows root and no temp-directory fallback",
		);
	}
	if (typeof candidate !== "string" || candidate === "" || !isAbsolute(candidate)) {
		return fail(
			CODES.NOT_ABSOLUTE,
			`the scratch root must be an absolute path (got ${JSON.stringify(candidate)}) — a relative root resolves against whatever cwd the tool happened to run in`,
		);
	}
	const root = resolve(candidate);
	if (componentsOf(root).length < MIN_ROOT_DEPTH) {
		return fail(
			CODES.TOO_SHALLOW,
			`${root} is not a private container — a root must sit at least ${MIN_ROOT_DEPTH} components below /, so a shared directory like /tmp cannot be one`,
		);
	}
	if (root === resolve(home)) {
		return fail(
			CODES.TOO_SHALLOW,
			`${root} is your home directory — a home is a container of many things, not a private scratch container; use ${defaultRoot({ home })} or another directory inside it`,
		);
	}
	return { ok: true, root };
}

/**
 * Walk from `/` to `root`, applying the zone rule to every component. With `create`, a missing
 * component is created at 0700 *after its parent has been validated* — top-down, so nothing is ever
 * created inside a directory that has not passed the predicate.
 */
function walkRoot(root, { lstat, uid, create, mkdir }) {
	for (const path of directoryChain(root)) {
		const zone = path === root ? "root" : "above";
		const found = statComponent(path, lstat);
		if (!found.ok && !found.missing) return found;
		if (found.missing && !create) {
			return fail(
				CODES.NOT_DIRECTORY,
				`${path} does not exist — create the chain with: node scripts/scratch-root.mjs init`,
			);
		}
		let stats = found.ok ? found.stats : null;
		if (stats === null) {
			try {
				mkdir(path, ROOT_DIR_MODE);
			} catch (error) {
				return fail(CODES.IO, `cannot create ${path} (${codeOf(error) || describe(error)})`);
			}
			const created = statComponent(path, lstat);
			if (!created.ok) return created.missing ? fail(CODES.IO, `${path} vanished after mkdir`) : created;
			stats = created.stats;
		}
		const verdict = checkComponent(path, stats, zone, uid);
		if (!verdict.ok) return verdict;
	}
	return { ok: true, root };
}

function optionsWith(options = {}) {
	return {
		lstat: options.lstat ?? lstatSync,
		uid: options.uid ?? currentUid(),
		home: options.home ?? homedir(),
		mkdir: options.mkdir ?? mkdirSync,
	};
}

/**
 * Validate an existing root chain. Never creates, never throws.
 * `{ ok: true, root } | { ok: false, code, message }`.
 */
export function validateRoot(candidate, options = {}) {
	const opts = optionsWith(options);
	if (opts.uid === null) return fail(CODES.UNSUPPORTED_PLATFORM, "this host has no uid — ownership cannot be established");
	const prepared = prepareRootPath(candidate, opts);
	if (!prepared.ok) return prepared;
	return walkRoot(prepared.root, { ...opts, create: false });
}

/**
 * Create the chain at 0700 if it is missing, then validate it — the fail-closed equivalent of
 * `mkdir -p` for a root. A component that already exists is validated, never repaired: changing a
 * mode we did not set would be a silent privilege grab, so a bad mode is a refusal naming `init`.
 */
export function ensureRoot(candidate, options = {}) {
	const opts = optionsWith(options);
	if (opts.uid === null) return fail(CODES.UNSUPPORTED_PLATFORM, "this host has no uid — ownership cannot be established");
	const prepared = prepareRootPath(candidate, opts);
	if (!prepared.ok) return prepared;
	return walkRoot(prepared.root, { ...opts, create: true });
}

// ---------------------------------------------------------------------------
// Confinement and the at/below-root walk
// ---------------------------------------------------------------------------

/**
 * Resolve `target` (absolute, or relative to `root`) and refuse anything outside the root. This is
 * path arithmetic only — it says where the bytes may land, not who owns the directories there.
 */
export function confine(root, target) {
	const base = resolve(root);
	if (typeof target !== "string" || target === "") {
		return fail(CODES.OUTSIDE_ROOT, `no path given — every write is confined at or below ${base}`);
	}
	const path = isAbsolute(target) ? resolve(target) : resolve(base, target);
	const rel = relative(base, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		return fail(CODES.OUTSIDE_ROOT, `${path} is outside the scratch root ${base} — writes are confined at or below it`);
	}
	return { ok: true, path };
}

/** `ensureDir`/`validateDir`: walk `dir` below an already-validated root. */
function walkBelow(dir, rootCheck, { lstat, uid, create, mkdir }) {
	let prefix = rootCheck.root;
	const rel = relative(prefix, dir);
	for (const part of rel === "" ? [] : rel.split(sep)) {
		prefix = join(prefix, part);
		const found = statComponent(prefix, lstat);
		if (!found.ok && !found.missing) return found;
		if (found.missing && !create) return fail(CODES.NOT_DIRECTORY, `${prefix} does not exist`);
		if (found.missing) {
			try {
				mkdir(prefix, ROOT_DIR_MODE);
			} catch (error) {
				return fail(CODES.IO, `cannot create ${prefix} (${codeOf(error) || describe(error)})`);
			}
			const created = statComponent(prefix, lstat);
			if (!created.ok) return created.missing ? fail(CODES.IO, `${prefix} vanished after mkdir`) : created;
			const verdict = checkComponent(prefix, created.stats, "below", uid);
			if (!verdict.ok) return verdict;
			continue;
		}
		const verdict = checkComponent(prefix, found.stats, "below", uid);
		if (!verdict.ok) return verdict;
	}
	return { ok: true, dir: prefix };
}

/**
 * Validate a directory at or below `root`: the root chain, then every component down to `dir`, each a
 * real directory (`lstat`) owned by us.
 */
export function validateDir(dir, options = {}) {
	const { root } = options;
	if (root === undefined) return fail(CODES.OUTSIDE_ROOT, "validateDir needs the root it is confined to");
	const opts = optionsWith(options);
	const confined = confine(root, dir);
	if (!confined.ok) return confined;
	const rootCheck = validateRoot(root, opts);
	if (!rootCheck.ok) return rootCheck;
	return walkBelow(confined.path, rootCheck, { ...opts, create: false });
}

/** `validateDir`, creating the missing components at 0700 (used for `<root>/review-<pr>`). */
export function ensureDir(dir, options = {}) {
	const { root } = options;
	if (root === undefined) return fail(CODES.OUTSIDE_ROOT, "ensureDir needs the root it is confined to");
	const opts = optionsWith(options);
	const confined = confine(root, dir);
	if (!confined.ok) return confined;
	const rootCheck = ensureRoot(root, opts);
	if (!rootCheck.ok) return rootCheck;
	return walkBelow(confined.path, rootCheck, { ...opts, create: true });
}

/**
 * Validate a directory that will HOLD a file we write, outside the private root (an explicit
 * `--out`). Same predicate, different placement: the directory itself is held to the ancestor rule,
 * because group/other write on it is rename authority over the file — which is exactly why `/tmp` is
 * refused `ancestor-writable` rather than by a special case. Never created: it is not our directory.
 */
export function validateWriteDir(dir, options = {}) {
	const opts = optionsWith(options);
	if (opts.uid === null) return fail(CODES.UNSUPPORTED_PLATFORM, "this host has no uid — ownership cannot be established");
	if (typeof dir !== "string" || dir === "" || !isAbsolute(dir)) {
		return fail(CODES.NOT_ABSOLUTE, `a record directory must be an absolute path (got ${JSON.stringify(dir)})`);
	}
	const path = resolve(dir);
	for (const prefix of directoryChain(path)) {
		const found = statComponent(prefix, opts.lstat);
		if (!found.ok) return found.missing ? fail(CODES.NOT_DIRECTORY, `${prefix} does not exist`) : found;
		const ancestor = checkComponent(prefix, found.stats, "above", opts.uid);
		if (!ancestor.ok) return ancestor;
		if (prefix !== path) continue;
		// The leaf must also be OURS, not merely trusted: writing into root's directory is not ours
		// to do. Its mode clause stays the ancestor rule — a 0750 directory we own is a fine place to
		// write, a 0775 one is not.
		const owned = checkComponent(prefix, found.stats, "below", opts.uid);
		if (!owned.ok) return owned;
	}
	return { ok: true, dir: path };
}

// ---------------------------------------------------------------------------
// File operations — explicit numeric flags, never "wx"
// ---------------------------------------------------------------------------

/** The named failure for an `open` the kernel refused: the errno is the evidence, not the prose. */
function openFailure(error, path, { exclusive }) {
	const code = codeOf(error);
	if (code === "EEXIST") {
		return fail(
			CODES.ALREADY_EXISTS,
			exclusive
				? `${path} already exists — creation is exclusive, so an existing file is never a silent clobber`
				: `${path} already exists and cannot be created over`,
		);
	}
	if (code === "ELOOP") {
		return fail(CODES.SYMLINK_LEAF, `${path} is a symlink — refused by O_NOFOLLOW, and its target is untouched`);
	}
	if (code === "ENOENT") return fail(CODES.MISSING, `${path} does not exist`);
	return fail(CODES.IO, `cannot open ${path} (${code || describe(error)})`);
}

/** One `open`, with `O_NOFOLLOW` always set — five call sites, one place that could forget. */
function openNoFollow(path, flags, { exclusive }) {
	if (O_NOFOLLOW === undefined) {
		return fail(
			CODES.UNSUPPORTED_PLATFORM,
			`this host has no O_NOFOLLOW, so ${path} cannot be opened without following a planted symlink — no write is safer than a followed one`,
		);
	}
	try {
		return { ok: true, fd: openSync(path, flags | O_NOFOLLOW, FILE_MODE) };
	} catch (error) {
		return openFailure(error, path, { exclusive });
	}
}

function writeAll(fd, data) {
	const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
	let offset = 0;
	while (offset < buffer.length) {
		offset += writeSync(fd, buffer, offset, buffer.length - offset);
	}
	return buffer.length;
}

/**
 * Create a file exclusively, no-follow: `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`, mode 0600. An existing
 * path — file, symlink or dangling symlink — is `already-exists`. `root` is required: this module has
 * no unconfined write.
 */
export function createExclusive(target, data, { root } = {}) {
	if (root === undefined) return fail(CODES.OUTSIDE_ROOT, "createExclusive needs the root it is confined to");
	const confined = confine(root, target);
	if (!confined.ok) return confined;
	const path = confined.path;
	const opened = openNoFollow(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, {
		exclusive: true,
	});
	if (!opened.ok) return opened;
	const { fd } = opened;
	try {
		const bytes = writeAll(fd, data);
		fsyncSync(fd);
		return { ok: true, path, bytes };
	} catch (error) {
		return fail(CODES.IO, `cannot write ${path} (${codeOf(error) || describe(error)})`);
	} finally {
		closeSync(fd);
	}
}

/**
 * Append to a file, creating it if missing: `O_CREAT|O_WRONLY|O_APPEND|O_NOFOLLOW`, mode 0600. A
 * planted leaf symlink is refused by `O_NOFOLLOW` with the target untouched, and a second legitimate
 * append still works — that is the findings bank.
 */
export function appendBytes(target, data, { root } = {}) {
	if (root === undefined) return fail(CODES.OUTSIDE_ROOT, "appendBytes needs the root it is confined to");
	const confined = confine(root, target);
	if (!confined.ok) return confined;
	const path = confined.path;
	const opened = openNoFollow(path, fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_APPEND, {
		exclusive: false,
	});
	if (!opened.ok) return opened;
	const { fd } = opened;
	try {
		const bytes = writeAll(fd, data);
		return { ok: true, path, bytes };
	} catch (error) {
		return fail(CODES.IO, `cannot append to ${path} (${codeOf(error) || describe(error)})`);
	} finally {
		closeSync(fd);
	}
}

/**
 * Read a regular file, no-follow: `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, plus an `fstat` that the
 * descriptor is a regular file.
 *
 * `O_NONBLOCK` is not decoration, and the `fstat` alone would not have been enough: opening a FIFO
 * for reading BLOCKS in `open`, before any `fstat` can run — a probe against a named pipe hung the
 * process for the whole timeout (#512). With `O_NONBLOCK` the open returns immediately, the `fstat`
 * names `not-regular`, and nothing ever reads the pipe. A regular file ignores the flag.
 *
 * `root` is optional — `--verify` must still read a record that predates the private root.
 */
export function readRegular(target, { root = null } = {}) {
	let path;
	if (root === null) {
		if (typeof target !== "string" || target === "") return fail(CODES.OUTSIDE_ROOT, "no path given");
		path = resolve(target);
	} else {
		const confined = confine(root, target);
		if (!confined.ok) return confined;
		path = confined.path;
	}
	const opened = openNoFollow(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK, { exclusive: false });
	if (!opened.ok) return opened;
	const { fd } = opened;
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) {
			return fail(
				CODES.NOT_REGULAR,
				`${path} is not a regular file (mode 0${(stats.mode & 0o777).toString(8)}) — a FIFO would block the reader and a device is not a record`,
			);
		}
		return { ok: true, path, bytes: readFileSync(fd) };
	} catch (error) {
		return fail(CODES.IO, `cannot read ${path} (${codeOf(error) || describe(error)})`);
	} finally {
		closeSync(fd);
	}
}

function unlinkQuietly(path) {
	try {
		unlinkSync(path);
	} catch {
		// Already gone, or the directory is unwritable — either way the original failure stands.
	}
}

/** `fsync` a directory fd, reporting whether it took; EINVAL/EPERM are documented, not failures. */
function syncDirectory(dir) {
	let fd;
	try {
		fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
		fsyncSync(fd);
		return true;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Replace `target` atomically: write `.<basename>.tmp-<pid>-<random>` in the SAME directory
 * (`O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`, 0600), `fsync`, close, `rename` over the target, then a
 * best-effort `fsync` of the directory. `rename` replaces a symlink standing at the target rather
 * than following it — the semantic this function exists for, pinned by a test.
 *
 * The directory fsync is best-effort by design: `EINVAL` (a filesystem that cannot sync a directory
 * fd) and `EPERM` are tolerated, because refusing the write after the rename has committed would
 * report a failure that did not happen. `dirSynced` says which one it was.
 */
export function atomicReplace(dir, target, data, { root } = {}) {
	if (root === undefined) return fail(CODES.OUTSIDE_ROOT, "atomicReplace needs the root it is confined to");
	const confined = confine(root, target);
	if (!confined.ok) return confined;
	const path = confined.path;
	const directory = resolve(dir);
	if (dirname(path) !== directory) {
		return fail(
			CODES.TARGET_OUTSIDE_DIR,
			`${path} is not in ${directory} — the temporary file must live in the target's own directory for rename to be atomic`,
		);
	}
	const temp = join(directory, `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
	const opened = openNoFollow(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, {
		exclusive: true,
	});
	if (!opened.ok) return opened;
	const { fd } = opened;
	try {
		writeAll(fd, data);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		unlinkQuietly(temp);
		return fail(CODES.IO, `cannot write the temporary file ${temp} (${codeOf(error) || describe(error)})`);
	}
	closeSync(fd);
	try {
		renameSync(temp, path);
	} catch (error) {
		unlinkQuietly(temp);
		return fail(CODES.IO, `cannot rename ${temp} over ${path} (${codeOf(error) || describe(error)})`);
	}
	return { ok: true, path, temp, dirSynced: syncDirectory(directory) };
}

// ---------------------------------------------------------------------------
// The lock — evidence, not age
// ---------------------------------------------------------------------------

/** A blocking sleep that stays synchronous, so the whole tool has one call shape (`main` returns a code). */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
export function blockSleep(ms) {
	Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

let bootIdMemo;
/** Current boot id, or `null` when `/proc` cannot answer. Memoized: it cannot change mid-process. */
export function currentBootId({ read = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8") } = {}) {
	if (bootIdMemo !== undefined) return bootIdMemo;
	try {
		const value = read().trim();
		bootIdMemo = value === "" ? null : value;
	} catch {
		bootIdMemo = null;
	}
	return bootIdMemo;
}

/**
 * Field 22 (starttime) of `/proc/<pid>/stat`, or `null`. Split after the LAST `)` because the `comm`
 * field may contain spaces and parentheses — the classic `/proc/stat` parsing trap.
 */
export function processStartTime(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	let text;
	try {
		text = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const close = text.lastIndexOf(")");
	if (close === -1) return null;
	const fields = text.slice(close + 1).trim().split(/\s+/);
	// fields[0] is field 3 (state), so field 22 is fields[19].
	return fields[19] ?? null;
}

/** The lock file's path: `<dir>/.<name>.lock` — a sibling of the record, never inside it. */
export function lockPath(dir, name) {
	return join(resolve(dir), `.${name}.lock`);
}

/** The holder's evidence, one spelling, used by every message and by `--break-lock`'s output. */
export function describeHolder(holder) {
	if (holder === null || holder === undefined) {
		return "an unreadable holder (the lock file carries no pid/boot id)";
	}
	const boot = holder.bootId === null || holder.bootId === undefined ? "boot unknown" : `boot ${holder.bootId}`;
	const started =
		holder.startTime === null || holder.startTime === undefined ? "start unknown" : `start ${holder.startTime}`;
	return `pid ${holder.pid} on ${boot} (${started}, lock taken ${holder.at ?? "at an unrecorded time"})`;
}

/**
 * `{ ok: true, path, holder }` or a named failure. Read through `readRegular`, so a symlink planted
 * at the lock path is refused rather than followed into whatever it names.
 */
export function readLock(dir, name) {
	const path = lockPath(dir, name);
	const read = readRegular(path);
	if (!read.ok) {
		return read.code === CODES.MISSING ? fail(CODES.NO_LOCK, `${path} holds no lock`) : read;
	}
	try {
		return { ok: true, path, holder: JSON.parse(read.bytes.toString("utf8")) };
	} catch (error) {
		return fail(
			CODES.UNRESOLVABLE,
			`${path} is not a lock we wrote (${describe(error)}) — its holder cannot be identified`,
		);
	}
}

/**
 * Is the recorded holder still there? Evidence, never age: a differing boot id, a pid that is gone,
 * or a pid now carrying a different start time (pid reuse) proves it is not. A live writer past any
 * threshold is LIVE. An unreadable answer from `kill` counts as live — fail-closed on the one
 * question that decides whether we delete somebody's lock.
 */
export function liveness(
	holder,
	{ bootId = currentBootId(), startTime = processStartTime, kill = (pid, signal) => process.kill(pid, signal) } = {},
) {
	if (holder === null || holder === undefined || !Number.isInteger(holder.pid) || holder.pid <= 0) {
		return { live: true, reason: "unreadable-holder" };
	}
	if (holder.bootId !== null && holder.bootId !== undefined && bootId !== null && holder.bootId !== bootId) {
		return { live: false, reason: "boot-id-changed" };
	}
	try {
		kill(holder.pid, 0);
	} catch (error) {
		const code = codeOf(error);
		if (code === "ESRCH") return { live: false, reason: "pid-not-alive" };
		if (code === "EPERM") return { live: true, reason: "alive" };
		return { live: true, reason: `kill-${code || "unknown"}` };
	}
	const now = startTime(holder.pid);
	if (
		holder.startTime !== null &&
		holder.startTime !== undefined &&
		now !== null &&
		String(now) !== String(holder.startTime)
	) {
		return { live: false, reason: "pid-reused" };
	}
	return { live: true, reason: "alive" };
}

function holderEvidence(verdict) {
	return verdict.live ? "alive" : `gone (${verdict.reason})`;
}

function heldMessage(path, holder, verdict) {
	return (
		`${path} is held by ${describeHolder(holder)} — ${holderEvidence(verdict)}; nothing is ever auto-removed: ` +
		"failure to acquire a stale lock is recovery by an operator, via node scripts/review-record.mjs --break-lock <record> [--yes]"
	);
}

function sameHolder(left, right) {
	return (
		left !== null &&
		left !== undefined &&
		right !== null &&
		right !== undefined &&
		left.pid === right.pid &&
		left.bootId === right.bootId &&
		left.startTime === right.startTime
	);
}

/** Create the lock file, or report who holds it. Never removes anything. */
function tryCreateLock(dir, name, bootId) {
	const path = lockPath(dir, name);
	const holder = {
		pid: process.pid,
		bootId,
		startTime: processStartTime(process.pid),
		at: new Date().toISOString(),
	};
	const opened = openNoFollow(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, {
		exclusive: true,
	});
	if (!opened.ok) {
		if (opened.code !== CODES.ALREADY_EXISTS && opened.code !== CODES.SYMLINK_LEAF) return opened;
		const existing = readLock(dir, name);
		const known = existing.ok ? existing.holder : null;
		return { ok: false, code: CODES.LOCK_HELD, holder: known, verdict: liveness(known, { bootId }) };
	}
	const { fd } = opened;
	try {
		writeAll(fd, `${JSON.stringify(holder)}\n`);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		unlinkQuietly(path);
		return fail(CODES.IO, `cannot write the lock ${path} (${codeOf(error) || describe(error)})`);
	}
	closeSync(fd);
	return { ok: true, holder };
}

/**
 * Take the lock, polling for `timeoutMs` (2000 ms / 25 ms by default) and then refusing with
 * `lock-held` and the holder's evidence. A stale lock is NOT removed here, whatever the caller wants:
 * recovery is `breakLock`, an explicit operator action.
 *
 * `{ ok: true, path, holder, release } | { ok: false, code, message, holder? }`
 */
export function acquireLock(dir, name, options = {}) {
	const {
		root,
		timeoutMs = LOCK_DEFAULTS.timeoutMs,
		intervalMs = LOCK_DEFAULTS.intervalMs,
		sleep = blockSleep,
		now = Date.now,
		bootId = currentBootId(),
	} = options;
	if (root === undefined) return fail(CODES.OUTSIDE_ROOT, "acquireLock needs the root it is confined to");
	const confined = confine(root, lockPath(dir, name));
	if (!confined.ok) return confined;
	const deadline = now() + timeoutMs;
	for (;;) {
		const attempt = tryCreateLock(dir, name, bootId);
		if (attempt.ok) {
			return { ok: true, path: confined.path, holder: attempt.holder, release: () => releaseLock(dir, name, attempt.holder) };
		}
		if (attempt.code !== CODES.LOCK_HELD) return attempt;
		if (now() >= deadline) {
			return {
				ok: false,
				code: CODES.LOCK_HELD,
				path: confined.path,
				holder: attempt.holder,
				message: heldMessage(confined.path, attempt.holder, attempt.verdict),
			};
		}
		sleep(intervalMs);
	}
}

/**
 * Release a lock. With the holder we acquired, the file is re-read first: if it is no longer ours
 * (an operator broke it and someone else took it), it is left alone — releasing must never delete a
 * third party's lock.
 */
export function releaseLock(dir, name, holder = null) {
	const path = lockPath(dir, name);
	if (holder !== null) {
		const current = readLock(dir, name);
		if (current.ok && !sameHolder(current.holder, holder)) {
			return fail(CODES.LOCK_CHANGED, `${path} now belongs to ${describeHolder(current.holder)} — not ours to release`);
		}
		// An unreadable lock file is not proof that ours is gone: fail-closed, and leave it for the
		// operator rather than deleting a file whose holder cannot be identified.
		if (!current.ok && current.code !== CODES.NO_LOCK) {
			return fail(CODES.LOCK_CHANGED, `cannot confirm ${path} is still ours (${current.code}) — leaving it in place`);
		}
	}
	try {
		unlinkSync(path);
		return { ok: true, path };
	} catch (error) {
		if (codeOf(error) === "ENOENT") return { ok: true, path, alreadyReleased: true };
		return fail(CODES.IO, `cannot release ${path} (${codeOf(error) || describe(error)})`);
	}
}

/**
 * The operator's recovery, and the only thing that ever removes a lock.
 *
 *   no lock           → `no-lock` (nothing was broken, so nothing is claimed)
 *   live holder       → `lock-held`, refused even with `--yes`
 *   stale, no `--yes` → `lock-stale`, with the evidence
 *   stale, `--yes`    → unlink, after re-reading the evidence so a holder that changed under us is
 *                       `lock-changed` instead of somebody else's live lock deleted
 */
export function breakLock(dir, name, options = {}) {
	const { yes = false, bootId = currentBootId(), startTime = processStartTime, kill } = options;
	const existing = readLock(dir, name);
	if (!existing.ok) return existing;
	const verdict = liveness(existing.holder, kill === undefined ? { bootId, startTime } : { bootId, startTime, kill });
	const evidence = describeHolder(existing.holder);
	if (verdict.live) {
		return fail(
			CODES.LOCK_HELD,
			`${existing.path} is held by ${evidence} — ${holderEvidence(verdict)}; a live holder is never removed${yes ? ", `--yes` included" : ""}`,
		);
	}
	if (!yes) {
		return fail(
			CODES.LOCK_STALE,
			`${existing.path} is held by ${evidence} — ${holderEvidence(verdict)}; re-run with --yes to unlink it`,
		);
	}
	const again = readLock(dir, name);
	if (!again.ok || !sameHolder(again.holder, existing.holder)) {
		return fail(CODES.LOCK_CHANGED, `${existing.path} changed while it was being examined — re-run --break-lock`);
	}
	try {
		unlinkSync(existing.path);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return { ok: true, path: existing.path, evidence, alreadyReleased: true };
		return fail(CODES.IO, `cannot unlink ${existing.path} (${codeOf(error) || describe(error)})`);
	}
	return { ok: true, path: existing.path, evidence, broken: true };
}
