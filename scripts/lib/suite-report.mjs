// Purpose: one definition of "a suite report that is evidence" — read it, DERIVE the count from it,
// refuse the shapes that only look like proof, and scan for it without ever selecting "newest"
// (issue #513).
//
// The defect this replaces: `readSuiteReport` trusted `numPassedTests`, so a report whose `testResults`
// were empty was accepted as a pass count, and `findNewestReport` listed one directory, so a report in a
// nested run directory was reported as "no report". Both gates (the handoff's suite claim and the PR
// body's `suite:` key) inherited both faults from the one module that defined them.
//
// THE COUNT IS DERIVED, NEVER QUOTED. `tests = Σ testResults[i].assertionResults.length`. Every
// top-level count vitest writes is a claim about the run, and a claim can be planted; the assertion
// results ARE the run. Measured ground truth on this repo (2842 tests): a green report has
// `numPassedTests === Σ`, a red run has `numPassedTests < Σ` — which is why the rule is
// "`numTotalTests` must equal Σ, and `numPassedTests` may not EXCEED it", not "numPassedTests must
// equal Σ". Equality on `numPassedTests` would refuse a legitimate red run, and the handoff is
// written right after a red run more often than anyone would like.
//
// REFUSALS ARE NAMED, and every one is a `ReportError` (an `InputError` with a `code`), so both CLIs
// answer with their existing "cannot check" exit (2) and never with a drift (1): a hollow report is not
// evidence that the claim is wrong, it is an input that cannot answer. The codes:
//
//   unreadable · not-json          the file is not readable / not JSON
//   empty-results                  `testResults` missing, not an array, or empty
//   hollow-report                  Σ assertion results is 0 — a pass count with nothing behind it
//   count-mismatch                 `numTotalTests` ≠ Σ, or `numPassedTests` > Σ
//   provenance-unreadable          a sidecar exists and cannot be read as `{head, dirty, capturedAt}`
//   provenance-mismatch            a caller expected a head and the sidecar names another
//   ambiguous-reports              several candidates, and nothing disambiguates them
//   no-provenance-match            several candidates, an expected head, and none whose sidecar matches
//   rejected-reports               candidates exist, every one was refused; the codes are in the message
//   no-report                      nothing to validate under the directory that was scanned
//   root-invalid                   the private root is absent/invalid, so there is no default directory
//
// PROVENANCE (1.3). `vitest --reporter=json` records no tree, so a report alone cannot say what it
// tested. The sidecar `<report>.provenance.json` carries `{head, dirty, capturedAt}`, written by
// `node scripts/suite-report.mjs --mark <report>`. Three rules, and they are the whole contract:
//   mismatch  REFUSED when the caller supplies an expected head (`provenance-mismatch`);
//   dirty     ACCEPTED, labelled `unattributed (dirty tree)` — the bytes were measured, the tree was not;
//   absent    ACCEPTED, labelled `provenance: absent`.
// Nothing here invents a producer beyond that command: `--capture` runs the suite and marks the result
// so the DEFAULT path always has provenance, and no other path pretends to.
//
// THE SCANNER (1.4) walks `dir` to depth ≤ 3, skips `node_modules` and sidecars, validates every
// candidate, and refuses to rank them: 0 valid → `null`; 1 valid → that one; ≥2 → a named error listing
// EVERY candidate path. An expected head is the only disambiguator (provenance), because "newest" is a
// preference, not evidence — the report that proves a claim is the one that tested the tree the claim
// describes.
//
// LIMITS, stated rather than implied: a report mutated between validation and use (the reader returns a
// snapshot, and nothing re-reads it); `assertionResults` counts assertions, so a `test.each` row is one
// result and the derivation follows vitest's own JSON shape rather than any other runner's; and the
// scanner's depth bound means a report deeper than three directories below the named root is invisible
// — it is refused as "no report", never guessed at.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { InputError, sameRevision } from "./handoff-claims.mjs";
import { defaultRoot, validateRoot } from "./scratch-root.mjs";

/** Named refusal codes. One spelling, so the CLIs, the docs and the tests cannot disagree. */
export const CODES = Object.freeze({
	UNREADABLE: "unreadable",
	NOT_JSON: "not-json",
	EMPTY_RESULTS: "empty-results",
	HOLLOW_REPORT: "hollow-report",
	COUNT_MISMATCH: "count-mismatch",
	PROVENANCE_UNREADABLE: "provenance-unreadable",
	PROVENANCE_MISMATCH: "provenance-mismatch",
	AMBIGUOUS: "ambiguous-reports",
	NO_PROVENANCE_MATCH: "no-provenance-match",
	REJECTED: "rejected-reports",
	NO_REPORT: "no-report",
	ROOT_INVALID: "root-invalid",
	GIT_UNAVAILABLE: "git-unavailable",
	CAPTURE_FAILED: "capture-failed",
});

/** The sidecar's suffix — the one place a name is spelled, so the marker and the reader agree. */
export const PROVENANCE_SUFFIX = ".provenance.json";

/** The subdirectory of the private root that holds the reports — one spelling, both sides. */
export const REPORTS_DIR_NAME = "reports";

/**
 * How far below the named directory the scanner looks: a candidate's depth is the number of directories
 * between it and the named `dir`, so `dir/run/suite.json` is depth 1 and is found; depth 4 is invisible.
 */
export const MAX_DEPTH = 3;

/** The directory names the scanner never descends into. */
export const SKIP_DIRS = Object.freeze(["node_modules"]);

/** The labels the provenance rules print — the words a verdict line carries, in one place. */
export const LABELS = Object.freeze({
	ABSENT: "provenance: absent",
	DIRTY: "unattributed (dirty tree)",
});

/**
 * A refused report. Extends `InputError` so every existing `catch (error instanceof InputError)` in the
 * two CLIs keeps answering "cannot check" (exit 2) — the code is the addition, not a new exit path.
 *
 * The code is part of the MESSAGE, not only the field: a refusal a caller cannot tell apart from another
 * refusal is the same defect one layer up, and every one of these messages is read by a human deciding
 * what to do next. Carrying it here also means no CLI has to remember to print it.
 */
export class ReportError extends InputError {
	constructor(code, message) {
		super(`${code}: ${message}`);
		this.name = "ReportError";
		this.code = code;
	}
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

function errno(error) {
	return typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : "";
}

// ---------------------------------------------------------------------------
// Provenance — the sidecar that says which tree the bytes describe
// ---------------------------------------------------------------------------

/**
 * The provenance beside a report: `{ path, provenance }` where `provenance` is
 * `{ head, dirty, capturedAt }` or `null` when no sidecar exists. A sidecar that exists but is not that
 * shape is a refusal, not an absence: an unreadable claim about the tested tree is exactly the thing
 * this record exists to make checkable.
 */
export function readProvenance(reportPath) {
	const path = `${reportPath}${PROVENANCE_SUFFIX}`;
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (errno(error) === "ENOENT") return { path, provenance: null };
		throw new ReportError(CODES.PROVENANCE_UNREADABLE, `${path}: cannot read the provenance sidecar (${describe(error)})`);
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new ReportError(CODES.PROVENANCE_UNREADABLE, `${path}: not JSON (${describe(error)})`);
	}
	if (typeof parsed !== "object" || parsed === null || typeof parsed.head !== "string" || parsed.head === "") {
		throw new ReportError(CODES.PROVENANCE_UNREADABLE, `${path}: expected {"head": "<sha>", "dirty": <bool>, "capturedAt": "<iso>"}`);
	}
	return {
		path,
		provenance: {
			head: parsed.head.toLowerCase(),
			dirty: parsed.dirty === true,
			capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : null,
		},
	};
}

/** The words a verdict line carries for a provenance — the label is stated, never implied. */
export function describeProvenance(provenance) {
	if (provenance === null || provenance === undefined) return LABELS.ABSENT;
	if (provenance.dirty) return LABELS.DIRTY;
	return `head ${provenance.head}`;
}

/** The sidecar's bytes, one object, newline-terminated — what `--mark` writes and `readProvenance` reads. */
export function provenanceRecord(record) {
	return `${JSON.stringify(record, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Reading — derive the count, then refuse the shapes that are not evidence
// ---------------------------------------------------------------------------

/**
 * Throws the first refusal a report earns. Order matters for the message a human reads: an empty
 * result set explains a zero count, so it is named first; the count rules then speak about a report
 * that at least has results in it.
 */
function validate(results, report, path) {
	if (!Array.isArray(report?.testResults) || report.testResults.length === 0) {
		throw new ReportError(
			CODES.EMPTY_RESULTS,
			`${path}: no testResults — is this vitest's json reporter output? A report with no results proves nothing`,
		);
	}
	const tests = results.reduce((total, file) => total + (Array.isArray(file?.assertionResults) ? file.assertionResults.length : 0), 0);
	if (tests === 0) {
		throw new ReportError(
			CODES.HOLLOW_REPORT,
			`${path}: ${results.length} result file(s) and 0 assertion results — ${
				typeof report.numPassedTests === "number" ? `a stated pass count of ${report.numPassedTests} with nothing behind it` : "an empty run"
			} is not evidence of a suite`,
		);
	}
	if (typeof report.numTotalTests === "number" && report.numTotalTests !== tests) {
		throw new ReportError(
			CODES.COUNT_MISMATCH,
			`${path}: numTotalTests ${report.numTotalTests} ≠ ${tests} assertion results — the report contradicts itself`,
		);
	}
	if (typeof report.numPassedTests === "number" && report.numPassedTests > tests) {
		throw new ReportError(
			CODES.COUNT_MISMATCH,
			`${path}: numPassedTests ${report.numPassedTests} > ${tests} assertion results — a pass count larger than the run it describes`,
		);
	}
	return tests;
}

/**
 * A validated report: `{ path, files, tests, provenance, label }`.
 *
 * `files` is the number of test files vitest reported, `tests` is DERIVED (never `numPassedTests`), and
 * `label` is the provenance phrase a verdict line prints. With `expectHead`, a sidecar naming another
 * commit is refused `provenance-mismatch`; absent provenance is accepted and labelled.
 */
export function readSuiteReport(path, { expectHead = "" } = {}) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new ReportError(CODES.UNREADABLE, `${path}: cannot read the vitest JSON report (${describe(error)})`);
	}
	let report;
	try {
		report = JSON.parse(text);
	} catch (error) {
		throw new ReportError(CODES.NOT_JSON, `${path}: not JSON (${describe(error)})`);
	}
	const results = report?.testResults;
	const tests = validate(results, report, path);
	const { provenance } = readProvenance(path);
	if (expectHead !== "" && provenance !== null && !sameRevision(provenance.head, expectHead)) {
		throw new ReportError(
			CODES.PROVENANCE_MISMATCH,
			`${path}: captured at ${provenance.head}, and the expected head is ${expectHead} — a report of another tree is not evidence about this one`,
		);
	}
	return { path, files: results.length, tests, provenance, label: describeProvenance(provenance) };
}

// ---------------------------------------------------------------------------
// Scanning — depth-bounded, never ranked
// ---------------------------------------------------------------------------

/** Every `*.json` path below `dir` to `depth`, skipping sidecars and `node_modules`, sorted. */
export function collectReportCandidates(dir, { maxDepth = MAX_DEPTH } = {}) {
	const found = [];
	const walk = (current, depth) => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			// Unreadable or vanished: not a candidate directory, and not a fault of the report search.
			return;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				if (depth < maxDepth && !SKIP_DIRS.includes(entry.name)) walk(path, depth + 1);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(PROVENANCE_SUFFIX)) continue;
			found.push(path);
		}
	};
	walk(resolve(dir), 0);
	return found.sort();
}

/**
 * One candidate as a refusal names it: the path AND the tree it claims. `head <sha>` or `provenance:
 * absent` — never the label alone, because `unattributed (dirty tree)` says why the head is not trusted
 * without saying which head it is, and the whole point of naming a candidate is that the reader can pick one.
 */
function describeCandidate(candidate) {
	const { provenance } = candidate;
	if (provenance === null) return `${candidate.path} (${LABELS.ABSENT})`;
	if (provenance.dirty) return `${candidate.path} (head ${provenance.head}, ${LABELS.DIRTY})`;
	return `${candidate.path} (head ${provenance.head})`;
}

/**
 * The candidates under `dir`: `{ dir, report, candidates, rejected }`.
 *
 * `report` is `null` when no candidate validated — `rejected` then says why each one was refused, and
 * `resolveReport` turns that into a named refusal rather than a silent "no report". One valid candidate
 * is chosen; several are never ranked: with an expected head, exactly one matching sidecar wins, and
 * otherwise the error names every path (and every provenance) and stops.
 */
export function findReports(dir, { expectHead = "", maxDepth = MAX_DEPTH } = {}) {
	const files = collectReportCandidates(dir, { maxDepth });
	const candidates = [];
	const rejected = [];
	for (const path of files) {
		try {
			// Validated WITHOUT the expected head: the head is a disambiguator for the selection below,
			// and refusing a candidate here would hide it from the "none matching" message that has to
			// name it.
			candidates.push(readSuiteReport(path));
		} catch (error) {
			if (!(error instanceof ReportError)) throw error;
			rejected.push({ path, code: error.code, message: error.message });
		}
	}
	const summary = (list) => list.map(describeCandidate).join(", ");
	const ambiguous = (list) =>
		new ReportError(
			CODES.AMBIGUOUS,
			`${list.length} candidate reports under ${dir} — ${summary(list)}; nothing here ranks them, so pass --report <path> to name the one this claim is about`,
		);
	const chosen = (report) => ({ dir, report, candidates, rejected, error: null });
	const refused = (error) => ({ dir, report: null, candidates, rejected, error });
	if (candidates.length === 0) return chosen(null);
	if (expectHead === "") return candidates.length === 1 ? chosen(candidates[0]) : refused(ambiguous(candidates));
	const matching = candidates.filter((candidate) => candidate.provenance !== null && sameRevision(candidate.provenance.head, expectHead));
	if (matching.length === 1) return chosen(matching[0]);
	if (matching.length > 1) {
		// Several candidates for the SAME tree are a copy, not a tie: `--capture` writes one report per head
		// and never prunes, so only a hand-copied (or twice-marked) report produces this shape. Naming it as
		// a duplicate is what tells the reader which one to delete — auto-dedupe would silently pick one of
		// two files that may already disagree, and a disagreement between two reports of one head is a fact
		// the gate must not bury.
		return refused(
			new ReportError(
				CODES.AMBIGUOUS,
				`${matching.length} candidate reports under ${dir} claim the SAME head ${expectHead} — ${summary(matching)}; that is a duplicate copy, not a tie, so pass --report <path> to name the one this claim is about`,
			),
		);
	}
	// No sidecar matches the expected head. An absent provenance is accepted when it is the ONLY
	// candidate (a report nobody marked is still the only evidence there is); a mismatch never is.
	if (candidates.length === 1 && candidates[0].provenance === null) return chosen(candidates[0]);
	if (candidates.length === 1) {
		return refused(
			new ReportError(
				CODES.PROVENANCE_MISMATCH,
				`${candidates[0].path}: captured at ${candidates[0].provenance.head}, and the expected head is ${expectHead} — a report of another tree is not evidence about this one`,
			),
		);
	}
	return refused(
		new ReportError(
			CODES.NO_PROVENANCE_MATCH,
			`${candidates.length} candidate reports under ${dir} and none was captured at ${expectHead} — ${summary(candidates)}; pass --report <path> to name the one this claim is about`,
		),
	);
}

// ---------------------------------------------------------------------------
// Resolution — the one seam both gates call
// ---------------------------------------------------------------------------

/** The default directory: `<root>/reports`, the private root of #512. Never a system temp directory. */
export function reportsDir({ home = homedir() } = {}) {
	return join(defaultRoot({ home }), REPORTS_DIR_NAME);
}

/** The private root's refusal, as a report refusal — the default is unavailable, so `--report` is required. */
function requireRoot(root) {
	const verdict = validateRoot(root);
	if (verdict.ok) return verdict;
	throw new ReportError(
		CODES.ROOT_INVALID,
		`the private scratch root ${root} is unusable (${verdict.code}): ${verdict.message} — create it with \`node scripts/scratch-root.mjs init\` and capture with \`node scripts/suite-report.mjs --capture\`, or pass --report <path>`,
	);
}

/**
 * The report a claim is checked against: an explicit `report` path wins and is validated like any other
 * (a hollow file named on the command line is still hollow); otherwise `dir` (default `<root>/reports`)
 * is scanned. Both refusals come out as `ReportError`, so the callers keep their one "cannot check"
 * path. The root is validated only when it is the directory actually used — an explicit `--report`
 * needs no root at all.
 */
export function resolveReport({ report = "", dir = "", expectHead = "", root = defaultRoot() } = {}) {
	if (report !== "") return readSuiteReport(resolve(report), { expectHead });
	const target = dir !== "" ? resolve(dir) : reportsDir();
	if (dir === "") requireRoot(root);
	const found = findReports(target, { expectHead });
	if (found.error !== null) throw found.error;
	if (found.report !== null) return found.report;
	if (found.rejected.length > 0) {
		// `ReportError` carries the code INSIDE its message by contract (see the class), so the detail joins the
		// messages as they are: re-prefixing the code read `hollow-report: hollow-report: …` (#520).
		const detail = found.rejected.map((entry) => entry.message).join("; ");
		throw new ReportError(
			CODES.REJECTED,
			`${found.rejected.length} report(s) under ${target} are not evidence — ${detail}; capture one with \`node scripts/suite-report.mjs --capture\` or pass --report <path>`,
		);
	}
	throw new ReportError(
		CODES.NO_REPORT,
		`no vitest JSON report under ${target} — capture one with \`node scripts/suite-report.mjs --capture\`, or pass --report <path>`,
	);
}
