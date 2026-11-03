// Purpose: Builds the project's `<engineering-bar>` system-prompt section for every child spawn (issue #421).
/**
 * Issue #421 — the engineering bar is injected, never selected.
 *
 * The bar lived in the repo-local `project-implementer`/`project-reviewer`
 * presets, and four dispatches (#411, #412, #415, #419) ran on the shipped
 * `dev-agent` preset, which has no bar text at all. A per-dispatch choice is not
 * a mechanism. The bar is therefore read from ONE tracked file
 * (`.pi/skills/worktree/references/engineering-bar.md`) and appended to the
 * child's system prompt at both spawn seams — whatever preset the conductor
 * picked.
 *
 * The gate is the umbrella `processChecks` flag (ADR 0019), read through
 * `project-flags.ts` and nowhere else: in a user's project the bar is neither
 * injected nor read. Fail-open by contract — a missing or broken manifest means
 * no injection, never a failed spawn.
 *
 * Failure to READ the bar is the one non-fail-open case, and it is loud: a
 * missing or empty reference file logs one warning and skips the section. It
 * never throws into a spawn, and it never skips silently — a silently
 * unenforced bar is exactly the drift this issue exists to end.
 *
 * The section is built HERE as a complete framed string (not interpolated by
 * the callers) so `session-manager.ts`'s sections builder keeps interpolating
 * only the two charset-bounded caller fields pinned by its neutralization
 * ratchet. The bar's content needs no marker neutralization: its source is a
 * tracked repository file, not LLM-controlled output.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logging";
import { isProcessChecksEnabled } from "./project-flags";

/** The tracked reference, relative to the project root. */
export const ENGINEERING_BAR_PATH = ".pi/skills/worktree/references/engineering-bar.md";

/**
 * The `<engineering-bar>` section for a child spawned at `cwd`, or `null` when
 * the project has not opted in or the reference is missing/empty.
 *
 * `log` is caller-supplied (dependency inversion): each seam passes the logger
 * it already owns, so the warning lands in the same sink as the rest of that
 * spawn's diagnostics — and a test can assert the warning without a filesystem
 * sink.
 */
export function buildEngineeringBarSection(cwd: string | undefined, log: Logger): string | null {
	// `!cwd` is type narrowing, not a second gate: `project-flags.ts` owns the
	// flag's semantics, and it reads a missing cwd as disabled too.
	if (!cwd || !isProcessChecksEnabled(cwd)) return null;

	const file = join(cwd, ENGINEERING_BAR_PATH);
	let body: string;
	try {
		body = readFileSync(file, "utf8").trim();
	} catch (err) {
		log.warn("engineering bar: reference file unreadable — section skipped", {
			path: file,
			error: (err as Error).message,
		});
		return null;
	}
	if (body === "") {
		log.warn("engineering bar: reference file is empty — section skipped", { path: file });
		return null;
	}

	return `\n<engineering-bar>\n${body}\n</engineering-bar>\n`;
}
