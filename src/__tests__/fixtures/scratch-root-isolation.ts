/**
 * Issue #511 (U2): the one definition of "where does a test's scratch root
 * live", shared by the global setup file and by the suites that rebuild the
 * module graph mid-test (`vi.resetModules()` gives them a FRESH `scratch-spawn`
 * instance, whose redirect is unset — re-running this is how such a test keeps
 * the guarantee).
 *
 * The root sits inside the repository's gitignored `.tmp/` chain, NOT under
 * `os.tmpdir()`: `/tmp` is `1777`, so the shipped resolver would warn about a
 * writable ancestor on every resolve (warned, never refused — but noise).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { __setScratchRoot } from "../../scratch-spawn";

/** This process's throwaway scratch root, created at 0700. */
export function scratchRootUnderRepoTmp(): string {
	const root = join(process.cwd(), ".tmp", `scratch-vitest-${process.pid}`);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}

/** Point the CURRENT `scratch-spawn` module instance at that root. */
export function redirectScratchRoot(): string {
	const root = scratchRootUnderRepoTmp();
	__setScratchRoot(root);
	return root;
}
