/**
 * Tests for `scripts/lib/suite-report.mjs` and its producer `scripts/suite-report.mjs` (issue #513).
 *
 * The defect these pin is an evidence defect, not a bug: the gates accepted a report that proved
 * nothing (`{numPassedTests: 9999, testResults: [{}]}`), and the scanner reported a nested
 * `root/run/suite.json` as "no report" because it listed one directory. So every case here is driven
 * through the public seam and asserts the CODE, not just the failure: a refusal a caller cannot tell
 * apart from a pass is the same defect one layer up.
 *
 * What the probes prove, and with what: a real private root (mode 0700 under the gitignored `.tmp/`,
 * because a root under `/tmp` is refused `ancestor-writable`/`tmpfs` — the refusal, not the property),
 * real files, and a real git repository for the provenance marker. `--capture` is driven with an
 * injected runner: this file does not run the suite from inside the suite.
 *
 * COVERAGE — what these probes do NOT cover, stated rather than implied:
 *  - a report MUTATED between validation and use. `readSuiteReport` returns a snapshot of the bytes it
 *    validated, and nothing re-reads the path afterwards; a writer that replaces the file in that window
 *    is out of reach of this module (the gates consume `{files, tests}` and never the file again);
 *  - non-Linux paths: the private root's `tmpfs` clause is Linux-only and its magic numbers are not
 *    portable, so a root that would be refused on Linux is accepted here when the mount type cannot be
 *    read. The suite runs on Linux in CI, and a skip prints why;
 *  - a `test.each` row that vitest reports as one assertion (the derivation follows vitest's own JSON
 *    shape; another runner's report is simply not a suite report and is refused `empty-results`);
 *  - a real `tmpfs` root for a `--mark` refusal (#520): the refusal WORDING is driven through
 *    `markRefusal` with a `tmpfs` verdict, because whether this checkout's `.tmp` is on a `tmpfs` is a
 *    property of the host. The message shape is what the change is about; the mount is pinned in
 *    `scratch-root.test.ts`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	CODES,
	LABELS,
	MAX_DEPTH,
	REPORTS_DIR_NAME,
	ReportError,
	collectReportCandidates,
	describeProvenance,
	findReports,
	provenanceRecord,
	readProvenance,
	readSuiteReport,
	reportsDir,
	resolveReport,
} from "../lib/suite-report.mjs";
import { EXIT, captureReport, describeCapture, main, markRefusal, markReport, parseArgs, testedTree } from "../suite-report.mjs";

const REPO = process.cwd();
const FIXTURES = join(REPO, "scripts", "__tests__", "fixtures", "handoffs");
const REPORT = join(FIXTURES, "suite-report.json");

/**
 * Scratch roots live inside the checkout, NOT under `/tmp`: `/tmp` is `1777` (refused
 * `ancestor-writable`) and on Linux `tmpfs` (refused `tmpfs`) — the point of #512, and a test of the
 * refusal would prove nothing here.
 */
const BASE = join(REPO, ".tmp");
mkdirSync(BASE, { recursive: true });
const WORK = mkdtempSync(join(BASE, "suite-report-"));
let counter = 0;

afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
});

/** A valid private root (0700, ours) and its `reports/` directory. */
function rootWith(label = "root"): { root: string; reports: string } {
	const root = join(WORK, `${label}-${(counter += 1)}`);
	mkdirSync(root, { mode: 0o700 });
	const reports = join(root, REPORTS_DIR_NAME);
	mkdirSync(reports, { mode: 0o700 });
	return { root, reports };
}

/** `n` passed assertions, in one file — the only shape that makes a report evidence. */
function assertions(n: number, status = "passed"): { fullName: string; status: string }[] {
	return Array.from({ length: n }, (_unused, index) => ({ fullName: `t${index}`, status }));
}

/** A report file written from a body, plus its path. */
function writeReport(dir: string, name: string, body: unknown): string {
	const path = join(dir, name);
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
	return path;
}

/** A green report of `total` assertions in one file. */
function green(dir: string, name: string, total: number): string {
	return writeReport(dir, name, { numTotalTests: total, numPassedTests: total, testResults: [{ assertionResults: assertions(total) }] });
}

/** A sidecar beside `report`. */
function writeSidecar(report: string, record: Record<string, unknown>): string {
	const path = `${report}.provenance.json`;
	writeFileSync(path, JSON.stringify(record));
	return path;
}

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof ReportError ? error.code : `not-a-ReportError: ${String(error)}`;
	}
	return "no-refusal";
}

function messageOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "";
}

describe("suite-report — the count is derived, never quoted", () => {
	it("counts assertionResults, so a low numPassedTests cannot shrink the suite", () => {
		const { reports } = rootWith();
		// 12 assertions, a stated pass count of 7: a red run, and the derivation wins on the total.
		const path = writeReport(reports, "red.json", { numPassedTests: 7, testResults: [{ assertionResults: assertions(12) }] });
		expect(readSuiteReport(path)).toMatchObject({ path, files: 1, tests: 12 });
	});

	it("accepts a legitimate red run — 2840 passed, 2842 total", () => {
		const { reports } = rootWith();
		const path = writeReport(reports, "red.json", {
			numTotalTests: 2842,
			numPassedTests: 2840,
			numFailedTests: 2,
			testResults: [{ assertionResults: assertions(2840) }, { assertionResults: assertions(2, "failed") }],
		});
		expect(readSuiteReport(path)).toMatchObject({ files: 2, tests: 2842 });
	});

	it("refuses a hollow report — a pass count with nothing behind it", () => {
		const { reports } = rootWith();
		const path = writeReport(reports, "hollow.json", { numPassedTests: 9999, testResults: [{}] });
		expect(codeOf(() => readSuiteReport(path))).toBe(CODES.HOLLOW_REPORT);
		expect(messageOf(() => readSuiteReport(path))).toContain(path);
		expect(messageOf(() => readSuiteReport(path))).toContain("9999");
	});

	it("refuses a pass count larger than the run it describes", () => {
		const { reports } = rootWith();
		const path = writeReport(reports, "liar.json", { numPassedTests: 9999, testResults: [{ assertionResults: assertions(2) }] });
		expect(codeOf(() => readSuiteReport(path))).toBe(CODES.COUNT_MISMATCH);
		expect(messageOf(() => readSuiteReport(path))).toContain("9999 > 2");
	});

	it("refuses a report that contradicts itself on numTotalTests", () => {
		const { reports } = rootWith();
		const path = writeReport(reports, "torn.json", { numTotalTests: 40, numPassedTests: 3, testResults: [{ assertionResults: assertions(3) }] });
		expect(codeOf(() => readSuiteReport(path))).toBe(CODES.COUNT_MISMATCH);
		expect(messageOf(() => readSuiteReport(path))).toContain("numTotalTests 40");
	});

	it("names an empty result set, in all three shapes", () => {
		const { reports } = rootWith();
		const missing = writeReport(reports, "missing.json", { numPassedTests: 3 });
		const frozen = writeReport(reports, "frozen.json", { numPassedTests: 3, testResults: { 0: {} } });
		const empty = writeReport(reports, "empty.json", { testResults: [] });
		for (const path of [missing, frozen, empty]) expect(codeOf(() => readSuiteReport(path))).toBe(CODES.EMPTY_RESULTS);
	});

	it("names an unreadable file and a non-JSON file, never as a drift", () => {
		const { reports } = rootWith();
		expect(codeOf(() => readSuiteReport(join(reports, "nope.json")))).toBe(CODES.UNREADABLE);
		const garbage = writeReport(reports, "garbage.json", "{ not json");
		expect(codeOf(() => readSuiteReport(garbage))).toBe(CODES.NOT_JSON);
		expect(messageOf(() => readSuiteReport(garbage))).toContain("not JSON");
	});

	it("reads the repo's own fixture as 2 files / 12 tests", () => {
		expect(readSuiteReport(REPORT)).toMatchObject({ path: REPORT, files: 2, tests: 12 });
	});
});

describe("suite-report — provenance", () => {
	const HEAD = "8e7f6a5c4b3a2918171615141312111009080706";
	const OTHER = "4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90";

	it("accepts a matching sidecar and labels it with the head", () => {
		const { reports } = rootWith();
		const path = green(reports, "g.json", 3);
		writeSidecar(path, { head: HEAD, dirty: false, capturedAt: "2026-11-11T00:00:00.000Z" });
		const report = readSuiteReport(path, { expectHead: HEAD.slice(0, 7) });
		expect(report.provenance).toEqual({ head: HEAD, dirty: false, capturedAt: "2026-11-11T00:00:00.000Z" });
		expect(report.label).toBe(`head ${HEAD}`);
	});

	it("refuses a mismatched sidecar when a head is expected", () => {
		const { reports } = rootWith();
		const path = green(reports, "g.json", 3);
		writeSidecar(path, { head: OTHER, dirty: false, capturedAt: "2026-11-11T00:00:00.000Z" });
		expect(codeOf(() => readSuiteReport(path, { expectHead: HEAD }))).toBe(CODES.PROVENANCE_MISMATCH);
		// ... and without an expected head it is only a label, not a refusal.
		expect(readSuiteReport(path).label).toBe(`head ${OTHER}`);
	});

	it("accepts a dirty tree, labelled unattributed — the bytes were measured, the tree was not", () => {
		const { reports } = rootWith();
		const path = green(reports, "g.json", 3);
		writeSidecar(path, { head: HEAD, dirty: true, capturedAt: "2026-11-11T00:00:00.000Z" });
		const report = readSuiteReport(path, { expectHead: HEAD });
		expect(report.label).toBe(LABELS.DIRTY);
		expect(LABELS.DIRTY).toBe("unattributed (dirty tree)");
	});

	it("accepts an absent sidecar, labelled provenance: absent", () => {
		const { reports } = rootWith();
		const path = green(reports, "g.json", 3);
		const report = readSuiteReport(path, { expectHead: HEAD });
		expect(report.provenance).toBeNull();
		expect(report.label).toBe(LABELS.ABSENT);
		expect(describeProvenance(null)).toBe("provenance: absent");
	});

	it("refuses a sidecar that exists but is not a record — an unreadable claim is not an absence", () => {
		const { reports } = rootWith();
		const path = green(reports, "g.json", 3);
		writeFileSync(`${path}.provenance.json`, "{ not json");
		expect(codeOf(() => readProvenance(path))).toBe(CODES.PROVENANCE_UNREADABLE);
		writeFileSync(`${path}.provenance.json`, JSON.stringify({ dirty: false }));
		expect(codeOf(() => readProvenance(path))).toBe(CODES.PROVENANCE_UNREADABLE);
	});

	it("writes the record shape the reader expects", () => {
		const record = { head: HEAD, dirty: false, capturedAt: "2026-11-11T00:00:00.000Z" };
		expect(JSON.parse(provenanceRecord(record))).toEqual(record);
	});
});

describe("suite-report — the scanner walks, never ranks", () => {
	it("finds a report nested in a run directory (the shape that used to return null)", () => {
		const { reports } = rootWith();
		const run = join(reports, "run");
		mkdirSync(run, { mode: 0o700 });
		const path = green(run, "suite.json", 4);
		expect(findReports(reports).report?.path).toBe(path);
		expect(resolveReport({ dir: reports }).path).toBe(path);
	});

	it("walks to the depth bound and no further", () => {
		const { reports } = rootWith();
		const deep = join(reports, "a", "b", "c");
		mkdirSync(deep, { recursive: true, mode: 0o700 });
		const atBound = green(deep, "suite.json", 2);
		expect(collectReportCandidates(reports)).toContain(atBound);
		const beyond = join(deep, "d");
		mkdirSync(beyond, { mode: 0o700 });
		green(beyond, "suite.json", 2);
		expect(collectReportCandidates(reports)).toEqual([atBound]);
		expect(MAX_DEPTH).toBe(3);
	});

	it("skips node_modules and every provenance sidecar", () => {
		const { reports } = rootWith();
		const nested = join(reports, "node_modules", "pkg");
		mkdirSync(nested, { recursive: true, mode: 0o700 });
		green(nested, "suite.json", 2);
		const path = green(reports, "suite.json", 5);
		writeSidecar(path, { head: "8e7f6a5", dirty: false, capturedAt: "2026-11-11T00:00:00.000Z" });
		expect(collectReportCandidates(reports)).toEqual([path]);
	});

	it("refuses two candidates by naming both, and never prefers the older-but-valid one", () => {
		const { reports } = rootWith();
		const older = green(reports, "older.json", 12);
		const newer = green(reports, "newer.json", 3);
		const message = messageOf(() => resolveReport({ dir: reports }));
		expect(codeOf(() => resolveReport({ dir: reports }))).toBe(CODES.AMBIGUOUS);
		expect(message).toContain(older);
		expect(message).toContain(newer);
		expect(findReports(reports).report).toBeNull();
	});

	it("uses provenance as the disambiguator when an expected head is supplied", () => {
		const { reports } = rootWith();
		const expected = "8e7f6a5c4b3a2918171615141312111009080706";
		const mine = green(reports, "mine.json", 12);
		const theirs = green(reports, "theirs.json", 3);
		writeSidecar(mine, { head: expected, dirty: false, capturedAt: "2026-11-11T00:00:00.000Z" });
		writeSidecar(theirs, { head: "4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90", dirty: false, capturedAt: "2026-11-11T00:00:00.000Z" });
		expect(resolveReport({ dir: reports, expectHead: expected }).path).toBe(mine);
	});

	it("names the candidates and their provenance when no sidecar matches the expected head", () => {
		const { reports } = rootWith();
		const absent = green(reports, "absent.json", 12);
		const other = green(reports, "other.json", 3);
		writeSidecar(other, { head: "4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90", dirty: true, capturedAt: "2026-11-11T00:00:00.000Z" });
		const message = messageOf(() => resolveReport({ dir: reports, expectHead: "8e7f6a5c4b3a2918171615141312111009080706" }));
		expect(codeOf(() => resolveReport({ dir: reports, expectHead: "8e7f6a5c4b3a2918171615141312111009080706" }))).toBe(
			CODES.NO_PROVENANCE_MATCH,
		);
		expect(message).toContain(absent);
		expect(message).toContain(LABELS.ABSENT);
		expect(message).toContain(other);
		expect(message).toContain(LABELS.DIRTY);
		// #520: the details name each candidate's HEAD, or `absent` — a dirty report's label says why the head
		// is not trusted without saying which head it is, and a reader choosing by hand needs both.
		expect(message).toContain("head 4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90, " + LABELS.DIRTY);
	});

	it("degrades to the one unmarked candidate, labelled provenance: absent (#520)", () => {
		const { reports } = rootWith();
		const sole = green(reports, "sole.json", 5);
		const resolved = resolveReport({ dir: reports, expectHead: "8e7f6a5c4b3a2918171615141312111009080706" });
		expect(resolved.path).toBe(sole);
		expect(resolved.label).toBe(LABELS.ABSENT);
	});

	it("names two reports of the SAME head as a duplicate copy, never as a tie (#520)", () => {
		const { reports } = rootWith();
		const head = "8e7f6a5c4b3a2918171615141312111009080706";
		// The shape is a hand-copied report: `--capture` writes one file per head and never prunes.
		const canonical = green(reports, `${head}.json`, 12);
		const copy = green(reports, "copy.json", 12);
		for (const path of [canonical, copy]) writeSidecar(path, { head, dirty: false, capturedAt: "2026-11-11T00:00:00.000Z" });
		const message = messageOf(() => resolveReport({ dir: reports, expectHead: head.slice(0, 7) }));
		expect(codeOf(() => resolveReport({ dir: reports, expectHead: head }))).toBe(CODES.AMBIGUOUS);
		expect(message).toContain("SAME head");
		expect(message).toContain("duplicate copy");
		expect(message).toContain(canonical);
		expect(message).toContain(copy);
		// Nothing dedupes them: two files that may already disagree are not a decision this module makes.
		expect(findReports(reports, { expectHead: head }).report).toBeNull();
	});
});

describe("suite-report — resolution: the one seam both gates call", () => {
	it("refuses a hollow report named on the command line, and one found by the scanner", () => {
		const { reports } = rootWith();
		const hollow = writeReport(reports, "hollow.json", { numPassedTests: 9999, testResults: [{}] });
		// explicit: the code is the report's own
		expect(codeOf(() => resolveReport({ report: hollow }))).toBe(CODES.HOLLOW_REPORT);
		// scanned: every candidate was refused, and the message carries each path and code
		const message = messageOf(() => resolveReport({ dir: reports }));
		expect(codeOf(() => resolveReport({ dir: reports }))).toBe(CODES.REJECTED);
		expect(message).toContain(hollow);
		expect(message).toContain(CODES.HOLLOW_REPORT);
		// The code is inside `ReportError.message` already, so the detail must not prefix it again (#520):
		// `hollow-report: hollow-report: …` was the doubled shape.
		expect(message.split(CODES.HOLLOW_REPORT).length - 1).toBe(1);
	});

	it("prefers an explicit --report over the directory, and validates it the same way", () => {
		const { reports } = rootWith();
		green(reports, "suite.json", 12);
		const injected = green(reports, "injected.json", 3);
		expect(resolveReport({ report: injected, dir: reports }).tests).toBe(3);
	});

	it("says there is no report rather than pretending an empty scan is a pass", () => {
		const { reports } = rootWith();
		expect(codeOf(() => resolveReport({ dir: reports }))).toBe(CODES.NO_REPORT);
		expect(codeOf(() => resolveReport({ dir: join(reports, "absent") }))).toBe(CODES.NO_REPORT);
	});

	it("refuses an unusable private root and requires --report, never falling back to a temp directory", () => {
		// /tmp is 1777 and (on Linux) tmpfs: the default root there can never be valid.
		const message = messageOf(() => resolveReport({ root: "/tmp" }));
		expect(codeOf(() => resolveReport({ root: "/tmp" }))).toBe(CODES.ROOT_INVALID);
		expect(message).toMatch(/ancestor-writable|tmpfs|too-shallow/);
		expect(message).toContain("--report");
		// An explicit report needs no root at all — that is the documented escape.
		const { reports } = rootWith();
		const pinned = green(reports, "pinned.json", 2);
		expect(resolveReport({ report: pinned, root: "/tmp" }).tests).toBe(2);
	});

	it("resolves the default directory under the private root, not a system temp directory", () => {
		expect(reportsDir().endsWith(join(".cache", "brl-subagent", "reports"))).toBe(true);
		expect(reportsDir({ home: "/home/someone" })).toBe("/home/someone/.cache/brl-subagent/reports");
	});
});

describe("suite-report — the producer: --mark and --capture", () => {
	/** A real git repository, one commit, so `testedTree` reads something that exists. */
	function gitRepo(label: string): string {
		const dir = join(WORK, `${label}-${(counter += 1)}`);
		mkdirSync(dir, { mode: 0o700 });
		const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
		git("init", "-q", "-b", "dev");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		writeFileSync(join(dir, "a.txt"), "a\n");
		git("add", ".");
		git("commit", "-qm", "first");
		return dir;
	}

	it("marks a report with the tested head and the dirty flag, from real git", () => {
		const { root, reports } = rootWith("mark");
		const repo = gitRepo("repo");
		const path = green(reports, "g.json", 3);
		const head = String(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout).trim();
		const marked = markReport(path, { root, repo, now: () => "2026-11-11T00:00:00.000Z" });
		expect(marked.record).toEqual({ head, dirty: false, capturedAt: "2026-11-11T00:00:00.000Z" });
		// The report returned is the one that landed: its label is the sidecar just written, not the
		// `provenance: absent` the file carried before this call.
		expect(marked.report.label).toBe(`head ${head}`);
		expect(marked.report.provenance).toEqual(marked.record);
		expect(JSON.parse(readFileSync(marked.sidecar, "utf8"))).toEqual(marked.record);
		expect(readProvenance(path).provenance?.head).toBe(head);

		// One uncommitted line is enough: the tree that was measured is no longer a commit.
		writeFileSync(join(repo, "b.txt"), "b\n");
		const dirty = markReport(path, { root, repo });
		expect(dirty.record.dirty).toBe(true);
		expect(readSuiteReport(path).label).toBe(LABELS.DIRTY);
	});

	it("refuses to mark a report outside the private root, and never invents a tree", () => {
		const { root } = rootWith("mark-out");
		const outside = mkdtempSync(join(BASE, "outside-"));
		const path = green(outside, "g.json", 3);
		expect(codeOf(() => markReport(path, { root, repo: REPO }))).toMatch(/outside-root|not-directory/);
		expect(codeOf(() => markReport(path, { root, repo: join(WORK, "no-such-repo") }))).toBe(CODES.GIT_UNAVAILABLE);
	});

	/**
	 * #520 — the constraint is one policy, and every branch of it has to name what failed and the fix. The
	 * containment template fits `outside-root` (where the report really is not inside the root) and reads
	 * `<root> is not a directory inside <root>` when the ROOT is the thing at fault — true, self-referential,
	 * and silent about the mode or the filesystem. The fix sentence is the same in every branch.
	 */
	it("names what failed and the fix, never '<root> is not a directory inside <root>' (#520)", () => {
		const { root, reports } = rootWith("mark-mode");
		const repo = gitRepo("mark-mode-repo");
		const path = green(reports, "g.json", 3);
		chmodSync(root, 0o755);
		const modeRefusal = messageOf(() => markReport(path, { root, repo }));
		expect(modeRefusal).toContain("root-mode");
		expect(modeRefusal).toContain("cannot mark a report in");
		expect(modeRefusal).not.toContain(`is not a directory inside ${root}`);
		expect(modeRefusal).toContain("--root <valid root>");
		// Containment keeps the containment wording: that shape IS the statement being made.
		const outside = mkdtempSync(join(BASE, "mark-outside-"));
		const stray = green(outside, "g.json", 3);
		const contained = messageOf(() => markReport(stray, { root, repo }));
		expect(contained).toContain(`is not a directory inside ${root}`);
		chmodSync(root, 0o700);
		// The tmpfs branch says what failed too — driven directly, because a tmpfs root cannot be relied on
		// here (this checkout's `.tmp` is on the repo's filesystem, and CI's is not guaranteed to be anything).
		const onTmpfs = markRefusal("/tmp/r", { root: "/tmp/r", code: "tmpfs", message: "/tmp/r is on a tmpfs" });
		expect(onTmpfs).toContain("cannot mark a report in");
		expect(onTmpfs).not.toContain("is not a directory inside");
	});

	it("leaves the report and its sidecar in one mode, 0600 (#520)", () => {
		const { root, reports } = rootWith("mark-mode-bits");
		const repo = gitRepo("mark-bits-repo");
		const path = green(reports, "g.json", 3);
		expect(statSync(path).mode & 0o777).toBe(0o644); // what a writer outside this tool leaves behind
		const marked = markReport(path, { root, repo, now: () => "2026-11-11T00:00:00.000Z" });
		expect(statSync(marked.path).mode & 0o777).toBe(0o600);
		expect(statSync(marked.sidecar).mode & 0o777).toBe(0o600);
	});

	it("captures into <root>/reports/<head>.json and marks it in one command", () => {
		const { root } = rootWith("capture");
		const repo = gitRepo("capture-repo");
		const head = String(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout).trim();
		const calls: string[][] = [];
		const result = captureReport({
			root,
			repo,
			label: "unit",
			now: () => "2026-11-11T00:00:00.000Z",
			run: (command: string, args: string[]) => {
				calls.push([command, ...args]);
				const target = args.find((arg) => arg.startsWith("--outputFile="));
				if (target !== undefined) writeFileSync(target.slice("--outputFile=".length), readFileSync(REPORT, "utf8"));
				return { status: 0, stdout: "", stderr: "" };
			},
		});
		expect(calls[0]).toEqual(["npx", "vitest", "run", "--reporter=json", `--outputFile=${result.path}`]);
		expect(result.path).toBe(join(root, REPORTS_DIR_NAME, `${head}.json`));
		expect(result.report).toMatchObject({ files: 2, tests: 12 });
		expect(result.record.head).toBe(head);
		expect(describeCapture(result)).toContain("[unit]");
		expect(describeCapture(result)).toContain("12 tests in 2 files");
		// #520: the capture's report is 0600 like its sidecar — the mode travels with the file.
		expect(statSync(result.path).mode & 0o777).toBe(0o600);
		// The default path is a path the gate can then read with its provenance intact.
		expect(resolveReport({ dir: join(root, REPORTS_DIR_NAME), expectHead: head }).path).toBe(result.path);
	});

	it("accepts a red suite, because a red run is still a report", () => {
		const { root } = rootWith("capture-red");
		const repo = gitRepo("capture-red-repo");
		const result = captureReport({
			root,
			repo,
			run: (_command: string, args: string[]) => {
				const target = args.find((arg) => arg.startsWith("--outputFile="));
				if (target !== undefined) {
					writeFileSync(
						target.slice("--outputFile=".length),
						JSON.stringify({ numTotalTests: 3, numPassedTests: 2, numFailedTests: 1, testResults: [{ assertionResults: [...assertions(2), ...assertions(1, "failed")] }] }),
					);
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		});
		expect(result.suiteExit).toBe(1);
		expect(result.report.tests).toBe(3);
		expect(describeCapture(result)).toContain("a red run is still a report");
	});

	it("refuses a capture whose suite wrote no report at all", () => {
		const { root } = rootWith("capture-blank");
		const repo = gitRepo("capture-blank-repo");
		expect(
			codeOf(() =>
				captureReport({ root, repo, run: () => ({ status: 0, stdout: "", stderr: "" }) }),
			),
		).toBe(CODES.UNREADABLE);
	});

	it("parses the documented flags, and refuses the shapes a marker cannot have", () => {
		expect(parseArgs(["--mark", "r.json"]).options).toMatchObject({ command: "mark", report: "r.json" });
		expect(parseArgs(["--capture", "--label", "dev", "--", "--bail"]).options).toMatchObject({ command: "capture", label: "dev", extra: ["--bail"] });
		expect(parseArgs([]).ok).toBe(false);
		expect(parseArgs(["--capture", "--mark", "r.json"]).ok).toBe(false);
		expect(parseArgs(["--mark"]).ok).toBe(false);
		expect(parseArgs(["--capture", "extra"]).ok).toBe(false);
		expect(parseArgs(["--frobnicate"]).ok).toBe(false);
	});

	it("exits 0 on a mark and 2 on a usage fault — 1 is reserved for a named refusal", () => {
		const { root, reports } = rootWith("cli");
		const repo = gitRepo("cli-repo");
		const path = green(reports, "g.json", 3);
		const run = (argv: string[]) => {
			const out: string[] = [];
			const err: string[] = [];
			const code = main(argv, { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line), mark: (target: string) => markReport(target, { root, repo }) });
			return { code, out: out.join("\n"), err: err.join("\n") };
		};
		const marked = run(["--mark", path]);
		expect(marked.code).toBe(EXIT.OK);
		expect(marked.out).toContain("marked");
		expect(readProvenance(path).provenance?.head).toBe(testedTree(repo).head);

		const usage = run([]);
		expect(usage.code).toBe(EXIT.USAGE);
		expect(usage.err).toContain("usage: suite-report.mjs");

		// A refusal is 1, and it names the code: a hollow report cannot be marked as evidence.
		const hollow = writeReport(reports, "hollow.json", { numPassedTests: 9, testResults: [{}] });
		const refused = run(["--mark", hollow]);
		expect(refused.code).toBe(EXIT.REFUSED);
		expect(refused.err).toContain(CODES.HOLLOW_REPORT);
	});
});
