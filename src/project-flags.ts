// Purpose: The single reader for the project-local `brl-subagent` umbrella flags (issue #415).
/**
 * The umbrella project-local flag: `{"brl-subagent": {"processChecks": true}}`.
 *
 * `processChecks` gates OUR process mechanisms — the Jev dispatch-line check
 * (#407/#412) and rule 2's durable-shape auto-switch (#412). It replaces the
 * merged-but-unreleased `requireJevLine`: one flag, one reader, no per-rule
 * fields.
 *
 * Why one reader (issue #415): the shape rule shipped GLOBAL, so a user's
 * explicit `background: false` + timeout was overridden by our conductor
 * decision rule. A conductor rule is not product behavior. Scoping both
 * mechanisms behind one project-local opt-in keeps a user's dispatch exactly as
 * they asked for it, and this module is the only place the manifest field is
 * read (the ratchet in `project-flags.test.ts` fails a second reader).
 *
 * FAIL-OPEN is the product contract: a missing, unreadable or malformed
 * `package.json` means `false`. A project's packaging mistake must never reject
 * a user's dispatch or reshape it.
 *
 * The manifest read is the project's OWN `package.json` — tracked, so it exists
 * in every worktree (worktrees share the repo's manifest), unlike a gitignored
 * marker under `.pi/`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The fields this module is allowed to read from the `brl-subagent` section.
 * A third field is a new mechanism, and a new mechanism needs its own ADR and
 * its own line in this whitelist (the ratchet enforces both directions).
 */
export const PROCESS_CHECK_KEYS = ["processChecks"] as const;

/**
 * Whether the project at `cwd` opted into our process checks. Fail-open in
 * every failure mode: no cwd, no manifest, unreadable manifest, malformed JSON,
 * a non-object section, or a non-boolean field all read as `false`.
 */
export function readProcessChecks(cwd: string | undefined): boolean {
	if (cwd === undefined || cwd === "") return false;
	try {
		const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
			"brl-subagent"?: { processChecks?: unknown };
		};
		return manifest?.["brl-subagent"]?.processChecks === true;
	} catch {
		return false;
	}
}

/**
 * The validation seam's name for the same read (`validatePreTask` asks "is the
 * check enabled for this project?"). One implementation: this is an alias, not
 * a second reader.
 */
export const isProcessChecksEnabled = readProcessChecks;
