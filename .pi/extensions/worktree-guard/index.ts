/**
 * worktree-guard — mechanically enforce rule #5 of the worktree framework:
 * "ALL code changes through a branch+worktree."
 *
 * INTERNAL dev-process tooling for the brl-subagent repo (issue #83).
 * Lives in .pi/extensions/ (TRACKED since #247 — not gitignored; pi project-local
 * auto-discovery, so it materializes in every worktree), NOT part of the shipped
 * extension — zero public-facing surface.
 *
 * What it does:
 *  1. tool_call block: intercepts write-tool calls (write/edit) whose target lands in the
 *     protected surface (`src/`, `presets/`) of a DURABLE checkout, and refuses them.
 *  2. before_agent_start: reminds the agent of the worktree rule.
 *
 * DURABLE vs SCRATCH (#617, brief `worktree-guard-durability`). A checkout tree is DURABLE
 * when a write there is a lasting change to the project, and SCRATCH when it is the
 * throwaway place rule #5 sends you. Identity is resolved PER TREE, walking up from the
 * target for `.git`, with no subprocess:
 *   a. `.git` is a DIRECTORY → the main worktree                      → durable;
 *   b. `.git` is a `gitdir:` FILE → read `<gitdir>/HEAD`:
 *        `ref: refs/heads/<branch>` with branch main|dev             → durable;
 *      (a detached HEAD is a bare sha and names no branch — clause c has to cover it);
 *   c. otherwise the tree's basename is in DURABLE_CHECKOUT_NAMES      → durable.
 * Everything else is scratch. The union is deliberate: each clause covers another's hole —
 * (a) survives a renamed main checkout, (b) covers a contributor's cockpit on `dev`, and
 * (c) survives the cockpit being detached or switched to a feature branch, where the branch
 * clause alone loses it (brief F4). The name list is the one environment fact, as a constant
 * reviewed beside the predicate that reads it (Q9).
 *
 * A target is protected iff ANY tree above its REAL path is durable — so a nested repo
 * cannot launder the cockpit, and a `.git` planted inside a scratch worktree cannot spoil a
 * fixture (Q5). Symlinks are resolved to the path that actually gets written (F5), and
 * metadata that cannot be read or parsed fails CLOSED with its own message, so "the guard is
 * blind" never reads as "you broke a rule" (Q2). No repository above the path → not
 * protected (Q3: the scratch root's own safety is scratch-root.mjs's job, #509). No cache:
 * HEAD moves and trees nest (F6).
 *
 * Whitelist (deliberate, per #83 design): .development/, README.md, package.json,
 * package-lock.json, .pi/ (so the guard can't block its own updates or the sync-extension
 * ritual), .github/, templates/, sync-extension.sh — evaluated on the DURABLE tree's
 * repo-relative path (Q7: the surface did not widen).
 *
 * COVERAGE BOUNDARY: `bash` is checked for package-manager installs only (#106/#215); a
 * src/ write smuggled through a shell is not inspected, and a shell parser would be a new
 * false-positive surface (Q11). This is a tripwire for the habitual path, not a sandbox.
 */

import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

// Repo root = the directory containing this extension's parent chain.
// Extension runs with cwd = the project root when auto-discovered. Used by the install
// heuristic's advice only — the classifier below resolves per target (issue #617).
const REPO_ROOT = process.cwd();
const WORKTREE_ROOT = resolve(REPO_ROOT, ".."); // sibling worktrees the install scan looks at

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
const PROTECTED_DIRS = ["src/", "presets/"];

/** Checkout basenames that are durable wherever they sit — the cockpit survives detach and a branch switch (F4). */
export const DURABLE_CHECKOUT_NAMES = ["brl-subagent", "brl-subagent-dev"];
/** Branches whose checkout is a release surface: a write there is durable, not scratch. */
const DURABLE_BRANCHES = ["main", "dev"];
const GITDIR_LINE_RE = /^gitdir:[ \t]*(.+?)[ \t]*$/m;
const BRANCH_REF_RE = /^ref:[ \t]*refs\/heads\/(.+)$/;
/** A detached HEAD is a bare object name; 7 is git's minimum abbreviation. */
const DETACHED_SHA_RE = /^[0-9a-f]{7,64}$/;

/** Why a tree is durable (or why its metadata could not be read) — pure data, so the matrix can assert it. */
export type TreeIdentity = {
	readonly root: string;
	readonly durable: boolean;
	readonly clause: "main-worktree" | "branch" | "name" | null;
	readonly branch: string | null;
	readonly error: string | null;
};

function identity(root: string, fields: Partial<TreeIdentity> = {}): TreeIdentity {
	return { root, durable: false, clause: null, branch: null, error: null, ...fields };
}

/** The branch HEAD names, or `null` for a detached HEAD; `error` when the link cannot be read or parsed. */
function readHead(gitDir: string): { branch: string | null; error: string | null } {
	const headPath = join(gitDir, "HEAD");
	let head: string;
	try {
		head = readFileSync(headPath, "utf8").trim();
	} catch {
		return { branch: null, error: `cannot read ${headPath}` };
	}
	const ref = BRANCH_REF_RE.exec(head);
	if (ref !== null) return { branch: ref[1].trim(), error: null };
	if (DETACHED_SHA_RE.test(head)) return { branch: null, error: null };
	return { branch: null, error: `${headPath} names neither a branch nor a commit` };
}

/**
 * The durability identity of the checkout rooted at `root` — the pure core of the classifier.
 * Pure with respect to history: it reads this tree's metadata and nothing else, so a nested
 * repo and its parent are independent answers (no root-keyed cache, F6).
 */
export function resolveTreeIdentity(root: string): TreeIdentity {
	const gitPath = join(root, ".git");
	try {
		// A directory IS the main worktree; no HEAD read is needed to know it is durable.
		if (statSync(gitPath).isDirectory()) return identity(root, { durable: true, clause: "main-worktree" });
	} catch {
		return identity(root, { error: `cannot read ${gitPath}` });
	}
	let text: string;
	try {
		text = readFileSync(gitPath, "utf8");
	} catch {
		return identity(root, { error: `cannot read ${gitPath}` });
	}
	const match = GITDIR_LINE_RE.exec(text);
	if (match === null) return identity(root, { error: `${gitPath} has no gitdir: line` });
	// A `--relative-paths` worktree writes `gitdir: ../..`, so the target is relative to THIS tree.
	const gitDir = isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
	const head = readHead(gitDir);
	if (head.error !== null) return identity(root, { error: head.error });
	if (head.branch !== null && DURABLE_BRANCHES.includes(head.branch)) {
		return identity(root, { durable: true, clause: "branch", branch: head.branch });
	}
	if (DURABLE_CHECKOUT_NAMES.includes(basename(root))) {
		return identity(root, { durable: true, clause: "name", branch: head.branch });
	}
	return identity(root, { branch: head.branch });
}

/**
 * Every checkout root at or above `from`, nearest first. `lstat`, not `exists`: a `.git`
 * that is a dangling symlink is still metadata, and the caller must fail closed on it
 * rather than read it as "no repository here" (Q2).
 */
function findTreeRoots(from: string): string[] {
	const roots: string[] = [];
	let dir = from;
	for (;;) {
		try {
			lstatSync(join(dir, ".git"));
			roots.push(dir);
		} catch {
			/* no checkout at this level */
		}
		const parent = dirname(dir);
		if (parent === dir) return roots;
		dir = parent;
	}
}

/**
 * The real path of `target`: `realpath` the deepest EXISTING ancestor and re-apply the
 * remaining segments lexically. A leaf symlink resolves — that is the file that gets
 * written (F5) — while a dangling leaf keeps its own lexical location, because there is no
 * destination to follow. One predicate, not two that must agree (Q8).
 */
function realTargetPath(target: string): string {
	const rest: string[] = [];
	let current = target;
	for (;;) {
		try {
			const real = realpathSync(current);
			return rest.length === 0 ? real : join(real, ...rest.slice().reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return target; // no existing ancestor: classify lexically
			rest.push(basename(current));
			current = parent;
		}
	}
}

/** Where the checkout walk starts: the target itself when it is a directory, else its parent. */
function walkStart(realPath: string): string {
	try {
		return statSync(realPath).isDirectory() ? realPath : dirname(realPath);
	} catch {
		return dirname(realPath);
	}
}

function ruleViolation(target: string): string {
	return `worktree-guard: ${target} is under src/ or presets/ and must only be changed through a worktree (rule #5). Create a worktree: git worktree add -b fix/... ../brl-subagent-<branch> dev, then work there.`;
}

/** The classifier's answer: refusal and its message travel together, so no caller invents one from `null`. */
type Verdict = { protected: false } | { protected: true; message: string };

/**
 * Classify one write target. `cwd` is the SESSION's directory: a relative target means
 * relative to the session, not to the extension's own checkout (#617's whole failure).
 */
function classifyTarget(target: string, cwd: string): Verdict {
	const real = realTargetPath(isAbsolute(target) ? resolve(target) : resolve(cwd, target));
	let unclassifiable: string | null = null;
	for (const root of findTreeRoots(walkStart(real))) {
		const tree = resolveTreeIdentity(root);
		if (tree.error !== null) {
			unclassifiable = tree.error;
			continue;
		}
		if (!tree.durable) continue;
		// The whitelist is written in repo-relative terms, so it is read against the DURABLE
		// tree this target sits in — never against the absolute path (rule #9: a raw absolute
		// path would miss `.pi/` and then the `/presets/` substring test would wrongly catch
		// `.pi/brl-subagent/presets/…`).
		const rel = relative(root, real).split(sep).join("/");
		if (WHITELIST_PREFIXES.some((w) => rel.startsWith(w))) continue;
		if (PROTECTED_DIRS.some((d) => rel.startsWith(d) || rel.includes("/" + d))) {
			return { protected: true, message: ruleViolation(target) };
		}
	}
	if (unclassifiable !== null) {
		return {
			protected: true,
			message: `worktree-guard: could not classify ${target}: ${unclassifiable} — refusing the write (fail-closed: rule #5 cannot be evaluated here).`,
		};
	}
	return { protected: false };
}

/**
 * True when a write/edit to `target` must be refused. Exported as the predicate the matrix
 * asks directly; the hook refuses on `true`. Defaults to the extension's own cwd, which is
 * the session cwd for an auto-discovered extension (the hook passes `ctx.cwd`).
 */
export function isPathProtected(target: string, cwd: string = process.cwd()): boolean {
	return classifyTarget(target, cwd).protected;
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
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (!event || typeof event.toolName !== "string") return;
		// The session's directory, not this extension's: a relative target is relative to
		// where the agent is working, which is what #617 got wrong.
		const sessionCwd = typeof ctx?.cwd === "string" && ctx.cwd !== "" ? ctx.cwd : process.cwd();

		// Issue #106: package-manager install through a symlinked node_modules
		// would clobber the cockpit's pristine tree (the #100 trap). This check runs
		// BEFORE the path-protection loop — the symlink targets must NOT go
		// through the classifier (a worktree's node_modules IS a legitimate symlink).
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

		for (const t of extractTargets(event.toolName, event.input ?? {})) {
			const verdict = classifyTarget(t, sessionCwd);
			if (verdict.protected) return { block: true, reason: verdict.message };
		}
	});

	pi.on("before_agent_start", async (_event: any, _ctx: any) => {
		// Reminder only — the tool_call block is the enforcement.
		return {
			message:
				"[worktree-guard] Remember: ALL changes to src/ or presets/ go through a SCRATCH worktree — a linked worktree on a branch that is not main/dev (git worktree add -b fix/... <path> dev). DURABLE checkouts are refused: the main worktree, any checkout on main or dev, and any checkout named brl-subagent or brl-subagent-dev. Whitelisted in a durable checkout: .development/, README.md, package.json, package-lock.json, .pi/, .github/, templates/, sync-extension.sh.",
		};
	});
}
