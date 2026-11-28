/**
 * The worktree-guard's classification matrix (issue #617, brief `worktree-guard-durability`).
 *
 * WHY THIS FILE EXISTS. The guard decides whether a `write`/`edit` may touch `src/` or `presets/`, and
 * it decided it from `process.cwd()` — so a session whose cwd is its own linked worktree refused every
 * sanctioned `src/` write (rule #5 blocked the one place that obeys rule #5), while the same session
 * could still write the COCKPIT's `src/` by absolute path. Nothing ran this predicate in CI: the old
 * `guard.test.cjs` held 13 install-heuristic checks and was wired to nothing (brief F10). This suite is
 * that file's port plus one case per falsifier F1–F12 of the brief, so a classifier regression fails
 * here instead of surfacing as friction inside a dispatch.
 *
 * WHAT A ROW CLAIMS: that the guard's `tool_call` handler, given this session cwd and this target,
 * blocks or does not block — the refusal REASON is asserted only where the brief distinguishes two of
 * them (F11's `could not classify …` must never read as a rule violation). The handler is the real one:
 * `initWorktreeGuard` is called with a fake `pi` that captures the registered handlers, so the rows
 * exercise the shipped wiring, not a re-implementation.
 *
 * WHY REAL REPOSITORIES. The classifier reads `.git` and `HEAD` (no subprocess) and the durability
 * decision depends on the layout: a main worktree's `.git` is a directory, a linked worktree's is a
 * `gitdir:` file — absolute or (F3) relative — with `commondir`, and a detached HEAD is a bare sha.
 * Faking those in memory would test the fake. So each layout is a real `git init` / `git worktree add`
 * fixture, built once in `beforeAll` under one `mkdtemp` directory.
 *
 * HERMETICITY: the fixture base is `mkdtemp(join(tmpdir(), …))` and is removed in `afterAll`; nothing is
 * written inside the repository. Git runs with `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at `/dev/null`
 * and explicit author/committer identity, so a developer's git config (signing, hooks, templates)
 * cannot change a fixture's shape and no command can reach a network.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import initWorktreeGuard, {
	DURABLE_CHECKOUT_NAMES,
	blockReason,
	isInstallCommand,
	isPathProtected,
	resolveTreeIdentity,
} from "../../../extensions/worktree-guard/index.ts";

/** Every git command in this file: hermetic env, no prompts, a fixed identity. */
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "guard-617",
	GIT_AUTHOR_EMAIL: "guard-617@example.invalid",
	GIT_COMMITTER_NAME: "guard-617",
	GIT_COMMITTER_EMAIL: "guard-617@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} (in ${cwd}) exited ${result.status}\n${result.stdout}\n${result.stderr}`);
	}
	return result.stdout;
}

/** `git init` + one empty commit, so `git worktree add` has a HEAD to branch from. */
function initRepo(dir: string, branch: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", branch);
	git(dir, "commit", "-q", "--allow-empty", "-m", "init");
}

function addWorktree(
	repo: string,
	worktreePath: string,
	options: { branch?: string; start?: string; relative?: boolean } = {},
): void {
	const args = ["worktree", "add", "-q"];
	if (options.relative) args.push("--relative-paths");
	if (options.branch) args.push("-b", options.branch);
	args.push(worktreePath);
	if (options.start) args.push(options.start);
	git(repo, ...args);
}

/** The fixture trees. Named once, assigned in `beforeAll`, read by every row. */
let base = "";
/** A tree with no `.git` above it at all — the scratch-root answer (F10). */
let plain = "";
/** The fixture project's MAIN worktree: `.git` is a directory, branch `feature/main-branch` (F7). */
let primary = "";
/** A linked worktree of the project on `dev`, basename `brl-subagent-dev`: durable by branch AND name. */
let cockpit = "";
/** A linked worktree of the project on `fix/617-x`, basename `scratch-wt`: durable by nothing. */
let scratch = "";
/** A linked worktree of the project on `main` added with `--relative-paths` (F3's relative `gitdir:`). */
let relativeGitdir = "";
/** A nested repo (a linked worktree of another project) INSIDE the scratch worktree (F9, allowed). */
let nestedInScratch = "";
/** The same, INSIDE the cockpit (F9, refused — the durable ancestor decides). */
let nestedInCockpit = "";
/** A `git init` nested inside the scratch worktree: a main worktree, durable by structure (boundary). */
let plainInitInScratch = "";
/** Basename `brl-subagent-dev`, detached HEAD: durable by name only (F6). */
let detachedCockpit = "";
/** Basename `brl-subagent-dev`, branch `feature/x`: durable by name only (F6). */
let switchedCockpit = "";
/** Branch `dev`, basename `cockpit-on-dev`: durable by branch only (F6). */
let otherNameOnDev = "";
/** `.git` file with no `gitdir:` line at all (F11). */
let brokenGit = "";
/** `.git` file whose `gitdir:` names nothing (F11). */
let missingGitdir = "";
/** `.git` file that cannot be read (F11). */
let unreadableGit = "";

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "guard-617-"));
	plain = join(base, "plain");
	mkdirSync(join(plain, "no-repo", "src"), { recursive: true });

	// The project. Its main worktree sits on a branch that is neither `main` nor `dev`, and its directory
	// basename is in no durable list — so F7 isolates the STRUCTURAL clause, and nothing else is durable.
	primary = join(base, "a", "tree-a");
	initRepo(primary, "feature/main-branch");
	git(primary, "branch", "main");
	cockpit = join(base, "a", "brl-subagent-dev");
	addWorktree(primary, cockpit, { branch: "dev" });
	scratch = join(base, "a", "scratch-wt");
	addWorktree(primary, scratch, { branch: "fix/617-x" });
	relativeGitdir = join(base, "a", "rel-gitdir");
	addWorktree(primary, relativeGitdir, { start: "main", relative: true });

	// F9. The nested projects are separate repositories, added as linked worktrees: a nested tree that is
	// durable by NOTHING, so the ancestor rule is the only thing that can decide — a nested MAIN worktree
	// would be durable on its own and prove nothing about ancestors (see the boundary row below).
	const vendor = join(base, "vendor-src");
	initRepo(vendor, "main");
	nestedInScratch = join(scratch, "vendor", "nested");
	addWorktree(vendor, nestedInScratch, { branch: "vendor/nested" });
	nestedInCockpit = join(cockpit, "vendor", "planted");
	addWorktree(vendor, nestedInCockpit, { branch: "vendor/planted" });
	plainInitInScratch = join(scratch, "vendor", "plaininit");
	initRepo(plainInitInScratch, "main");

	// F6: three durable-by-one-clause cockpits whose second clause cannot rescue them.
	const repoB = join(base, "b", "tree-b");
	initRepo(repoB, "main");
	detachedCockpit = join(base, "b", "brl-subagent-dev");
	addWorktree(repoB, detachedCockpit, { branch: "feature/cockpit" });
	git(detachedCockpit, "checkout", "-q", "--detach");

	const repoC = join(base, "c", "tree-c");
	initRepo(repoC, "main");
	switchedCockpit = join(base, "c", "brl-subagent-dev");
	addWorktree(repoC, switchedCockpit, { branch: "feature/x" });

	const repoD = join(base, "d", "tree-d");
	initRepo(repoD, "main");
	otherNameOnDev = join(base, "d", "cockpit-on-dev");
	addWorktree(repoD, otherNameOnDev, { branch: "dev" });

	// F11: three unreadable/unparseable metadata shapes.
	brokenGit = join(base, "f11", "broken-git");
	mkdirSync(join(brokenGit, "src"), { recursive: true });
	writeFileSync(join(brokenGit, ".git"), "this checkout's metadata is not a gitdir line\n");
	missingGitdir = join(base, "f11", "missing-gitdir");
	mkdirSync(join(missingGitdir, "src"), { recursive: true });
	writeFileSync(join(missingGitdir, ".git"), "gitdir: /nonexistent/guard-617/worktrees/gone\n");
	unreadableGit = join(base, "f11", "unreadable-git");
	mkdirSync(join(unreadableGit, "src"), { recursive: true });
	writeFileSync(join(unreadableGit, ".git"), "gitdir: /nonexistent/guard-617/worktrees/gone\n");
	chmodSync(join(unreadableGit, ".git"), 0o000);

	// F8: the symlink shapes. A leaf link in the scratch worktree aimed at the cockpit's `src/`, a whole
	// directory link, a cockpit-internal alias into a whitelisted tree, and two dangling leaves — one in
	// the cockpit's `src/` (its own location must decide) and one in the scratch worktree. The fixture
	// checkouts are empty (one empty commit each), so the directories a link can point into are made here.
	mkdirSync(join(cockpit, "src"), { recursive: true });
	mkdirSync(join(cockpit, ".pi"), { recursive: true });
	mkdirSync(join(scratch, "src"), { recursive: true });
	// A real file, so the leaf link below RESOLVES — a dangling leaf is the next-but-one row, and its
	// answer (its own lexical location) is the opposite one.
	writeFileSync(join(cockpit, "src", "x.ts"), "// fixture\n");
	symlinkSync(join(cockpit, "src", "x.ts"), join(scratch, "leaf.ts"));
	symlinkSync(join(cockpit, "src"), join(scratch, "linkdir"));
	symlinkSync(join(cockpit, ".pi", "tool.ts"), join(cockpit, "alias.ts"));
	symlinkSync(join(scratch, "missing.ts"), join(cockpit, "src", "dangling.ts"));
	symlinkSync(join(cockpit, "src", "missing.ts"), join(scratch, "dangling.ts"));
});

afterAll(() => {
	if (base !== "") rmSync(base, { recursive: true, force: true });
});

/** The handlers the extension registers, captured from its real `initWorktreeGuard`. */
const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
initWorktreeGuard({
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
		handlers.set(event, handler);
	},
});

type Decision = { block: boolean; reason: string };

/** Drive the shipped `tool_call` handler as a `write` of `target` in a session whose cwd is `sessionCwd`. */
async function attempt(target: string, sessionCwd: string): Promise<Decision> {
	const handler = handlers.get("tool_call");
	if (handler === undefined) throw new Error("the extension registered no tool_call handler");
	const result = (await handler({ toolName: "write", input: { path: target } }, { cwd: sessionCwd })) as
		| { block?: boolean; reason?: string }
		| undefined;
	if (result?.block === true) return { block: true, reason: String(result.reason ?? "") };
	return { block: false, reason: "" };
}

async function expectAllowed(target: string, sessionCwd: string): Promise<void> {
	const decision = await attempt(target, sessionCwd);
	expect(decision.block, `expected ALLOWED, got: ${decision.reason}`).toBe(false);
}

async function expectRefused(target: string, sessionCwd: string): Promise<void> {
	const decision = await attempt(target, sessionCwd);
	expect(decision.block, "expected the guard to refuse this write").toBe(true);
	expect(decision.reason).toContain("must only be changed through a worktree");
}

/** F11's message must be distinguishable from a rule violation, or "the guard is blind" reads as "you broke a rule". */
async function expectUnclassified(target: string, sessionCwd: string): Promise<void> {
	const decision = await attempt(target, sessionCwd);
	expect(decision.block, "an unclassifiable target must fail closed").toBe(true);
	expect(decision.reason).toMatch(/could not classify/);
	expect(decision.reason).toContain(target);
	expect(decision.reason).not.toContain("must only be changed through a worktree");
}

describe("the module loads and wires its handlers (the old jiti load check)", () => {
	it("exports a default extension function that registers tool_call and before_agent_start", () => {
		expect(typeof initWorktreeGuard).toBe("function");
		expect(handlers.has("tool_call")).toBe(true);
		expect(handlers.has("before_agent_start")).toBe(true);
	});

	it("keeps the reminder, in durable/scratch vocabulary rather than sibling-path vocabulary", async () => {
		const reminder = (await handlers.get("before_agent_start")?.({}, {})) as { message?: string } | undefined;
		expect(typeof reminder?.message).toBe("string");
		expect(reminder?.message).toContain("worktree");
		expect(reminder?.message).not.toContain("../brl-subagent-<branch>");
	});
});

describe("F1/F2 — the sanctioned place to obey rule #5 is allowed", () => {
	it("F1: a relative src/ path from a scratch worktree is allowed", async () => {
		await expectAllowed("src/tui.ts", scratch);
	});

	it("F1: a relative presets/ path from a scratch worktree is allowed", async () => {
		await expectAllowed("presets/dev-agent.md", scratch);
	});

	it("F2: an absolute src/ path inside the session's own worktree is allowed", async () => {
		await expectAllowed(join(scratch, "src", "tui.ts"), scratch);
	});
});

describe("F3 — the cockpit's own src/ is refused from a worktree session", () => {
	it("F3: an absolute cockpit src/ path is refused", async () => {
		await expectRefused(join(cockpit, "src", "tui.ts"), scratch);
	});

	it("F4: ../brl-subagent-dev/src/… is refused", async () => {
		await expectRefused("../brl-subagent-dev/src/tui.ts", scratch);
	});
});

describe("F5 — a durable checkout still may not change its own protected surface", () => {
	it("F5: a relative src/ path from the cockpit is refused", async () => {
		await expectRefused("src/tui.ts", cockpit);
	});

	it("F5: an absolute src/ path inside the cockpit is refused", async () => {
		await expectRefused(join(cockpit, "src", "tui.ts"), cockpit);
	});

	it("F5: a presets/ path in the cockpit is refused", async () => {
		await expectRefused("presets/dev-agent.md", cockpit);
	});

	it("F5: the cockpit's .pi/ is whitelisted", async () => {
		await expectAllowed(".pi/extensions/worktree-guard/index.ts", cockpit);
	});

	it("F5: the cockpit's .development/ is whitelisted", async () => {
		await expectAllowed(".development/handoff/state.md", cockpit);
	});
});

describe("F6 — the name clause survives a detached or switched cockpit", () => {
	it("F6: a detached cockpit's relative src/ is refused", async () => {
		await expectRefused("src/tui.ts", detachedCockpit);
	});

	it("F6: a detached cockpit's absolute src/ is refused", async () => {
		await expectRefused(join(detachedCockpit, "src", "tui.ts"), detachedCockpit);
	});

	it("F6: a cockpit switched to feature/x is refused", async () => {
		await expectRefused("src/tui.ts", switchedCockpit);
	});

	it("F6: a cockpit on dev under another name is refused (the branch clause)", async () => {
		await expectRefused("src/tui.ts", otherNameOnDev);
	});
});

describe("F7 — the structural clause: a main worktree is durable on any branch", () => {
	it("F7: the main worktree's relative src/ is refused", async () => {
		await expectRefused("src/tui.ts", primary);
	});

	it("F7: the main worktree's absolute src/ is refused", async () => {
		await expectRefused(join(primary, "src", "tui.ts"), primary);
	});

	it("F7: a linked worktree on main is durable through the branch (and its gitdir is relative)", async () => {
		expect(readFileSync(join(relativeGitdir, ".git"), "utf8")).toMatch(/^gitdir: [^/]/);
		await expectRefused("src/tui.ts", relativeGitdir);
	});
});

describe("F8 — the decision follows the bytes that get written", () => {
	it("F8: a worktree leaf symlink to the cockpit's src/ is refused", async () => {
		await expectRefused("leaf.ts", scratch);
	});

	it("F8: the same leaf, by absolute path, is refused", async () => {
		await expectRefused(join(scratch, "leaf.ts"), scratch);
	});

	it("F8: a worktree directory symlink to the cockpit's src/ is refused", async () => {
		await expectRefused("linkdir/tui.ts", scratch);
	});

	it("F8: a cockpit-internal symlink into a whitelisted tree is allowed", async () => {
		await expectAllowed("alias.ts", cockpit);
	});

	it("F8: a dangling leaf inside the cockpit's src/ is classified at its own location and refused", async () => {
		await expectRefused(join(cockpit, "src", "dangling.ts"), cockpit);
	});

	it("F8: a dangling leaf inside a scratch worktree stays allowed", async () => {
		await expectAllowed(join(scratch, "dangling.ts"), scratch);
	});
});

describe("F9 — a nested repository cannot launder and cannot spoil", () => {
	it("F9: a nested repo inside a scratch worktree is allowed", async () => {
		await expectAllowed(join(nestedInScratch, "src", "fixture.ts"), scratch);
		await expectAllowed("src/fixture.ts", nestedInScratch);
	});

	it("F9: a nested repo inside the cockpit is refused (the durable ancestor decides)", async () => {
		await expectRefused(join(nestedInCockpit, "src", "fixture.ts"), nestedInCockpit);
		await expectRefused(join(nestedInCockpit, "src", "fixture.ts"), cockpit);
	});

	// BOUNDARY, recorded rather than wished away: durability is a property of every tree in the chain, and
	// a `git init` is a MAIN worktree (clause a), so it is durable wherever it sits. The brief's Q5 prose
	// ("keeps vendored fixtures usable") holds for a nested LINKED worktree — the two rows above — not for
	// a nested `git init`. Flagged for the maintainer; the classifier is doing what the union says.
	it("F9 boundary: a nested `git init` is a main worktree, so it is durable even inside a scratch tree", async () => {
		await expectRefused("src/fixture.ts", plainInitInScratch);
	});
});

describe("F10 — no repository above the path", () => {
	it("F10: a path in a plain directory with no .git above it is allowed", async () => {
		await expectAllowed("src/notes.ts", plain);
		await expectAllowed(join(plain, "no-repo", "src", "notes.ts"), plain);
	});
});

describe("F11 — unresolvable metadata fails closed, with its own message", () => {
	it("F11: a .git file with no gitdir: line is refused as unclassifiable", async () => {
		await expectUnclassified("src/tui.ts", brokenGit);
	});

	it("F11: a .git file naming a gitdir that does not exist is refused as unclassifiable", async () => {
		await expectUnclassified("src/tui.ts", missingGitdir);
	});

	it("F11: an unreadable .git file is refused as unclassifiable", async () => {
		await expectUnclassified("src/tui.ts", unreadableGit);
	});
});

describe("F12 — the whitelist is evaluated on the durable tree's repo-relative path", () => {
	it("F12: a path under the cockpit's .pi/ is allowed even when src/ appears below it", async () => {
		await expectAllowed(".pi/vendor/src/preset.ts", cockpit);
		await expectAllowed(".pi/brl-subagent/presets/dev-agent.md", cockpit);
	});

	it("F12: .github/ and templates/ stay whitelisted in the cockpit", async () => {
		await expectAllowed(".github/scripts/src/gate.ts", cockpit);
		await expectAllowed("templates/src-note.md", cockpit);
	});

	it("F12: the control — the same cockpit still refuses plain src/", async () => {
		await expectRefused("src/preset.ts", cockpit);
	});
});

describe("the pure pieces the hook is built from", () => {
	it("pins the durable name list — widening it is a policy change, not a bug fix", () => {
		expect(DURABLE_CHECKOUT_NAMES).toEqual(["brl-subagent", "brl-subagent-dev"]);
	});

	it("names the clause that made each fixture durable, and the branch it read", () => {
		expect(resolveTreeIdentity(primary)).toMatchObject({ durable: true, clause: "main-worktree", error: null });
		expect(resolveTreeIdentity(cockpit)).toMatchObject({ durable: true, clause: "branch", branch: "dev" });
		expect(resolveTreeIdentity(otherNameOnDev)).toMatchObject({ durable: true, clause: "branch", branch: "dev" });
		expect(resolveTreeIdentity(relativeGitdir)).toMatchObject({ durable: true, clause: "branch", branch: "main" });
		expect(resolveTreeIdentity(detachedCockpit)).toMatchObject({ durable: true, clause: "name", branch: null });
		expect(resolveTreeIdentity(switchedCockpit)).toMatchObject({ durable: true, clause: "name", branch: "feature/x" });
		expect(resolveTreeIdentity(scratch)).toMatchObject({ durable: false, clause: null, branch: "fix/617-x" });
		expect(resolveTreeIdentity(nestedInCockpit)).toMatchObject({ durable: false, branch: "vendor/planted" });
	});

	it("reports unreadable metadata as an error rather than as scratch", () => {
		for (const tree of [brokenGit, missingGitdir, unreadableGit]) {
			expect(resolveTreeIdentity(tree).error, tree).not.toBeNull();
			expect(resolveTreeIdentity(tree).durable).toBe(false);
		}
	});

	it("the predicate answers for the session cwd, and agrees with the hook", () => {
		expect(isPathProtected("src/tui.ts", scratch)).toBe(false);
		expect(isPathProtected(join(cockpit, "src", "tui.ts"), scratch)).toBe(true);
		expect(isPathProtected("src/tui.ts", plain)).toBe(false);
	});
});

describe("the install heuristic keeps its #215 behaviour", () => {
	it("an echo banner containing 'npm install' is NOT an install", () => {
		expect(isInstallCommand('echo "=== 1. remove npm install ===" && pi remove npm:brl-subagent')).toBe(false);
	});

	it("quoted words inside a larger command are NOT an install", () => {
		expect(isInstallCommand('echo "run npm ci later"')).toBe(false);
	});

	it("plain npm ci IS an install", () => {
		expect(isInstallCommand("npm ci")).toBe(true);
	});

	it("npm install after && IS an install", () => {
		expect(isInstallCommand("cd ../somewhere && npm install")).toBe(true);
	});

	it("npm i after ; IS an install", () => {
		expect(isInstallCommand("true; npm i")).toBe(true);
	});

	it("an env-prefixed install IS an install", () => {
		expect(isInstallCommand("CI=1 npm install")).toBe(true);
	});

	it("a sudo-prefixed install IS an install", () => {
		expect(isInstallCommand("sudo npm ci")).toBe(true);
	});

	it("pnpm add IS an install", () => {
		expect(isInstallCommand("pnpm add -D typebox")).toBe(true);
	});

	it("npm run build is NOT an install", () => {
		expect(isInstallCommand("npm run build")).toBe(false);
	});

	it("npm test is NOT an install", () => {
		expect(isInstallCommand("npm test")).toBe(false);
	});

	it("the documented gap: an install inside an exec-string is not matched", () => {
		expect(isInstallCommand('bash -c "npm ci"')).toBe(false);
	});
});

describe("the symlink advice keeps its #215 behaviour", () => {
	it("a symlink into the shared tree gets the check-repo advice", () => {
		const fixture = mkdtempSync(join(tmpdir(), "guard-617-shared-"));
		try {
			symlinkSync(join(process.cwd(), "node_modules"), join(fixture, "node_modules"));
			expect(blockReason("shared-fixture", fixture)).toMatch(/check-repo\.sh/);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("a foreign symlink keeps the --force-isolated advice", () => {
		const fixture = mkdtempSync(join(tmpdir(), "guard-617-foreign-"));
		try {
			symlinkSync(join(tmpdir(), "guard-617-nonexistent-target"), join(fixture, "node_modules"));
			expect(blockReason("foreign-fixture", fixture)).toMatch(/--force-isolated/);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
});
