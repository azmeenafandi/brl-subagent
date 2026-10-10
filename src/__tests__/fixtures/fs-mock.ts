/**
 * A transparent `node:fs` test double shared by the `/proc` scan suites.
 *
 * The recovery/proc tests need deterministic `/proc` failure paths, but a
 * module-wide `node:fs` mock must not perturb any other call. This wrapper
 * therefore intercepts ONLY `readdirSync` / `readFileSync` and delegates every
 * other call — and every un-stubbed path — to the real module:
 *
 *   - `readdirError` — throw it instead of listing (a `/proc` listing failure);
 *   - `dirEntries`   — return these entries instead of the real listing;
 *   - `statErrors`   — throw the errno mapped to a path string (a `stat` read
 *                      failure for one pid);
 *   - `statContents` — return the contents mapped to a path string.
 *
 * With none of the controls set the mock is fully transparent, so a suite that
 * never populates it is unaffected. Vitest isolates the module registry per test
 * file, so `fsMockControl` is a per-file singleton: each suite imports it to
 * drive and reset the mock it installed with `buildFsMock`.
 */

import type * as fs from "node:fs";

export interface FsMockControl {
	readdirError?: NodeJS.ErrnoException;
	dirEntries?: string[];
	statErrors: Map<string, NodeJS.ErrnoException>;
	statContents: Map<string, string>;
}

/**
 * The per-file mock control. Reset to full transparency with `resetFsMock` in
 * `beforeEach`/`afterEach` so a forced failure cannot leak between tests.
 */
export const fsMockControl: FsMockControl = {
	readdirError: undefined,
	dirEntries: undefined,
	statErrors: new Map(),
	statContents: new Map(),
};

/** Reset every control so the mock delegates to the real `node:fs` again. */
export function resetFsMock(): void {
	fsMockControl.readdirError = undefined;
	fsMockControl.dirEntries = undefined;
	fsMockControl.statErrors.clear();
	fsMockControl.statContents.clear();
}

/**
 * Build the mocked `node:fs` module namespace from the real module and the
 * shared control. Intended use:
 *
 *   vi.mock("node:fs", async (importOriginal) => {
 *     const actual = await importOriginal<typeof import("node:fs")>();
 *     const { buildFsMock } = await import("./fixtures/fs-mock");
 *     return buildFsMock(actual);
 *   });
 */
export function buildFsMock(actual: typeof fs): typeof fs {
	return {
		...actual,
		readdirSync: ((...args: unknown[]) => {
			if (fsMockControl.readdirError) throw fsMockControl.readdirError;
			if (fsMockControl.dirEntries) return fsMockControl.dirEntries;
			return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
		}) as typeof actual.readdirSync,
		readFileSync: ((...args: unknown[]) => {
			const file = String(args[0]);
			const err = fsMockControl.statErrors.get(file);
			if (err) throw err;
			const contents = fsMockControl.statContents.get(file);
			if (contents !== undefined) return contents;
			return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
		}) as typeof actual.readFileSync,
	};
}
