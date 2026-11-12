#!/usr/bin/env node
// Purpose: Generated PR-evidence numbers, checked against the tree (issue #488).
//
// Three PR bodies in one cycle carried counts that did not match the tree: S5 said `index.ts` "landed
// at 338" when it was 353, S6 said "44 seam tests" when the files ran 84, and S6 described
// `applyTemplate` as "stays at 24" when it was new. Each was caught — by a human who happened to check.
// #488's first answer (`value ← command`, re-run in review) still trusts a paste; this tool removes the
// paste: the block is EMITTED from the repo, and `--check` RECOMPUTES every key and compares.
//
//   node scripts/pr-evidence.mjs --emit   [--base <ref>] [--head <sha>] [--report <json>] [--report-dir <dir>]
//   node scripts/pr-evidence.mjs --check  (--body <file> | --pr <n>) [--base <ref>] [--report <json>] [--report-dir <dir>]
//   node scripts/pr-evidence.mjs --apply  --pr <n>            [--base <ref>] [--report <json>] [--report-dir <dir>]
//   every mode also takes --json.
//
// Exit 0 clean · 1 drift (one named code per finding) · 2 usage, an input that cannot be read, an
// environment that cannot answer, or a body that states a count with no block. A drift and an
// unanswerable check are never conflated: "cannot check" is exit 2, never a silent pass.
//
// THE ONE HARD RULE: **no text from a PR body is ever executed.** A body is untrusted — anyone with a
// fork can write one — so the `← <command>` half of every line is inert documentation. This file starts
// processes (git, gh, the budget guard's own measurement) and every argv it builds is a fixed string
// plus a validated PR number or a path from *this* command line; the body is only ever parsed, in
// `scripts/lib/pr-evidence.mjs`, by pure functions. `--apply` writes the body back through
// `gh pr edit --body-file -` (stdin), so body text never becomes an argument or a shell word.
//
// WHERE THE NUMBERS COME FROM, and the seam the tests replace (`io.probe`):
//   head · changed-files · src-diff-lines   git in THIS checkout — `git diff <base>...<head>`, so a
//                                           rebased base still measures the merge-base, like the PR does
//   suite · budget                          a vitest JSON report, validated by `scripts/lib/suite-report.mjs`
//                                           (#513): `--report` wins, else the reports under
//                                           `--report-dir` (default `<root>/reports`) are scanned with
//                                           THIS tree's head as the expected provenance; and the repo's
//                                           own guard (`measureSurface`, one definition of each ratio)
//   --pr bodies                             `gh pr view <n> --json headRefOid,body`
//
// Suite and budget are measured from the CHECKED-OUT TREE, so a `--pr` check requires that the PR's head
// is what is checked out here (a review worktree is provisioned that way). Checking a body against a
// tree that is not its head would be a confident wrong answer, so it exits 2 and says which two shas
// disagree — never a pass, never a drift.
//
// Determinism: values are read from the repo, the block is byte-identical between runs, findings are in
// the block's key order, and no timestamp appears anywhere. The `←` commands are the canonical
// reproduction commands, not the report path of the moment — an absolute path in the block would make
// two emits differ for no reason. The path that WAS read, and its provenance label, are printed on
// stderr (Rule 11).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SURFACES, measureSurface } from "./check-test-budget.mjs";
import { resolveReport } from "./lib/suite-report.mjs";
import { EXIT, SCOPE, checkBody, renderBlock, sameHead, upsertBlock } from "./lib/pr-evidence.mjs";
import { InputError } from "./lib/handoff-claims.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — `git` runs here, never in a hard-coded cockpit path. */
export const ROOT = join(HERE, "..");

/** The base a unit's PR is measured against; overridable with `--base`. */
export const DEFAULT_BASE = "dev";

export const USAGE =
	"usage: pr-evidence.mjs --emit [--base <ref>] [--head <sha>] | " +
	"--check (--body <file> | --pr <n>) [--base <ref>] | --apply --pr <n> | " +
	"[--report <json>] [--report-dir <dir>] [--json]";

export { EXIT, SCOPE };

function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Facts — the repo side. Everything IO-shaped lives behind `createEvidenceProbe`.
// ---------------------------------------------------------------------------

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

function ghOrThrow(root, args, what, input) {
	const result = spawnSync("gh", args, { cwd: root, encoding: "utf8", ...(input === undefined ? {} : { input }) });
	if (result.error) throw new InputError(`${what}: ${describeError(result.error)}`);
	if (result.status !== 0) {
		const reason = (result.stderr ?? "").trim().split("\n")[0] || "no output";
		throw new InputError(`${what} failed (${reason})`);
	}
	return result.stdout;
}

/** `git diff --name-only` output as a count — `wc -l` over the same text, no path list retained. */
export function countPaths(text) {
	return String(text)
		.split("\n")
		.filter((line) => line !== "").length;
}

/**
 * `git diff --numstat … -- src`, summed: added + deleted, and 0 for an untouched surface. A binary
 * file's `-` is not a line count, so it contributes nothing rather than making the sum NaN — and an
 * empty diff is `0`, never an empty value.
 */
export function sumNumstat(text) {
	let total = 0;
	for (const line of String(text).split("\n")) {
		if (line.trim() === "") continue;
		const [added, deleted] = line.split("\t");
		total += (Number(added) || 0) + (Number(deleted) || 0);
	}
	return total;
}

/**
 * The repo side of every key, as one plain object — the single seam the tests replace (no git, no `gh`,
 * no report on disk). `report` is resolved lazily, so a usage fault never pays for a directory scan.
 *
 * `suite(expectHead)` takes the head the numbers must describe: the report is the evidence for THIS
 * tree, so the scanner's provenance disambiguator is that head (#513). A stub that ignores the
 * argument still works, which is what keeps the seam cheap.
 */
export function createEvidenceProbe(root, { report = "", reportDir = "" } = {}) {
	return {
		root,
		resolveHead: (ref) => gitOrThrow(root, ["rev-parse", "--verify", `${ref}^{commit}`], ref).trim(),
		changedFiles: (base, head) => countPaths(gitOrThrow(root, ["diff", "--name-only", `${base}...${head}`], `${base}...${head}`)),
		srcDiffLines: (base, head) =>
			sumNumstat(gitOrThrow(root, ["diff", "--numstat", `${base}...${head}`, "--", "src"], `${base}...${head} -- src`)),
		suite: (expectHead = "") => {
			const found = resolveReport({ report, dir: reportDir, expectHead });
			return { files: found.files, tests: found.tests, path: found.path, label: found.label };
		},
		// Every surface the guard measures, by name: the ratio a block states IS that guard's number.
		budget: () => {
			const ratios = {};
			for (const surface of SURFACES) ratios[surface.name] = measureSurface(surface, root).ratio;
			return { src: ratios.src, scripts: ratios.scripts };
		},
		prView: (pr) => {
			const raw = ghOrThrow(root, ["pr", "view", String(pr), "--json", "headRefOid,body"], `gh pr view ${pr}`);
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch (error) {
				throw new InputError(`gh pr view ${pr}: output is not JSON (${describeError(error)})`);
			}
			if (typeof parsed?.body !== "string" || typeof parsed?.headRefOid !== "string") {
				throw new InputError(`gh pr view ${pr}: expected headRefOid and body`);
			}
			return { head: parsed.headRefOid, body: parsed.body };
		},
		// The body goes in on stdin: it is never an argv element and never a temp file to leak.
		prEdit: (pr, body) => {
			ghOrThrow(root, ["pr", "edit", String(pr), "--body-file", "-"], `gh pr edit ${pr}`, body);
		},
	};
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const MODE_FLAGS = new Map([
	["--emit", "emit"],
	["--check", "check"],
	["--apply", "apply"],
]);
const VALUE_FLAGS = new Map([
	["--base", "base"],
	["--head", "head"],
	["--body", "body"],
	["--pr", "pr"],
	["--report", "report"],
	["--report-dir", "reportDir"],
]);

/** `{ ok: true, options }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	const options = { mode: "", base: "", head: "", body: "", pr: "", report: "", reportDir: "", json: false };
	const modes = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--json") {
			options.json = true;
			continue;
		}
		const mode = MODE_FLAGS.get(argument);
		if (mode !== undefined) {
			modes.push(mode);
			continue;
		}
		const key = VALUE_FLAGS.get(argument);
		if (key === undefined) {
			return { ok: false, message: argument.startsWith("--") ? `unknown flag: ${argument}` : `unexpected argument: ${argument}` };
		}
		const value = argv[index + 1];
		if (value === undefined || value === "" || value.startsWith("--")) return { ok: false, message: `${argument} needs a value` };
		options[key] = value;
		index += 1;
	}
	if (modes.length !== 1) {
		return { ok: false, message: modes.length === 0 ? "one of --emit, --check, --apply is required" : "one mode at a time" };
	}
	options.mode = modes[0];
	if (options.pr !== "" && !/^\d+$/.test(options.pr)) return { ok: false, message: `--pr needs a PR number, got "${options.pr}"` };
	if (options.mode === "emit" && (options.body !== "" || options.pr !== "")) {
		return { ok: false, message: "--emit takes no --body/--pr: it prints the block for this tree" };
	}
	if (options.mode === "check") {
		if ((options.body === "") === (options.pr === "")) return { ok: false, message: "--check takes exactly one of --body <file> or --pr <n>" };
	}
	if (options.mode === "apply") {
		if (options.pr === "") return { ok: false, message: "--apply needs --pr <n>" };
		if (options.body !== "") return { ok: false, message: "--apply takes no --body: it rewrites the PR it names" };
	}
	if (options.mode !== "emit" && options.head !== "") {
		return { ok: false, message: "--head is --emit only: a body's head is the repo's HEAD, a PR's is its headRefOid" };
	}
	return { ok: true, options };
}

/** The measured evidence, plus the report path and label (provenance for stderr, never inside the block). */
function measure(probe, base, head) {
	const suite = probe.suite(head);
	return {
		reportPath: suite.path === undefined ? "" : suite.path,
		reportLabel: suite.label === undefined ? "" : suite.label,
		evidence: {
			head,
			changedFiles: probe.changedFiles(base, head),
			srcDiffLines: probe.srcDiffLines(base, head),
			suite: { files: suite.files, tests: suite.tests },
			budget: probe.budget(),
		},
	};
}

function describeFinding(finding) {
	const where = finding.line === undefined ? "" : ` (line ${finding.line})`;
	const text = finding.text === undefined ? "" : ` — ${finding.text}`;
	return `pr-evidence: ${finding.code}${where}: ${finding.detail}${text}`;
}

function runEmit(options, probe, out, err) {
	const base = options.base === "" ? DEFAULT_BASE : options.base;
	const headRef = options.head === "" ? "HEAD" : options.head;
	const head = probe.resolveHead(headRef);
	const { evidence, reportPath, reportLabel } = measure(probe, base, head);
	const block = renderBlock(evidence, { base, headRef });
	if (options.json) out(JSON.stringify({ ok: true, base, block, evidence }, null, 2));
	else out(block);
	if (reportPath !== "") err(`pr-evidence: suite/budget read from ${reportPath} (${reportLabel})`);
	return EXIT.OK;
}

/**
 * The PR (or file) being checked, and the head its numbers must describe. A PR whose head is not
 * checked out HERE cannot be checked: suite and budget are measured from the tree.
 */
function readSubject(options, probe) {
	if (options.pr === "") {
		const path = resolve(options.body);
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			throw new InputError(`cannot read ${path} (${describeError(error)})`);
		}
		return { head: probe.resolveHead("HEAD"), body: text };
	}
	const view = probe.prView(options.pr);
	const tree = probe.resolveHead("HEAD");
	if (!sameHead(view.head, tree)) {
		throw new InputError(
			`PR #${options.pr}'s head ${view.head} is not checked out here (HEAD is ${tree}) — suite and budget are measured from the tree`,
		);
	}
	return view;
}

function runCheck(options, probe, out, err) {
	const base = options.base === "" ? DEFAULT_BASE : options.base;
	const subject = readSubject(options, probe);
	const { evidence, reportPath, reportLabel } = measure(probe, base, subject.head);
	const verdict = checkBody(subject.body, evidence);
	if (reportPath !== "") err(`pr-evidence: suite/budget read from ${reportPath} (${reportLabel})`);
	if (options.json) {
		out(JSON.stringify({ ok: verdict.exit === EXIT.OK, exit: verdict.exit, blocks: verdict.blocks, findings: verdict.findings }, null, 2));
		err(`pr-evidence: ${SCOPE}`);
		return verdict.exit;
	}
	for (const finding of verdict.findings) out(describeFinding(finding));
	if (verdict.blocks === 0 && verdict.exit === EXIT.OK) out("pr-evidence: no block and no counts — nothing to attribute");
	else if (verdict.exit === EXIT.OK) out(`pr-evidence: clean — every key recomputed at ${subject.head}`);
	else out(`pr-evidence: ${verdict.findings.length} finding(s)`);
	out(`pr-evidence: ${SCOPE}`);
	return verdict.exit;
}

function runApply(options, probe, out, err) {
	const base = options.base === "" ? DEFAULT_BASE : options.base;
	const subject = readSubject(options, probe);
	const { evidence, reportPath, reportLabel } = measure(probe, base, subject.head);
	const block = renderBlock(evidence, { base, headRef: "HEAD" });
	probe.prEdit(options.pr, upsertBlock(subject.body, block));
	if (reportPath !== "") err(`pr-evidence: suite/budget read from ${reportPath} (${reportLabel})`);
	if (options.json) out(JSON.stringify({ ok: true, pr: Number(options.pr), head: subject.head, block }, null, 2));
	else out(block);
	return EXIT.OK;
}

/** Run one mode. Returns the exit code; `io.probe` replaces the repo side wholesale. */
export function main(argv = process.argv.slice(2), io = {}) {
	const out = io.out ?? console.log;
	const err = io.err ?? console.error;
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		err(`${USAGE}\n${parsed.message}`);
		return EXIT.USAGE;
	}
	const options = parsed.options;
	try {
		const probe = io.probe ?? createEvidenceProbe(ROOT, options);
		if (options.mode === "emit") return runEmit(options, probe, out, err);
		if (options.mode === "apply") return runApply(options, probe, out, err);
		return runCheck(options, probe, out, err);
	} catch (error) {
		if (error instanceof InputError) {
			err(`pr-evidence: ${describeError(error)}`);
			return EXIT.USAGE;
		}
		throw error;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
