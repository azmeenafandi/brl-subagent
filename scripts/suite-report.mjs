#!/usr/bin/env node
// Purpose: the suite report's producer and marker — `--capture` runs the suite into the private root,
// `--mark` records which tree the bytes describe (issue #513).
//
// Why a producer exists at all: `vitest --reporter=json` records no commit, no dirty flag, no tree. A
// report is therefore evidence about *some* run, and the gate that reads it cannot tell whether that run
// was this tree. #513's rule is that provenance must have a producer and must be optional — requiring a
// sidecar unconditionally would break both gates the day the sidecar was introduced — so this file is
// the producer, and it is the only one. The reader (`scripts/lib/suite-report.mjs`) refuses a MISMATCH,
// accepts a dirty tree with the label `unattributed (dirty tree)`, and accepts an absent sidecar with
// the label `provenance: absent`.
//
//   node scripts/suite-report.mjs --capture [--label <text>] [--root <path>]
//   node scripts/suite-report.mjs --mark <report>            [--root <path>]
//
// `--capture` is a convenience, and the ONE command that makes the default path carry provenance: it
// runs `npx vitest run --reporter=json --outputFile=<root>/reports/<head>.json` and then marks it, so a
// capture never lands somewhere the gate has to guess about. Nothing else depends on it — `--mark`
// on a report captured by hand is the same operation, and the gate reads whatever the two produce.
//
// `--label` is a HUMAN annotation for the capture line only. It is deliberately not written into the
// sidecar: the sidecar is `{head, dirty, capturedAt}` — a statement about the tested TREE — and a run
// label is a statement about the run. Two kinds of claim in one record is how a record starts lying.
//
// THE ROOT IS NOT A FALLBACK. Both modes go through `scripts/lib/scratch-root.mjs`: the root must pass
// the #512 predicate (0700, ours, no writable ancestor, and not `tmpfs` on Linux), and the report and
// its sidecar are written inside it. A refusal names the code; there is no path here that writes to a
// system temp directory.
//
// Exit: 0 ok · 1 a named refusal (the code is in the message) · 2 usage.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InputError } from "./lib/handoff-claims.mjs";
import { atomicReplace, defaultRoot, ensureDir, ensureRoot, validateDir } from "./lib/scratch-root.mjs";
import { CODES, PROVENANCE_SUFFIX, REPORTS_DIR_NAME, ReportError, provenanceRecord, readSuiteReport } from "./lib/suite-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — `git` runs here, never in a hard-coded cockpit path. */
export const ROOT = join(HERE, "..");

export const EXIT = Object.freeze({ OK: 0, REFUSED: 1, USAGE: 2 });

export const USAGE = `usage: suite-report.mjs --capture [--label <text>] [--root <path>] [-- <vitest args>]
       suite-report.mjs --mark <report> [--root <path>]

  --capture   run the suite into <root>/reports/<head>.json and mark it
  --mark      write <report>${PROVENANCE_SUFFIX} = {head, dirty, capturedAt}

  <root> defaults to ~/.cache/brl-subagent (the private root, mode 0700).
  exit 0 ok · 1 a named refusal · 2 usage`;

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/** `{ ok: true, options }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	const options = { command: "", report: "", root: defaultRoot(), label: "", extra: [] };
	const positional = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--") {
			options.extra = argv.slice(index + 1);
			break;
		}
		if (argument === "--capture" || argument === "--mark") {
			if (options.command !== "") return { ok: false, message: "one of --capture, --mark is required, and only one" };
			options.command = argument.slice(2);
			continue;
		}
		if (argument === "--root" || argument === "--label") {
			const value = argv[index + 1];
			if (value === undefined || value === "") return { ok: false, message: `${argument} needs a value` };
			options[argument.slice(2)] = value;
			index += 1;
			continue;
		}
		if (argument.startsWith("--")) return { ok: false, message: `unknown flag: ${argument}` };
		positional.push(argument);
	}
	if (options.command === "") return { ok: false, message: "one of --capture, --mark is required" };
	if (options.command === "mark") {
		if (positional.length !== 1) return { ok: false, message: "--mark takes exactly one report path" };
		options.report = positional[0];
	} else if (positional.length !== 0) {
		return { ok: false, message: `--capture takes no positional arguments (got ${positional.join(" ")})` };
	}
	return { ok: true, options };
}

// ---------------------------------------------------------------------------
// Git — the tested tree, from the checkout
// ---------------------------------------------------------------------------

const git = (repo, args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

/** `{ head, dirty }` from one checkout. A git that cannot answer is a refusal, never a guessed tree. */
export function testedTree(repo, { run = git } = {}) {
	const head = run(repo, ["rev-parse", "HEAD"]);
	if (head.error || head.status !== 0) {
		throw new ReportError(
			CODES.GIT_UNAVAILABLE,
			`cannot resolve HEAD in ${repo} (${(head.stderr ?? "").trim().split("\n")[0] || describe(head.error)}) — provenance needs the tested commit, and an unrecorded tree is not a guess this tool makes`,
		);
	}
	const status = run(repo, ["status", "--porcelain"]);
	if (status.error || status.status !== 0) {
		throw new ReportError(CODES.GIT_UNAVAILABLE, `cannot read the working tree of ${repo} — the dirty flag is part of the record`);
	}
	return { head: String(head.stdout).trim(), dirty: String(status.stdout).trim() !== "" };
}

// ---------------------------------------------------------------------------
// The two operations
// ---------------------------------------------------------------------------

/**
 * Write the provenance sidecar beside `reportPath`: `{head, dirty, capturedAt}`, atomically, inside the
 * private root. The report is validated first — a sidecar is a claim that these bytes came from this
 * tree, and a file that is not a report has nothing to claim. Returns the record it wrote.
 */
export function markReport(reportPath, options = {}) {
	const { root = defaultRoot(), repo = ROOT, now = () => new Date().toISOString(), run } = options;
	const path = resolve(reportPath);
	const report = readSuiteReport(path);
	const tree = testedTree(repo, run === undefined ? {} : { run });
	const record = { head: tree.head, dirty: tree.dirty, capturedAt: now() };
	const ensured = validateDir(dirname(path), { root });
	if (!ensured.ok) {
		throw new ReportError(
			ensured.code,
			`${dirname(path)} is not a directory inside ${root} (${ensured.code}: ${ensured.message}) — a report and its sidecar live at or below the private root`,
		);
	}
	const written = atomicReplace(dirname(path), `${path}${PROVENANCE_SUFFIX}`, provenanceRecord(record), { root });
	if (!written.ok) throw new ReportError(written.code, written.message);
	// Re-read what landed instead of reusing the in-memory report: that object was read BEFORE the sidecar
	// existed, so its label says `provenance: absent` and the capture line would report a label the file on
	// disk does not carry. Reading it back is also what the gate will do, which is the claim being made.
	return { path, sidecar: written.path, record, report: readSuiteReport(path) };
}

/**
 * `npx vitest run --reporter=json --outputFile=<root>/reports/<head>.json`, then mark it. A RED suite is
 * not a capture failure: exit 1 with a written report is a legitimate report (it is what a `2840 of
 * 2842` run looks like), so the suite's exit status is reported and the file is validated on its own.
 */
export function captureReport(options = {}) {
	const {
		root = defaultRoot(),
		repo = ROOT,
		label = "",
		extra = [],
		now = () => new Date().toISOString(),
		run = (command, args, spawnOptions) => spawnSync(command, args, spawnOptions),
	} = options;
	const ensuredRoot = ensureRoot(root);
	if (!ensuredRoot.ok) throw new ReportError(ensuredRoot.code, ensuredRoot.message);
	const ensuredDir = ensureDir(join(root, REPORTS_DIR_NAME), { root });
	if (!ensuredDir.ok) throw new ReportError(ensuredDir.code, ensuredDir.message);
	const tree = testedTree(repo);
	const path = join(ensuredDir.dir, `${tree.head}.json`);
	const result = run("npx", ["vitest", "run", "--reporter=json", `--outputFile=${path}`, ...extra], { cwd: repo, encoding: "utf8" });
	if (result.error) throw new ReportError(CODES.CAPTURE_FAILED, `cannot run vitest (${describe(result.error)})`);
	const marked = markReport(path, { root, repo, now });
	return { path, sidecar: marked.sidecar, record: marked.record, report: marked.report, label, suiteExit: result.status ?? -1 };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** One human line: what was captured, where, and which tree it claims. Deterministic except the capture time. */
export function describeCapture(result) {
	const tests = `${result.report.tests} test${result.report.tests === 1 ? "" : "s"} in ${result.report.files} file${result.report.files === 1 ? "" : "s"}`;
	const label = result.label === "" ? "" : ` [${result.label}]`;
	const suite = result.suiteExit === 0 ? "exit 0" : `exit ${result.suiteExit} — a red run is still a report`;
	return `suite-report: captured ${tests}${label} → ${result.path} (${result.report.label}; suite ${suite})`;
}

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
		if (options.command === "mark") {
			const marked = io.mark === undefined ? markReport(options.report, { root: options.root }) : io.mark(options.report, { root: options.root });
			out(`suite-report: marked ${marked.path} → ${marked.sidecar} (${marked.report.label})`);
			return EXIT.OK;
		}
		const captured = io.capture === undefined ? captureReport({ root: options.root, label: options.label, extra: options.extra }) : io.capture(options);
		out(describeCapture(captured));
		return EXIT.OK;
	} catch (error) {
		if (error instanceof InputError) {
			// The message already starts with the code (see `ReportError`), so nothing is prefixed twice.
			err(`suite-report: ${describe(error)}`);
			return EXIT.REFUSED;
		}
		throw error;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
