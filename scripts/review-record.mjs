#!/usr/bin/env node
// Purpose: The review record's one tool — it WRITES the block `merge-guard.sh` parses, and CHECKS one.
//
// The record used to be hand-written prose, so its *shape* was authored by prose, and three units in a
// row reached the gate in a shape it could not read: S4 (#484) had no `jev-recheck:` line, S5 (#485)
// fused `Risk class:` and `jev-recheck:` onto one line, S6 (#486) was a findings bank with no
// `Verdict:`. The gate was correct and closed every time. This tool is the fix: the field rules live in
// `scripts/lib/record-fields.mjs` (one definition, used by both modes), the reviewer runs one command,
// and the block is emitted rather than transcribed.
//
// Write (#596):
//   node scripts/review-record.mjs --pr <n> --verdict approve|approve-with-nits|changes-requested \
//     --head <sha> --risk C1|C2|C3 --findings <path|-> [--log <absolute ledger>] \
//     [--conductor-verified "<text>"] [--out <path>] [--new-head]
//
//   The `jev-recheck:` line is not an argument any more. It is RESOLVED from the ledger's newest
//   `recheck-<pr>` row, because the line is a fact the classifier printed, not a string the conductor
//   carried into the review. The ledger path is explicit: `--log` > `JEV_PROVENANCE` >
//   `<cwd>/.pi/jev-lines.log`, a relative `--log` is exit 2, and nothing is discovered (no pointer
//   files, no repo-root probe) — a worktree without an override fails loudly and names `--log`.
//   Resolution reads with `parseProvenanceLog`, so a torn or malformed ledger is inherited
//   fail-closed (exit 2, the parser's own message) rather than read as "no rows"; the resolved ISO
//   and the ledger path go to stderr and the record's bytes do not change. The resolved line is
//   re-validated with the record's own shape and tier rules before it is rendered. `--recheck` is
//   gone (#596): passed by name it is refused with that sentence, because an alias would be a second
//   way to author the one field check (f) binds to the ledger.
//   refuses     a record that already covers the SAME head with a DIFFERENT resolved line (exit 1),
//               naming both lines and the prior record. One head carries one line: a second is a
//               contradiction, not an update. Recovery is deleting the record, or `--new-head` when
//               the head actually changed. There is no `--replace`: a free-text reason rendered into
//               the record is a field-injection surface (a newline forges `conductor-verified:` past
//               `verifyRendered`).
//
//   stdout IS the record; the same bytes are written to `--out`, whose default is the PRIVATE scratch
//   root — `~/.cache/brl-subagent/review-<n>/REVIEW_<n>.md` (#512) — so a reviewer pastes stdout or
//   hands over the file, and there is no second transcription to get wrong. The path is keyed to the
//   PR, not to the run: a second review of the same PR meets the same prior record, the same
//   prior-head refusal and the same supersede chain.
//
//   private     the default destination is a validated 0700 root (`scripts/lib/scratch-root.mjs`),
//               owned by us, with no group/other write on any ancestor — and, on Linux, refused
//               `tmpfs` when the filesystem is one, because a record there does not survive a
//               reboot. An explicit `--out` is still honoured: its directory must pass the ownership
//               and write-authority clauses — `/tmp` is refused `ancestor-writable`, and the message
//               names the default — because group/other write on a directory is rename authority over
//               the file in it, but a `tmpfs` destination is NOT refused. On Linux it is WARNED about:
//               one `review-record: warning:` line on stderr after a successful write, with stdout's
//               bytes and the exit code unchanged — an explicit destination is the caller's choice,
//               while the default root is ours to refuse. The ladder is: the default root refuses,
//               an explicit destination warns.
//               There is no temp-directory fallback: an invalid root is a refusal, not a relocation.
//   serialized  EVERY path that reads prior state and then writes the record takes
//               `<dir>/.REVIEW_<n>.md.lock` before the read (#512): the same-head rerun, the
//               `--new-head` supersede, and an explicit `--out`. The prior read happens INSIDE the
//               lock, so a delayed writer cannot erase a committed supersede — it queues behind it
//               and then reads what the newer writer left.
//   atomic      the record is written to a temp file in the same directory and renamed over the
//               target, so a reader sees the old complete record or the new one, never half of one,
//               and a symlink standing at the target is replaced rather than followed.
//   idempotent  identical inputs → byte-identical output. No timestamps, no clock, one case per
//               field; re-running the same command is a no-op on disk.
//   refuses     a record that already covers a DIFFERENT head (exit 1) — a retry must not silently
//               mint a newer record. `--new-head` supersedes it, keeping the old head on a
//               `Superseded head:` line so the review chain stays readable.
//   refuses     a declared `Risk class` weaker than the recheck's (exit 1): gate rule (f), caught
//               where it is cheap instead of at the merge point.
//   refuses     a findings body carrying its own line-start `Verdict:` / `Risk class:` /
//               `jev-recheck:` line (exit 1) — the gate would read the body, not the record.
//   refuses     a lock another writer holds (exit 1, `lock-held`) after a bounded poll, naming the
//               holder's pid, boot id and start time. A stale lock is never auto-removed.
//
// Lock recovery (a killed writer leaves its lock behind, and age cannot prove a writer dead):
//   node scripts/review-record.mjs --break-lock <record> [--yes]
//
//   prints the holder's evidence and exits 1. With `--yes` AND evidence of staleness (a different
//   boot id, a pid that is gone, or a pid now carrying a different start time) it unlinks the lock
//   and exits 0. A live holder is refused even with `--yes`: nothing here removes a lock by age.
//
// Check (what `.pi/skills/worktree/merge-guard.sh --check-record` runs — no network, no `gh`):
//   node scripts/review-record.mjs --check <record> [--pr <n>] [--head <sha>] [--log <abs path>] [--shape-only]
//
//   exit 0 every field rule holds · 1 a named reason failed · 2 usage or unreadable input. With
//   `--pr` the check also binds the record's `jev-recheck:` line to a `recheck-<pr>` row: the gate's
//   existential question, asked with `matchRow` (ANY row, not the newest, and no trimming — a
//   reformatted confidence is a different line). The ledger resolves exactly as the writer's does
//   (`--log`, else `JEV_PROVENANCE`, else `<cwd>/.pi/jev-lines.log`); `--log` without `--pr` is exit
//   2 because the label derives from the PR, and a missing ledger is exit 2 naming `--log` — 2 is
//   "cannot check", never "no match". `--shape-only` skips the row check and reproduces the pre-#596
//   output byte for byte. It reports `changes-requested` as well-formed but unmergeable: the merge
//   decision stays the full gate's, whose (a) CI needs the network. Reading is UNRESTRICTED by the
//   private root: an old `/tmp/REVIEW_<n>.md` record must still verify.
//
// Verify (#503: the record FILE is the unit of proof):
//   node scripts/review-record.mjs --verify <record> [--json]
//
//   stdout is ONE line a third party recomputes — the same field rules as `--check`, plus the file's
//   own sha256, so "I ran it" becomes a line with an artifact behind it:
//     record: ~/.cache/brl-subagent/review-412/REVIEW_412.md · verdict approve-with-nits · head <40-hex> · findings <n> · sha256 <64-hex>
//
//   exit 0 every field rule holds · 1 not a record the gate could read (named reasons on stderr; the
//   `--check` rules PLUS a head the line can print, 7-40 hex) · 2 usage, or a file that is not there
//   or not readable — the message names the RESOLVED path, which is the U2 failure caught in one line
//   instead of after a `/tmp` listing. `findings <n>` comes from `countFindings` — the one definition
//   on `parseRecord` — the one definition the gate's check rules share, never a second counter. `--json` prints
//   one object instead of the line (on every exit: a refusal and an unreadable file carry their
//   `reasons[]` there too).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	HEAD_RE,
	MERGEABLE_VERDICTS,
	checkHeadShape,
	checkRecord,
	parseRecord,
	recheckProblems,
	renderRecord,
	validateSpec,
	verifyRendered,
} from "./lib/record-fields.mjs";
import {
	StructuralError,
	describe,
	matchRow,
	parseProvenanceLog,
} from "./lib/provenance-ledger.mjs";
import {
	acquireLock,
	atomicReplace,
	breakLock,
	defaultRoot,
	ensureDir,
	ensureRoot,
	readRegular,
	recordPath,
	validateWriteDir,
} from "./lib/scratch-root.mjs";

export const USAGE =
	"usage: review-record.mjs --pr <n> --verdict <approve|approve-with-nits|changes-requested> " +
	"--head <sha> --risk <C1|C2|C3> --findings <path|-> [--log <absolute ledger>] " +
	'[--conductor-verified "<text>"] [--out <path>] [--new-head]';

export const CHECK_USAGE =
	"usage: review-record.mjs --check <record> [--pr <n>] [--head <sha>] [--log <absolute ledger>] [--shape-only]";

export const VERIFY_USAGE = "usage: review-record.mjs --verify <record> [--json]";

export const BREAK_USAGE = "usage: review-record.mjs --break-lock <record> [--yes]";

/** Exit codes, named so the docs and the tests cannot drift from the script. */
export const EXIT = Object.freeze({ WRITTEN: 0, REFUSED: 1, USAGE: 2 });

/** The value-taking flags of each mode, one map apiece — no second list to keep in sync. */
const WRITE_FLAGS = new Map([
	["--pr", "pr"],
	["--verdict", "verdict"],
	["--head", "head"],
	["--risk", "risk"],
	["--log", "log"],
	["--findings", "findings"],
	["--conductor-verified", "conductorVerified"],
	["--out", "out"],
]);
const CHECK_FLAGS = new Map([
	["--pr", "pr"],
	["--head", "head"],
	["--log", "log"],
]);

/** The default ledger, relative to the CALLER's cwd — the one place discovery would start, so it is
 *  stated once instead of probed (#596 decision 1: no pointer files, no repo-root probe). */
export const DEFAULT_LEDGER = ".pi/jev-lines.log";

/** A PR number is a positive integer: `0` has no `recheck-0` label and no record path. */
function validPrNumber(value) {
	return /^[0-9]+$/.test(String(value)) && Number(value) >= 1;
}

/** `{ ok: true, spec, newHead }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	const spec = {
		pr: "",
		verdict: "",
		head: "",
		risk: "",
		recheck: "",
		log: "",
		findings: "",
		conductorVerified: "",
		out: "",
	};
	let newHead = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--new-head") {
			newHead = true;
			continue;
		}
		// Named, not "unknown argument": a conductor carrying a line from an older dispatch needs to
		// read that the flag is GONE, and why, in the same breath (#596 decision 3).
		if (argument === "--recheck") {
			return {
				ok: false,
				message:
					"--recheck is gone (#596): the line is resolved from the ledger by --pr — print the row with " +
					"jev-check --classifier '<raw answers>' --label recheck-<pr>, then pass --log <absolute path> (or set JEV_PROVENANCE)",
			};
		}
		const key = WRITE_FLAGS.get(argument);
		if (key === undefined) return { ok: false, message: `unknown argument: ${argument}` };
		const value = argv[index + 1];
		if (value === undefined) return { ok: false, message: `${argument} needs a value` };
		spec[key] = value;
		index += 1;
	}
	if (spec.findings === "") {
		return { ok: false, message: "--findings <path|-> is required: the record states its findings or says it has none" };
	}
	// `spec.out === ""` means "the private default" — the path is resolved (and the root created and
	// validated) only once the invocation itself is well-formed, see `resolveDestination`.
	return { ok: true, spec, newHead };
}

/** `{ ok: true, file, pr, head, log, shapeOnly }` or `{ ok: false, message }` for `--check`. */
export function parseCheckArgs(argv) {
	const parsed = { file: "", pr: "", head: "", log: "", shapeOnly: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--shape-only") {
			parsed.shapeOnly = true;
			continue;
		}
		const key = CHECK_FLAGS.get(argument);
		if (key === undefined) {
			if (argument.startsWith("--")) return { ok: false, message: `unknown argument: ${argument}` };
			if (parsed.file !== "") return { ok: false, message: `unexpected argument: ${argument}` };
			parsed.file = argument;
			continue;
		}
		const value = argv[index + 1];
		if (value === undefined) return { ok: false, message: `${argument} needs a value` };
		parsed[key] = value;
		index += 1;
	}
	if (parsed.file === "") return { ok: false, message: "missing the record path" };
	if (parsed.pr !== "" && !validPrNumber(parsed.pr)) return { ok: false, message: "--pr must be a PR number" };
	if (parsed.head !== "" && !HEAD_RE.test(parsed.head)) {
		return { ok: false, message: `--head must be a commit sha, 7-40 hex chars (got "${parsed.head}")` };
	}
	// The label is `recheck-<pr>`: a ledger without a PR cannot ask the row question, and a PR without
	// a ledger is resolved from the environment or the cwd default, never from the record's path.
	if (parsed.log !== "" && parsed.pr === "") {
		return { ok: false, message: "--log needs --pr: the provenance row's label is recheck-<pr>, and --pr is what names it" };
	}
	if (parsed.log !== "" && !isAbsolute(parsed.log)) {
		return { ok: false, message: `--log must be an absolute path (got "${parsed.log}") — a relative ledger names nothing` };
	}
	return { ok: true, ...parsed };
}

/** Two heads name the same commit when they are equal, or one is a >=7-char prefix of the other. */
function sameCommit(left, right) {
	const a = String(left).toLowerCase();
	const b = String(right).toLowerCase();
	if (a === "" || b === "") return false;
	if (a === b) return true;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	return shorter.length >= 7 && longer.startsWith(shorter);
}

/** The head, the resolved recheck line and the supersede chain already on disk, or `null` when
 *  there is no record yet. The line is read for the same-head contradiction (#596): one head carries
 *  one line, so a differing line is a refusal — not a re-render. */
function readPrior(file, { root }) {
	const read = readRegular(file, { root });
	if (!read.ok) {
		if (read.code === "missing") return null;
		throw new Error(read.message);
	}
	const facts = parseRecord(read.bytes.toString("utf8"));
	return { head: facts.head, recheck: facts.recheck, supersededHeads: facts.supersededHeads };
}

/**
 * The ledger path — `--log` > `JEV_PROVENANCE` > `<cwd>/.pi/jev-lines.log`, and nothing else
 * (#596 decision 1). A RELATIVE override is a usage error in both places: a path that means "next to
 * wherever this ran" is the discovery U2 removes, and guessing the cwd is how a review binds the
 * wrong ledger. No pointer file and no repo-root probe: the caller states the ledger or inherits the
 * cwd default, and a missing file is named when it is read.
 */
export function resolveLedgerPath({ log = "" } = {}, { env = process.env, cwd = process.cwd() } = {}) {
	const given = String(log);
	if (given !== "") {
		if (!isAbsolute(given)) {
			return { ok: false, code: "relative-log", message: `--log must be an absolute path (got "${given}") — a relative ledger names nothing` };
		}
		return { ok: true, path: given };
	}
	const fromEnv = String(env.JEV_PROVENANCE ?? "");
	if (fromEnv !== "") {
		if (!isAbsolute(fromEnv)) {
			return { ok: false, code: "relative-log", message: `JEV_PROVENANCE must be an absolute path (got "${fromEnv}") — a relative ledger names nothing` };
		}
		return { ok: true, path: fromEnv };
	}
	return { ok: true, path: resolve(cwd, DEFAULT_LEDGER) };
}

/**
 * The newest `recheck-<pr>` row's line, resolved BEFORE any destination exists (#596).
 *
 * The order is the promise: a record the ledger cannot back is refused with no file and no directory
 * behind it, so this runs before `resolveDestination`'s `ensureRoot`/`ensureDir`. The reader is
 * `parseProvenanceLog`, so a torn or malformed ledger is inherited fail-closed — the parser's own
 * message, exit 2 — never "no entries". Newest = last row in file order; the printed ISO is the
 * row's, so the reviewer's stderr line names WHEN the line was classified.
 */
export function resolveRecheckLine(
	{ pr, log = "" },
	{ env = process.env, cwd = process.cwd(), readLedger = readFileSync } = {},
) {
	const ledger = resolveLedgerPath({ log }, { env, cwd });
	if (!ledger.ok) return ledger;
	let text;
	try {
		text = readLedger(ledger.path, "utf8");
	} catch (error) {
		return {
			ok: false,
			code: "unreadable-ledger",
			message:
				`${ledger.path}: cannot read the provenance ledger (${describe(error)}) — the ledger is explicit: pass ` +
				`--log <absolute path> (or set JEV_PROVENANCE); a missing ledger is not "no rows yet"`,
		};
	}
	let parsed;
	try {
		parsed = parseProvenanceLog(text);
	} catch (error) {
		// The parser's message, not a paraphrase: it names the line number and the repair.
		if (!(error instanceof StructuralError)) throw error;
		return { ok: false, code: "malformed-ledger", message: `${ledger.path}: ${error.message}` };
	}
	const label = `recheck-${pr}`;
	const rows = parsed.entries.filter((entry) => entry.label === label);
	if (rows.length === 0) {
		return {
			ok: false,
			code: "no-recheck-row",
			message:
				`${ledger.path}: no "${label}" row — the recheck line is the classifier's answer printed at review time; ` +
				`print it with: jev-check --classifier '<raw answers>' --label ${label}`,
		};
	}
	const newest = rows[rows.length - 1];
	// The parser trims; the gate's predicate does not. A row whose raw bytes are not the line the gate
	// will look for (a CRLF or padded third field) would resolve here and then fail `matchRow` at the
	// merge point — so the writer asks the gate's question BEFORE it renders, and refuses to mint a
	// record the gate cannot bind. Same predicate, both questions, one ledger.
	if (!matchRow(text.split("\n"), label, newest.line)) {
		return {
			ok: false,
			code: "row-bytes-mismatch",
			message:
				`${ledger.path}: the newest ${label} row resolves to "${newest.line}" but its raw bytes are not ` +
				`that exact line (a CRLF or padded field) — the gate matches bytes, so this row cannot bind the ` +
				`record; reprint it with: jev-check --classifier '<raw answers>' --label ${label}`,
		};
	}
	return { ok: true, path: ledger.path, line: newest.line, at: newest.at, count: rows.length };
}

/**
 * Where this record will be written: `{ ok: true, path, dir }` or a named refusal.
 *
 * The default is `<root>/review-<pr>/REVIEW_<pr>.md` in the private root, whose chain is created at
 * 0700 if it is missing and validated if it is not. An explicit `--out` keeps its meaning, but its
 * DIRECTORY must pass the ownership and write-authority clauses: `/tmp` is `ancestor-writable`
 * (group/other write there is rename authority over the record), a symlinked component is
 * `symlink-component`, a foreign owner is `untrusted-owner` — and every refusal names the private
 * default, because the reviewer's next move is to drop `--out`, not to pick another shared directory.
 * The mount clause is the one that softens: a destination on a `tmpfs` is accepted, and its success
 * result carries a `warning` the caller prints (#518).
 */
export function resolveDestination(spec, options = {}) {
	const { root = defaultRoot(), ...seams } = options;
	const fallback = recordPath(spec.pr, { root });
	if (spec.out === "") {
		const rootCheck = ensureRoot(root, seams);
		if (!rootCheck.ok) return rootCheck;
		const dirCheck = ensureDir(dirname(fallback), { root: rootCheck.root, ...seams });
		if (!dirCheck.ok) return dirCheck;
		// No `warning` here, by construction: `ensureRoot` REFUSES a tmpfs root, so the default branch
		// cannot reach a destination this module would warn about.
		return { ok: true, path: fallback, dir: dirCheck.dir };
	}
	const path = resolve(spec.out);
	const dirCheck = validateWriteDir(dirname(path), seams);
	if (!dirCheck.ok) {
		return { ok: false, code: dirCheck.code, message: `${dirCheck.message} — the private default is ${fallback}; drop --out to use it` };
	}
	return { ok: true, path, dir: dirCheck.dir, warning: dirCheck.warning };
}

function refuse(err, code, message) {
	err(`review-record: refused (${code}): ${message}`);
	return EXIT.REFUSED;
}

/** `{ ok: true, file, json }` or `{ ok: false, message }` for `--verify` (the path is positional). */
export function parseVerifyArgs(argv) {
	const parsed = { file: "", json: false };
	for (const argument of argv) {
		if (argument === "--json") {
			parsed.json = true;
			continue;
		}
		if (argument.startsWith("--")) return { ok: false, message: `unknown argument: ${argument}` };
		if (parsed.file !== "") return { ok: false, message: `unexpected argument: ${argument}` };
		parsed.file = argument;
	}
	if (parsed.file === "") return { ok: false, message: "missing the record path" };
	return { ok: true, ...parsed };
}

/**
 * `--verify`'s reasons: the `--check` rules, plus a head the `record:` line can actually print. One
 * code appears once — `missing-head` can be reached from both lists and one line per reason reads
 * better than a repeat.
 */
function verifyProblems(text) {
	const seen = new Set();
	return [...checkRecord(text), ...checkHeadShape(text)].filter((item) => {
		if (seen.has(item.code)) return false;
		seen.add(item.code);
		return true;
	});
}

/** `--check`: the offline field check. No network, no `gh`, no provenance log. */
/** `--check`: the offline field check — and, with `--pr`, the provenance row question. No network,
 *  no `gh`. `--shape-only` is the pre-#596 contract, byte for byte. */
export function recordCheck(
	argv,
	{ out = console.log, err = console.error, readLedger = readFileSync, env = process.env, cwd = process.cwd() } = {},
) {
	const parsed = parseCheckArgs(argv);
	if (!parsed.ok) {
		err(`review-record: ${CHECK_USAGE}\n${parsed.message}`);
		return EXIT.USAGE;
	}
	let text;
	try {
		text = readFileSync(parsed.file, "utf8");
	} catch (error) {
		err(`review-record: cannot read ${parsed.file} (${describe(error)})`);
		return EXIT.USAGE;
	}
	const problems = checkRecord(text, { pr: parsed.pr, head: parsed.head });
	if (problems.length > 0) {
		for (const item of problems) err(`  ✗ ${item.code}: ${item.message}`);
		err(`record-check: ${problems.length} reason(s) — ${parsed.file} is not a record the gate can read`);
		return EXIT.REFUSED;
	}
	// The field rules first: a record with no `jev-recheck:` line has no row to look for (it is
	// already refused above as `missing-recheck`), and a shape fault is cheaper to report than a
	// ledger read. `--shape-only` stops here — the output is the pre-#596 output.
	if (!parsed.shapeOnly && parsed.pr !== "") {
		const bound = bindProvenanceRow(parsed, text, { err, readLedger, env, cwd });
		if (bound !== EXIT.WRITTEN) return bound;
	}
	const facts = parseRecord(text);
	const disposition = MERGEABLE_VERDICTS.includes(facts.verdict)
		? facts.verdict
		: `${facts.verdict} — well-formed, but the gate blocks the merge until the head is re-reviewed`;
	out(`record-check: OK — ${parsed.file} (${disposition}; Risk class ${facts.risk}; head ${facts.head.slice(0, 12)})`);
	return EXIT.WRITTEN;
}

/**
 * `--check`'s provenance half: does ANY row carry this label and this line?
 *
 * The gate's predicate (`matchRow`: no trim, no `#` skip, `>= 3` columns), asked over the raw bytes,
 * because the gate will ask the same bytes the same way. The read comes first: `parseProvenanceLog`
 * makes a torn ledger exit 2 (the parser's message) instead of reading as "no match" — 2 is "cannot
 * check", 1 is "checked, absent", and conflating them is the defect the ledger reader exists to end.
 */
function bindProvenanceRow({ pr, log, file }, text, { err, readLedger, env, cwd }) {
	const ledger = resolveLedgerPath({ log }, { env, cwd });
	if (!ledger.ok) {
		err(`review-record: ${CHECK_USAGE}\n${ledger.message}`);
		return EXIT.USAGE;
	}
	let ledgerText;
	try {
		ledgerText = readLedger(ledger.path, "utf8");
	} catch (error) {
		err(
			`record-check: ${ledger.path}: cannot read the provenance ledger (${describe(error)}) — pass ` +
				`--log <absolute path> (or set JEV_PROVENANCE); the ledger is explicit, never discovered`,
		);
		return EXIT.USAGE;
	}
	try {
		parseProvenanceLog(ledgerText);
	} catch (error) {
		if (!(error instanceof StructuralError)) throw error;
		err(`record-check: ${ledger.path}: ${error.message}`);
		return EXIT.USAGE;
	}
	const label = `recheck-${pr}`;
	const line = parseRecord(text).recheck;
	if (matchRow(ledgerText.split("\n"), label, line)) return EXIT.WRITTEN;
	err(
		`record-check: no provenance row "${line}" for the recheck — label ${label} in ${ledger.path}; ` +
			`print the review-time line with: jev-check --classifier '<raw answers>' --label ${label}`,
	);
	err(`record-check: ${file} binds its jev-recheck line to a ${label} row, and none carries it`);
	return EXIT.REFUSED;
}

/** `--verify`: one line, recomputable — the record file IS the proof, not a claim about it (#503). */
export function recordVerify(argv, { out = console.log, err = console.error } = {}) {
	const parsed = parseVerifyArgs(argv);
	if (!parsed.ok) {
		err(`review-record: ${VERIFY_USAGE}\n${parsed.message}`);
		return EXIT.USAGE;
	}
	// The RESOLVED path is what gets printed: the conductor recomputes `sha256sum <path>` from this
	// line, and a relative path that only works from one cwd is the thing this mode exists to remove.
	const path = resolve(parsed.file);
	const report = (payload) => {
		if (parsed.json) out(JSON.stringify(payload, null, 2));
	};

	let bytes;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		const reason = { code: "unreadable-record", message: `cannot read ${path} (${describe(error)})` };
		err(`review-record: ${reason.message} — a missing record is not a passing check, it is the #503 failure`);
		report({ ok: false, path, verdict: "", head: "", findings: 0, sha256: "", reasons: [reason] });
		return EXIT.USAGE;
	}

	// Hash the BYTES, not a decoded string: `sha256sum <path>` is the comparison, so a re-encoding
	// here would make the two disagree on a file that is not valid UTF-8.
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const text = bytes.toString("utf8");
	const facts = parseRecord(text);
	const problems = verifyProblems(text);
	if (problems.length > 0) {
		for (const item of problems) err(`  ✗ ${item.code}: ${item.message}`);
		err(`record-verify: ${problems.length} reason(s) — ${path} is not a record the gate can read (sha256 ${sha256})`);
		report({ ok: false, path, verdict: facts.verdict, head: facts.head, findings: facts.findings, sha256, reasons: problems.map(({ code, message }) => ({ code, message })) });
		return EXIT.REFUSED;
	}

	if (parsed.json) {
		report({ ok: true, path, verdict: facts.verdict, head: facts.head, findings: facts.findings, sha256, reasons: [] });
	} else {
		out(`record: ${path} · verdict ${facts.verdict} · head ${facts.head} · findings ${facts.findings} · sha256 ${sha256}`);
	}
	return EXIT.WRITTEN;
}

/**
 * The generator. Returns the exit code; stdout / stderr / stdin go through `out` / `err` /
 * `readStdin`, and `root` / `lock` are the seams a test uses to point the private root elsewhere or
 * to shorten the lock poll.
 *
 * Order is the contract: validate the invocation → read the findings → resolve and validate the
 * destination → take the lock → read the prior record INSIDE it → decide the head → render, verify,
 * atomically replace → release. The findings are read before the lock on purpose: an unbounded stdin
 * read is no reason to hold a lock, and the lock exists for the read-prior-then-replace window only.
 *
 * Any remaining option is a filesystem seam (`statfs`, `platform`, …) passed straight to
 * `resolveDestination`, so a test can stub the destination's mount type (#518) without a real tmpfs.
 */
export function writeRecord(
	argv,
	{
		out = (chunk) => process.stdout.write(chunk),
		err = console.error,
		readStdin = () => readFileSync(0, "utf8"),
		root = defaultRoot(),
		lock = {},
		env = process.env,
		cwd = process.cwd(),
		readLedger = readFileSync,
		...seams
	} = {},
) {
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		err(`review-record: ${USAGE}\n${parsed.message}`);
		return EXIT.USAGE;
	}
	const { spec, newHead } = parsed;

	const problems = validateSpec(spec);
	const shape = problems.filter((item) => item.kind === "usage");
	if (shape.length > 0) {
		err(`review-record: ${USAGE}`);
		for (const item of shape) err(`  ✗ ${item.code}: ${item.message}`);
		return EXIT.USAGE;
	}
	// An intrinsic refusal is decided before any file is read: never touch the disk to reject inputs.
	for (const item of problems) {
		if (item.kind !== "usage") return refuse(err, item.code, item.message);
	}

	// The ledger BEFORE the destination, so a record the ledger cannot back leaves no file and no
	// directory behind (that is the #596 resolution-order contract, and the mutant that moves this
	// below `resolveDestination` fails on an empty private root). The reader is the shared parser:
	// a torn ledger is exit 2 here exactly as it is in every audit.
	const resolved = resolveRecheckLine({ pr: spec.pr, log: spec.log }, { env, cwd, readLedger });
	if (!resolved.ok) {
		err(`review-record: cannot resolve the recheck line — ${resolved.message}`);
		return EXIT.USAGE;
	}
	spec.recheck = resolved.line;
	const lineProblems = recheckProblems(spec.risk, spec.recheck);
	const lineShape = lineProblems.filter((item) => item.kind === "usage");
	if (lineShape.length > 0) {
		err(`review-record: the newest recheck-${spec.pr} row is not a recheck line — ${resolved.path}`);
		for (const item of lineShape) err(`  ✗ ${item.code}: ${item.message}`);
		return EXIT.USAGE;
	}
	// A row is not a promise either: the tier rule is the same rule, against the RESOLVED line.
	for (const item of lineProblems) return refuse(err, item.code, item.message);

	let findings;
	try {
		findings = spec.findings === "-" ? readStdin() : readFileSync(spec.findings, "utf8");
	} catch (error) {
		err(`review-record: cannot read the findings (${describe(error)})`);
		return EXIT.USAGE;
	}

	const destination = resolveDestination(spec, { root, ...seams });
	if (!destination.ok) return refuse(err, destination.code, destination.message);
	const file = destination.path;
	const dir = destination.dir;

	const held = acquireLock(dir, basename(file), { ...lock, root: dir });
	if (!held.ok) {
		return refuse(err, held.code, held.message ?? `${file} is locked by another writer (${held.code})`);
	}
	try {
		// Under the lock, always: the head refusal and the supersede chain are decided on the bytes
		// that are on disk NOW, not on the ones a delayed writer saw before another run committed.
		let prior;
		try {
			prior = readPrior(file, { root: dir });
		} catch (error) {
			err(`review-record: cannot read the existing record ${file} (${describe(error)})`);
			return EXIT.USAGE;
		}
		const supersededHeads = prior === null ? [] : [...prior.supersededHeads];
		if (prior !== null && prior.head !== "" && !sameCommit(prior.head, spec.head)) {
			if (!newHead) {
				return refuse(
					err,
					"head-mismatch",
					`${file} already covers head ${prior.head} and --head is ${spec.head} — a retry must not ` +
						'silently mint a newer record; re-run with --new-head to supersede it (the old head is kept on a "Superseded head:" line)',
				);
			}
			supersededHeads.push(prior.head);
		}
		// One head carries one line (#596 decision 2). A differing line for the SAME head is a
		// contradiction, not an update: the record would otherwise be re-rendered to a line that the
		// prior record's reader never saw. Recovery is deleting the record, or --new-head when the head
		// moved. No `--replace`: a free-text reason in the record is a field-injection surface.
		if (
			prior !== null &&
			prior.head !== "" &&
			sameCommit(prior.head, spec.head) &&
			prior.recheck !== "" &&
			prior.recheck !== spec.recheck
		) {
			return refuse(
				err,
				"line-mismatch",
				`${file} already covers head ${prior.head} with jev-recheck "${prior.recheck}", but the ledger ` +
					`resolves "${spec.recheck}" for recheck-${spec.pr} — one head carries one line; delete ${file} to ` +
					"re-author it, or re-run with --new-head when the head actually changed",
			);
		}

		const record = renderRecord({ ...spec, findings, supersededHeads });
		const drift = verifyRendered(record, { ...spec, findings, supersededHeads });
		if (drift.length > 0) {
			for (const item of drift) err(`  ✗ ${item.code}: ${item.message}`);
			err(
				`review-record: refused (unreadable-record): the rendered block does not read back as written — ${drift.length} reason(s), nothing written`,
			);
			return EXIT.REFUSED;
		}

		// A temp file in the same directory and a rename over the target: a kill leaves either the old
		// complete record or the new one plus a `.REVIEW_<n>.md.tmp-*` leftover that no reader ever
		// mistakes for a record (the name is not the record's, and `--check` is never pointed at it).
		const written = atomicReplace(dir, file, record, { root: dir });
		if (!written.ok) return refuse(err, written.code, written.message);

		out(record);
		// After the write, never before it: a warning about a destination that was then refused would
		// describe a file that does not exist. Once per write, and on stderr — stdout IS the record.
		if (destination.warning !== undefined) err(`review-record: warning: ${destination.warning}`);
		const head = spec.head.toLowerCase();
		// Which row, WHEN, and from which ledger: stderr only, so the record's bytes are untouched, and
		// the reviewer can see the line it did not supply.
		err(
			`review-record: recheck ${resolved.at} from ${resolved.path} (label recheck-${spec.pr}` +
				`${resolved.count > 1 ? `, ${resolved.count} rows — the newest wins` : ""})`,
		);
		err(
			`review-record: wrote ${file} (PR #${spec.pr}, head ${head.slice(0, 12)}, verdict ${spec.verdict}, ` +
				`Risk class ${spec.risk.toUpperCase()}${supersededHeads.length > 0 ? `, supersedes ${supersededHeads[supersededHeads.length - 1]}` : ""})`,
		);
		err(
			`review-record: verify with: bash .pi/skills/worktree/merge-guard.sh --check-record ${file} --pr ${spec.pr} --head ${head} --provenance ${resolved.path}`,
		);
		return EXIT.WRITTEN;
	} finally {
		const released = held.release();
		if (!released.ok) err(`review-record: ${released.code}: ${released.message}`);
	}
}

/**
 * `--break-lock`: print the holder's evidence, and unlink only when that evidence proves the holder
 * is gone AND the operator passed `--yes`. A live holder is refused even with `--yes` — nothing here
 * removes a lock by age, because age cannot distinguish a dead writer from a slow one.
 */
export function recordBreakLock(argv, { out = console.log, err = console.error } = {}) {
	let file = "";
	let yes = false;
	for (const argument of argv) {
		if (argument === "--yes") {
			yes = true;
			continue;
		}
		if (argument.startsWith("--")) {
			err(`review-record: ${BREAK_USAGE}\nunknown argument: ${argument}`);
			return EXIT.USAGE;
		}
		if (file !== "") {
			err(`review-record: ${BREAK_USAGE}\nunexpected argument: ${argument}`);
			return EXIT.USAGE;
		}
		file = argument;
	}
	if (file === "") {
		err(`review-record: ${BREAK_USAGE}\nmissing the record path`);
		return EXIT.USAGE;
	}
	const path = resolve(file);
	const result = breakLock(dirname(path), basename(path), { yes });
	if (!result.ok) {
		err(`review-record: refused (${result.code}): ${result.message}`);
		return EXIT.REFUSED;
	}
	out(`review-record: broke ${result.path} — holder was ${result.evidence}${result.alreadyReleased ? " (it was gone already)" : ""}`);
	return EXIT.WRITTEN;
}

/** `--check` is the offline field check, `--verify` the record line, `--break-lock` the recovery; anything else generates. */
export function main(argv = process.argv.slice(2), io = {}) {
	if (argv[0] === "--check") return recordCheck(argv.slice(1), io);
	if (argv[0] === "--verify") return recordVerify(argv.slice(1), io);
	if (argv[0] === "--break-lock") return recordBreakLock(argv.slice(1), io);
	return writeRecord(argv, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
