/**
 * brl-subagent — Pure TUI formatting helpers
 *
 * Row-render logic shared by the live monitor and dashboard "Active
 * Subagents" panel. Kept free of pi-tui imports so it is unit-testable
 * without a TUI harness.
 */

import { formatTokens } from "./types";

/** Braille spinner frames, indexed by Math.floor(now / 150) % 10. */
export const LIVE_SPINNER_FRAMES: readonly string[] = [
	"\u280B",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283C",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280F",
];

/**
 * Format an elapsed duration (ms) as a compact string, e.g. "5s", "1m 5s".
 * Unified format: minutes and seconds are separated by a space.
 */
export function formatElapsed(ms: number): string {
	const elapsed = Math.round(ms / 1000);
	return elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

/** Live row display name: explicit label wins, else task truncated to 40 chars. */
export function liveRowName(label: string | undefined, task: string): string {
	return label || task.slice(0, 40);
}

/** Spinner frame at a given timestamp (ms since epoch). */
export function liveSpinner(now: number): string {
	return LIVE_SPINNER_FRAMES[Math.floor(now / 150) % 10];
}

/** Dim section of a live row: short id + token counts + elapsed. */
export function formatLiveRowDim(
	id: string,
	usage: { input: number; output: number },
	elapsedStr: string,
): string {
	return `  [${id.slice(0, 8)}]  \u2191${formatTokens(usage.input)} \u2193${formatTokens(usage.output)}  ${elapsedStr}`;
}
