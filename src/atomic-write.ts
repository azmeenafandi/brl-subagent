// Purpose: A same-directory temp+rename writer for the agent record — a reader never sees a torn JSON file.
/**
 * Issue #554 — process-kill atomicity for the agent store's one record writer.
 *
 * `persistAgent` used to `writeFileSync(filePath, json)`: Node truncates the
 * destination and then writes, so a SIGKILL between those two steps leaves a
 * half-written record — unparseable, and indistinguishable from a permissions
 * fault to every reader. The fix is the standard one: write the whole text to a
 * temp file in the SAME directory, `fsync` it best-effort, then `rename` it over
 * the destination. On POSIX a rename is atomic, so a reader sees either the old
 * file or the new one — never a torn one.
 *
 * WHAT THIS DOES NOT CLAIM (issue #554 §2): the guarantee is process-kill
 * atomicity, not power-loss durability. The temp file is fsynced best-effort
 * (a failure is swallowed — some filesystems/files reject it and a record write
 * must not fail for that), and the DIRECTORY is deliberately not fsynced. Nor is
 * this writer isolation: two writers can still interleave, and the last rename
 * wins. Atomicity is a reader-facing invariant, not a last-writer-wins one.
 *
 * The temp's mode travels through the rename (the destination's inode changes);
 * callers get a `0o600` record on every successful write, which is the mode
 * `persistAgent` has always asked for.
 */
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * The filesystem surface this writer uses. Production passes nothing (the real
 * `node:fs` is the default); `options.fs` exists ONLY as a fault-injection seam
 * for tests — there is no production caller that supplies it.
 */
export interface AtomicFs {
	openSync(path: string, flags: string, mode?: number): number;
	writeFileSync(fd: number, data: string): void;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
	renameSync(from: string, to: string): void;
	unlinkSync(path: string): void;
}

const nodeFs: AtomicFs = { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync };

/** Default mode for the temp (and therefore the destination) file. */
const DEFAULT_MODE = 0o600;

/**
 * Write `text` to `file` atomically with respect to a process kill.
 *
 * The temp is `${file}.${pid}.${8 random bytes}.tmp` in the destination's own
 * directory, so the rename never crosses a filesystem boundary. `mode` is
 * applied when the temp is CREATED (the old file's mode is not consulted).
 *
 * On any failure the temp is unlinked best-effort — its own error is swallowed
 * so it can never mask the original — and the original error is rethrown.
 */
export function writeFileAtomicSync(
	file: string,
	text: string,
	options?: { mode?: number; fs?: AtomicFs },
): void {
	const fs = options?.fs ?? nodeFs;
	const mode = options?.mode ?? DEFAULT_MODE;
	const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
	try {
		const fd = fs.openSync(tmp, 'wx', mode);
		try {
			fs.writeFileSync(fd, text);
			// Best-effort: the guarantee is a complete file after a process kill,
			// not that its bytes survive a power loss.
			try {
				fs.fsyncSync(fd);
			} catch {
				// swallowed on purpose — see the module comment
			}
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
	} catch (err) {
		// Best-effort cleanup whose failure must never mask `err`.
		try {
			fs.unlinkSync(tmp);
		} catch {
			// already gone, or the directory is unwritable — nothing to do
		}
		throw err;
	}
}
