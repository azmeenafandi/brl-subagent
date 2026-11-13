/**
 * Issue #511 (U2): point every spawn's scratch root at a throwaway directory.
 *
 * The spawn seam resolves a real root and CREATES `<root>/runs/<id>` on every
 * dispatch, so without this redirect a test run would write into the
 * developer's own `~/.cache/brl-subagent` (and leave it there — a run directory
 * is only pruned after it is marked settled and ages out).
 *
 * The location and the redirect both live in
 * `fixtures/scratch-root-isolation.ts`, because the suites that rebuild the
 * module graph (`vi.resetModules()`) must be able to re-apply them.
 */
import { rmSync } from "node:fs";
import { redirectScratchRoot, scratchRootUnderRepoTmp } from "./fixtures/scratch-root-isolation";

// Fresh per process: a leftover root from a killed run would otherwise be
// pruned/asserted against by this one.
rmSync(scratchRootUnderRepoTmp(), { recursive: true, force: true });
redirectScratchRoot();
