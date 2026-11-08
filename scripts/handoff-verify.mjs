#!/usr/bin/env node
// Purpose: Diffs the handoff STATE's mechanical claims against the repo — one command, seven checks
// (issue #495).
//
// The claim grammar and the verdict are in `scripts/lib/handoff-claims.mjs` (pure); this file is the two
// ends around it: the repo facts a check needs (`createRepoProbe`) and the CLI (`main`). Nothing here
// decides whether a claim holds — that is the lib's job, which is what lets the tests drive every drift
// without a repo, a network or a subprocess.
//
//   node scripts/handoff-verify.mjs [--file .development/HANDOFF.md] [--report <vitest.json>]
//                                   [--issues <gh-issue-list.json>] [--no-network] [--json]
//
// Exit 0 every claim holds · 1 drift, one named code per failing claim · 2 usage, a missing/unreadable
// input, or an environment that cannot answer (no `dev` ref, no vitest report, `gh` unavailable). A drift
// and an unanswerable check are never conflated: "cannot check" is exit 2, never a silent pass.
//
// OUT OF SCOPE BY DESIGN (said in the output, not just here): narrative claims — the cycle queue,
// `### Next actions` and the `### Since the last handover` bullets. They are prose, and the only mechanical
// reading of them is a guess at which queue item is "current"; a heuristic there would fail closed on a
// legitimate rewrite, which is worse than a human reading three lines. See `SCOPE` below.
//
// Fact sources, and the flags that make them injectable:
//   verified/dev/install  `git` in THIS checkout — never a hard-coded cockpit path; `git rev-parse dev`
//                         works from a worktree, which is where a unit runs.
//   open set              `gh issue list --state open --limit 1000`, or `--issues <json>` (a gh-format
//                         array). `--issues` wins over `--no-network`: the check then runs offline.
//                         `--no-network` without `--issues` skips the check AND prints that it skipped.
//   suite counts          a vitest JSON report: `--report <path>`, else the newest parseable report
//                         directly under /tmp. The report's path is printed with the verdict, so a count
//                         is never shown without the provenance of what produced it (Rule 11, #488).
//   module/ADR counts     the repo's own generators (`docs-arch`, `docs-decisions`), imported rather than
//                         re-counted so the guard and the generator cannot disagree.
//   file sizes            `wc -l` — `countLines` from `scripts/check-test-budget.mjs`, one definition of
//                         "physical lines" in the repo.
//
// Two deliberate choices, both load-bearing:
//   • Check 1's range ends at `dev`, not at `HEAD`. §STATE describes dev; a worktree's HEAD is a feature
//     branch the handoff never describes, so measuring against HEAD would report every unit's own work as
//     drift and the tool could never be run from a worktree. In the cockpit HEAD == dev and the two are
//     the same ref — which is where the extension runs. Reachability is still checked against HEAD, which
//     is what catches a rebase, an amend or another branch.
//   • A drift means the CLAIM is wrong: fix the claim, never this script. It reads the shapes the handoff
//     contract promises and nothing else — prose is not parsed, nothing is rewritten, nothing is fixed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countLines } from "./check-test-budget.mjs";
import { collectDecisions } from "./docs-decisions.mjs";
import { collectModules } from "./docs-arch.mjs";
import { InputError, evaluate, parseClaims } from "./lib/handoff-claims.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — never a hard-coded cockpit path; `git rev-parse dev` works here. */
export const ROOT = join(HERE, "..");
export const DEFAULT_FILE = join(".development", "HANDOFF.md");

export const USAGE =
	"usage: handoff-verify.mjs [--file <handoff>] [--report <vitest-json-report>] [--issues <gh-issue-list.json>] [--no-network] [--json]";

/**
 * The claims this tool refuses to check, printed with every verdict: a scope nobody states is a scope the
 * reader fills in with their own guess. One sentence, and the reason — a heuristic here would FAIL CLOSED
 * on a legitimate rewrite of the queue or of a "Since" bullet, which is a worse trade than prose.
 */
export const SCOPE =
	"out of scope by design: narrative claims — the cycle queue, `Next actions`, `Since` bullets — are prose, and a heuristic there would fail closed on a legitimate rewrite";

/** Exit codes, named so the docs and the tests cannot drift from the script. */
export const EXIT = Object.freeze({ OK: 0, DRIFT: 1, USAGE: 2 });

function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Facts — the repo side. Everything IO-shaped lives behind `createRepoProbe`.
// ---------------------------------------------------------------------------

/** `src/<name>` first (every counted file is a module), then the repo root. `null` when neither exists. */
export function resolveModulePath(root, name) {
	for (const candidate of [join(root, "src", name), join(root, name)]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** The counts a vitest JSON report states: one per test file, and the PASSED tests (the claim says "green"). */
export function readSuiteReport(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new InputError(`${path}: cannot read the vitest JSON report (${describeError(error)})`);
	}
	let report;
	try {
		report = JSON.parse(text);
	} catch (error) {
		throw new InputError(`${path}: not JSON (${describeError(error)})`);
	}
	const results = report?.testResults;
	if (!Array.isArray(results) || results.length === 0) {
		throw new InputError(`${path}: no testResults — is this vitest's json reporter output?`);
	}
	const tests =
		typeof report.numPassedTests === "number"
			? report.numPassedTests
			: results.reduce((total, file) => total + (Array.isArray(file?.assertionResults) ? file.assertionResults.length : 0), 0);
	return { path, files: results.length, tests };
}

/**
 * The newest parseable vitest JSON report directly under `dir` — mtime descending, then name descending so
 * a tie is still deterministic. Candidates that do not parse as a vitest report are skipped, which is why a
 * stray `/tmp/*.json` cannot make the check unanswerable.
 */
export function findNewestReport(dir = tmpdir()) {
	const candidates = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => {
			const path = join(dir, entry.name);
			try {
				return { path, mtime: statSync(path).mtimeMs };
			} catch {
				// The entry vanished between the listing and the stat: not a candidate, not a fault.
				return { path, mtime: -1 };
			}
		})
		.filter((candidate) => candidate.mtime >= 0)
		.sort((left, right) => right.mtime - left.mtime || (left.path < right.path ? 1 : -1));
	for (const candidate of candidates) {
		try {
			return readSuiteReport(candidate.path);
		} catch {
			// not a vitest report — keep looking
		}
	}
	return null;
}

/** The open set the handoff is compared against: `gh issue list` here, a JSON file under `--issues`. */
export function readIssues({ root, issues = "" }) {
	if (issues !== "") {
		let text;
		try {
			text = readFileSync(issues, "utf8");
		} catch (error) {
			throw new InputError(`${issues}: cannot read the issue list (${describeError(error)})`);
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new InputError(`${issues}: not JSON (${describeError(error)})`);
		}
		if (!Array.isArray(parsed)) throw new InputError(`${issues}: expected an array of issues (gh issue list --json number)`);
		return parsed.map((item) => (typeof item === "number" ? item : item?.number)).filter((number) => Number.isInteger(number));
	}
	// `--limit` matters: gh's default is 30, and a board larger than that would silently under-report.
	const result = spawnSync("gh", ["issue", "list", "--state", "open", "--limit", "1000", "--json", "number"], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.error) throw new InputError(`gh issue list: ${describeError(result.error)}`);
	if (result.status !== 0) {
		const reason = (result.stderr ?? "").trim().split("\n")[0] || "no output";
		throw new InputError(`gh issue list failed (${reason}) — pass --issues <json> or --no-network to work offline`);
	}
	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (error) {
		throw new InputError(`gh issue list: output is not JSON (${describeError(error)})`);
	}
	if (!Array.isArray(parsed)) throw new InputError("gh issue list: expected an array of issues");
	return parsed.map((item) => item?.number).filter((number) => Number.isInteger(number));
}

/**
 * The commits of `git log --format=%x01%H --name-status -z -M <range>`: one record per commit, each with
 * the paths it touched. A rename/copy contributes BOTH sides, so a foreign file renamed to `HANDOFF.md`
 * (or the reverse) is not mistaken for a handoff-only commit.
 */
export function parseRangeLog(raw) {
	const commits = [];
	for (const segment of String(raw).split("\u0001")) {
		if (segment === "") continue;
		const tokens = segment
			.split("\u0000")
			.map((token) => token.replace(/^\n/, ""))
			.filter((token) => token !== "");
		if (tokens.length === 0) continue;
		const sha = tokens[0].trim();
		const paths = [];
		for (let index = 1; index < tokens.length; ) {
			const status = tokens[index].slice(0, 1);
			const wanted = status === "R" || status === "C" ? 2 : 1;
			paths.push(...tokens.slice(index + 1, index + 1 + wanted));
			index += 1 + wanted;
		}
		commits.push({ sha, paths });
	}
	return commits;
}

const git = (root, args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

function gitOrThrow(root, args, what) {
	const result = git(root, args);
	if (result.error) throw new InputError(`${what}: ${describeError(result.error)}`);
	if (result.status !== 0) {
		const reason = (result.stderr ?? "").trim().split("\n")[0] || "no output";
		throw new InputError(`${what}: git ${args.join(" ")} failed (${reason})`);
	}
	return result.stdout;
}

/**
 * The repo side of every check, as one plain object — the single seam the tests replace. It takes the
 * SAME option names `parseArgs` produces (`report`, `issues`), because the two are joined by `main` and a
 * renamed side is how `--report <json>` and `--issues <json>` were silently dropped once. `report` is
 * resolved lazily so `--no-network` and a usage fault never pay for a `/tmp` scan.
 */
export function createRepoProbe(root, { report = "", issues = "" } = {}) {
	return {
		root,
		headSha: () => gitOrThrow(root, ["rev-parse", "HEAD"], "HEAD").trim(),
		devSha: () => gitOrThrow(root, ["rev-parse", "dev"], "dev").trim(),
		// An unknown revision is NOT "cannot check": the handoff names a commit that is not here, which is
		// exactly the drift `verified-not-ancestor` exists for. Only a git that cannot run is a usage fault.
		isAncestor: (sha) => {
			const result = git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]);
			if (result.error) throw new InputError(`HEAD: ${describeError(result.error)}`);
			return result.status === 0;
		},
		commitsAfter: (sha) =>
			parseRangeLog(gitOrThrow(root, ["log", "--format=%x01%H", "--name-status", "-z", "-M", `${sha}..dev`], "dev")),
		exists: (path) => existsSync(path),
		lineCount: (name) => {
			const path = resolveModulePath(root, name);
			return path === null ? null : { path, lines: countLines(path) };
		},
		modules: () => collectModules().length,
		adrs: () => collectDecisions().length,
		openIssues: () => readIssues({ root, issues }),
		report: () => (report === "" ? findNewestReport() : readSuiteReport(report)),
	};
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Map([
	["--file", "file"],
	["--report", "report"],
	["--issues", "issues"],
]);
const BOOLEAN_FLAGS = new Map([
	["--no-network", "noNetwork"],
	["--json", "json"],
]);

/** `{ ok: true, options }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	const options = { file: "", report: "", issues: "", noNetwork: false, json: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const booleanKey = BOOLEAN_FLAGS.get(argument);
		if (booleanKey !== undefined) {
			options[booleanKey] = true;
			continue;
		}
		const valueKey = VALUE_FLAGS.get(argument);
		if (valueKey === undefined) {
			return { ok: false, message: argument.startsWith("--") ? `unknown flag: ${argument}` : `unexpected argument: ${argument}` };
		}
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) return { ok: false, message: `${argument} needs a path` };
		options[valueKey] = value;
		index += 1;
	}
	return { ok: true, options };
}

/**
 * Run the check. Returns the exit code; every line of output goes through `out` / `err`, and `io.probe`
 * replaces the repo side wholesale (the tests' only seam — no `gh`, no network, no subprocess).
 */
export function main(argv = process.argv.slice(2), io = {}) {
	const out = io.out ?? console.log;
	const err = io.err ?? console.error;
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		err(`${USAGE}\n${parsed.message}`);
		return EXIT.USAGE;
	}
	const options = parsed.options;
	const filePath = options.file === "" ? join(ROOT, DEFAULT_FILE) : resolve(options.file);
	let text;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		err(`handoff-verify: cannot read ${filePath} (${describeError(error)})`);
		return EXIT.USAGE;
	}
	const claims = parseClaims(text);
	if (claims.state === null) {
		err(`handoff-verify: ${filePath} has no "## STATE" section — nothing mechanical to check`);
		return EXIT.USAGE;
	}
	let results;
	let drifts;
	try {
		const probe = io.probe ?? createRepoProbe(ROOT, options);
		({ results, drifts } = evaluate(claims, probe, { noNetwork: options.noNetwork, issuesInjected: options.issues !== "" }));
	} catch (error) {
		err(`handoff-verify: ${describeError(error)}`);
		return EXIT.USAGE;
	}

	if (options.json) {
		out(JSON.stringify({ ok: drifts.length === 0, drifts }, null, 2));
		// stdout is the machine's; a skip and the scope both still have to be said out loud, so stderr.
		err(`handoff-verify: ${SCOPE}`);
		for (const result of results.filter((item) => item.skipped)) err(`handoff-verify: ${result.claim} — skipped (${result.reason})`);
	} else {
		for (const result of results) out(result.line);
		out(`handoff-verify: ${SCOPE}`);
		out(`handoff-verify: ${drifts.length} drift(s)`);
	}
	return drifts.length === 0 ? EXIT.OK : EXIT.DRIFT;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
