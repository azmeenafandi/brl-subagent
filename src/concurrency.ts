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
import type { SessionState } from "./state";

// ---------------------------------------------------------------------------
// Slot management
// ---------------------------------------------------------------------------

/**
 * Acquire a concurrency slot. If maxParallel is reached, the caller is queued.
 * Returns true if a slot was acquired, false if cancelled while waiting.
 */
export async function acquireSlot(
	state: SessionState,
	ctx: ExtensionContext,
	signal?: AbortSignal,
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
		};
		state.pendingQueue.push(entry);
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

export function updateProgressStatus(state: SessionState, ctx: ExtensionContext): void {
	const total = state.activeSubagents + state.completedSubagents + state.failedSubagents;

	if (total === 0) {
		updateStatus(state, ctx);
		return;
	}

	const parts: string[] = [];
	if (state.activeSubagents > 0) parts.push(`${state.activeSubagents} running`);
	if (state.completedSubagents > 0) {
		if (state.unseenSubagents > 0) {
			parts.push(`${state.completedSubagents} done (${state.unseenSubagents} unseen)`);
		} else {
			parts.push(`${state.completedSubagents} done`);
		}
	}
	if (state.failedSubagents > 0) parts.push(`${state.failedSubagents} failed`);

	const statusText = `brl: ${parts.join(", ")}`;
	ctx.ui.setStatus("brl-subagent", ctx.ui.theme.fg("accent", statusText));

	// When all subagents finish, reset counters after a brief delay
	if (state.activeSubagents === 0 && total > 0) {
		const snapshotTotal = total;
		setTimeout(() => {
			if (
				state.activeSubagents === 0 &&
				state.completedSubagents + state.failedSubagents === snapshotTotal
			) {
				state.completedSubagents = 0;
				state.failedSubagents = 0;
				state.unseenSubagents = 0;
				updateStatus(state, ctx);
			}
		}, STATUS_RESET_DELAY_MS);
	}
}

export function updateStatus(state: SessionState, ctx: ExtensionContext): void {
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
