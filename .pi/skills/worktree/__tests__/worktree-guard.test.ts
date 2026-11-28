/**
 * The worktree-guard's classification matrix (issue #617, brief `worktree-guard-durability`).
 *
 * WHY THIS FILE EXISTS. The guard decides whether a `write`/`edit` may touch `src/` or `presets/`, and it
 * decided it from `process.cwd()` — so a session whose cwd is its own linked worktree refused every
 * sanctioned `src/` write (rule #5 blocked the one place that obeys rule #5), while the same session could
 * still write the COCKPIT's `src/` by absolute path. Nothing ran this predicate in CI: the old
 * `guard.test.cjs` held the install-heuristic checks and was wired to nothing (brief F10). This suite is
 * that file's port plus ONE CASE PER FALSIFIER F1–F12 of the brief, so a classifier regression fails here
 * instead of surfacing as friction inside a dispatch.
 *
 * SCOPED DURABILITY (Q12 = A, post-grill 2026-11-28). Identity clauses are evaluated only for trees of the
 * SESSION's repository — the one whose common gitdir the session's cwd resolves to. A foreign repository
 * (a temp `git init`, a contributor's unrelated clone) is durable only through a durable ANCESTOR in that
 * same scope, so the rows below that hold a foreign repo are written twice: once from this repository's
 * session (allowed) and once from the foreign repo's own session (its own structural clause).
 *
 * WHAT A ROW CLAIMS: that the guard's `tool_call` handler, given this session cwd and this target, blocks
 * or does not block — the refusal REASON is asserted only where the brief distinguishes two of them
 * (F11's `could not classify …` must never read as a rule violation). The handler is the real one:
 * `initWorktreeGuard` runs with a fake `pi` that captures what it registered, so the rows exercise the
 * shipped wiring, not a re-implementation.
 *
 * WHY REAL REPOSITORIES. The classifier reads `.git` and `HEAD` (no subprocess) and its answer depends on
 * the layout: a main worktree's `.git` is a directory, a linked worktree's is a `gitdir:` file — absolute
 * or relative — with `commondir`, and a detached HEAD is a bare sha. Faking those in memory would test the
 * fake. Each layout is therefore a real `git init` / `git worktree add` fixture, built once in `beforeAll`
 * under one `mkdtemp` directory.
 *
 * HERMETICITY: the fixture base is `mkdtemp(join(tmpdir(), …))` and is removed in `afterAll`; nothing is
 * written inside the repository. Git runs with `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at `/dev/null` and
 * an explicit identity, so a developer's git config (signing, hooks, templates) cannot change a fixture's
 * shape and no command can reach a network.
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

/** The fixture trees. Named once, assigned in `beforeAll`, read by the rows. */
let base = "";
/** A tree with no `.git` above it at all — the scratch-root answer (F10), and an unresolvable session. */
let plain = "";
/** A FOREIGN repository (`git init` on branch `main`) outside the session's repository (Q12). */
let foreignOutside = "";
/** The project's MAIN worktree: `.git` is a directory, branch `feature/main-branch` (F7). */
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
/** A `git init` nested inside the scratch worktree: a main worktree, durable by structure (F9 boundary). */
let plainInitInScratch = "";
/** Basename `brl-subagent-dev`, detached HEAD: durable by name only (F6). */
let detachedCockpit = "";
/** Basename `brl-subagent-dev`, branch `feature/x`: durable by name only (F6). */
let switchedCockpit = "";
/** Branch `dev`, basename `cockpit-on-dev`: durable by branch only (F6). */
let otherNameOnDev = "";
/** `.git` file with no `gitdir:` line, one whose `gitdir:` names nothing, one that cannot be read (F11). */
let brokenGit = "";
let missingGitdir = "";
let unreadableGit = "";

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "guard-617-"));
	plain = join(base, "plain");
	mkdirSync(join(plain, "no-repo", "src"), { recursive: true });
	// Q12: a repository that is not ours, on the branch an unscoped branch clause would call durable.
	foreignOutside = join(base, "foreign", "git-init-main");
	initRepo(foreignOutside, "main");

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

	// F9. The nested projects are separate repositories, added as linked worktrees: a nested tree durable by
	// NOTHING, so the ancestor rule is the only thing that can decide. A nested MAIN worktree would be
	// durable on its own and prove nothing about ancestors (the boundary row below covers that).
	const vendor = join(base, "vendor-src");
	initRepo(vendor, "main");
	nestedInScratch = join(scratch, "vendor", "nested");
	addWorktree(vendor, nestedInScratch, { branch: "vendor/nested" });
	nestedInCockpit = join(cockpit, "vendor", "planted");
	addWorktree(vendor, nestedInCockpit, { branch: "vendor/planted" });
	plainInitInScratch = join(scratch, "vendor", "plaininit");
	initRepo(plainInitInScratch, "main");

	// F6: three cockpits whose second clause cannot rescue a missing one.
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

	// F8: the symlink shapes. The fixture checkouts are empty (one empty commit each), so the directories
	// and the one real file a link can point into are made here — a leaf link must RESOLVE for its row to
	// prove symlink resolution, and the dangling rows are the opposite case on purpose.
	mkdirSync(join(cockpit, "src"), { recursive: true });
	mkdirSync(join(cockpit, ".pi"), { recursive: true });
	mkdirSync(join(scratch, "src"), { recursive: true });
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
	expect(decision.block, `expected ALLOWED: ${target} (cwd ${sessionCwd}) got: ${decision.reason}`).toBe(false);
}

async function expectRefused(target: string, sessionCwd: string): Promise<void> {
	const decision = await attempt(target, sessionCwd);
	expect(decision.block, `expected REFUSED: ${target} (cwd ${sessionCwd})`).toBe(true);
	expect(decision.reason).toContain("must only be changed through a worktree");
}

/** F11's message must be distinguishable from a rule violation, or "the guard is blind" reads as "you broke a rule". */
async function expectUnclassified(target: string, sessionCwd: string): Promise<void> {
	const decision = await attempt(target, sessionCwd);
	expect(decision.block, `an unclassifiable target must fail closed: ${target}`).toBe(true);
	expect(decision.reason).toMatch(/could not classify/);
	expect(decision.reason).toContain(target);
	expect(decision.reason).not.toContain("must only be changed through a worktree");
}

describe("the extension module (the old jiti load check, reproduced by a direct import)", () => {
	it("exports the extension function, wires both handlers, and keeps a durable/scratch reminder", async () => {
		expect(typeof initWorktreeGuard).toBe("function");
		expect(handlers.has("tool_call")).toBe(true);
		expect(handlers.has("before_agent_start")).toBe(true);
		const reminder = (await handlers.get("before_agent_start")?.({}, {})) as { message?: string } | undefined;
		expect(typeof reminder?.message).toBe("string");
		expect(reminder?.message).toContain("worktree");
		expect(reminder?.message).not.toContain("../brl-subagent-<branch>");
	});
});

describe("F1/F2 — a scratch worktree may change its own protected surface", () => {
	it("F1/F2: relative src/, relative presets/ and the worktree's absolute src/ are all allowed", async () => {
		await expectAllowed("src/tui.ts", scratch);
		await expectAllowed("presets/dev-agent.md", scratch);
		await expectAllowed(join(scratch, "src", "tui.ts"), scratch);
	});
});

describe("F3/F4 — the cockpit's src/ is refused from a worktree session", () => {
	it("F3/F4: an absolute cockpit src/ path and ../brl-subagent-dev/src/… are refused", async () => {
		await expectRefused(join(cockpit, "src", "tui.ts"), scratch);
		await expectRefused("../brl-subagent-dev/src/tui.ts", scratch);
	});
});

describe("F5 — a durable checkout may not change its own protected surface, and keeps its whitelist", () => {
	it("F5: the cockpit refuses its own src/ and presets/, and allows .pi/ and .development/", async () => {
		await expectRefused("src/tui.ts", cockpit);
		await expectRefused(join(cockpit, "src", "tui.ts"), cockpit);
		await expectRefused("presets/dev-agent.md", cockpit);
		await expectAllowed(".pi/extensions/worktree-guard/index.ts", cockpit);
		await expectAllowed(".development/handoff/state.md", cockpit);
	});
});

describe("F6 — the name clause survives a detached or switched cockpit", () => {
	it("F6: a detached cockpit, a cockpit switched to feature/x, and a cockpit on dev under another name are refused", async () => {
		await expectRefused("src/tui.ts", detachedCockpit);
		await expectRefused(join(detachedCockpit, "src", "tui.ts"), detachedCockpit);
		await expectRefused("src/tui.ts", switchedCockpit);
		await expectRefused("src/tui.ts", otherNameOnDev);
	});
});

describe("F7 — the structural clause: a main worktree is durable on any branch", () => {
	it("F7: the main worktree's src/ is refused, absolutely and relatively", async () => {
		await expectRefused("src/tui.ts", primary);
		await expectRefused(join(primary, "src", "tui.ts"), primary);
	});

	it("F7: the linked worktree on main is durable through the branch, read from a RELATIVE gitdir", async () => {
		expect(readFileSync(join(relativeGitdir, ".git"), "utf8")).toMatch(/^gitdir: [^/]/);
		await expectRefused("src/tui.ts", relativeGitdir);
	});
});

describe("F8 — the decision follows the bytes that get written", () => {
	it("F8: symlinks resolve (leaf and directory), a whitelisted alias is allowed, and a dangling leaf keeps its own location", async () => {
		await expectRefused("leaf.ts", scratch);
		await expectRefused(join(scratch, "leaf.ts"), scratch);
		await expectRefused("linkdir/tui.ts", scratch);
		await expectAllowed("alias.ts", cockpit);
		await expectRefused(join(cockpit, "src", "dangling.ts"), cockpit);
		await expectAllowed(join(scratch, "dangling.ts"), scratch);
	});
});

describe("F9 — a nested repository cannot launder and cannot spoil", () => {
	it("F9: a nested repo inside a scratch worktree is allowed, inside the cockpit it is refused", async () => {
		await expectAllowed(join(nestedInScratch, "src", "fixture.ts"), scratch);
		await expectAllowed("src/fixture.ts", nestedInScratch);
		await expectRefused(join(nestedInCockpit, "src", "fixture.ts"), cockpit);
		await expectRefused(join(nestedInCockpit, "src", "fixture.ts"), scratch);
	});

	// CHANGED MEANING (Q12 = A), recorded rather than wished away: the durable ancestor must belong to the
	// SESSION's repository. A session whose cwd is inside the planted repo is foreign to the cockpit, so its
	// own `src/` is allowed — the row above is the one Q5 asks for (a session in OUR repo cannot launder).
	it("F9/Q12: a session inside the planted repo itself is foreign to the cockpit, so its src/ is allowed", async () => {
		await expectAllowed(join(nestedInCockpit, "src", "fixture.ts"), nestedInCockpit);
	});

	// CHANGED MEANING (Q12 = A): the old F9 boundary — a nested `git init` is a main worktree, so it is
	// durable wherever it sits — WAS the unscoped structural clause, and it refused a fixture repo that a
	// scratch worktree legitimately owns. Scoped, the `git init` is durable in its OWN session only.
	it("F9/Q12 boundary: a nested `git init` is allowed from a scratch-worktree session, refused from its own", async () => {
		await expectAllowed(join(plainInitInScratch, "src", "fixture.ts"), scratch);
		await expectRefused("src/fixture.ts", plainInitInScratch);
	});
});

describe("Q12 — durability is scoped to the SESSION's repository", () => {
	it("Q12: a foreign repo on branch main OUTSIDE the session's repository is allowed", async () => {
		await expectAllowed(join(foreignOutside, "src", "tui.ts"), scratch);
		await expectAllowed(join(foreignOutside, "src", "tui.ts"), cockpit);
		await expectAllowed(join(foreignOutside, "presets", "dev-agent.md"), scratch);
	});

	it("Q12: a session whose cwd IS that foreign repo refuses its own src/ — the structural clause, in scope", async () => {
		await expectRefused("src/tui.ts", foreignOutside);
	});

	it("Q12: our real main worktree is still refused from a session inside one of its linked worktrees", async () => {
		await expectRefused(join(primary, "src", "tui.ts"), scratch);
		await expectRefused(join(primary, "src", "tui.ts"), cockpit);
	});

	it("Q12: a session whose own repository cannot be resolved fails closed as could-not-classify", async () => {
		await expectUnclassified("src/notes.ts", plain);
		await expectUnclassified("src/tui.ts", unreadableGit);
	});
});

describe("F10 — no repository above the target", () => {
	// CHANGED MEANING (Q12 = A): a session with no repository above its cwd cannot be scoped at all, so the
	// plain-cwd row moved to the Q12 block as a fail-closed case. F10 now asserts what it was about — a
	// TARGET outside every repository is allowed, from a session that HAS one.
	it("F10: a target in a plain directory with no .git above it is allowed", async () => {
		await expectAllowed(join(plain, "src", "notes.ts"), scratch);
		await expectAllowed(join(plain, "no-repo", "src", "notes.ts"), cockpit);
	});
});

describe("F11 — unresolvable metadata fails closed, with its own message", () => {
	it("F11: a .git with no gitdir: line, a gitdir: naming nothing, and an unreadable .git are all unclassifiable", async () => {
		for (const tree of [brokenGit, missingGitdir, unreadableGit]) {
			// As the TARGET's metadata, from a session that resolves…
			await expectUnclassified(join(tree, "src", "tui.ts"), scratch);
			// …and as the SESSION's own metadata (Q12: an unscopable session is blind, so it refuses).
			await expectUnclassified("src/tui.ts", tree);
		}
	});
});

describe("F12 — the whitelist is read on the durable tree's repo-relative path", () => {
	it("F12: .pi/, .github/ and templates/ are allowed even when src/ appears below them; plain src/ is not", async () => {
		await expectAllowed(".pi/vendor/src/preset.ts", cockpit);
		await expectAllowed(".pi/brl-subagent/presets/dev-agent.md", cockpit);
		await expectAllowed(".github/scripts/src/gate.ts", cockpit);
		await expectAllowed("templates/src-note.md", cockpit);
		await expectRefused("src/preset.ts", cockpit);
	});
});

describe("the pure pieces the hook is built from", () => {
	it("pins the durable name list and the clause each fixture tree answers with", () => {
		expect(DURABLE_CHECKOUT_NAMES).toEqual(["brl-subagent", "brl-subagent-dev"]);
		expect(resolveTreeIdentity(primary)).toMatchObject({ clause: "main-worktree", error: null });
		expect(resolveTreeIdentity(cockpit)).toMatchObject({ clause: "branch", branch: "dev" });
		expect(resolveTreeIdentity(otherNameOnDev)).toMatchObject({ clause: "branch", branch: "dev" });
		expect(resolveTreeIdentity(relativeGitdir)).toMatchObject({ clause: "branch", branch: "main" });
		expect(resolveTreeIdentity(detachedCockpit)).toMatchObject({ clause: "name", branch: null });
		expect(resolveTreeIdentity(switchedCockpit)).toMatchObject({ clause: "name", branch: "feature/x" });
		expect(resolveTreeIdentity(scratch)).toMatchObject({ clause: null, branch: "fix/617-x" });
		expect(resolveTreeIdentity(nestedInCockpit)).toMatchObject({ clause: null, branch: "vendor/planted" });
	});

	it("gives every tree of one repository the same common gitdir, and a foreign repo its own", () => {
		const project = resolveTreeIdentity(primary).commonGitDir;
		expect(project).not.toBeNull();
		for (const tree of [cockpit, scratch, relativeGitdir]) {
			expect(resolveTreeIdentity(tree).commonGitDir, tree).toBe(project);
		}
		for (const tree of [nestedInScratch, nestedInCockpit, plainInitInScratch, foreignOutside, otherNameOnDev]) {
			expect(resolveTreeIdentity(tree).commonGitDir, tree).not.toBe(project);
		}
	});

	it("reports unreadable metadata as an error, and answers the predicate for the session cwd", () => {
		for (const tree of [brokenGit, missingGitdir, unreadableGit]) {
			expect(resolveTreeIdentity(tree).error, tree).not.toBeNull();
			expect(resolveTreeIdentity(tree).clause, tree).toBeNull();
		}
		expect(isPathProtected("src/tui.ts", scratch)).toBe(false);
		expect(isPathProtected(join(cockpit, "src", "tui.ts"), scratch)).toBe(true);
		expect(isPathProtected(join(plain, "src", "notes.ts"), scratch)).toBe(false);
	});
});

/** The install heuristic's table — the command text, and whether it is an install at a command position. */
const INSTALL_CASES: Array<[string, string, boolean]> = [
	["an echo banner containing 'npm install' is NOT an install", 'echo "=== 1. remove npm install ===" && pi remove npm:brl-subagent', false],
	["quoted words inside a larger command are NOT an install", 'echo "run npm ci later"', false],
	["plain npm ci IS an install", "npm ci", true],
	["npm install after && IS an install", "cd ../somewhere && npm install", true],
	["npm i after ; IS an install", "true; npm i", true],
	["an env-prefixed install IS an install", "CI=1 npm install", true],
	["a sudo-prefixed install IS an install", "sudo npm ci", true],
	["pnpm add IS an install", "pnpm add -D typebox", true],
	["npm run build is NOT an install", "npm run build", false],
	["npm test is NOT an install", "npm test", false],
	["the documented gap: an install inside an exec-string is not matched", 'bash -c "npm ci"', false],
];

describe("the install heuristic keeps its #215 behaviour", () => {
	it.each(INSTALL_CASES)("%s", (_name, command, expected) => {
		expect(isInstallCommand(command)).toBe(expected);
	});
});

describe("the symlink advice keeps its #215 behaviour", () => {
	it("a symlink into the shared tree gets the check-repo advice, a foreign one keeps --force-isolated", () => {
		const shared = mkdtempSync(join(tmpdir(), "guard-617-shared-"));
		const foreign = mkdtempSync(join(tmpdir(), "guard-617-foreign-"));
		try {
			symlinkSync(join(process.cwd(), "node_modules"), join(shared, "node_modules"));
			expect(blockReason("shared-fixture", shared)).toMatch(/check-repo\.sh/);
			symlinkSync(join(tmpdir(), "guard-617-nonexistent-target"), join(foreign, "node_modules"));
			expect(blockReason("foreign-fixture", foreign)).toMatch(/--force-isolated/);
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(foreign, { recursive: true, force: true });
		}
	});
});
