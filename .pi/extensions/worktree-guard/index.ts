/**
 * worktree-guard — mechanically enforce rule #5 of the worktree framework:
 * "ALL code changes through a branch+worktree."
 *
 * INTERNAL dev-process tooling for the brl-subagent repo (issue #83).
 * Lives in .pi/extensions/ (gitignored, pi project-local auto-discovery),
 * NOT part of the shipped extension — zero public-facing surface.
 *
 * What it does:
 *  1. tool_call block: intercepts write-tool calls (write/edit/bash) that
 *     target src/ or presets/ OUTSIDE a git worktree, and refuses them.
 *  2. before_agent_start: reminds the agent of the worktree rule.
 *
 * Whitelist (deliberate, per #83 design): .development/, README.md,
 * package.json, .pi/ (so the guard can't block its own updates or the
 * sync-extension ritual), and anything under a worktree
 * directory (../brl-subagent-*).
 */

import { lstatSync, readlinkSync } from "fs";
import { join, resolve } from "path";

// Repo root = the directory containing this extension's parent chain.
// Extension runs with cwd = the project root when auto-discovered.
const REPO_ROOT = process.cwd();
const WORKTREE_ROOT = resolve(REPO_ROOT, ".."); // worktrees are siblings

// Package-manager install commands that mutate node_modules (issue #106).
// Matched only at a COMMAND POSITION — the start of a shell segment — so the
// same words inside quoted text or an echo banner are not treated as an
// install (friction `guard-false-positive`, issue #215). COVERAGE BOUNDARY:
// an install hidden inside an exec-string (`bash -c "npm ci"`) is NOT matched.
// Accepted: the guard exists to stop the direct install a conductor runs
// against a symlinked tree; a deliberate nested shell is out of scope. Keep
// this boundary current if the heuristic changes.
const INSTALL_AT_POSITION_RE =
	/^(?:sudo\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|up|upgrade)\b/;

/** True when the command contains an install command at a shell command position. */
export function isInstallCommand(cmd: string): boolean {
	return cmd
		.split(/(?:&&|\|\||;|\n|\|)/)
		.some((segment) => INSTALL_AT_POSITION_RE.test(segment.trimStart()));
}

/**
 * True if the given dir's node_modules is a SYMLINK (the #100 trap: a bump
 * worktree prep'd without --force-isolated has a symlinked node_modules, and
 * npm install through it clobbers the cockpit's shared, pristine tree).
 */
function isSymlinkedNodeModules(dir: string): boolean {
	try {
		return lstatSync(join(dir, "node_modules")).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Block message for a symlinked node_modules (issue #215). When the symlink
 * targets the COCKPIT checkout's tree, the fix is to refresh that shared tree —
 * not to break the symlink — so the advice names the context-correct path;
 * `--force-isolated` remains the remedy only for a genuinely isolated bump
 * worktree (issue #100).
 */
export function blockReason(dirLabel: string, dirPath: string): string {
	const base = `worktree-guard: ${dirLabel}/node_modules is a SYMLINK to the cockpit's shared tree — an install here would clobber it (issue #100/#106).`;
	let link: string | null = null;
	try {
		link = readlinkSync(join(dirPath, "node_modules"));
	} catch {
		/* not a symlink — the caller checked; keep the generic advice */
	}
	const shared =
		link !== null && resolve(dirPath, link) === join(REPO_ROOT, "node_modules");
	if (shared) {
		return `${base} If the shared tree is merely STALE, refresh it in the COCKPIT: bash .pi/skills/worktree/check-repo.sh (it names the exact command). Re-prep with --force-isolated only if you intend an isolated dependency-bump worktree.`;
	}
	return `${base} Re-prep this worktree: worktree-prep.sh ${dirLabel} --force-isolated, then install.`;
}
const WHITELIST_PREFIXES = [
	".development/",
	"README.md",
	"package.json",
	"package-lock.json",
	".pi/",
	".github/",
	"templates/", // builtin template .md files are content, not code — editable
	"sync-extension.sh",
];
// Worktrees are siblings of the repo root named brl-subagent-<branch>.
const WORKTREE_PATTERN = /brl-subagent-[a-z0-9]+/;
const PROTECTED_DIRS = ["src/", "presets/"];

function isPathProtected(p: string): boolean {
	// Relativize FIRST — the edit tool sends absolute paths, and the whitelist
	// is written in repo-relative terms. Checking the raw absolute path against
	// the whitelist would fail, then the '/presets/' substring check would
	// wrongly catch whitelisted paths like .pi/brl-subagent/presets/ (found by
	// the guard itself at the point of use, 2026-08-17 — Rule 9).
	let rel = p;
	if (p.startsWith(REPO_ROOT + "/")) rel = p.slice(REPO_ROOT.length + 1);
	if (WHITELIST_PREFIXES.some((w) => rel.startsWith(w))) return false;
	// Inside a worktree sibling → not protected (worktrees are the allowed path).
	// The edit tool sends ABSOLUTE paths, and worktree siblings do NOT start
	// with REPO_ROOT — so relativize against WORKTREE_ROOT too, or the
	// exemption never fires for absolute paths (found at the point of use,
	// 2026-09-02, PR #152 — issue #153).
	const wtRel = p.startsWith(WORKTREE_ROOT + "/")
		? p.slice(WORKTREE_ROOT.length + 1)
		: rel;
	// NOTE: the repo-root check must include the trailing slash — a sibling
	// named brl-subagent-wt-154 STRING-PREFIXES brl-subagent, so a slash-less
	// startsWith(REPO_ROOT) misfires and blocks worktree paths (issue #153,
	// second round — found by instrumenting the exemption, 2026-09-04).
	if (WORKTREE_PATTERN.test(wtRel.split("/")[0] || "") && !p.startsWith(REPO_ROOT + "/")) return false;
	return PROTECTED_DIRS.some((d) => rel.startsWith(d) || rel.includes("/" + d));
}

function extractTargets(toolName: string, input: Record<string, unknown>): string[] {
	const targets: string[] = [];
	const push = (v: unknown) => {
		if (typeof v === "string") targets.push(v);
	};
	if (toolName === "write" || toolName === "edit") {
		push(input.path);
	} else if (toolName === "bash") {
		const cmd = typeof input.command === "string" ? input.command : "";
		// Heuristic: capture file-path-ish args to write/edit/tee/redirect.
		// This is deliberately conservative — false negatives are fine (the
		// before_agent_start reminder + review ritual are the backstop); false
		// positives would be worse (blocking legitimate bash).
	}
	return targets;
}

export default function initWorktreeGuard(pi: {
	on: (event: string, handler: (event: any, ctx: any) => unknown) => void;
}) {
	pi.on("tool_call", async (event: any, _ctx: any) => {
		if (!event || typeof event.toolName !== "string") return;

		// Issue #106: package-manager install through a symlinked node_modules
		// would clobber the cockpit's pristine tree (the #100 trap). This check runs
		// BEFORE the path-protection loop — the symlink targets must NOT go
		// through isPathProtected (whose worktree exemption would let them
		// through: a worktree's node_modules IS a legitimate symlink path).
		if (event.toolName === "bash") {
			const cmd = typeof event.input?.command === "string" ? event.input.command : "";
			if (isInstallCommand(cmd)) {
				// Path 1: the guard's own cwd is a worktree with a symlinked
				// node_modules (covers bash running inside a bump worktree).
				// Path 2: the command cd's into a worktree sibling whose
				// node_modules is a symlink (covers `cd ../brl-subagent-x && npm i`
				// from the cockpit checkout).
				if (isSymlinkedNodeModules(process.cwd())) {
					return {
						block: true,
						reason: blockReason("this checkout", process.cwd()),
					};
				}
				const refs = cmd.match(/brl-subagent-[a-zA-Z0-9-]+/g) ?? [];
				for (const ref of refs) {
					if (isSymlinkedNodeModules(join(WORKTREE_ROOT, ref))) {
						return {
							block: true,
							reason: blockReason(ref, join(WORKTREE_ROOT, ref)),
						};
					}
				}
			}
		}

		const targets = extractTargets(event.toolName, event.input ?? {});
		for (const t of targets) {
			if (isPathProtected(t)) {
				return {
					block: true,
					reason: `worktree-guard: ${t} is under src/ or presets/ and must only be changed through a worktree (rule #5). Create a worktree: git worktree add -b fix/... ../brl-subagent-<branch> dev, then work there.`,
				};
			}
		}
	});

	pi.on("before_agent_start", async (_event: any, _ctx: any) => {
		// Reminder only — the tool_call block is the enforcement.
		return {
			message:
				"[worktree-guard] Remember: ALL changes to src/ or presets/ go through a worktree (git worktree add -b fix/... ../brl-subagent-<branch> dev). Whitelisted: .development/, README.md, package.json, .pi/, .github/, templates/.",
		};
	});
}
