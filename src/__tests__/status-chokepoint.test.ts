/**
 * Issue #356 — the footer repaint chokepoint.
 *
 * The status layer owns the paint: every lifecycle edge (dispatch, settle,
 * dequeue, config change, poller/spinner tick, linger fire) calls
 * `repaintStatus`, and no production source outside `src/concurrency.ts` calls
 * the paint implementation, aliases it, calls the idle line directly, or writes
 * the footer status key. The source scan below is the build failure that keeps a
 * future caller from drifting; tests opt in to the implementation directly.
 *
 * The unit half pins the chokepoint's two load-bearing properties: repeated
 * calls are idempotent (same line at a frozen clock, no stacked timers) and a
 * re-entrant paint from inside `setStatus` terminates without duplicating the
 * ticker.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { repaintStatus, stopProgressTicker } from "../concurrency";
import { createSessionState } from "../state";

const SRC_DIR = join(__dirname, "..");
const CONCURRENCY_FILE = join(SRC_DIR, "concurrency.ts");

/**
 * Production modules only: every TypeScript file under `src/`, excluding test
 * trees and the status layer itself. The walk is recursive so a future nested
 * module cannot silently escape the scan.
 */
function productionSources(): Array<{ file: string; text: string }> {
	const sources: Array<{ file: string; text: string }> = [];

	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__tests__") continue;
				walk(path);
				continue;
			}
			if (!entry.name.endsWith(".ts") || path === CONCURRENCY_FILE) continue;
			sources.push({ file: relative(SRC_DIR, path), text: readFileSync(path, "utf8") });
		}
	};

	walk(SRC_DIR);
	return sources;
}

function mockCtx() {
	const setStatus = vi.fn();
	const ctx = {
		ui: {
			setStatus,
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
	return { ctx, setStatus };
}

describe("footer repaint chokepoint — source boundary (issue #356)", () => {
	it("no production module outside the status layer calls the implementation", () => {
		const offenders = productionSources().filter(({ text }) =>
			/\bupdateProgressStatus\s*\(/.test(text),
		);
		expect(offenders.map(({ file }) => file)).toEqual([]);
	});

	it("no production module outside the status layer calls the idle line directly", () => {
		const offenders = productionSources().filter(({ text }) => /\bupdateStatus\s*\(/.test(text));
		expect(offenders.map(({ file }) => file)).toEqual([]);
	});

	it("no production module aliases the paint implementation or the idle line", () => {
		// Catches `const x = updateProgressStatus` / `= updateStatus` and
		// `import { updateStatus as x }`-style aliases. See the report note on
		// what a determined caller could still evade (e.g. `obj[\"updateStatus\"]`).
		const aliasPattern =
			/\b(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:updateProgressStatus|updateStatus)\b|\b(?:updateProgressStatus|updateStatus)\s+as\s+\w+/;
		const offenders = productionSources().filter(({ text }) => aliasPattern.test(text));
		expect(offenders.map(({ file }) => file)).toEqual([]);
	});

	it("no production module outside the status layer paints the footer key directly", () => {
		const offenders = productionSources().filter(({ text }) =>
			/\.ui\.setStatus\s*\(\s*["'`]brl-subagent/.test(text),
		);
		expect(offenders.map(({ file }) => file)).toEqual([]);
	});

	it("src/index.ts routes every repaint through repaintStatus", () => {
		const indexSource = readFileSync(join(SRC_DIR, "index.ts"), "utf8");

		expect(indexSource).not.toMatch(/\bupdateProgressStatus\b/);
		expect(indexSource).not.toMatch(/\bupdateStatus\b/);
		expect(indexSource).toMatch(/\brepaintStatus\s*\(/);
	});

	it("only the chokepoint calls the paint implementation", () => {
		const concurrencySource = readFileSync(CONCURRENCY_FILE, "utf8");

		// The definition is not a call; the single `(state, ctx)` call is the
		// chokepoint delegating to the implementation.
		expect(concurrencySource.match(/updateProgressStatus\(state, ctx\)/g)).toHaveLength(1);
	});
});

describe("footer repaint chokepoint — idempotence and reentrancy (issue #356)", () => {
	let setIntervalSpy: ReturnType<typeof vi.spyOn>;
	let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("repaints the same line and does not stack the spinner ticker", () => {
		const state = createSessionState();
		state.activeSubagents = 2;
		const { ctx, setStatus } = mockCtx();

		repaintStatus(state, ctx);
		const firstLine = setStatus.mock.calls.at(-1)?.[1];
		repaintStatus(state, ctx);
		const secondLine = setStatus.mock.calls.at(-1)?.[1];

		expect(secondLine).toBe(firstLine);
		expect(setStatus).toHaveBeenCalledTimes(2);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(setTimeoutSpy).not.toHaveBeenCalled();
		expect(state.activeSubagents).toBe(2);

		stopProgressTicker(state);
	});

	it("arms one linger timer across repeated idle renders, then fires once", () => {
		const state = createSessionState();
		state.completedSubagents = 1;
		state.unseenSubagents = 1;
		const { ctx, setStatus } = mockCtx();

		repaintStatus(state, ctx);
		repaintStatus(state, ctx);
		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

		const callsBeforeReset = setStatus.mock.calls.length;
		vi.advanceTimersByTime(3_000);

		expect(setStatus.mock.calls.length).toBe(callsBeforeReset + 1);
		expect(String(setStatus.mock.calls.at(-1)?.[1])).toContain("use /brl-subagent to configure");
		expect(state.completedSubagents).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("terminates when a render re-enters the chokepoint, without a second ticker", () => {
		const state = createSessionState();
		state.activeSubagents = 1;

		let reentered = false;
		const { ctx, setStatus } = mockCtx();
		setStatus.mockImplementation(() => {
			if (reentered) return;
			reentered = true;
			repaintStatus(state, ctx); // nested paint from inside the render
		});

		repaintStatus(state, ctx);

		expect(reentered).toBe(true);
		expect(setStatus).toHaveBeenCalledTimes(2);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(state.activeSubagents).toBe(1);
		expect(state.completedSubagents).toBe(0);

		stopProgressTicker(state);
	});
});
