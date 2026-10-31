// Purpose: Owner-only repair for the persistent stores' directories and files — mkdirSync's mode applies only on CREATE.
/**
 * Issue #408 — owner-only persistence repair.
 *
 * F6 (issue #29) intended `0o700` directories and `0o600` files, but
 * `mkdirSync(dir, { recursive: true, mode: 0o700 })` does NOT chmod a directory
 * that already exists (and the SDK's `SessionManager` creates its per-run dir
 * with the process default). A store created before the mode intent therefore
 * stayed world-readable: `.pi/subagents`, `.pi/subagents/sessions`,
 * `.pi/run-registry` and `.pi/output` were all `0o755` on the machine this was
 * found on.
 *
 * THE CONFIDENTIALITY BOUNDARY IS THE DIRECTORY MODE. A `0o700` directory
 * denies other local users traversal, so the files inside are unreachable even
 * if a file mode is wider; the file repairs below are defense-in-depth, not the
 * enforcement. Every store therefore calls `ensureOwnerOnlyDir` on EVERY use —
 * create-only modes are not a repair.
 *
 * Both helpers are best-effort by construction: they never throw, because they
 * run on spawn/settle/registry-write paths where a permission failure must not
 * break execution. A failure is logged and the path is left as it was.
 */
import { chmodSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logging';

const log = createLogger('brl-subagent');

/** Owner-only directory mode (rwx for the owner, no traversal for anyone else). */
export const OWNER_ONLY_DIR_MODE = 0o700;
/** Owner-only file mode (read/write for the owner only). */
export const OWNER_ONLY_FILE_MODE = 0o600;

/**
 * Create `dir` owner-only, or repair an existing directory whose mode grants
 * any group/other bits (`mode & 0o077 !== 0`). Idempotent; never throws.
 *
 * When `dir` is missing, `mkdirSync` creates it (and any missing parents); the
 * explicit `statSync`/`chmodSync` below then normalizes the LEAF, so a fresh
 * directory is `0o700` regardless of umask or Node's per-component defaults.
 */
export function ensureOwnerOnlyDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  } catch (err) {
    log.warn(`Could not create owner-only dir ${dir}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  try {
    const mode = statSync(dir).mode & 0o777;
    if ((mode & 0o077) !== 0) chmodSync(dir, OWNER_ONLY_DIR_MODE);
  } catch (err) {
    // Best-effort: a vanished/unreadable path must never break the caller.
    log.warn(`Could not repair owner-only dir ${dir}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Repair the modes of the FLAT files directly inside `dir` (the per-run session
 * dir is small — one `.jsonl` plus at most a retention marker), leaving
 * subdirectories alone. Best-effort: a file that vanishes between `readdir` and
 * `stat` is skipped silently, and a failed chmod is logged, never thrown.
 *
 * Defense-in-depth only — see the module comment: the directory mode is what
 * keeps other local users out.
 */
export function repairOwnerOnlyFiles(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // missing/unreadable dir — nothing to repair
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      if ((stat.mode & 0o077) !== 0) chmodSync(file, OWNER_ONLY_FILE_MODE);
    } catch {
      // Vanished between readdir and stat, or otherwise unreadable — skip.
    }
  }
}
