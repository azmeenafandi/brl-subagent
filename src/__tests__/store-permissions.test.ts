/**
 * Falsifiers for issue #408 — the store directories must be repaired on EVERY
 * use, because `mkdirSync`'s `mode` applies only on CREATE.
 *
 * The two mutations these tests are built to kill:
 *   1. drop the `chmod` repair in `ensureOwnerOnlyDir` → the pre-existing-0o755
 *      test fails (the directory keeps its wide mode);
 *   2. let the helper throw instead of catching → every never-throw test fails.
 *
 * POSIX-only: Windows reports synthesized modes (`0o666`/`0o777`) regardless of
 * the requested mode, so mode assertions no-op there.
 */
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureOwnerOnlyDir,
	repairOwnerOnlyFiles,
	OWNER_ONLY_DIR_MODE,
	OWNER_ONLY_FILE_MODE,
} from "../store-permissions";

const POSIX = process.platform !== "win32";

const modeOf = (path: string): number => statSync(path).mode & 0o777;

// One scaffold for both describes (a duplicated one was the review's SOLID/DRY nit).
const created: string[] = [];
const tempDir = (name: string): string => {
	const dir = mkdtempSync(join(tmpdir(), `brl-store-perm-${name}-`));
	created.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ensureOwnerOnlyDir (issue #408)", () => {
	it("creates a fresh directory owner-only", () => {
		if (!POSIX) return;
		const dir = join(tempDir("fresh"), "store");
		ensureOwnerOnlyDir(dir);
		expect(existsSync(dir)).toBe(true);
		expect(modeOf(dir)).toBe(OWNER_ONLY_DIR_MODE);
	});

	it("repairs a PRE-EXISTING 0o755 directory on use (the store that predates F6)", () => {
		if (!POSIX) return;
		const dir = join(tempDir("preexisting"), "store");
		mkdirSync(dir, { recursive: true, mode: 0o755 });
		chmodSync(dir, 0o755); // ensure the process umask did not narrow it
		expect(modeOf(dir)).toBe(0o755);

		ensureOwnerOnlyDir(dir);

		expect(modeOf(dir)).toBe(OWNER_ONLY_DIR_MODE);
	});

	it("repairs group-only exposure (0o750) too", () => {
		if (!POSIX) return;
		const dir = join(tempDir("group"), "store");
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o750);
		ensureOwnerOnlyDir(dir);
		expect(modeOf(dir)).toBe(OWNER_ONLY_DIR_MODE);
	});

	it("is idempotent on an already owner-only directory", () => {
		if (!POSIX) return;
		const dir = join(tempDir("idempotent"), "store");
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o700);
		ensureOwnerOnlyDir(dir);
		ensureOwnerOnlyDir(dir);
		expect(modeOf(dir)).toBe(OWNER_ONLY_DIR_MODE);
	});

	it("never throws on a MISSING path — it creates it", () => {
		const dir = join(tempDir("missing"), "a", "b", "store");
		expect(() => ensureOwnerOnlyDir(dir)).not.toThrow();
		expect(existsSync(dir)).toBe(true);
	});

	it("never throws on an UNWRITABLE path (a regular file where a dir belongs)", () => {
		const root = tempDir("unwritable");
		const file = join(root, "not-a-dir");
		writeFileSync(file, "x");
		expect(() => ensureOwnerOnlyDir(join(file, "child"))).not.toThrow();
		expect(existsSync(join(file, "child"))).toBe(false);
	});

	it("never throws on a malformed path", () => {
		expect(() => ensureOwnerOnlyDir("\0invalid")).not.toThrow();
	});

	it("never throws on a READONLY (owner-untraversable) directory", () => {
		if (!POSIX) return;
		const dir = join(tempDir("readonly"), "store");
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o500);
		// 0o500 has no group/other bits, so there is nothing to repair — the
		// helper must simply not throw (and must not widen the dir).
		expect(() => ensureOwnerOnlyDir(dir)).not.toThrow();
		expect(modeOf(dir)).toBe(0o500);
	});

	it("never follows a symlinked dir (chmod would retarget the link's target)", () => {
		if (!POSIX) return;
		const base = tempDir("symdir");
		const target = join(base, "target");
		const link = join(base, "link");
		mkdirSync(target, { recursive: true });
		chmodSync(target, 0o755);
		symlinkSync(target, link, "dir");
		ensureOwnerOnlyDir(link);
		expect(modeOf(target)).toBe(0o755);
	});
});

describe("repairOwnerOnlyFiles (issue #408)", () => {
	it("never chmods through a symlinked file", () => {
		if (!POSIX) return;
		// The target lives OUTSIDE the repaired dir: inside it, the target is a
		// regular file and the repair would legitimately chmod it.
		const outside = join(tempDir("symtarget"), "target.jsonl");
		const dir = tempDir("symfile");
		const link = join(dir, "link.jsonl");
		writeFileSync(outside, "{}\n");
		chmodSync(outside, 0o644);
		symlinkSync(outside, link);
		repairOwnerOnlyFiles(dir);
		expect(modeOf(outside)).toBe(0o644);
	});

	it("repairs a world-readable file to owner-only and leaves subdirectories alone", () => {
		if (!POSIX) return;
		const dir = tempDir("flat");
		const file = join(dir, "session.jsonl");
		const nested = join(dir, "nested");
		writeFileSync(file, "{}\n");
		chmodSync(file, 0o644);
		mkdirSync(nested, { recursive: true });
		chmodSync(nested, 0o755);

		repairOwnerOnlyFiles(dir);

		expect(modeOf(file)).toBe(OWNER_ONLY_FILE_MODE);
		// A directory is not a session file — only the dir helper owns its mode.
		expect(modeOf(nested)).toBe(0o755);
	});

	it("leaves an already owner-only file unchanged", () => {
		if (!POSIX) return;
		const dir = tempDir("already");
		const file = join(dir, "session.jsonl");
		writeFileSync(file, "{}\n");
		chmodSync(file, 0o600);
		repairOwnerOnlyFiles(dir);
		expect(modeOf(file)).toBe(OWNER_ONLY_FILE_MODE);
	});

	it("never throws on a missing directory", () => {
		expect(() => repairOwnerOnlyFiles(join(tempDir("missing-dir"), "absent"))).not.toThrow();
	});
});
