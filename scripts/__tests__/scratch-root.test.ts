/**
 * Tests for the private scratch root's primitives (issue #512) — the root predicate, the four file
 * operations, and the evidence-based lock.
 *
 * The adversary here is a second uid on the same host, so the properties are pinned with REAL
 * filesystem objects and REAL child processes wherever a mock could not tell the two apart: a planted
 * symlink (its target is read back), a FIFO (the reader must not hang), a `SIGKILL`ed lock holder, two
 * concurrent processes racing one `create`. The ownership cases are the one exception: `chown` needs
 * privileges a suite must not assume, so `validateRoot` takes an injectable `lstat` seam and those
 * cases hand it a modified `uid`/`mode`.
 *
 * COVERAGE — what these probes do NOT cover, stated rather than implied:
 *  - a MOUNT-NAMESPACE substitution by a user who already holds privileges. The round-3 critique
 *    could not establish that an unprivileged foreign user can mount into the victim's namespace, so
 *    the chain is validated from the path each time and a privileged remount between validation and
 *    write is out of the threat model;
 *  - NFS, where `O_NOFOLLOW`/`rename` semantics belong to the server, and where `lstat` ownership may
 *    be mapped by the exporter;
 *  - a host with no `/proc/sys/kernel/random/boot_id` (non-Linux): the lock then records `bootId:
 *    null` and staleness rests on pid liveness plus the start-time comparison alone;
 *  - a live reboot. Persistence is inferred from the record's mount being non-tmpfs (`findmnt`), which
 *    is what the acceptance states — the reboot itself is not performed.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	FILE_MODE,
	acquireLock,
	appendBytes,
	atomicReplace,
	breakLock,
	confine,
	createExclusive,
	currentBootId,
	currentUid,
	defaultRoot,
	describeHolder,
	ensureDir,
	ensureRoot,
	liveness,
	lockPath,
	processStartTime,
	readLock,
	readRegular,
	releaseLock,
	validateDir,
	validateRoot,
	validateWriteDir,
} from "../lib/scratch-root.mjs";
import { EXIT, main as cliMain } from "../scratch-root.mjs";

const REPO = process.cwd();
const CLI = join(REPO, "scripts", "scratch-root.mjs");
const UID = currentUid();
const hasMkfifo = spawnSync("mkfifo", ["--version"], { encoding: "utf8" }).status === 0;
const hasFindmnt = spawnSync("findmnt", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * Scratch roots live inside the checkout, NOT under `/tmp`: `/tmp` is mode 1777, so a root under it is
 * refused `ancestor-writable` — which is the point of the unit, and would make every test here a test
 * of the refusal. `.tmp/` is gitignored and its chain (`/home/<user>/…`) is uid-owned and 0755.
 */
const BASE = join(REPO, ".tmp");
mkdirSync(BASE, { recursive: true });
const WORK = mkdtempSync(join(BASE, "scratch-root-"));
const HOME_ROOT = join(homedir(), ".cache", `brl-subagent-test-${process.pid}`);
let counter = 0;

function sandbox(label = "root"): string {
	const dir = join(WORK, `${label}-${(counter += 1)}`);
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}

function list(dir: string): string[] {
	return readdirSync(dir).sort();
}

function read(path: string): string {
	return readFileSync(path, "utf8");
}

afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
	rmSync(HOME_ROOT, { recursive: true, force: true });
});

/** An `lstat` seam: the real stats, with `uid`/`mode`/kind rewritten for the paths the test names. */
function lstatSeam(patch: (path: string) => { uid?: number; mode?: number; kind?: "dir" | "symlink" } | null) {
	return (path: string) => {
		const stats = lstatSync(path);
		const override = patch(path);
		if (override === null) return stats;
		const kind = override.kind ?? "dir";
		return {
			uid: override.uid ?? stats.uid,
			mode: override.mode ?? stats.mode,
			isDirectory: () => kind === "dir",
			isSymbolicLink: () => kind === "symlink",
		};
	};
}

/** The pid of a process that has certainly exited — spawnSync reaps it before returning. */
function deadPid(): number {
	const result = spawnSync("true", { encoding: "utf8" });
	return result.pid as number;
}

/** Write a lock file by hand, so the holder's evidence is exactly what the test says it is. */
function plantLock(root: string, name: string, holder: Record<string, unknown>): string {
	const path = lockPath(root, name);
	writeFileSync(path, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
	return path;
}

function cli(args: string[], stdin = ""): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input: stdin });
	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("scratch-root — the root predicate (two zones, trust by ownership)", () => {
	it("names the default root and accepts a normal $HOME path (the falsifier)", () => {
		expect(defaultRoot()).toBe(join(homedir(), ".cache", "brl-subagent"));
		const created = ensureRoot(HOME_ROOT);
		expect(created, JSON.stringify(created)).toMatchObject({ ok: true, root: HOME_ROOT });
		expect(lstatSync(HOME_ROOT).mode & 0o777).toBe(0o700);
		// Idempotent: the second call validates what the first created, and changes nothing.
		expect(ensureRoot(HOME_ROOT).ok).toBe(true);
		expect(validateRoot(HOME_ROOT).ok).toBe(true);
	});

	it("refuses a shared or too-shallow root, and a relative one, by name", () => {
		expect(validateRoot("/tmp")).toMatchObject({ ok: false, code: "too-shallow" });
		expect(validateRoot("/")).toMatchObject({ ok: false, code: "too-shallow" });
		expect(validateRoot(homedir())).toMatchObject({ ok: false, code: "too-shallow" });
		expect(validateRoot("relative/root")).toMatchObject({ ok: false, code: "not-absolute" });
	});

	it("refuses a root that is not 0700 (the confidentiality boundary)", () => {
		const root = sandbox("mode");
		chmodSync(root, 0o755);
		const verdict = validateRoot(root);
		expect(verdict).toMatchObject({ ok: false, code: "root-mode" });
		expect(verdict.message).toContain("0755");
		chmodSync(root, 0o700);
		expect(validateRoot(root).ok).toBe(true);
	});

	it("refuses a foreign-owned root", () => {
		const root = sandbox("foreign-root");
		const verdict = validateRoot(root, { lstat: lstatSeam((path) => (path === root ? { uid: UID + 1 } : null)) });
		expect(verdict).toMatchObject({ ok: false, code: "root-not-owner" });
		expect(verdict.message).toContain(`uid ${UID + 1}`);
	});

	it("refuses an ancestor owned by a third party — the round-3 rename-authority case", () => {
		const base = sandbox("third-party");
		const root = join(base, "root");
		mkdirSync(root, { mode: 0o700 });
		// The `0755` mode would pass a mode-only check; the OWNER is what grants rename authority.
		const verdict = validateRoot(root, {
			lstat: lstatSeam((path) => (path === base ? { uid: UID + 1, mode: 0o755 } : null)),
		});
		expect(verdict).toMatchObject({ ok: false, code: "untrusted-owner" });
	});

	it("refuses a group/other-writable ancestor", () => {
		const base = sandbox("writable");
		const root = join(base, "root");
		mkdirSync(root, { mode: 0o700 });
		chmodSync(base, 0o775);
		try {
			expect(validateRoot(root)).toMatchObject({ ok: false, code: "ancestor-writable" });
		} finally {
			chmodSync(base, 0o700);
		}
		expect(validateRoot(root).ok).toBe(true);
	});

	it("refuses a symlinked component above AND below the root (lstat, never followed)", () => {
		const real = sandbox("real");
		const root = join(real, "root");
		mkdirSync(root, { mode: 0o700 });
		const link = join(WORK, `link-${(counter += 1)}`);
		symlinkSync(real, link);
		// Above: the link is an ancestor of the candidate root.
		expect(validateRoot(join(link, "root"))).toMatchObject({ ok: false, code: "symlink-component" });
		// Below: a link inside a valid root is refused by the same rule when a directory is expected.
		const inner = sandbox("inner-target");
		symlinkSync(inner, join(root, "sub"));
		expect(validateDir(join(root, "sub"), { root })).toMatchObject({ ok: false, code: "symlink-component" });
		expect(ensureDir(join(root, "sub"), { root })).toMatchObject({ ok: false, code: "symlink-component" });
	});

	it("refuses a non-directory in the chain, and a missing root, without creating it", () => {
		const base = sandbox("file-chain");
		const file = join(base, "not-a-dir");
		writeFileSync(file, "x");
		expect(validateRoot(join(file, "root"))).toMatchObject({ ok: false, code: "not-directory" });
		const missing = join(base, "absent", "root");
		expect(validateRoot(missing)).toMatchObject({ ok: false, code: "not-directory" });
		expect(validateRoot(missing).message).toContain("scratch-root.mjs init");
		// Validation never creates: only `ensureRoot`/`init` do.
		expect(list(base)).toEqual(["not-a-dir"]);
	});

	it("creates the chain at 0700 top-down and leaves an existing chain alone", () => {
		const root = join(WORK, "created", "deeper", "root");
		expect(ensureRoot(root)).toMatchObject({ ok: true, root });
		expect(lstatSync(root).mode & 0o777).toBe(0o700);
		expect(lstatSync(join(WORK, "created")).mode & 0o777).toBe(0o700);
	});

	it("refuses a directory that would hold a written file but is renameable by others", () => {
		const dir = sandbox("write-dir");
		expect(validateWriteDir(dir).ok).toBe(true);
		chmodSync(dir, 0o777);
		expect(validateWriteDir(dir)).toMatchObject({ ok: false, code: "ancestor-writable" });
		chmodSync(dir, 0o700);
		expect(validateWriteDir(dir).ok).toBe(true);
	});
});

describe("scratch-root — create, append, read (explicit numeric flags, no follows)", () => {
	it("creates exclusively at 0600 and never clobbers", () => {
		const root = sandbox("create");
		const file = join(root, "note.md");
		expect(createExclusive(file, "one\n", { root })).toMatchObject({ ok: true, bytes: 4 });
		expect(read(file)).toBe("one\n");
		expect(lstatSync(file).mode & 0o777).toBe(FILE_MODE);
		expect(createExclusive(file, "two\n", { root })).toMatchObject({ ok: false, code: "already-exists" });
		expect(read(file)).toBe("one\n");
	});

	it("refuses a planted leaf symlink on create, and its target is unchanged", () => {
		const root = sandbox("create-symlink");
		const victim = join(root, "victim.md");
		writeFileSync(victim, "untouched\n", { mode: 0o600 });
		const planted = join(root, "planted.md");
		symlinkSync(victim, planted);
		expect(createExclusive(planted, "attacker\n", { root })).toMatchObject({ ok: false, code: "already-exists" });
		expect(read(victim)).toBe("untouched\n");
		expect(lstatSync(planted).isSymbolicLink()).toBe(true);
	});

	it("refuses a planted leaf symlink on append, and a second legitimate append still works", () => {
		const root = sandbox("append");
		const victim = join(root, "victim.md");
		writeFileSync(victim, "untouched\n", { mode: 0o600 });
		const planted = join(root, "bank.md");
		symlinkSync(victim, planted);
		expect(appendBytes(planted, "attacker\n", { root })).toMatchObject({ ok: false, code: "symlink-leaf" });
		expect(read(victim)).toBe("untouched\n");
		rmSync(planted);
		expect(appendBytes(planted, "finding one\n", { root }).ok).toBe(true);
		expect(appendBytes(planted, "finding two\n", { root }).ok).toBe(true);
		expect(read(planted)).toBe("finding one\nfinding two\n");
		expect(lstatSync(planted).mode & 0o777).toBe(FILE_MODE);
	});

	it.runIf(hasMkfifo)("refuses a FIFO without blocking: the reader returns, it does not hang", () => {
		const root = sandbox("fifo");
		const fifo = join(root, "pipe");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		const result = readRegular(fifo);
		expect(result).toMatchObject({ ok: false, code: "not-regular" });
	});

	it("reads a regular file, and names a missing one and a symlink", () => {
		const root = sandbox("read");
		const file = join(root, "record.md");
		writeFileSync(file, "bytes\n", { mode: 0o600 });
		const ok = readRegular(file, { root });
		expect(ok.ok).toBe(true);
		expect(ok.bytes.toString("utf8")).toBe("bytes\n");
		expect(readRegular(join(root, "absent.md"))).toMatchObject({ ok: false, code: "missing" });
		const link = join(root, "link.md");
		symlinkSync(file, link);
		expect(readRegular(link)).toMatchObject({ ok: false, code: "symlink-leaf" });
	});

	it("confines every write to the root, naming the root", () => {
		const root = sandbox("confine");
		const outside = join(sandbox("outside"), "escape.md");
		expect(confine(root, outside)).toMatchObject({ ok: false, code: "outside-root" });
		expect(confine(root, outside).message).toContain(root);
		expect(createExclusive(outside, "x", { root })).toMatchObject({ ok: false, code: "outside-root" });
		expect(appendBytes(outside, "x", { root })).toMatchObject({ ok: false, code: "outside-root" });
		expect(atomicReplace(root, outside, "x", { root })).toMatchObject({ ok: false, code: "outside-root" });
		expect(relative(root, outside).startsWith("..")).toBe(true);
		expect(list(join(root))).toEqual([]);
	});
});

describe("scratch-root — atomic replace", () => {
	it("replaces the bytes and leaves no temporary file behind", () => {
		const root = sandbox("replace");
		const file = join(root, "REVIEW_1.md");
		writeFileSync(file, "old\n", { mode: 0o600 });
		const result = atomicReplace(root, file, "new\n", { root });
		expect(result.ok).toBe(true);
		expect(read(file)).toBe("new\n");
		expect(list(root)).toEqual(["REVIEW_1.md"]);
	});

	it("replaces a symlink standing at the target instead of following it", () => {
		const root = sandbox("replace-symlink");
		const victim = join(root, "victim.md");
		writeFileSync(victim, "untouched\n", { mode: 0o600 });
		const target = join(root, "REVIEW_2.md");
		symlinkSync(victim, target);
		expect(atomicReplace(root, target, "the record\n", { root }).ok).toBe(true);
		expect(read(victim)).toBe("untouched\n");
		expect(lstatSync(target).isSymbolicLink()).toBe(false);
		expect(read(target)).toBe("the record\n");
	});

	it("refuses a target that is not in the directory the caller named", () => {
		const root = sandbox("replace-dir");
		const other = sandbox("replace-other");
		const target = join(other, "x.md");
		expect(atomicReplace(root, target, "x", { root: other })).toMatchObject({
			ok: false,
			code: "target-outside-dir",
		});
	});
});

describe("scratch-root — the lock: evidence, not age", () => {
	const NAME = "REVIEW_7.md";

	it("records pid, boot id and start time, and releases cleanly", () => {
		const root = sandbox("lock");
		const held = acquireLock(root, NAME, { root });
		if (!held.ok) throw new Error(held.message);
		const holder = JSON.parse(read(held.path));
		expect(holder).toMatchObject({ pid: process.pid, bootId: currentBootId(), startTime: processStartTime(process.pid) });
		expect(typeof holder.at).toBe("string");
		expect(describeHolder(holder)).toContain(`pid ${process.pid}`);
		expect(held.release()).toMatchObject({ ok: true, path: held.path });
		expect(list(root)).toEqual([]);
		// Released, so the next writer takes it immediately.
		const again = acquireLock(root, NAME, { root });
		expect(again.ok).toBe(true);
		if (again.ok) again.release();
	});

	it("refuses a held lock with the holder's evidence rather than waiting forever", () => {
		const root = sandbox("lock-held");
		const held = acquireLock(root, NAME, { root });
		if (!held.ok) throw new Error(held.message);
		const blocked = acquireLock(root, NAME, { root, timeoutMs: 0 });
		expect(blocked).toMatchObject({ ok: false, code: "lock-held" });
		expect(blocked.message).toContain(`pid ${process.pid}`);
		expect(blocked.message).toContain("--break-lock");
		// A live holder's lock is exactly where it was.
		expect(list(root)).toEqual([`.${NAME}.lock`]);
		held.release();
	});

	it("never removes a dead holder's lock — recovery is an operator action", () => {
		const root = sandbox("lock-dead");
		const path = plantLock(root, NAME, { pid: deadPid(), bootId: currentBootId(), startTime: "1", at: "then" });
		const blocked = acquireLock(root, NAME, { root, timeoutMs: 0 });
		expect(blocked).toMatchObject({ ok: false, code: "lock-held" });
		expect(blocked.message).toContain("gone");
		expect(list(root)).toEqual([`.${NAME}.lock`]);
		expect(read(path)).toContain("then");
	});

	it("breaks a stale lock only with --yes, and refuses a live one even with --yes", () => {
		const root = sandbox("lock-break");
		expect(breakLock(root, NAME, {})).toMatchObject({ ok: false, code: "no-lock" });

		// Live: our own pid, matching start time.
		plantLock(root, NAME, {
			pid: process.pid,
			bootId: currentBootId(),
			startTime: processStartTime(process.pid),
			at: "now",
		});
		expect(breakLock(root, NAME, { yes: true })).toMatchObject({ ok: false, code: "lock-held" });
		expect(list(root)).toEqual([`.${NAME}.lock`]);

		// Stale evidence, no confirmation: refused, with the evidence printed.
		const dead = plantLock(root, NAME, { pid: deadPid(), bootId: currentBootId(), startTime: "1", at: "then" });
		const refused = breakLock(root, NAME, {});
		expect(refused).toMatchObject({ ok: false, code: "lock-stale" });
		expect(refused.message).toContain("pid");
		expect(refused.message).toContain("--yes");
		expect(read(dead)).toContain("then");

		// Stale evidence, confirmed: unlinked.
		const broken = breakLock(root, NAME, { yes: true });
		expect(broken).toMatchObject({ ok: true, broken: true });
		expect(list(root)).toEqual([]);
	});

	it("calls a lock stale on a different boot id and on a reused pid — never on age", () => {
		const root = sandbox("lock-evidence");
		plantLock(root, NAME, { pid: process.pid, bootId: "boot-from-before", startTime: "1", at: "then" });
		const otherBoot = breakLock(root, NAME, { bootId: "boot-now" });
		expect(otherBoot).toMatchObject({ ok: false, code: "lock-stale" });
		expect(otherBoot.message).toContain("boot-id-changed");

		// Same pid, different start time: the recorded process is gone and its pid was reused.
		plantLock(root, NAME, { pid: process.pid, bootId: currentBootId(), startTime: "not-the-real-start", at: "then" });
		const reused = breakLock(root, NAME, {});
		expect(reused).toMatchObject({ ok: false, code: "lock-stale" });
		expect(reused.message).toContain("pid-reused");
	});

	it("treats an EPERM probe as alive and an unknown answer as alive (fail-closed)", () => {
		const perm = () => {
			const error = new Error("not permitted");
			Object.assign(error, { code: "EPERM" });
			throw error;
		};
		expect(liveness({ pid: 4, bootId: null, startTime: null }, { bootId: null, kill: perm })).toMatchObject({
			live: true,
			reason: "alive",
		});
		expect(liveness({ pid: 4, bootId: null, startTime: null }, { bootId: null, kill: () => ({}) })).toMatchObject({
			live: true,
		});
		expect(liveness(null)).toMatchObject({ live: true, reason: "unreadable-holder" });
	});

	it("releasing never deletes a lock that is no longer ours", () => {
		const root = sandbox("lock-foreign");
		const foreign = plantLock(root, NAME, { pid: deadPid(), bootId: currentBootId(), startTime: "1", at: "then" });
		const result = releaseLock(root, NAME, { pid: process.pid, bootId: currentBootId(), startTime: "0" });
		expect(result).toMatchObject({ ok: false, code: "lock-changed" });
		expect(read(foreign)).toContain("then");
		// An unidentifiable lock file is reported, not silently unlinked either.
		writeFileSync(lockPath(root, NAME), "not json\n");
		expect(readLock(root, NAME)).toMatchObject({ ok: false, code: "unresolvable" });
		// …and releasing cannot confirm it is ours, so it stays for the operator (fail-closed).
		const unresolvable = releaseLock(root, NAME, { pid: process.pid, bootId: currentBootId(), startTime: "0" });
		expect(unresolvable).toMatchObject({ ok: false, code: "lock-changed" });
		expect(read(lockPath(root, NAME))).toBe("not json\n");
	});
});

describe("scratch-root — the CLI a bash-only reviewer uses", () => {
	it("prints the root, initialises it, and checks it (human and --json)", () => {
		const root = join(WORK, "cli-root", "deeper");
		const before = cli(["path", "--root", root]);
		expect(before.status).toBe(EXIT.REFUSED);
		expect(before.stderr).toContain("not-directory");

		const init = cli(["init", "--root", root, "--json"]);
		expect(init.status).toBe(EXIT.OK);
		expect(JSON.parse(init.stdout)).toMatchObject({ ok: true, command: "init", root });

		const path = cli(["path", "--root", root]);
		expect(path.status).toBe(EXIT.OK);
		expect(path.stdout.trim()).toBe(`scratch-root: ${root}`);
		expect(cli(["check", "--root", root]).status).toBe(EXIT.OK);
		expect(cli(["check", "/tmp"]).status).toBe(EXIT.REFUSED);
	});

	it("creates and appends through stdin, relative to the root, and refuses an escape", () => {
		const root = sandbox("cli-write");
		const created = cli(["create", "review-9/findings.md", "--root", root], "one\n");
		expect(created.status, created.stderr).toBe(EXIT.OK);
		expect(read(join(root, "review-9", "findings.md"))).toBe("one\n");
		expect(lstatSync(join(root, "review-9")).mode & 0o777).toBe(0o700);
		const appended = cli(["append", "review-9/findings.md", "--root", root], "two\n");
		expect(appended.status).toBe(EXIT.OK);
		expect(read(join(root, "review-9", "findings.md"))).toBe("one\ntwo\n");
		const again = cli(["create", "review-9/findings.md", "--root", root], "three\n");
		expect(again.status).toBe(EXIT.REFUSED);
		expect(again.stderr).toContain("already-exists");
		const escape = cli(["create", join(sandbox("cli-outside"), "x.md"), "--root", root], "x");
		expect(escape.status).toBe(EXIT.REFUSED);
		expect(escape.stderr).toContain("outside-root");
	});

	it("exits 2 on a bad invocation and reports one object with --json", () => {
		expect(cli([]).status).toBe(EXIT.USAGE);
		expect(cli(["nonsense"]).status).toBe(EXIT.USAGE);
		expect(cli(["create"]).status).toBe(EXIT.USAGE);
		expect(cli(["path", "--nope"]).status).toBe(EXIT.USAGE);
		const failure = cli(["path", "--root", "/tmp", "--json"]);
		expect(failure.status).toBe(EXIT.REFUSED);
		expect(JSON.parse(failure.stdout)).toMatchObject({ ok: false, code: "too-shallow" });
	});

	it("serializes two concurrent creates: exactly one wins, the other is named already-exists", async () => {
		const root = sandbox("race");
		const race = (args: string[]) =>
			new Promise<{ status: number; stderr: string }>((resolve) => {
				const child = spawn(process.execPath, [CLI, ...args, "--root", root], {
					stdio: ["ignore", "ignore", "pipe"],
				});
				let stderr = "";
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				});
				child.on("close", (code: number | null) => resolve({ status: code ?? -1, stderr }));
			});
		const results = await Promise.all([
			race(["create", "race.md"]),
			race(["create", "race.md"]),
		]);
		const statuses = results.map((result) => result.status).sort();
		expect(statuses).toEqual([EXIT.OK, EXIT.REFUSED]);
		expect(results.find((result) => result.status === EXIT.REFUSED)?.stderr).toContain("already-exists");
		expect(list(root)).toEqual(["race.md"]);
	});

	it("drives the same primitives in-process (the module is the CLI's one implementation)", () => {
		const root = sandbox("cli-in-process");
		const stdout: string[] = [];
		const stderr: string[] = [];
		const usage = cliMain(["nonsense"], {
			out: (chunk: string) => void stdout.push(chunk),
			err: (line: string) => void stderr.push(line),
			readStdin: () => "finding\n",
		});
		expect(usage).toBe(EXIT.USAGE);
		expect(stderr.join("\n")).toContain("unknown command: nonsense");
		const withRoot = cliMain(["append", "bank.md", "--root", root], {
			out: (chunk: string) => void stdout.push(chunk),
			err: (line: string) => void stderr.push(line),
			readStdin: () => "finding\n",
		});
		expect(withRoot).toBe(EXIT.OK);
		expect(read(join(root, "bank.md"))).toBe("finding\n");
	});
});

describe("scratch-root — persistence is a mount property, not a promise", () => {
	it.runIf(hasFindmnt)("the default root is on a non-tmpfs mount (reboot survival is inferred from this)", () => {
		const root = (ensureRoot(HOME_ROOT) as { root: string }).root;
		const mount = spawnSync("findmnt", ["-T", root, "-o", "TARGET,FSTYPE", "-n"], { encoding: "utf8" });
		expect(mount.status, mount.stderr).toBe(0);
		const fstype = mount.stdout.trim().split(/\s+/)[1];
		expect(fstype).toBeTruthy();
		expect(fstype).not.toBe("tmpfs");
		// The record's home is not under the worktree either, so removing the worktree cannot take it.
		expect(relative(REPO, root).startsWith("..")).toBe(true);
	});
});
