/**
 * Tests for the shipped scratch root (issue #511, U1) — the platform map, the chain predicate, the
 * umask-independent creation, the settle marker and the retention sweep.
 *
 * The adversary here is another uid on the same host, so the security properties are pinned with REAL
 * filesystem objects wherever a mock could not tell the two apart: a planted symlink (its target's mode
 * and mtime are read back), a group-writable ancestor, a `1777` ancestor that has the `/tmp` shape, and
 * a `0777` umask that would defeat `mkdirSync`'s mode. A symlinked ANCESTOR is a supported setup (a
 * `~/.cache` moved to another disk), so it is pinned in both directions: a link to a real `0700`
 * directory we own resolves and is created THROUGH, while a link to a `0775` directory, a broken link,
 * a link cycle and a link two levels up each get their own observed code. TWO exceptions, both stated:
 *
 *  - the tmpfs probe is a SEAM (`statfs` is injected), because whether `$HOME` is on a `tmpfs` is a
 *    property of the machine and not of the code — and on this surface it is a WARNING, not a refusal;
 *  - the ownership case needs `chown`, so it is skipped unless the suite runs as root.
 *
 * The sandbox lives under `<repo>/.tmp` (gitignored), never under `/tmp`: `/tmp` is `1777`, so a root
 * under it is refused `ancestor-writable` — which is the unit's point, and would make every test here a
 * test of that one refusal.
 *
 * COVERAGE — what these probes do NOT cover, stated rather than implied: a mount-namespace substitution
 * by a user who already holds privileges; NFS, where ownership and `chmod` semantics belong to the
 * server; a root that becomes a mount point or is renamed AFTER it was validated; and a real Windows
 * host (the `win32` layout is asserted from injected values on POSIX, where `node:path` uses POSIX
 * separators — the comparison is against `join(…)` for exactly that reason).
 */
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	BANK_FILENAME,
	DONE_MARKER,
	KEEP_DAYS,
	RUNS_DIR,
	ROOT_MODE,
	TMPFS_MAGIC,
	bankPath,
	ensureRunDir,
	formatMode,
	markRunDone,
	pruneRuns,
	resolveRoot,
	type RootOptions,
} from "../scratch-root";

const REPO = process.cwd();
const BASE = join(REPO, ".tmp");
mkdirSync(BASE, { recursive: true });
const WORK = mkdtempSync(join(BASE, "shipped-scratch-root-"));

/** A `tmpfs`-free mount probe: the warning path is asserted by injection, never by the host's layout. */
const EXT4 = () => ({ type: 0xef53 });

let counter = 0;

/** One throwaway `$HOME` per test, mode 0700, inside the safe `.tmp` chain. */
function sandbox(): string {
	const dir = join(WORK, `home-${(counter += 1)}`);
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}

/** The Linux layout for an injected home — the shape every filesystem probe here uses. */
function rootOf(home: string): string {
	return join(home, ".cache", "brl-subagent");
}

function resolveIn(home: string, extra: RootOptions = {}) {
	return resolveRoot({ platform: "linux", env: {}, home, statfs: EXT4, ...extra });
}

/** Narrow a result union to its `ok: true` arm, failing loudly (the message carries the refusal). */
function mustOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
	if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
	return result as Extract<T, { ok: true }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
});

describe("scratch root — the platform map", () => {
	it("resolves linux, darwin and win32 from injected values, and ignores XDG_CACHE_HOME", () => {
		const home = sandbox();
		expect(resolveIn(home)).toEqual({ ok: true, root: join(home, ".cache", "brl-subagent") });
		// XDG is an environment variable, so it is a path the environment chooses: set it and the
		// resolved path must not move.
		expect(resolveIn(home, { env: { XDG_CACHE_HOME: join(WORK, "elsewhere") } })).toEqual({
			ok: true,
			root: join(home, ".cache", "brl-subagent"),
		});
		expect(resolveIn(home, { platform: "darwin" })).toEqual({ ok: true, root: join(home, "Library", "Caches", "brl-subagent") });
		const localAppData = sandbox();
		expect(resolveRoot({ platform: "win32", env: { LOCALAPPDATA: localAppData }, home: join(WORK, "ignored") })).toEqual({
			ok: true,
			root: join(localAppData, "brl-subagent"),
		});
		// Every other POSIX falls back to the documented Linux path.
		expect(resolveIn(home, { platform: "freebsd" })).toEqual({ ok: true, root: join(home, ".cache", "brl-subagent") });
	});

	it("refuses an unresolvable home by name — never a temp fallback", () => {
		const posix = resolveIn("");
		expect(posix).toMatchObject({ ok: false, code: "home-unresolvable" });
		expect(posix.ok === false && posix.message).toContain("no system-temp fallback");
		expect(resolveIn("   ")).toMatchObject({ ok: false, code: "home-unresolvable" });
		expect(resolveRoot({ platform: "darwin", env: {}, home: "" })).toMatchObject({ ok: false, code: "home-unresolvable" });
		const absent = resolveRoot({ platform: "win32", env: {} });
		expect(absent).toMatchObject({ ok: false, code: "home-unresolvable" });
		expect(absent.ok === false && absent.message).toContain("LOCALAPPDATA");
		expect(resolveRoot({ platform: "win32", env: { LOCALAPPDATA: "" } })).toMatchObject({ ok: false, code: "home-unresolvable" });
	});

	it("accepts a root that does not exist yet, and creates nothing while resolving", () => {
		const home = sandbox();
		expect(mustOk(resolveIn(home)).root).toBe(rootOf(home));
		expect(existsSync(join(home, ".cache"))).toBe(false);
	});
});

describe("scratch root — the chain predicate (a refusal per defect)", () => {
	it("refuses a root that is not exactly 0700", () => {
		const home = sandbox();
		const root = rootOf(home);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		chmodSync(root, 0o750);
		const verdict = resolveIn(home);
		expect(verdict).toMatchObject({ ok: false, code: "root-mode" });
		expect(verdict.ok === false && verdict.message).toContain("0750");
		chmodSync(root, 0o700);
		expect(resolveIn(home).ok).toBe(true);
	});

	it("refuses a symlinked root and never chmods through the link (the target is untouched)", () => {
		const home = sandbox();
		mkdirSync(join(home, ".cache"), { mode: 0o700 });
		const target = join(WORK, `link-target-${(counter += 1)}`);
		mkdirSync(target, { mode: 0o755 });
		chmodSync(target, 0o755);
		symlinkSync(target, rootOf(home));
		const before = statSync(target);
		const verdict = resolveIn(home);
		expect(verdict).toMatchObject({ ok: false, code: "root-symlink" });
		const after = statSync(target);
		// The chmod-through-link defect would retarget the LINK's target: mode and mtime are the evidence.
		expect(after.mode & 0o7777).toBe(0o755);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		// Creation must refuse too, and write nothing through the link.
		expect(ensureRunDir(rootOf(home), "run-1")).toMatchObject({ ok: false, code: "root-symlink" });
		expect(existsSync(join(target, RUNS_DIR))).toBe(false);
		expect(statSync(target).mtimeMs).toBe(before.mtimeMs);
	});

	it("refuses a root that is not a directory", () => {
		const home = sandbox();
		mkdirSync(join(home, ".cache"), { mode: 0o700 });
		writeFileSync(rootOf(home), "not a directory");
		expect(resolveIn(home)).toMatchObject({ ok: false, code: "root-not-dir" });
	});

	it("refuses a group-writable ancestor", () => {
		const home = sandbox();
		const cache = join(home, ".cache");
		mkdirSync(rootOf(home), { recursive: true, mode: 0o700 });
		chmodSync(cache, 0o775);
		const verdict = resolveIn(home);
		expect(verdict).toMatchObject({ ok: false, code: "ancestor-writable" });
		expect(verdict.ok === false && verdict.message).toContain("0775");
		chmodSync(cache, 0o700);
		expect(resolveIn(home).ok).toBe(true);
	});

	it("refuses a 1777 ancestor — the /tmp shape — even when the leaf is 0700", () => {
		const home = sandbox();
		const cache = join(home, ".cache");
		mkdirSync(rootOf(home), { recursive: true, mode: 0o700 });
		chmodSync(cache, 0o1777);
		try {
			const verdict = resolveIn(home);
			expect(verdict).toMatchObject({ ok: false, code: "ancestor-writable" });
			expect(verdict.ok === false && verdict.message).toContain("1777");
			// The same shape through creation: refused BEFORE anything is created.
			const created = ensureRunDir(join(cache, "other-root"), "run-1");
			expect(created).toMatchObject({ ok: false, code: "ancestor-writable" });
			expect(existsSync(join(cache, "other-root"))).toBe(false);
		} finally {
			chmodSync(cache, 0o700);
		}
	});

	it("refuses a file ancestor as ancestor-not-dir", () => {
		const other = sandbox();
		writeFileSync(join(other, ".cache"), "not a directory");
		const verdict = resolveIn(other);
		expect(verdict).toMatchObject({ ok: false, code: "ancestor-not-dir" });
		expect(verdict.ok === false && verdict.message).toContain(join(other, ".cache"));
	});

	// `chown` needs privileges a suite must not assume: skipped, and it SAYS so, rather than passing
	// silently as if the ownership clause had been checked against a real foreign uid.
	it.skipIf(process.getuid?.() !== 0)("refuses a foreign-owned root (root-only: chown)", () => {
		const home = sandbox();
		const root = rootOf(home);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		chownSync(root, 1, 1);
		const verdict = resolveIn(home);
		expect(verdict).toMatchObject({ ok: false, code: "root-not-owned" });
		expect(verdict.ok === false && verdict.message).toContain("uid 1");
	});
});

describe("scratch root — a symlinked ancestor is resolved, then validated", () => {
	it("resolves a cache directory that is a link to a real 0700 directory, and creates through it", () => {
		const home = sandbox();
		const target = join(WORK, `cache-disk-${(counter += 1)}`);
		mkdirSync(target, { mode: 0o700 });
		chmodSync(target, 0o700);
		const link = join(home, ".cache");
		symlinkSync(target, link);

		// The RETURNED path is the link — what the user typed, and what the preamble must name.
		expect(resolveIn(home)).toEqual({ ok: true, root: rootOf(home) });

		const created = mustOk(ensureRunDir(rootOf(home), "run-1"));
		expect(created.runDir).toBe(join(rootOf(home), RUNS_DIR, "run-1"));
		// Read through the link …
		expect(existsSync(created.runDir)).toBe(true);
		// … and on disk, where the bytes actually are: a real 0700 directory owned by us.
		const onDisk = join(realpathSync(link), "brl-subagent", RUNS_DIR, "run-1");
		expect(existsSync(onDisk)).toBe(true);
		expect(lstatSync(onDisk).isSymbolicLink()).toBe(false);
		expect(statSync(onDisk).mode & 0o7777).toBe(ROOT_MODE);
		// Nothing on the way down escaped the mode: every created component is 0700 on disk.
		expect(created.created).toEqual([rootOf(home), join(rootOf(home), RUNS_DIR), created.runDir]);
		for (const path of created.created) expect(statSync(realpathSync(path)).mode & 0o7777, path).toBe(ROOT_MODE);
	});

	it("refuses a link that lands on a group-writable directory, naming the link and the target", () => {
		const home = sandbox();
		const target = join(WORK, `cache-writable-${(counter += 1)}`);
		mkdirSync(target, { mode: 0o700 });
		chmodSync(target, 0o775);
		const link = join(home, ".cache");
		symlinkSync(target, link);
		const resolved = realpathSync(target);

		const verdict = resolveIn(home);
		expect(verdict).toMatchObject({ ok: false, code: "ancestor-writable" });
		if (verdict.ok) throw new Error("expected a refusal");
		// Both paths are named: "<link> is mode 0775" would send the reader to a mode the link lacks.
		expect(verdict.message).toContain("0775");
		expect(verdict.message).toContain(link);
		expect(verdict.message).toContain(resolved);
		// Creation refuses too, before anything is written through the link.
		expect(ensureRunDir(rootOf(home), "run-1")).toMatchObject({ ok: false, code: "ancestor-writable" });
		expect(existsSync(join(resolved, "brl-subagent"))).toBe(false);
	});

	it("refuses a broken link ancestor as ancestor-not-dir, naming the link", () => {
		const home = sandbox();
		const link = join(home, ".cache");
		symlinkSync(join(WORK, `absent-${(counter += 1)}`), link);
		const verdict = resolveIn(home);
		expect(verdict).toMatchObject({ ok: false, code: "ancestor-not-dir" });
		if (verdict.ok) throw new Error("expected a refusal");
		expect(verdict.message).toContain(link);
		expect(verdict.message).toContain("does not resolve");
		expect(ensureRunDir(rootOf(home), "run-1")).toMatchObject({ ok: false, code: "ancestor-not-dir" });
	});

	it("refuses a symlink cycle without walking it, and never loops", () => {
		const home = sandbox();
		const a = join(WORK, `cycle-a-${(counter += 1)}`);
		const b = join(WORK, `cycle-b-${(counter += 1)}`);
		symlinkSync(b, a);
		symlinkSync(a, b);
		const link = join(home, ".cache");
		symlinkSync(a, link);

		const verdict = resolveIn(home);
		expect(verdict).toMatchObject({ ok: false, code: "ancestor-not-dir" });
		if (verdict.ok) throw new Error("expected a refusal");
		expect(verdict.message).toContain(link);
		// The loop is the platform's refusal (`ELOOP`), not a walk of our own: one call, one verdict.
		expect(() => realpathSync(link)).toThrow();
		expect(ensureRunDir(rootOf(home), "run-1")).toMatchObject({ ok: false, code: "ancestor-not-dir" });
		// Nothing was followed, created or repaired: both ends of the cycle are still links.
		expect(lstatSync(a).isSymbolicLink()).toBe(true);
		expect(lstatSync(b).isSymbolicLink()).toBe(true);
	});

	it("resolves a symlinked ancestor two levels up — the home directory itself", () => {
		const realHome = sandbox();
		const linkHome = join(WORK, `home-link-${(counter += 1)}`);
		symlinkSync(realHome, linkHome);

		expect(resolveIn(linkHome)).toEqual({ ok: true, root: rootOf(linkHome) });
		const created = mustOk(ensureRunDir(rootOf(linkHome), "run-2"));
		expect(created.runDir).toBe(join(rootOf(linkHome), RUNS_DIR, "run-2"));
		const onDisk = join(realHome, ".cache", "brl-subagent", RUNS_DIR, "run-2");
		expect(existsSync(onDisk)).toBe(true);
		expect(statSync(onDisk).mode & 0o7777).toBe(ROOT_MODE);
	});
});

describe("scratch root — creation is umask-independent", () => {
	it("creates the chain at 0700 under a 0777 umask, and the marker at 0600", () => {
		const home = sandbox();
		const root = rootOf(home);
		const previous = process.umask(0o777);
		try {
			const created = mustOk(ensureRunDir(root, "run-1"));
			expect(created.runDir).toBe(join(root, RUNS_DIR, "run-1"));
			const made = [join(home, ".cache"), root, join(root, RUNS_DIR), created.runDir];
			for (const path of made) {
				expect(statSync(path).mode & 0o7777, path).toBe(ROOT_MODE);
				expect(lstatSync(path).isSymbolicLink(), path).toBe(false);
			}
			expect(created.created).toEqual(made);
			const marked = mustOk(markRunDone(created.runDir));
			expect(marked.path).toBe(join(created.runDir, DONE_MARKER));
			expect(lstatSync(marked.path).mode & 0o7777).toBe(0o600);
			// Idempotent: the second call validates what exists and creates nothing.
			expect(mustOk(ensureRunDir(root, "run-1")).created).toEqual([]);
		} finally {
			process.umask(previous);
		}
	});

	it("refuses a run id that is not one path segment with bad-run-id, creating nothing", () => {
		const home = sandbox();
		const root = rootOf(home);
		// The REASON is what the refusal names, never the raw value: a value carrying a NUL (or a
		// newline) must not be pasted into a message a human reads.
		const cases: [string, string][] = [
			["", "it is empty"],
			[".", "it is ., which names a directory"],
			["..", "it is .., which names a directory"],
			["../escape", "it contains a path separator"],
			["a/b", "it contains a path separator"],
			["a\\b", "it contains a path separator"],
			["nul\0", "it contains a NUL byte"],
		];
		for (const [runId, reason] of cases) {
			const verdict = ensureRunDir(root, runId);
			expect(verdict, JSON.stringify(runId)).toMatchObject({ ok: false, code: "bad-run-id" });
			expect(verdict.ok === false && verdict.message, JSON.stringify(runId)).toContain(reason);
			expect(verdict.ok === false && verdict.message, JSON.stringify(runId)).not.toContain("\0");
		}
		expect(existsSync(root)).toBe(false);
	});

	it("removes only what it created when a later component fails", () => {
		const home = sandbox();
		// A pre-existing `.cache` is NOT ours to remove, so the rollback must leave it standing.
		mkdirSync(join(home, ".cache"), { mode: 0o700 });
		const root = rootOf(home);
		// One path segment the filesystem refuses (> `NAME_MAX`): `<root>` and `<root>/runs` exist by the
		// time the deepest `mkdir` fails, which is the only way to reach the rollback path without a
		// fault-injection seam this module deliberately does not have. Its code is `create-failed`, NOT
		// `bad-run-id`: `NAME_MAX` belongs to the filesystem, so an `ENAMETOOLONG` here is a real fs
		// failure and only `mkdir` can say so.
		const tooLong = "r".repeat(300);
		try {
			mkdirSync(join(WORK, tooLong));
			rmSync(join(WORK, tooLong), { recursive: true, force: true });
			console.warn("[scratch-root] SKIP rollback probe: this filesystem accepts a 300-character name");
			return;
		} catch {
			// Expected: the name is too long, which is the fault this test needs.
		}
		const verdict = ensureRunDir(root, tooLong);
		expect(verdict).toMatchObject({ ok: false, code: "create-failed" });
		expect(existsSync(root)).toBe(false);
		expect(existsSync(join(home, ".cache"))).toBe(true);
	});
});

describe("scratch root — the mount probe is a warning, not a refusal", () => {
	it("warns on a tmpfs root and stays ok", () => {
		const home = sandbox();
		const warnings: string[] = [];
		const verdict = resolveIn(home, { statfs: () => ({ type: TMPFS_MAGIC }), warn: (message) => warnings.push(message) });
		expect(verdict.ok).toBe(true);
		expect(verdict.ok === true && verdict.warning).toContain("will not survive a reboot");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("tmpfs");
	});

	it("carries no warning off a tmpfs, and skips the probe off Linux", () => {
		const home = sandbox();
		const warnings: string[] = [];
		expect(resolveIn(home, { warn: (message) => warnings.push(message) })).toEqual({ ok: true, root: rootOf(home) });
		// Non-Linux: `f_type` magic numbers are not portable, so the probe is not consulted at all.
		const probed: string[] = [];
		expect(
			resolveIn(home, {
				platform: "darwin",
				statfs: (path: string) => {
					probed.push(path);
					return { type: TMPFS_MAGIC };
				},
			}),
		).toEqual({ ok: true, root: join(home, "Library", "Caches", "brl-subagent") });
		expect(probed).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe("scratch root — the settle marker and retention", () => {
	it("marks a run done with an owner-only, empty marker", () => {
		const home = sandbox();
		const root = rootOf(home);
		const runDir = mustOk(ensureRunDir(root, "run-1")).runDir;
		const marked = mustOk(markRunDone(runDir));
		const stats = lstatSync(marked.path);
		expect(stats.isFile()).toBe(true);
		expect(stats.mode & 0o7777).toBe(0o600);
		expect(statSync(marked.path).size).toBe(0);
		expect(mustOk(markRunDone(runDir)).path).toBe(marked.path);
	});

	it("prunes only settled directories older than keepDays, and never the current run", () => {
		const home = sandbox();
		const root = rootOf(home);
		const runs = join(root, RUNS_DIR);
		mkdirSync(runs, { recursive: true, mode: 0o700 });
		const now = new Date("2026-01-31T00:00:00Z");
		const settle = (id: string, days: number) => {
			mkdirSync(join(runs, id), { mode: 0o700 });
			const marker = join(runs, id, DONE_MARKER);
			writeFileSync(marker, "", { mode: 0o600 });
			// The MARKER's mtime is the retention clock — never the directory's.
			const when = new Date(now.getTime() - days * DAY_MS);
			utimesSync(marker, when, when);
		};
		settle("old", 15);
		settle("fresh", 5);
		settle("current", 30);
		mkdirSync(join(runs, "unmarked"), { mode: 0o700 });
		// A directory is not settled by AGE alone: an unmarked one is live, queued or crashed.
		utimesSync(join(runs, "unmarked"), new Date(now.getTime() - 30 * DAY_MS), new Date(now.getTime() - 30 * DAY_MS));

		expect(KEEP_DAYS).toBe(14);
		const result = pruneRuns(root, { now, exclude: join(runs, "current") });
		expect(result.removed).toEqual([join(runs, "old")]);
		expect(result.failed).toEqual([]);
		expect(readdirSync(runs).sort()).toEqual(["current", "fresh", "unmarked"]);
		// The excluded run keeps its marker; the unmarked one is kept by the absence of a marker, not by
		// its age (it is the oldest directory in the sweep).
		expect(existsSync(join(runs, "current", DONE_MARKER))).toBe(true);
		expect(result.kept).toHaveLength(3);
		for (const id of ["current", "fresh", "unmarked"]) expect(result.kept).toContain(join(runs, id));
	});

	it("keeps a symlink named like a run, and reports a removal failure instead of throwing", () => {
		const home = sandbox();
		const root = rootOf(home);
		const runs = join(root, RUNS_DIR);
		mkdirSync(runs, { recursive: true, mode: 0o700 });
		const now = new Date("2026-01-31T00:00:00Z");
		const settle = (id: string, days: number) => {
			mkdirSync(join(runs, id), { mode: 0o700 });
			const marker = join(runs, id, DONE_MARKER);
			writeFileSync(marker, "", { mode: 0o600 });
			const when = new Date(now.getTime() - days * DAY_MS);
			utimesSync(marker, when, when);
		};
		settle("blocked", 15);
		const target = join(WORK, `run-link-target-${(counter += 1)}`);
		mkdirSync(target, { mode: 0o700 });
		symlinkSync(target, join(runs, "linked"));

		const result = pruneRuns(root, {
			now,
			remove: () => {
				throw Object.assign(new Error("device busy"), { code: "EBUSY" });
			},
		});
		expect(result.removed).toEqual([]);
		expect(result.failed).toEqual([{ path: join(runs, "blocked"), message: "EBUSY" }]);
		// Best effort: the failure is reported, the directory (and its bytes) survive, nothing throws.
		expect(existsSync(join(runs, "blocked", DONE_MARKER))).toBe(true);
		// A symlink is not a run at all — a dirent does not follow it, so the sweep never even reads a
		// marker through the link, and the target survives whatever the age of its contents.
		expect(result.removed).not.toContain(join(runs, "linked"));
		expect(lstatSync(join(runs, "linked")).isSymbolicLink()).toBe(true);
		expect(existsSync(target)).toBe(true);
	});

	it("treats a missing runs directory as an empty sweep", () => {
		const home = sandbox();
		expect(pruneRuns(rootOf(home), { now: new Date("2026-01-31T00:00:00Z") })).toEqual({ removed: [], kept: [], failed: [] });
	});
});

describe("scratch root — the small exported surface", () => {
	it("names the modes in four octal digits and the bank path in one place", () => {
		expect(formatMode(0o700)).toBe("0700");
		expect(formatMode(0o1777)).toBe("1777");
		expect(formatMode(0o777)).toBe("0777");
		expect(BANK_FILENAME).toBe("bank.md");
		expect(bankPath("/root/runs/run-1")).toBe(join("/root/runs/run-1", "bank.md"));
	});
});
