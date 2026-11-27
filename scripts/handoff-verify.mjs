#!/usr/bin/env node
// Purpose: Diffs the handoff against the repo — the INDEX's shape and citations (seven checks) and the
// STATE PAGE's mechanical claims (checks 2–7) — one command (issue #495, index #607).
//
// TWO DOCUMENTS since #607. `.development/HANDOFF.md` is an index: four §STATE lines, bounded
// §Invariants/§Pointers/§Resume protocol sections, no counts. The mechanical claims it used to carry live
// in the page `.development/handoff/state.md` (below the index's own directory), in the SAME grammar
// `parseClaims` has always read. Two passes, one verdict:
//
//   pass A (index)   structure/shape · verified · budget · index completeness · citation liveness ·
//                    no counts in prose · one next action
//   pass B (page)    dev · install · open set · suite · modules/ADRs · file sizes — checks 2–7, with the
//                    index's `Verified:` as the head the suite report must have been captured at
//
// The claim grammars and both verdicts are in `scripts/lib/handoff-claims.mjs` (pure); this file is the two
// ends around them: the repo facts a check needs (`createRepoProbe`) and the CLI (`main`). Nothing here
// decides whether a claim holds — that is the lib's job, which is what lets the tests drive every drift
// without a repo, a network or a subprocess.
//
//   node scripts/handoff-verify.mjs [--root <path>] [--file .development/HANDOFF.md]
//                                   [--report <vitest.json>] [--report-dir <dir>]
//                                   [--issues <gh-issue-list.json>] [--no-network] [--json]
//
// Exit 0 every claim holds · 1 drift, one named code per failing claim · 2 usage, a missing/unreadable
// input, or an environment that cannot answer (no `dev` ref, no vitest report, `gh` unavailable, and since
// #607 a missing state page: `state-page-missing`). A drift and an unanswerable check are never
// conflated: "cannot check" is exit 2, never a silent pass.
//
// OUT OF SCOPE BY DESIGN (said in the output, not just here): the MEANING of the index's prose. The index
// is checked for shape, size, set relations, citation liveness and counts — never for whether a sentence
// is wise, and never for what a page says beyond the claims it states. The old scope sentence named
// narrative claims (`### Next actions`, the `Since the last handover` bullets); #607 removed those
// sections, so the residual is stated instead of the sections: a bounded line can still carry prose, and
// the mechanical guarantee is smallness with a named shape. See `SCOPE` below.
//
// Fact sources, and the flags that make them injectable:
//   root                  this checkout, or the one `--root <path>` names (#548). EVERY repo fact follows it —
//                         the default subject file, the `git` calls, the module/ADR counters and `gh`'s cwd —
//                         so the tool can be pointed at another checkout instead of silently reading this one.
//                         It must be the TOP LEVEL of a git worktree: `git -C <subdir> rev-parse --show-toplevel`
//                         answers with the parent's tree, and a nested or non-repo root would then report a
//                         foreign checkout's facts as if they were the requested one's. Both sides are
//                         canonicalised, so a symlinked alias is the same root and a typo is exit 2.
//   verified/dev/install  `git` in the selected root — never a hard-coded cockpit path; `git rev-parse dev`
//                         works from a worktree, which is where a unit runs. The `dev @` CLAIM is not that
//                         ref: it is the ref with its trailing handoff commits walked back (#497), because
//                         the convention is that the claim names the last merge and the handoff sits on top.
//   open set              `gh issue list --state open --limit 1000` in the selected root, or `--issues <json>`
//                         (a gh-format array). `--issues` wins over `--no-network`: the check then runs
//                         offline. `--no-network` without `--issues` skips the check AND prints that it skipped.
//   suite counts          a vitest JSON report, validated by `scripts/lib/suite-report.mjs` (#513):
//                         `--report <path>` wins, else the reports under `--report-dir` (default: the #512
//                         private scratch root's `reports/`, NOT the checkout) are scanned — and the handoff's
//                         own `Verified:` sha disambiguates them (#520), because the report that proves the
//                         `Suite:` line is the one captured at the tree §STATE describes. Several reports
//                         for the SAME head are a named duplicate copy, never a tie; no head in the STATE
//                         and several reports is still a refusal naming both, never "newest". The report's
//                         path AND its provenance (head · dirty · absent) are printed with the verdict, so a
//                         count is never shown without the provenance of what produced it (Rule 11, #488).
//                         DELIBERATE: `--root` moves the REPO FACTS, never the capture directory — the
//                         default is a property of this machine's scratch root (#512), not of the checkout
//                         being evaluated, so a run against another repo must not start reading its
//                         `reports/`. `--report` / `--report-dir` stay relative to the cwd that ran this.
//   module/ADR counts     the selected root's own generators (`docs-arch`, `docs-decisions`), imported rather
//                         than re-counted so the guard and the generator cannot disagree.
//   file sizes            `wc -l` — `countLines` from `scripts/check-test-budget.mjs`, one definition of
//                         "physical lines" in the repo. A claimed name resolves `src/`, then `scripts/`,
//                         then the root, so a bare `friction-disposition.mjs` is a checkable claim (#583).
//
// The resolved root is printed with the verdict (the `Running install:` line names `this repo (<root>)`), so a
// run against a foreign checkout is self-identifying instead of looking like this one.
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
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countLines } from "./check-test-budget.mjs";
import { collectDecisions } from "./docs-decisions.mjs";
import { collectModules } from "./docs-arch.mjs";
import { InputError, evaluateIndex, evaluateStatePage, isHandoffOwnCommit, parseClaims, parseIndex } from "./lib/handoff-claims.mjs";
import { resolveReport } from "./lib/suite-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — never a hard-coded cockpit path; `git rev-parse dev` works here. */
export const ROOT = join(HERE, "..");
export const DEFAULT_FILE = join(".development", "HANDOFF.md");
/** The page the index points at, relative to the index's own directory (#607 D1). */
export const STATE_PAGE = join("handoff", "state.md");

export const USAGE =
	"usage: handoff-verify.mjs [--root <path>] [--file <handoff-index>] [--report <vitest-json-report>] [--report-dir <dir>] [--issues <gh-issue-list.json>] [--no-network] [--json]";

/**
 * The claims this tool refuses to check, printed with every verdict: a scope nobody states is a scope the
 * reader fills in with their own guess. One sentence, and the reason — the index is checked for SHAPE, and
 * a bounded line can still hold a sentence, so the residual is stated rather than claimed away.
 */
export const SCOPE =
	"out of scope by design: the MEANING of the index's prose — a bounded line can still hold a sentence, so the guarantee is smallness with a named shape (H2 set · four §STATE fields · section bounds · budget · citations · no counts), and a page is opened on demand rather than read here";

/** Exit codes, named so the docs and the tests cannot drift from the script. */
export const EXIT = Object.freeze({ OK: 0, DRIFT: 1, USAGE: 2 });

function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Facts — the repo side. Everything IO-shaped lives behind `createRepoProbe`.
// ---------------------------------------------------------------------------

/**
 * `src/<name>` first (every counted module lives there), then `scripts/<name>` (the process tooling a
 * `Suite:`/size row also names), then the repo root. The order is documented and load-bearing: a name
 * present in both `src/` and `scripts/` resolves to `src/`, which is where the module claims point.
 * `null` when none exists.
 */
export function resolveModulePath(root, name) {
	for (const candidate of [join(root, "src", name), join(root, "scripts", name), join(root, name)]) {
		if (existsSync(candidate)) return candidate;
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
 * The dev CLAIM: `dev` with its trailing handoff commits walked back (issue #497). The repo's convention is
 * that the `dev @ <sha>` claim names the last MERGE sha and the handoff commit sits on top of it, so
 * comparing the claim against the raw ref cries wolf after every handoff commit — the failure mode the tool
 * exists to prevent, on the file it exists to check. Check 1 already applies the same rule (`Verified:` plus
 * "nothing but the handoff after it"); this is the one resolution checks 2 and 3 share, so a `dev @` line and
 * the install line can never be compared against two different tips.
 *
 * A walk with no floor is an environment fault, never a guess: a dev whose every commit back to the root is
 * handoff-only exits 2 and says so. A shallow checkout needs no special case — git reports a shallow boundary
 * commit as adding every file, so it is not handoff-only and the walk stops at the ref.
 */
export function resolveDevClaim(root) {
	let sha = gitOrThrow(root, ["rev-parse", "dev"], "dev").trim();
	for (let steps = 1; ; steps += 1) {
		const [commit] = parseRangeLog(
			gitOrThrow(root, ["log", "-1", "--format=%x01%H", "--name-status", "-z", "-M", sha], "dev"),
		);
		if (commit === undefined) throw new InputError(`dev: git log -1 ${sha} reported no commit — cannot resolve the dev claim`);
		// A merge commit reports no paths, so it is never handoff-only: the walk stops where the convention says.
		if (!isHandoffOwnCommit(commit)) return sha;
		const parent = git(root, ["rev-parse", "--verify", `${sha}^`]);
		if (parent.status !== 0) {
			throw new InputError(
				`dev: ${steps} commit(s) back from the tip touch only the handoff and the walk has no parent left — cannot resolve the dev claim`,
			);
		}
		sha = parent.stdout.trim();
	}
}

/**
 * The repo side of every check, as one plain object — the single seam the tests replace. It takes the
 * SAME option names `parseArgs` produces (`report`, `issues`), because the two are joined by `main` and a
 * renamed side is how `--report <json>` and `--issues <json>` were silently dropped once. `report` is
 * resolved lazily so `--no-network` and a usage fault never pay for a directory scan.
 *
 * `report(expectHead)` takes the handoff's `Verified:` sha, and the caller supplies it: the scanner keeps
 * one report per capture and never prunes, so by the second capture the default directory holds several
 * candidates. The verified head is the only honest disambiguator (#520) — resolution by it lives in
 * `scripts/lib/suite-report.mjs`, and the order (read `Verified:`, THEN resolve) is the caller's, here.
 *
 * The suite report itself is not read here any more (#513): `scripts/lib/suite-report.mjs` owns that, so
 * the handoff's suite check and the PR body's `suite:` key cannot disagree about what a report is.
 *
 * The INDEX's four facts (#607) are here too, because they are the only facts the index checks need and
 * they are all IO: the page directory (`pages`), a pointer target (`pointerExists`, resolved against the
 * index's directory first and then the checkout root — the two places a row can name), an issue's state
 * (`issueState`, `gh issue view`), and dev ancestry for a cited sha (`isAncestorOfDev`, not `isAncestor`:
 * a citation names a commit on the branch the index describes, and a worktree's HEAD is not that branch).
 *
 * `indexFile` is the resolved index path, so `pages`/`pointerExists` resolve against the directory the
 * index actually lives in — `--file` may name any document, and its pages are its own.
 */
export function createRepoProbe(root, { report = "", reportDir = "", issues = "", indexFile = "" } = {}) {
	const indexDir = dirname(resolve(indexFile === "" ? join(root, DEFAULT_FILE) : indexFile));
	return {
		root,
		indexDir,
		headSha: () => gitOrThrow(root, ["rev-parse", "HEAD"], "HEAD").trim(),
		devSha: () => gitOrThrow(root, ["rev-parse", "dev"], "dev").trim(),
		devClaimSha: () => resolveDevClaim(root),
		// An unknown revision is NOT "cannot check": the handoff names a commit that is not here, which is
		// exactly the drift `verified-not-ancestor` exists for. Only a git that cannot run is a usage fault.
		isAncestor: (sha) => {
			const result = git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]);
			if (result.error) throw new InputError(`HEAD: ${describeError(result.error)}`);
			return result.status === 0;
		},
		// Same rule, different subject: a cited sha must be on `dev`, the branch the index describes.
		isAncestorOfDev: (sha) => {
			const result = git(root, ["merge-base", "--is-ancestor", sha, "dev"]);
			if (result.error) throw new InputError(`dev: ${describeError(result.error)}`);
			return result.status === 0;
		},
		commitsAfter: (sha) =>
			parseRangeLog(gitOrThrow(root, ["log", "--format=%x01%H", "--name-status", "-z", "-M", `${sha}..dev`], "dev")),
		exists: (path) => existsSync(path),
		// The pages the index must point at: every `.md` beside it under `handoff/`. An absent directory is
		// `[]`, not a fault — `main` has already refused a missing page as `state-page-missing`.
		pages: () => {
			try {
				return readdirSync(join(indexDir, "handoff")).filter((name) => name.endsWith(".md")).sort();
			} catch {
				return [];
			}
		},
		// Index directory first (a page row reads `handoff/state.md`), then the checkout root (a skill row reads
		// `.pi/skills/handoff/SKILL.md`). Both are places a `## Pointers` row legitimately names.
		pointerExists: (target) => existsSync(resolve(indexDir, target)) || existsSync(resolve(root, target)),
		issueState: (number) => {
			const result = spawnSync("gh", ["issue", "view", String(number), "--json", "number,state"], { cwd: root, encoding: "utf8" });
			if (result.error) throw new InputError(`gh issue view ${number}: ${describeError(result.error)}`);
			if (result.status !== 0) {
				const reason = (result.stderr ?? "").trim().split("\n")[0] || "no output";
				throw new InputError(`gh issue view ${number} failed (${reason}) — pass --no-network to skip the citation check`);
			}
			let parsed;
			try {
				parsed = JSON.parse(result.stdout);
			} catch (error) {
				throw new InputError(`gh issue view ${number}: output is not JSON (${describeError(error)})`);
			}
			const state = typeof parsed?.state === "string" ? parsed.state.toLowerCase() : "";
			if (!["open", "closed", "merged"].includes(state)) {
				throw new InputError(`gh issue view ${number}: unexpected state ${JSON.stringify(parsed?.state)}`);
			}
			return state;
		},
		lineCount: (name) => {
			const path = resolveModulePath(root, name);
			return path === null ? null : { path, lines: countLines(path) };
		},
		modules: () => collectModules(root).length,
		adrs: () => collectDecisions(root).length,
		openIssues: () => readIssues({ root, issues }),
		report: (expectHead = "") => resolveReport({ report, dir: reportDir, expectHead }),
	};
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * The checkout `--root` names, canonicalised — or a named fault (#548).
 *
 * The rule is "this directory IS that checkout's top level", and `resolve()` alone cannot decide it: it keeps
 * symlinks, and `git -C <subdir> rev-parse --show-toplevel` happily answers with the PARENT's tree, which would
 * evaluate one handoff against another checkout's facts without saying so. So both sides go through `realpath`:
 * a nested subdirectory, a plain directory that is not a repo, and a non-directory are all exit 2, while a
 * symlinked alias of the same top level is the same root. The canonical form is what comes back, so the verdict
 * (`Running install: this repo (<root>)`) names the tree that was actually read.
 */
export function resolveRoot(requested) {
	const fault = (reason) => new InputError(`--root ${requested}: ${reason}`);
	const target = resolve(requested);
	let stats;
	try {
		stats = statSync(target);
	} catch (error) {
		throw fault(`not a directory (${describeError(error)})`);
	}
	if (!stats.isDirectory()) throw fault("not a directory");
	const root = realpathSync(target);
	const top = git(root, ["rev-parse", "--show-toplevel"]);
	if (top.error) throw fault(describeError(top.error));
	const toplevel = top.status === 0 ? top.stdout.trim() : "";
	if (toplevel === "") throw fault("not a git worktree top-level (resolved root is none — git finds no worktree there)");
	const canonicalTop = realpathSync(toplevel);
	if (canonicalTop !== root) throw fault(`not a git worktree top-level (resolved root is ${canonicalTop})`);
	return root;
}

const VALUE_FLAGS = new Map([
	["--root", "root"],
	["--file", "file"],
	["--report", "report"],
	["--report-dir", "reportDir"],
	["--issues", "issues"],
]);
const BOOLEAN_FLAGS = new Map([
	["--no-network", "noNetwork"],
	["--json", "json"],
]);

/** `{ ok: true, options }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	// `root: ""` is the DEFAULT, not just a map entry: `--root` absent must resolve to the checkout this script
	// lives in, and `resolve(undefined)` would throw on it. `""` keeps "absent" and "empty" one state.
	const options = { root: "", file: "", report: "", reportDir: "", issues: "", noNetwork: false, json: false };
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
	// The selected root decides WHICH checkout every repo fact is read from (#548); absent means this one, and
	// an absent root is the literal `""` `parseArgs` defaults to, never `undefined`.
	let root;
	try {
		root = options.root === "" ? ROOT : resolveRoot(options.root);
	} catch (error) {
		err(`handoff-verify: ${describeError(error)}`);
		return EXIT.USAGE;
	}
	// `--file` still wins and stays cwd-relative: it names one document, not another checkout.
	const filePath = options.file === "" ? join(root, DEFAULT_FILE) : resolve(options.file);
	let text;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		err(`handoff-verify: cannot read ${filePath} (${describeError(error)})`);
		return EXIT.USAGE;
	}
	const index = parseIndex(text);
	// A document with no `## STATE` heading at all is a usage fault, not a drift: there is nothing to check
	// and no injection. A `## STATE` that EXISTS with the wrong body is drift (`state-shape`), which is the
	// distinction the reader needs — a wrong file vs. a wrong section.
	if (!index.structure.headings.some((heading) => heading.text === "STATE")) {
		err(`handoff-verify: ${filePath} has no "## STATE" section — nothing mechanical to check`);
		return EXIT.USAGE;
	}
	// Pass B's subject, derived from the index rather than named by a second flag (#607 D1): `--file` names
	// ONE document, and the page it points at is its own. A missing page is "cannot check" (2), never
	// a drift — there is nothing to compare a claim against.
	const pagePath = join(dirname(filePath), STATE_PAGE);
	let pageText;
	try {
		pageText = readFileSync(pagePath, "utf8");
	} catch (error) {
		err(`handoff-verify: state-page-missing: ${pagePath} (${describeError(error)}) — the index's mechanical claims live in a page at <dir-of-index>/${STATE_PAGE}`);
		return EXIT.USAGE;
	}
	const pageClaims = parseClaims(pageText);
	if (pageClaims.state === null) {
		err(`handoff-verify: ${pagePath} has no "## STATE" section — nothing mechanical to check`);
		return EXIT.USAGE;
	}
	let results;
	let drifts;
	try {
		const probe = io.probe ?? createRepoProbe(root, { ...options, indexFile: filePath });
		const context = { noNetwork: options.noNetwork, issuesInjected: options.issues !== "" };
		// Pass A then pass B, in that order: the index's `Verified:` is what pass B's suite check needs, and a
		// reader follows the document the same way.
		const indexPass = evaluateIndex(index, probe, context);
		const pagePass = evaluateStatePage(pageClaims, probe, {
			...context,
			expectHead: index.verified === null ? "" : index.verified.sha,
		});
		results = [...indexPass.results, ...pagePass.results];
		drifts = [...indexPass.drifts, ...pagePass.drifts];
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
