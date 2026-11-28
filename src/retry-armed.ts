// Purpose: The durable "retry armed" marker for the background transport auto-retry (issue #616).
/**
 * Issue #616 (Q3) — the ARMED-RETRY marker.
 *
 * The background transport auto-retry has an unaddressable window: the retry
 * attempt's id is minted inside `spawnBackgroundSession` and its agent record +
 * registry entry only land several statements later. Between the two, nothing
 * durable says the retry exists, so a `stop_subagent` aimed at the dispatch
 * finds a dead attempt 1 and truthfully-but-uselessly reports "stopped" while
 * the retry is being started.
 *
 * This module closes that window with a marker that is an **intent, not a run**:
 *
 *   - it is written by `scheduleTransportRetry` BEFORE the spawn
 *     (`armRetry`), naming the SOURCE run it replaces and the attempt it will
 *     become;
 *   - a stop of that dispatch sets `cancelRequested` (`cancelArmedRetry`);
 *   - the spawn honours it at its pre-prompt gate
 *     (`isRetryCancelRequested` → settle `stopped`, never prompt) and clears it
 *     once the retry is durable (`clearArmedRetry`).
 *
 * WHY NOT A FIELD ON THE EXISTING REGISTRY ENTRY: the retry's entry does not
 * exist yet inside the window — that IS the window. The marker therefore hangs
 * off the one id that does exist, the source run.
 *
 * WHY A SUBDIRECTORY (`.pi/run-registry/armed/`): every run-shaped reader —
 * `listInflightRuns` (and therefore the boot scan), run history, the monitor —
 * enumerates `*.json` files directly in the registry directory. A nested
 * directory is invisible to all of them by construction, which is what keeps an
 * INTENT from rendering as a RUN ROW. (`src/__tests__/stop-subagent-lineage.test.ts`
 * pins that: arming produces no registry entry and no run record.)
 *
 * Writes are atomic (temp + rename) and owner-only (0o600), mirroring the
 * registry's own discipline. Every reader is total: a missing, unreadable or
 * malformed marker reads as "nothing armed" and never throws — the failure mode
 * is the pre-#616 window, not a broken stop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomicSync } from './atomic-write';
import { registryDir } from './run-registry';
import { assertSafeAgentId } from './sanitize';
import { ensureOwnerOnlyDir } from './store-permissions';

/** The armed retry's cause. Only the automatic transport retry is ever armed. */
export type ArmedRetryCause = 'transport';

/** One durable "a transport retry is being started for this run" intent. */
export interface ArmedRetry {
	/** The SOURCE run id — the attempt a stop of the dispatch resolves to. */
	parentId: string;
	/** The attempt number the retry will carry (`sourceAttempt + 1`). */
	attempt: number;
	cause: ArmedRetryCause;
	/** ISO stamp of the arm write (diagnostics and ordering). */
	armedAt: string;
	/** Set by a stop that reached the dispatch while the retry was unspawned. */
	cancelRequested?: boolean;
	/** ISO stamp of that cancel. */
	cancelRequestedAt?: string;
}

/** The marker subdirectory, resolved against the CURRENT registry dir per call. */
function armedDir(): string {
	return path.join(registryDir(), 'armed');
}

/** `<registry>/armed/<parentId>.json`, or `null` for an unusable id. */
function armedPath(parentId: string): string | null {
	try {
		assertSafeAgentId(parentId);
	} catch {
		return null;
	}
	return path.join(armedDir(), `${parentId}.json`);
}

function isArmedRetry(value: unknown): value is ArmedRetry {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	if (typeof v.parentId !== 'string' || v.parentId === '') return false;
	if (typeof v.attempt !== 'number' || !Number.isFinite(v.attempt) || v.attempt < 1) return false;
	if (v.cause !== 'transport') return false;
	if (typeof v.armedAt !== 'string' || v.armedAt === '') return false;
	if (v.cancelRequested !== undefined && typeof v.cancelRequested !== 'boolean') return false;
	if (v.cancelRequestedAt !== undefined && typeof v.cancelRequestedAt !== 'string') return false;
	return true;
}

function writeArmed(retry: ArmedRetry): boolean {
	const file = armedPath(retry.parentId);
	if (!file) return false;
	try {
		ensureOwnerOnlyDir(armedDir());
		writeFileAtomicSync(file, JSON.stringify(retry, null, 2));
		return true;
	} catch {
		// Best-effort by contract: a marker that cannot be written leaves the
		// pre-#616 window, which is strictly better than refusing the retry.
		return false;
	}
}

/** Read one marker. Total: absent/unreadable/malformed all read as `null`. */
export function readArmedRetry(parentId: string): ArmedRetry | null {
	const file = armedPath(parentId);
	if (!file) return null;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
		if (!isArmedRetry(parsed)) return null;
		// The id in the FILE must be the id we asked about: a mismatched marker is
		// not this run's intent.
		return parsed.parentId === parentId ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Arm `attempt` for `parentId`. Idempotent: re-arming an already-armed retry
 * refreshes the stamp but PRESERVES a cancel that is already requested (a second
 * arming must not un-cancel a stop that already reached it).
 */
export function armRetry(input: {
	parentId: string;
	attempt: number;
	armedAt: string;
}): boolean {
	const existing = readArmedRetry(input.parentId);
	if (existing && existing.attempt === input.attempt) {
		return writeArmed({ ...existing, armedAt: input.armedAt });
	}
	return writeArmed({
		parentId: input.parentId,
		attempt: input.attempt,
		cause: 'transport',
		armedAt: input.armedAt,
	});
}

/**
 * What a stop's cancel attempt did. Three outcomes, not two, because the caller
 * must distinguish "the retry has not spawned yet" (`cancelled`) from "the
 * marker was already gone because the retry became durable" (`gone` — worth ONE
 * lineage re-read, since the retry is now a normal record) from "the marker is
 * there and could not be written" (`failed` — the retry may still prompt, which
 * is an error the caller must report).
 */
export type CancelOutcome = 'cancelled' | 'gone' | 'failed';

/** Request the cancel on an armed retry. Never throws. */
export function cancelArmedRetry(parentId: string, attempt: number): CancelOutcome {
	const existing = readArmedRetry(parentId);
	// A marker for a DIFFERENT attempt is not this retry's intent: treat it as
	// gone for this attempt (the gate compares attempts too, so no cancel leaks).
	if (!existing || existing.attempt !== attempt) return 'gone';
	const cancelled: ArmedRetry = {
		...existing,
		cancelRequested: true,
		cancelRequestedAt: new Date().toISOString(),
	};
	return writeArmed(cancelled) ? 'cancelled' : 'failed';
}

/**
 * The PRE-PROMPT gate (issue #616's Q3 seam): has a stop cancelled the retry
 * that is about to prompt? Total — an unreadable marker answers `false`, which
 * degrades to the pre-#616 behaviour rather than blocking a legitimate retry.
 */
export function isRetryCancelRequested(parentId: string, attempt: number): boolean {
	const armed = readArmedRetry(parentId);
	return !!armed && armed.attempt === attempt && armed.cancelRequested === true;
}

/** Drop the marker for `parentId` when it names `attempt`. True when none is left. */
export function clearArmedRetry(parentId: string, attempt?: number): boolean {
	const file = armedPath(parentId);
	if (!file) return true;
	const existing = readArmedRetry(parentId);
	if (existing && attempt !== undefined && existing.attempt !== attempt) return false;
	try {
		fs.unlinkSync(file);
		return true;
	} catch (err) {
		// Only ENOENT proves the desired end state (the same rule
		// `clearInflightRun` follows).
		return (err as NodeJS.ErrnoException).code === 'ENOENT';
	}
}
