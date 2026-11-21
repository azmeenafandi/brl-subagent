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
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURFACES } from "../../../../scripts/check-test-budget.mjs";

const SELF = fileURLToPath(import.meta.url);
/** `.pi/skills/worktree` — the scripts under test, and the tree every row's copy is made from. */
const SKILL_DIR = dirname(dirname(SELF));
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

/** The ONE spawn site: the git fixture and all ten rows go through it, so no row is a special case. */
function sh(argv: string[], cwd: string) {
	const result = spawnSync(argv[0], argv.slice(1), { cwd, env: env(), encoding: "utf8", timeout: 60_000 });
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
function entryScripts(dir: string = SKILL_DIR): string[] {
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
	const text = readFileSync(join(SKILL_DIR, script), "utf8");
	const escaped = lib.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^\\s*(?:source|\\.)\\s+[^\\n]*lib/${escaped}\\b`, "m").test(text);
}

beforeAll(() => {
	SCRATCH = mkdtempSync(join(tmpdir(), "brl-script-guards-"));
	mkdirSync(join(SCRATCH, ".pi", "skills"), { recursive: true });
	cpSync(SKILL_DIR, join(SCRATCH, COPY_REL), { recursive: true });
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
				const header = readFileSync(join(SKILL_DIR, row.script), "utf8").split("\n")[row.extra.usage.line - 1];
				expect(header).not.toContain(row.extra.usage.mustNotName);
			}
		});
	}
});

describe("the guard table holds itself together", () => {
	it("has a row for every top-level entry script on disk", () => {
		const files = entryScripts();
		// Vacuity control: the listing is not empty, and the helper sees a script with no row.
		expect(files).toContain("merge-guard.sh");
		expect(missingGuards([...files, "new-guard.sh"], ROWS)).toEqual(["new-guard.sh"]);
		expect(missingGuards(files, ROWS.filter((row) => row.script !== "recon.sh"))).toEqual(["recon.sh"]);
		expect(missingGuards(files, ROWS)).toEqual([]);
	});

	it("covers every `lib/*.sh` through the entry script that sources it", () => {
		const libs = readdirSync(join(SKILL_DIR, "lib")).filter((file) => file.endsWith(".sh"));
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
