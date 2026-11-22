/**
 * Tests for the worktree skill's entry scripts (issue #558) — one refusal per script, so the class
 * "a guard that no longer refuses" fails a test instead of a merge.
 *
 * The ten scripts here carry the merge gate, the worktree lifecycle and the dispatch audit, and none
 * of them had a test: every one of them changed gate or record logic this cycle, and nothing that ran
 * in CI would have noticed a guard silently returning success. One row per entry script, its
 * known-bad input, and the refusal it must produce.
 *
 * THREE STRUCTURAL ROWS hold the table itself together, because a table of tests rots in ways its
 * rows cannot see: a new script nobody added a row for (completeness), a `lib/` helper no covered
 * entry script sources (lib coverage), and ten copies of spawn+assert drifting into ten different
 * mechanisms (single mechanism). The completeness control is a FIXTURE listing, never a mutation of
 * the tracked tree — a test that edits its own repository is a test that can leave it edited.
 *
 * HERMETICITY. Every row runs against a COPY of `.pi/skills/worktree/` inside a `mkdtemp` git repo,
 * with `cwd` = that repo, and the copy sits at the same relative path (`<scratch>/.pi/skills/
 * worktree/`). Every script that derives its root from its own location therefore derives the
 * SCRATCH: `worktree-cleanup.sh` removes worktrees, `codegraph-refresh.sh` writes an index, and
 * neither can reach the real repository from here. The scratch has NO REMOTES (so a `git fetch` in a
 * row is a no-op and cannot leave the machine), prompting disabled, and no user git config; a
 * sentinel file plus a `for-each-ref` / `status --porcelain` snapshot is taken before the rows and
 * re-compared after them.
 *
 * WHAT A ROW CLAIMS, stated precisely because three of these scripts keep working past their first
 * finding: `check-repo.sh` reports the missing deps and continues into its other checks before
 * exiting 1. A row asserts the exit status, a substring of the output and — where the row says so —
 * the header it printed; never that the script stopped early.
 *
 * TWO SECTIONS WERE ADDED BY #570, and they read a different tree in a different way. The first
 * pins the SELFTESTS CI SHIPS: a parsed read of `.github/workflows/ci.yml` (indentation and item
 * body, never a substring — a comment naming a command is documentation, not a step), so the gate
 * that decides every merge cannot lose its CI step silently. The second pins `worktree-cleanup.sh`'s
 * teardown RULES — protected refs, branch derivation, the not-a-worktree refusal, the extension-sync
 * flag — each in its own disposable cockpit with its own BARE origin, so "remote branch deleted" is a
 * measured ref and never this machine's network.
 *
 * WHICH TREE IS READ is `SKILLS_TEST_ROOTS` (`{skillsDir, repoRoot, mutated}`): absent, it is this
 * checkout; present, it is a copy whose difference from this checkout must be EXACTLY the declared
 * mutation — two roots, because the workflow is outside the skills tree, and a hash comparison,
 * because a green receipt from a stale tree (or one where only the copy moved) proves nothing.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURFACES } from "../../../../scripts/check-test-budget.mjs";

const SELF = fileURLToPath(import.meta.url);
/** `.pi/skills/worktree` — the scripts under test, and the tree every row's copy is made from. */
const SKILL_DIR = dirname(dirname(SELF));
/** The repository root: `.github/workflows/ci.yml` and the `scripts/` the gate runs live here. */
const REPO_ROOT = join(SKILL_DIR, "..", "..", "..");

/**
 * WHICH TREE THIS SUITE READS (#570, `SKILLS_TEST_ROOTS`). Default: this checkout. Mutation mode:
 * a copy, named by BOTH roots plus the files that differ — because one root is not enough (the
 * workflow lives under `.github/workflows`, outside the skills tree) and an inherited override that
 * silently redirected an ordinary run would let CI go green reading a stale tree. `mutated` is what
 * makes the difference the mutation rather than the tree: it is compared, not trusted (`[]` = the
 * baseline, which must be byte-identical to this checkout).
 */
interface Roots {
	/** The `worktree` skill directory to read and copy — `.pi/skills/worktree` in this checkout. */
	skillsDir: string;
	/** The repository root whose `.github/workflows/` is read. */
	repoRoot: string;
	/** Mutation mode only: the absolute paths the copy has changed, exactly (`[]` = baseline). */
	mutated?: string[];
}

const OVERRIDE = process.env.SKILLS_TEST_ROOTS;
const ROOTS: Roots = OVERRIDE === undefined ? { skillsDir: SKILL_DIR, repoRoot: REPO_ROOT } : JSON.parse(OVERRIDE);

/** The scratch's path for the copy: the same relative shape, so path-derived roots land in the scratch. */
const COPY_REL = join(".pi", "skills", "worktree");
const SENTINEL = "sentinel: if a row wrote here, this file is gone or changed\n";

/**
 * The extensions the budget guard counts as source on the `skills` surface — read from that surface's
 * own definition, so a language added there gets a completeness row here or the row fails.
 */
const SOURCE_EXTENSIONS: string[] = SURFACES.find((surface: { name: string }) => surface.name === "skills").sourceExtensions;

/** One row: the script, the argv that must be refused, and the refusal. `<scratch>` is expanded. */
interface Row {
	/** Path relative to `.pi/skills/worktree`. */
	script: string;
	/** Arguments after the script path. `<scratch>` becomes the scratch root. */
	argv: string[];
	/** The exit status the refusal carries. */
	exit: number;
	/** A substring the refusal must contain — the message a caller can act on. */
	contains: string;
	/** What the row protects, in one line. */
	why: string;
	/**
	 * Facts beyond exit + substring, kept as DATA so one script's row stays one test: a refusal that is
	 * also a header, and a usage line documenting a flag nobody passes (M5 restores it, this row fails).
	 */
	extra?: {
		/** The refusal's first stdout line, with `<scratch>` expanded. */
		firstLine?: string;
		/** A 1-based line of the script's own header that must NOT name this token. */
		usage?: { line: number; mustNotName: string };
	};
}

const ROWS: Row[] = [
	{
		script: "merge-guard.sh",
		argv: [],
		exit: 2,
		contains: "expected <pr-number> <review-record-path>",
		why: "the merge gate with no PR is a usage error, never a pass",
	},
	{
		script: "recon.sh",
		argv: ["--bogus"],
		exit: 2,
		contains: "Unknown argument: --bogus",
		why: "an unknown flag must not be read as a symbol to look up",
	},
	{
		script: "run.sh",
		argv: ["--bogus", "--", "true"],
		exit: 64,
		contains: "unexpected argument '--bogus'",
		why: "a status helper that guessed at flags would report the wrong exit code",
	},
	{
		script: "worktree-prep.sh",
		argv: [],
		exit: 1,
		contains: "worktree path required",
		why: "provisioning with no path must not default to somewhere real",
	},
	{
		script: "worktree-cleanup.sh",
		argv: [],
		exit: 1,
		contains: "worktree path required",
		why: "teardown with no path must never guess which worktree to remove",
	},
	{
		script: "jev-check.mjs",
		argv: ["--bogus-flag"],
		exit: 2,
		contains: 'unknown mode "--bogus-flag"',
		why: "an unknown mode must not fall through to a default report",
	},
	{
		script: "sprint-metrics.py",
		argv: ["--bogus"],
		exit: 2,
		contains: "usage:",
		why: "argparse's refusal is the contract: no metric is computed from a bad invocation",
	},
	{
		script: "codegraph-check.py",
		argv: ["--db", "<scratch>/none.db"],
		exit: 2,
		contains: "not found",
		why: "a missing index is `cannot check`, never a verified index",
	},
	{
		script: "codegraph-refresh.sh",
		argv: ["--repo-root", "<scratch>"],
		exit: 2,
		contains: "no src/ in",
		why: "a root with no `src/` is the wrong cockpit, not an index to refresh",
	},
	{
		script: "check-repo.sh",
		argv: ["<scratch>/empty"],
		exit: 1,
		contains: "node_modules missing",
		why: "an unprovisioned checkout must not be reported healthy",
		extra: {
			// The root is POSITIONAL (`REPO_ROOT="${1:-…}"`); the usage line used to advertise a
			// `--repo-root` flag no caller passed, so it described a program that does not exist.
			firstLine: "Pre-flight: <scratch>/empty",
			usage: { line: 4, mustNotName: "--repo-root" },
		},
	},
];

/** The interpreter for a script's own extension — the table names no interpreter, so it cannot lie. */
function interpreterOf(script: string): string {
	if (script.endsWith(".sh")) return "bash";
	if (script.endsWith(".py")) return "python3";
	return process.execPath;
}

/** `<scratch>` in a row's data becomes the scratch root, so no row carries an absolute path of its own. */
function expand(value: string, scratch: string): string {
	return value.split("<scratch>").join(scratch);
}

let SCRATCH = "";
let SNAPSHOT: Snapshot | undefined;

interface Snapshot {
	refs: string;
	status: string;
	sentinel: string;
}

/** No prompting, no user or system git config: a row's git command reads nothing from this machine. */
function env(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		// An EMPTY config file: the machine's `~/.gitconfig` (aliases, hooks, `insteadOf`) is not read.
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
	};
}

/**
 * The ONE spawn site: the git fixture, all ten rows, and the environment guard go through it, so no
 * case is a special case. `extraEnv` exists for #581 — a refusal that depends only on the agent dir.
 */
function sh(argv: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(argv[0], argv.slice(1), {
		cwd,
		env: { ...env(), ...extraEnv },
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.error) throw new Error(`${argv.join(" ")}: ${result.error.message}`);
	return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(...args: string[]) {
	return sh(["git", ...args], SCRATCH);
}

function snapshot(): Snapshot {
	return {
		refs: git("for-each-ref", "--format=%(refname) %(objectname)").stdout,
		status: git("status", "--porcelain").stdout,
		sentinel: readFileSync(join(SCRATCH, "sentinel.txt"), "utf8"),
	};
}

/** Run one row's script in the scratch copy, in the scratch root, and capture the refusal. */
function runRow(row: Row) {
	const script = join(SCRATCH, COPY_REL, row.script);
	const result = sh([interpreterOf(row.script), script, ...row.argv.map((argument) => expand(argument, SCRATCH))], SCRATCH);
	return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
}

/** A script's top-level source files on the `skills` surface — directories are not scripts. */
function entryScripts(dir: string = ROOTS.skillsDir): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.filter((name) => SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension)))
		.sort();
}

/** The scripts `files` lists that no row covers. PURE, so the control can be a fixture listing. */
export function missingGuards(files: string[], table: Row[]): string[] {
	const covered = new Set(table.map((row) => row.script));
	return files.filter((file) => !covered.has(file)).sort();
}

/** Whether `script` sources `lib/<lib>` — the edge that makes the helper's guard reachable. */
function sourcesLib(script: string, lib: string): boolean {
	const text = readFileSync(join(ROOTS.skillsDir, script), "utf8");
	const escaped = lib.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^\\s*(?:source|\\.)\\s+[^\\n]*lib/${escaped}\\b`, "m").test(text);
}

beforeAll(() => {
	SCRATCH = mkdtempSync(join(tmpdir(), "brl-script-guards-"));
	mkdirSync(join(SCRATCH, ".pi", "skills"), { recursive: true });
	cpSync(ROOTS.skillsDir, join(SCRATCH, COPY_REL), { recursive: true });
	mkdirSync(join(SCRATCH, "empty"), { recursive: true });
	writeFileSync(join(SCRATCH, "sentinel.txt"), SENTINEL);
	git("init", "-q", "-b", "dev");
	git("-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "add", "-A");
	git("-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "base");
	// No remotes: a `git fetch origin` inside a row is a no-op, not an escape from this machine.
	expect(git("remote").stdout).toBe("");
	SNAPSHOT = snapshot();
});

afterAll(() => {
	// The isolation control, compared after the rows: a changed ref, a removed worktree or a written
	// sentinel fails here and names what moved. It runs in a hook, so the FAILING run is the one that
	// proves it — a pass proves only that nothing moved.
	if (SNAPSHOT !== undefined) {
		expect(SCRATCH.startsWith(tmpdir())).toBe(true);
		expect(snapshot()).toEqual(SNAPSHOT);
	}
	rmSync(SCRATCH, { recursive: true, force: true });
});

describe("every worktree entry script refuses its known-bad input", () => {
	for (const row of ROWS) {
		it(`${row.script} refuses: ${row.why}`, () => {
			const result = runRow(row);
			expect([row.script, result.status]).toEqual([row.script, row.exit]);
			expect(result.output).toContain(row.contains);
			if (row.extra?.firstLine !== undefined) {
				expect(result.stdout.split("\n")[0]).toBe(expand(row.extra.firstLine, SCRATCH));
			}
			if (row.extra?.usage !== undefined) {
				const header = readFileSync(join(ROOTS.skillsDir, row.script), "utf8").split("\n")[row.extra.usage.line - 1];
				expect(header).not.toContain(row.extra.usage.mustNotName);
			}
		});
	}
});

describe("the guard table holds itself together", () => {
	it("#581 — two brl-subagent installs fail the pre-flight, naming both and the absolute removal", () => {
		// OUTSIDE the scratch repo: a file written there would move `git status` and trip the
		// isolation control in afterAll, which is exactly the failure this file exists to catch.
		const agent = mkdtempSync(join(tmpdir(), "brl-agent-two-"));
		const settings = join(agent, "settings.json");
		writeFileSync(settings, JSON.stringify({ packages: ["npm:brl-subagent@2.9.1", "../../x/brl-subagent-dev"] }));
		const script = join(SCRATCH, COPY_REL, "check-repo.sh");
		const two = sh(["bash", script, join(SCRATCH, "empty")], SCRATCH, { PI_CODING_AGENT_DIR: agent });
		const twoOutput = `${two.stdout}${two.stderr}`;
		expect(two.status).toBe(1);
		expect(twoOutput).toContain("2 brl-subagent packages are installed at once");
		expect(twoOutput).toContain("npm:brl-subagent@2.9.1");
		expect(twoOutput).toContain("../../x/brl-subagent-dev");
		expect(twoOutput).toContain("pi remove /abs/path/to/brl-subagent-dev");

		// The control: ONE install is a pass line. Without it, the row above would pass on a guard
		// that simply always fails — the failure mode this check exists to prevent.
		writeFileSync(settings, JSON.stringify({ packages: ["../../x/brl-subagent-dev"] }));
		const one = sh(["bash", script, join(SCRATCH, "empty")], SCRATCH, { PI_CODING_AGENT_DIR: agent });
		expect(`${one.stdout}${one.stderr}`).toContain("one brl-subagent install");
		rmSync(agent, { recursive: true, force: true });
	});

	it("has a row for every top-level entry script on disk", () => {
		const files = entryScripts();
		// Vacuity control: the listing is not empty, and the helper sees a script with no row.
		expect(files).toContain("merge-guard.sh");
		expect(missingGuards([...files, "new-guard.sh"], ROWS)).toEqual(["new-guard.sh"]);
		expect(missingGuards(files, ROWS.filter((row) => row.script !== "recon.sh"))).toEqual(["recon.sh"]);
		expect(missingGuards(files, ROWS)).toEqual([]);
	});

	it("covers every `lib/*.sh` through the entry script that sources it", () => {
		const libs = readdirSync(join(ROOTS.skillsDir, "lib")).filter((file) => file.endsWith(".sh"));
		expect(libs.length).toBeGreaterThan(0);
		expect(libs.filter((lib) => !ROWS.some((row) => sourcesLib(row.script, lib)))).toEqual([]);
		// The control: a lib nobody sources IS reported, so the row above cannot pass vacuously.
		expect(libs.filter((lib) => !ROWS.some((row) => sourcesLib(row.script, `absent-${lib}`)))).toEqual(libs);
	});

	it("runs every row through ONE spawn site — the kill is measured on production mutants", () => {
		// Ten near-identical spawns would be ten places for a bad assertion to hide. M6 (worktree-prep's
		// path guard deleted) and M7 (run.sh's 64 changed to 0) each fail exactly their own row and
		// nothing else; the remaining eight share this one mechanism and claim no separate kill.
		const source = readFileSync(SELF, "utf8");
		expect(source.match(/spawnSync\(/g) ?? []).toHaveLength(1);
		for (const row of ROWS) expect(source).toContain(`"${row.script}"`);
	});
});

// ── The selftests CI ships (#570) ─────────────────────────────────────────────────────────────
//
// The merge gate's own selftest was the one selftest no workflow ran: the check that decides every
// merge could stop working and CI stayed green. A table of the steps pins each command, and a
// PARSED read of the workflow — never a substring — is what pins it: `grep` is satisfied by a
// comment naming the command, by a `run: echo …--selftest`, and by a second copy of the line in a
// job that never runs. The parser is indentation-and-item-body, so a comment is not a step, a
// `- name:` step's sibling `run:` is, and the negative half is asserted against the parser itself.

/** One CI step the table pins: the script the issue named, and the exact `run:` scalar. */
interface SelftestStep {
	/** The script, relative to the repository root — the identity the reverse check uses. */
	script: string;
	/** The step's exact command. A substring match would accept a comment; this does not. */
	command: string;
}

const JEV_STEP: SelftestStep = {
	script: ".pi/skills/worktree/jev-check.mjs",
	command: "node .pi/skills/worktree/jev-check.mjs --selftest",
};
const SPRINT_STEP: SelftestStep = {
	script: ".pi/skills/worktree/sprint-metrics.py",
	command: "python3 .pi/skills/worktree/sprint-metrics.py --selftest",
};
const RUN_STEP: SelftestStep = {
	script: ".pi/skills/worktree/run.sh",
	command: "bash .pi/skills/worktree/run.sh --selftest",
};
const MERGE_GUARD_STEP: SelftestStep = {
	script: ".pi/skills/worktree/merge-guard.sh",
	command: "bash .pi/skills/worktree/merge-guard.sh --selftest",
};
const SELFTEST_STEPS: SelftestStep[] = [JEV_STEP, SPRINT_STEP, RUN_STEP, MERGE_GUARD_STEP];

/** A parsed workflow step: the job that owns it and the raw (comment-free) lines of its own item. */
interface WorkflowStep {
	job: string;
	lines: string[];
}

function indentOf(line: string): number {
	return /^[ ]*/.exec(line)?.[0].length ?? 0;
}

/**
 * The steps of every job in a workflow, by INDENTATION and item body. Comment-only lines are dropped
 * before anything is read (a comment naming a command is documentation, not a step), and a step is
 * the `- ` item at the step indent plus every deeper line that follows it — so `- name:` + its
 * sibling `run:` is ONE step, and a sequence item cannot bleed into its neighbour.
 */
function workflowSteps(yaml: string): WorkflowStep[] {
	const steps: WorkflowStep[] = [];
	let job = "";
	let jobsIndent = -1;
	let jobIndent = -1;
	let inSteps = false;
	let stepIndent = -1;
	let body: string[] = [];
	const flush = () => {
		if (inSteps && body.length > 0) steps.push({ job, lines: body });
		body = [];
	};
	for (const line of yaml.split("\n")) {
		if (line.trim() === "" || /^\s*#/.test(line)) continue;
		const indent = indentOf(line);
		const text = line.trim();
		if (/^steps:\s*$/.test(text)) {
			flush();
			inSteps = true;
			stepIndent = -1;
			continue;
		}
		if (inSteps) {
			if (stepIndent === -1) {
				if (!text.startsWith("- ")) continue;
				stepIndent = indent;
				body = [line];
				continue;
			}
			if (indent > stepIndent) {
				body.push(line);
				continue;
			}
			flush();
			if (indent === stepIndent && text.startsWith("- ")) {
				body = [line];
				continue;
			}
			inSteps = false;
		}
		if (/^jobs:\s*$/.test(text)) {
			jobsIndent = indent;
			job = "";
			jobIndent = -1;
			continue;
		}
		if (jobsIndent !== -1 && indent > jobsIndent && /^[A-Za-z0-9_.-]+:\s*$/.test(text) && (jobIndent === -1 || indent <= jobIndent)) {
			job = text.replace(/:\s*$/, "");
			jobIndent = indent;
		}
	}
	flush();
	return steps;
}

/**
 * Every `run:` scalar a step carries, block scalars included. A step that runs nothing has none,
 * which is why the table's assertion is an exact command and not a `toContain`.
 */
function runCommands(step: WorkflowStep): string[] {
	const commands: string[] = [];
	for (let index = 0; index < step.lines.length; index++) {
		const match = /^\s*(?:-\s+)?run:\s*(.*)$/.exec(step.lines[index]);
		if (match === null) continue;
		const scalar = match[1].trim();
		if (/^[|>][+-]?\d*$/.test(scalar)) {
			const keyIndent = indentOf(step.lines[index]);
			const block: string[] = [];
			let next = index + 1;
			for (; next < step.lines.length; next++) {
				if (indentOf(step.lines[next]) <= keyIndent) break;
				block.push(step.lines[next].trim());
			}
			commands.push(block.join("\n"));
			index = next - 1;
			continue;
		}
		commands.push(scalar.replace(/^(['"])(.*)\1$/, "$2"));
	}
	return commands;
}

/** Whether the step RUNS this exact command — one line of one `run:` scalar, not a substring. */
function runsCommand(step: WorkflowStep, command: string): boolean {
	return runCommands(step).some((scalar) => scalar.split("\n").some((line) => line.trim() === command));
}

/**
 * Whether a step carries the two shapes that make a parsed-as-present step execute nothing: a
 * condition pinned false, or `continue-on-error: true` (which turns the gate's exit status into a
 * data point the job ignores). Both are one-line YAML keys in the step's own item body.
 */
function isDisabled(step: WorkflowStep): boolean {
	const text = step.lines.join("\n");
	return /^\s*if:\s*(?:false|\$\{\{\s*(?:!\s*)?false\s*\}\})\s*$/m.test(text) || /^\s*continue-on-error:\s*true\s*$/m.test(text);
}

const WORKFLOWS_DIR = join(ROOTS.repoRoot, ".github", "workflows");
const WORKFLOW = join(WORKFLOWS_DIR, "ci.yml");

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file under `dir`, skipping the two trees that are byte-noise between two checkouts. */
function walk(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__pycache__" || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...walk(path));
		else if (entry.isFile()) found.push(path);
	}
	return found;
}

/** The corpus this suite can read, keyed by a stable name: the skills tree plus every workflow. */
function corpusOf(roots: Roots): Map<string, string> {
	const corpus = new Map<string, string>();
	for (const path of walk(roots.skillsDir)) corpus.set(join("skills", relative(roots.skillsDir, path)), sha256(path));
	const workflows = join(roots.repoRoot, ".github", "workflows");
	if (existsSync(workflows)) {
		for (const path of walk(workflows)) corpus.set(join("workflows", relative(workflows, path)), sha256(path));
	}
	return corpus;
}

/** A `mutated` absolute path as the corpus keys it — and a refusal when it is under neither root. */
function corpusKey(roots: Roots, path: string): string {
	const skills = relative(roots.skillsDir, path);
	if (!skills.startsWith("..")) return join("skills", skills);
	const workflows = relative(join(roots.repoRoot, ".github", "workflows"), path);
	if (!workflows.startsWith("..")) return join("workflows", workflows);
	throw new Error(`${path} is under neither root — mutation mode must name a file this suite reads`);
}

/**
 * The corpus keys where `copy` and `checkout` differ — the UNION of both key sets, so a key present on
 * one side only (a file deleted from the copy, or added to it) is a difference with `undefined` on the
 * other side. Iterating the copy's keys alone reports a deletion as nothing, which is the fail-open a
 * stale tree missing an unread file would ride in on.
 */
function differingKeys(copy: Map<string, string>, checkout: Map<string, string>): string[] {
	const keys = new Set([...copy.keys(), ...checkout.keys()]);
	return [...keys].filter((key) => copy.get(key) !== checkout.get(key)).sort();
}

describe("runs every selftest CI ships", () => {
	it("binds its roots: this checkout's skills tree, or a copy whose only difference is the mutation", () => {
		// Both roots must exist before anything is read from them: a typo'd override is a red row,
		// not an empty parse that trivially satisfies the table.
		expect(existsSync(ROOTS.skillsDir)).toBe(true);
		expect(existsSync(ROOTS.repoRoot)).toBe(true);
		// The workflow is read from ROOTS.repoRoot, so a skills-only override cannot point the reader
		// at one tree and the CI contract at another.
		expect(existsSync(WORKFLOW)).toBe(true);

		if (OVERRIDE === undefined) {
			// The default path: an ordinary run reads THIS checkout. An inherited `SKILLS_TEST_ROOTS`
			// that named some other tree would have to be an override, and an override must say why.
			const skillsRoot = realpathSync(join(REPO_ROOT, ".pi", "skills"));
			expect(relative(skillsRoot, realpathSync(ROOTS.skillsDir)).startsWith("..")).toBe(false);
			return;
		}

		// Mutation mode. The copy must differ from this checkout in EXACTLY the files it declares, so
		// a red row is the mutation's doing and not a stale or foreign tree — and an unmutated copy
		// (`mutated: []`, the baseline) must be byte-identical to this checkout, which is what makes
		// its green run the same tree's run. An override that names neither root, or a file under
		// neither, throws instead of comparing nothing.
		const mutated = (ROOTS.mutated ?? []).map((path) => corpusKey(ROOTS, path)).sort();
		const copy = corpusOf(ROOTS);
		const checkout = corpusOf({ skillsDir: SKILL_DIR, repoRoot: REPO_ROOT });
		// The UNION of both key sets, not the copy's alone: a key present on one side only is a
		// difference with `undefined` on the other, so a file DELETED from the copy is as red as a
		// modified one — the fail-open this row exists to close.
		expect(differingKeys(copy, checkout)).toEqual(mutated);
	});

	it("counts a deletion as a difference, not only a changed byte — the seam compares the union of keys", () => {
		// The seam's own unit, in the default run: mutation mode is measured by hand, so the union it
		// relies on needs a row that fails here if someone narrows it back to one side's keys.
		const checkout = new Map([
			["skills/a.sh", "sha-a"],
			["skills/b.sh", "sha-b"],
		]);
		expect(differingKeys(new Map(checkout), checkout)).toEqual([]);
		// A changed byte is a difference, in either direction.
		expect(differingKeys(new Map(checkout).set("skills/a.sh", "sha-changed"), checkout)).toEqual(["skills/a.sh"]);
		// A file the copy no longer has: the copy's own keys say nothing, so this is the case the
		// old one-sided filter reported as `[]` (green) against an undeclared deletion.
		expect(differingKeys(new Map([["skills/b.sh", "sha-b"]]), checkout)).toEqual(["skills/a.sh"]);
		// A file only the copy has — the same union, the other side.
		expect(differingKeys(new Map([...checkout, ["skills/c.sh", "sha-c"]]), checkout)).toEqual(["skills/c.sh"]);
	});

	it("pins exactly one step per script, and no step that is disabled or tolerant of failure", () => {
		const steps = workflowSteps(readFileSync(WORKFLOW, "utf8"));
		// Vacuity control: a parse that found nothing must not satisfy a table of four.
		expect(steps.length).toBeGreaterThan(10);
		for (const entry of SELFTEST_STEPS) {
			const matching = steps.filter((step) => runsCommand(step, entry.command));
			expect([entry.command, matching.length]).toEqual([entry.command, 1]);
			// Present is not the same as executed: a step pinned false, or one whose failure the job
			// tolerates, parses as a step and runs nothing.
			expect([entry.command, isDisabled(matching[0])]).toEqual([entry.command, false]);
		}
	});

	it("knows every worktree script a workflow runs — a new selftest without a row fails here too", () => {
		const known = new Set(SELFTEST_STEPS.map((entry) => entry.script));
		const named = new Set<string>();
		for (const name of readdirSync(WORKFLOWS_DIR).filter((file) => /\.ya?ml$/.test(file))) {
			const steps = workflowSteps(readFileSync(join(WORKFLOWS_DIR, name), "utf8"));
			for (const step of steps) {
				for (const script of runCommands(step).join("\n").match(/\.pi\/skills\/worktree\/[\w.-]+/g) ?? []) named.add(script);
			}
		}
		// Both directions at once: a script gaining a CI step without a table row is red, and a table
		// row whose step was deleted is red.
		expect([...named].sort()).toEqual([...known].sort());
	});

	it("does not read a comment as a step — the parser is tested, not just its result on ci.yml", () => {
		// Six lines: the commented command is the exact string the table pins, and it must NOT be a step.
		const commented = ["jobs:", "  test:", "    steps:", `      # - run: ${MERGE_GUARD_STEP.command}`, "      - run: echo kept", "      - name: named"].join("\n");
		const parsed = workflowSteps(commented);
		expect(parsed).toHaveLength(2);
		expect(parsed.some((step) => runsCommand(step, MERGE_GUARD_STEP.command))).toBe(false);

		// The positive control: the same command as an ACTIVE item body IS found, and a `- name:` step
		// carries its sibling `run:` — the shapes a line-presence check gets wrong in both directions.
		const active = ["jobs:", "  test:", "    steps:", `      - run: ${MERGE_GUARD_STEP.command}`, "      - name: named", "        run: |", `          ${MERGE_GUARD_STEP.command}`].join("\n");
		const found = workflowSteps(active);
		expect(found).toHaveLength(2);
		expect(found.filter((step) => runsCommand(step, MERGE_GUARD_STEP.command))).toHaveLength(2);

		// And the two nonexecuting shapes the table refuses are exactly the ones `isDisabled` names.
		const disabled = workflowSteps(
			["jobs:", "  test:", "    steps:", `      - run: ${MERGE_GUARD_STEP.command}`, "        if: ${{ false }}", "      - run: bash .pi/skills/worktree/run.sh --selftest", "        continue-on-error: true"].join("\n"),
		);
		expect(disabled.map(isDisabled)).toEqual([true, true]);
	});
});

// ── worktree-cleanup.sh's teardown contract (#570) ────────────────────────────────────────────
//
// The #568 row above pins teardown's missing-path refusal and nothing else, so every rule that
// makes the script SAFE to run — protected refs, branch derivation, the not-a-worktree refusal, and
// the extension-sync flag — was unpinned. Each rule gets its own disposable cockpit: own temp dir,
// own BARE origin (so "remote deleted" is a measured ref, never this machine's network), own
// worktree, and no afterAll snapshot, because these rows deliberately delete things.

/** A cockpit the teardown rules can be measured against. Every path is inside one mkdtemp. */
interface CleanupFixture {
	/** The mkdtemp root: the fixture's boundary, removed when the row ends. */
	root: string;
	/** The BARE origin — `dev` is pushed here at setup, and rows assert its refs. */
	origin: string;
	/** The cockpit checkout: the repo `--repo-root` names. */
	cockpit: string;
	/** The teardown under test, copied from the tree the roots name — a mutant is what runs. */
	script: string;
	/** `dev`'s sha as the fixture created it. */
	dev: string;
	/** The disposable worktree, when the row asked for one. */
	worktree?: string;
}

/** What one row needs built. Everything is optional because each row is one rule's case. */
interface CleanupOptions {
	/** The branch the COCKPIT itself is on (default `dev`). A row linking `dev` must pick another. */
	cockpitBranch?: string;
	/** A branch to create (from the cockpit's HEAD) and push to the bare origin. */
	branch?: string;
	/** Link `branch` into a disposable worktree — false leaves the branch pushed but unchecked out. */
	worktree?: boolean;
	/** Dirty a tracked file in that worktree, so a removal without `--force` would fail. */
	modify?: boolean;
	/** Push one commit to the bare origin's `dev`, so the cockpit's fetch/pull has somewhere to go. */
	advanceDev?: boolean;
	/** An executable `sync-extension.sh` writing `extension-synced.txt` — the flag's own sentinel. */
	extensionSentinel?: boolean;
}

/** The identity every fixture commit carries: no user config is read (`GIT_CONFIG_GLOBAL=/dev/null`). */
const IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com"];

/** One fixture git command; the status is the caller's to assert. */
function gitAt(cwd: string, ...args: string[]) {
	return sh(["git", ...IDENTITY, ...args], cwd);
}

/** A fixture git command whose failure is a broken fixture, not a rule under test: throw loudly. */
function gitOk(cwd: string, ...args: string[]): string {
	const result = gitAt(cwd, ...args);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${result.status}: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

/**
 * A disposable cockpit: bare origin, one clean `dev`, and whatever the row asked for. The skill is
 * COPIED to the fixture's own `.pi/skills/worktree`, so even a row that lost its `--repo-root` would
 * derive the fixture — never this checkout — as its repo root.
 *
 * The temp root is created AND removed in this one place: a setup command that throws fails the row
 * before any `finally` can see the fixture, so the directory is swept here or it is litter forever.
 */
function cleanupRepo(options: CleanupOptions = {}): CleanupFixture {
	const root = mkdtempSync(join(tmpdir(), "brl-cleanup-"));
	try {
		return buildCockpit(root, options);
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

/** Fill `root` with the cockpit `options` asks for — every path under the root `cleanupRepo` made. */
function buildCockpit(root: string, options: CleanupOptions): CleanupFixture {
	const origin = join(root, "origin.git");
	const cockpit = join(root, "cockpit");
	const script = join(root, COPY_REL, "worktree-cleanup.sh");
	gitOk(root, "init", "-q", "--bare", origin);
	mkdirSync(join(root, ".pi", "skills"), { recursive: true });
	cpSync(ROOTS.skillsDir, join(root, COPY_REL), { recursive: true });
	mkdirSync(cockpit);
	gitOk(cockpit, "init", "-q", "-b", "dev");
	writeFileSync(join(cockpit, "README.md"), "cockpit\n");
	gitOk(cockpit, "add", "-A");
	gitOk(cockpit, "commit", "-qm", "base");
	gitOk(cockpit, "remote", "add", "origin", origin);
	gitOk(cockpit, "push", "-q", "-u", "origin", "dev");
	if (options.extensionSentinel === true) {
		// The extension sync's own marker, seeded with `dev` as it stands: "unchanged" is then a
		// content assertion, and the flag is the only thing that can move it.
		const dev = gitOk(cockpit, "rev-parse", "dev");
		writeFileSync(join(cockpit, "sync-extension.sh"), '#!/usr/bin/env bash\ngit rev-parse HEAD > "$(dirname "$0")/extension-synced.txt"\n', { mode: 0o755 });
		writeFileSync(join(cockpit, "extension-synced.txt"), `${dev}\n`);
	}
	if (options.advanceDev === true) {
		// A writer clone, not a hand-made commit object: the origin's `dev` advances the way a merged
		// PR advances it, and the cockpit has to fetch/pull to see it.
		const writer = join(root, "writer");
		gitOk(root, "clone", "-q", "-b", "dev", origin, writer);
		writeFileSync(join(writer, "later.md"), "one commit after the cockpit's dev\n");
		gitOk(writer, "add", "-A");
		gitOk(writer, "commit", "-qm", "later");
		gitOk(writer, "push", "-q", "origin", "dev");
	}
	if (options.cockpitBranch !== undefined) gitOk(cockpit, "checkout", "-q", "-b", options.cockpitBranch);
	const fixture: CleanupFixture = { root, origin, cockpit, script, dev: gitOk(cockpit, "rev-parse", "dev") };
	if (options.branch !== undefined) {
		const branch = options.branch;
		const exists = gitAt(cockpit, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).status === 0;
		if (options.worktree !== false) {
			fixture.worktree = join(root, "wt");
			gitOk(cockpit, "worktree", "add", "-q", ...(exists ? [fixture.worktree, branch] : ["-b", branch, fixture.worktree]));
			if (options.modify === true) writeFileSync(join(fixture.worktree, "README.md"), "modified in the worktree\n");
		} else if (!exists) {
			gitOk(cockpit, "branch", branch);
		}
		gitOk(cockpit, "push", "-q", "origin", branch);
	}
	return fixture;
}

/** The worktree a row asked for; a row that forgot to ask is a test bug, not a skipped assertion. */
function worktreeOf(fixture: CleanupFixture): string {
	if (fixture.worktree === undefined) throw new Error("this row needs `branch` with a worktree");
	return fixture.worktree;
}

/** A ref's sha in a repo, or `undefined` when it is gone — the shape a ref assertion wants. */
function revParse(repo: string, ref: string): string | undefined {
	const result = gitAt(repo, "rev-parse", "--verify", "--quiet", ref);
	return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Run the teardown from OUTSIDE the cockpit, so `--repo-root` is what names it. */
function runCleanup(fixture: CleanupFixture, argv: string[]) {
	const result = sh([interpreterOf(basename(fixture.script)), fixture.script, ...argv], fixture.root);
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Build the fixture, run the row, and remove the fixture even when an assertion throws. */
function withCleanupRepo(options: CleanupOptions, row: (fixture: CleanupFixture) => void): void {
	const fixture = cleanupRepo(options);
	try {
		row(fixture);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
}

// Every branch the teardown regex protects — `^(main|master|dev)$` — one row each, so a branch
// dropped from the regex is a red row rather than a silent narrowing of what the suite pins.
const PROTECTED_ROWS = ["dev", "main", "master"];

describe("worktree-cleanup's teardown rules", () => {
	// Every protected branch — `main`, `master`, `dev` — one row each: `dev` is the case the issue's
	// teardown meets in practice, and `main`/`master` are the ones that prove the guard is not an
	// accident of "git refuses to delete the branch the cockpit is on" (the cockpit only ever sits
	// on one of them).
	for (const protectedBranch of PROTECTED_ROWS) {
		it(`protects the long-lived branches: ${protectedBranch} survives a \`--branch ${protectedBranch}\` teardown`, () => {
			// The worktree is on the PROTECTED branch and its file is MODIFIED, so the plain removal
			// would refuse and the script must force it. After that removal the branch is checked out
			// NOWHERE, so git WOULD delete it — the guard, not the warning, is what keeps this green.
			withCleanupRepo({ cockpitBranch: `task/host-${protectedBranch}`, branch: protectedBranch, modify: true }, (fixture) => {
				const before = revParse(fixture.cockpit, `refs/heads/${protectedBranch}`);
				expect(before).toBeDefined();
				const result = runCleanup(fixture, [worktreeOf(fixture), "--branch", protectedBranch, "--repo-root", fixture.cockpit, "--skip-extension-sync"]);
				expect(result.status).toBe(0);
				expect(result.output).toContain("worktree removed:");
				expect(result.output).toContain(`WARNING: refusing to delete protected branch: ${protectedBranch}`);
				expect(existsSync(worktreeOf(fixture))).toBe(false);
				expect(revParse(fixture.cockpit, `refs/heads/${protectedBranch}`)).toBe(before);
				expect(revParse(fixture.origin, `refs/heads/${protectedBranch}`)).toBe(before);
			});
		});
	}

	it("derives the branch when it is omitted, and deletes it local and remote", () => {
		withCleanupRepo({ branch: "task/x" }, (fixture) => {
			const result = runCleanup(fixture, [worktreeOf(fixture), "--repo-root", fixture.cockpit, "--skip-extension-sync"]);
			expect(result.status).toBe(0);
			expect(result.output).toContain("branch derived from worktree: task/x");
			expect(result.output).toContain("local branch deleted: task/x");
			expect(result.output).toContain("remote branch deleted: task/x");
			expect(revParse(fixture.cockpit, "refs/heads/task/x")).toBeUndefined();
			expect(revParse(fixture.origin, "refs/heads/task/x")).toBeUndefined();
			// Derivation must not cost the protected branch its protection on the way past.
			expect(revParse(fixture.cockpit, "refs/heads/dev")).toBe(fixture.dev);
		});
	});

	it("refuses a path that is not a worktree, and leaves the directory and both refs intact", () => {
		// The branch exists and is pushed, but is checked out NOWHERE: if the deletion path were
		// reached it would succeed, so a ref surviving here means the row refused, not that git did.
		withCleanupRepo({ branch: "task/x", worktree: false }, (fixture) => {
			const plain = join(fixture.root, "plain");
			mkdirSync(plain);
			writeFileSync(join(plain, "keep.txt"), "keep me\n");
			const result = runCleanup(fixture, [plain, "--branch", "task/x", "--repo-root", fixture.cockpit, "--skip-extension-sync"]);
			expect(result.status).toBe(128);
			expect(result.output).toContain("is not a working tree");
			expect(existsSync(join(plain, "keep.txt"))).toBe(true);
			expect(readFileSync(join(plain, "keep.txt"), "utf8")).toBe("keep me\n");
			expect(revParse(fixture.cockpit, "refs/heads/task/x")).toBeDefined();
			expect(revParse(fixture.origin, "refs/heads/task/x")).toBeDefined();
			expect(revParse(fixture.cockpit, "refs/heads/dev")).toBe(fixture.dev);
		});
	});

	it("skips the cockpit sync when asked", () => {
		// Two fixtures, because the flag's whole content is the difference between them. The sentinel
		// is what the EXTENSION sync writes: measured, `--skip-extension-sync` does not govern
		// fetch/pull, so a `dev`-sha sentinel would red this row against the shipped script.
		withCleanupRepo({ advanceDev: true, extensionSentinel: true }, (fixture) => {
			const result = runCleanup(fixture, [join(fixture.root, "absent"), "--repo-root", fixture.cockpit, "--skip-extension-sync"]);
			expect(result.status).toBe(0);
			expect(result.output).toContain("extension sync skipped");
			expect(result.output).not.toContain("extension synced");
			expect(readFileSync(join(fixture.cockpit, "extension-synced.txt"), "utf8").trim()).toBe(fixture.dev);
			// The flag's measured scope: it skips the extension, not the fetch/pull beside it.
			expect(revParse(fixture.cockpit, "refs/heads/dev")).not.toBe(fixture.dev);
		});
		withCleanupRepo({ advanceDev: true, extensionSentinel: true }, (fixture) => {
			const result = runCleanup(fixture, [join(fixture.root, "absent"), "--repo-root", fixture.cockpit]);
			expect(result.status).toBe(0);
			expect(result.output).toContain("extension synced");
			const advanced = revParse(fixture.cockpit, "refs/heads/dev");
			expect(advanced).not.toBe(fixture.dev);
			expect(readFileSync(join(fixture.cockpit, "extension-synced.txt"), "utf8").trim()).toBe(advanced);
		});
	});
});
