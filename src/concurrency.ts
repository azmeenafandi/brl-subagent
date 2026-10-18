// Purpose: Session-bound concurrency queue: slot acquisition/release, priority insertion, and progress counters.
/**
 * brl-subagent — Concurrency Controller (F8)
 *
 * Manages the concurrency queue and progress tracking for subagent execution.
 * All state is contained in the SessionState instance — no module-level mutable variables.
 *
 * F8: Race condition fixes — progress counters are updated atomically within
 * acquireSlot/releaseSlot, eliminating races between parallel completions.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Priority } from "./types";
import { PRIORITY_ORDER } from "./types";
import type { SessionState } from "./state";
import { LIVE_SPINNER_FRAME_MS, formatProgressStatus } from "./tui-format";

// ---------------------------------------------------------------------------
// Slot management
// ---------------------------------------------------------------------------

/**
 * Acquire a concurrency slot. If maxParallel is reached, the caller is queued.
 * Returns true if a slot was acquired, false if cancelled while waiting.
 */
/**
 * Insert an entry into a priority queue. The entry is placed before the first
 * item with lower priority (higher numeric value). Equal-priority items maintain
 * FIFO order (stack behind existing same-priority items).
 */
export function priorityInsert<T extends { priority: Priority }>(
	queue: T[],
	entry: T,
): void {
	const newOrder = PRIORITY_ORDER[entry.priority];
	const idx = queue.findIndex(
		(existing) => PRIORITY_ORDER[existing.priority] > newOrder,
	);
	if (idx >= 0) {
		queue.splice(idx, 0, entry);
	} else {
		queue.push(entry);
	}
}

export async function acquireSlot(
	state: SessionState,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	priority?: Priority,
): Promise<boolean> {
	const maxParallel = state.config.maxParallel;

	if (maxParallel === 0 || state.activeSubagents < maxParallel) {
		state.activeSubagents++;
		updateProgressStatus(state, ctx);
		return true;
	}

	return new Promise((resolve) => {
		const entry = {
			run: () => {
				state.activeSubagents++;
				updateProgressStatus(state, ctx);
				resolve(true);
			},
			signal,
			ctx,
			priority: priority ?? "normal",
		};
		priorityInsert(state.pendingQueue, entry);
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					const idx = state.pendingQueue.indexOf(entry);
					if (idx >= 0) {
						state.pendingQueue.splice(idx, 1);
						resolve(false);
					}
				},
				{ once: true },
			);
		}
	});
}

/**
 * Release a concurrency slot and update progress counters.
 * This is the single point where counters are mutated — no races.
 */
export function releaseSlot(state: SessionState, success: boolean, ctx: ExtensionContext): void {
	// Atomically update all counters
	state.activeSubagents--;

	if (state.activeSubagents < 0) {
		state.activeSubagents = 0; // Defensive: should never happen
	}

	if (success) {
		state.completedSubagents++;
		state.unseenSubagents++;
	} else {
		state.failedSubagents++;
	}

	updateProgressStatus(state, ctx);

	// Dequeue next waiting task
	const next = state.pendingQueue.shift();
	if (next && !next.signal?.aborted) {
		next.run();
	}
}

// ---------------------------------------------------------------------------
// Progress status display
// ---------------------------------------------------------------------------

const STATUS_RESET_DELAY_MS = 3000;

/** Repaint the footer from the current counters (issue #354). */
function renderProgressStatus(state: SessionState, ctx: ExtensionContext): void {
	ctx.ui.setStatus(
		"brl-subagent",
		formatProgressStatus(state, Date.now(), ctx.ui.theme),
	);
}

/**
 * Keep the elapsed anchor in step with the active count: it is the start of
 * the run that opened the current burst of activity, so it survives the settle
 * of a later sibling and clears when the last run stops.
 */
function syncActiveSince(state: SessionState, now: number): void {
	if (state.activeSubagents > 0) {
		if (state.activeSinceMs === undefined) state.activeSinceMs = now;
	} else {
		state.activeSinceMs = undefined;
	}
}

/**
 * One ticker per session (issue #354): started by the first active run,
 * stopped when the last one settles. Idempotent, so every counter update can
 * call it — and it never coexists with the 2 s background poller, which ticks
 * on its own interval in src/index.ts.
 */
function syncProgressTicker(state: SessionState, ctx: ExtensionContext): void {
	if (state.activeSubagents === 0) {
		stopProgressTicker(state);
		return;
	}
	if (state.statusTicker === undefined) {
		state.statusTicker = setInterval(
			() => renderProgressStatus(state, ctx),
			LIVE_SPINNER_FRAME_MS,
		);
	}
}

/**
 * Stop the footer ticker (idempotent) and drop the elapsed anchor. Exported so
 * session shutdown/dispose can guarantee no timer outlives the session.
 */
export function stopProgressTicker(state: SessionState): void {
	if (state.statusTicker !== undefined) {
		clearInterval(state.statusTicker);
		state.statusTicker = undefined;
	}
	state.activeSinceMs = undefined;
}

/**
 * Drop the linger timer (idempotent). Exported so session shutdown can
 * guarantee no timer outlives the session.
 */
export function clearProgressLinger(state: SessionState): void {
	if (state.statusResetTimer !== undefined) {
		clearTimeout(state.statusResetTimer);
		state.statusResetTimer = undefined;
	}
}

/**
 * One linger timer per burst of settled runs (issue #354, F2).
 *
 * When every run has settled the footer lingers on the static summary line for
 * {@link STATUS_RESET_DELAY_MS} before the counters reset and the idle config
 * line returns. The timer is EDGE-triggered: it arms once, on the transition
 * into `active === 0` with something settled, and repeated renders of the same
 * linger line leave it alone — so N renders can never stack N timers, and no
 * render allocates a closure. Cleared when a new run becomes active (the
 * linger window is over), when it fires, and on session shutdown.
 *
 * The window is measured from the end of the burst, not from the last render:
 * a sibling settling inside it updates the line but does not extend it.
 */
export function syncProgressLinger(state: SessionState, ctx: ExtensionContext): void {
	const settled = state.completedSubagents + state.failedSubagents;

	// A live run, or nothing settled to linger over: no armed timer may survive.
	if (state.activeSubagents > 0 || settled === 0) {
		clearProgressLinger(state);
		return;
	}

	if (state.statusResetTimer !== undefined) return; // already armed — edge held

	state.statusResetTimer = setTimeout(() => {
		state.statusResetTimer = undefined;
		state.completedSubagents = 0;
		state.failedSubagents = 0;
		state.unseenSubagents = 0;
		updateStatus(state, ctx);
	}, STATUS_RESET_DELAY_MS);
}

export function updateProgressStatus(state: SessionState, ctx: ExtensionContext): void {
	syncActiveSince(state, Date.now());
	syncProgressLinger(state, ctx);

	const total = state.activeSubagents + state.completedSubagents + state.failedSubagents;

	if (total === 0) {
		updateStatus(state, ctx);
		return;
	}

	renderProgressStatus(state, ctx);
	syncProgressTicker(state, ctx);
}

export function updateStatus(state: SessionState, ctx: ExtensionContext): void {
	// The idle config line: no run is active, so the spinner has no job.
	stopProgressTicker(state);

	if (state.config.model) {
		ctx.ui.setStatus(
			"brl-subagent",
			ctx.ui.theme.fg(
				"accent",
				`brl:${state.config.model.id} [max think:${state.config.maxThinkingLevel}]`,
			),
		);
	} else {
		ctx.ui.setStatus(
			"brl-subagent",
			ctx.ui.theme.fg("muted", "brl: (use /brl-subagent to configure)"),
		);
	}
}
