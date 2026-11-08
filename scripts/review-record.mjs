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
// Write:
//   node scripts/review-record.mjs --pr <n> --verdict approve|approve-with-nits|changes-requested \
//     --head <sha> --risk C1|C2|C3 --recheck "jev: <level> (<conf>) · Cx · worktree <y|n>" \
//     --findings <path|-> [--conductor-verified "<text>"] [--out /tmp/REVIEW_<n>.md] [--new-head]
//
//   stdout IS the record; the same bytes are written to `--out` (default `/tmp/REVIEW_<n>.md`), so a
//   reviewer pastes stdout or hands over the file — there is no second transcription to get wrong.
//
//   idempotent  identical inputs → byte-identical output. No timestamps, no clock, one case per field;
//               re-running the same command is a no-op on disk.
//   refuses     a record that already covers a DIFFERENT head (exit 1) — a retry must not silently mint
//               a newer record. `--new-head` supersedes it, keeping the old head on a
//               `Superseded head:` line so the review chain stays readable.
//   refuses     a declared `Risk class` weaker than the recheck's (exit 1): gate rule (f), caught where
//               it is cheap instead of at the merge point.
//   refuses     a findings body carrying its own line-start `Verdict:` / `Risk class:` / `jev-recheck:`
//               line (exit 1) — the gate would read the body, not the record.
//
// Check (what `.pi/skills/worktree/merge-guard.sh --check-record` runs — no network, no `gh`):
//   node scripts/review-record.mjs --check <record> [--pr <n>] [--head <sha>]
//
//   exit 0 every field rule holds · 1 a named reason failed · 2 usage or unreadable input. It reports
//   `changes-requested` as well-formed but unmergeable: the merge decision stays the full gate's, whose
//   (a) CI and (f) `recheck-<pr>` provenance checks need the network and the local log.
//
// Verify (#503: the record FILE is the unit of proof):
//   node scripts/review-record.mjs --verify <record> [--json]
//
//   stdout is ONE line a third party recomputes — the same field rules as `--check`, plus the file's
//   own sha256, so "I ran it" becomes a line with an artifact behind it:
//     record: /tmp/REVIEW_412.md · verdict approve-with-nits · head <40-hex> · findings <n> · sha256 <64-hex>
//
//   exit 0 every field rule holds · 1 not a record the gate could read (named reasons on stderr; the
//   `--check` rules PLUS a head the line can print, 7-40 hex) · 2 usage, or a file that is not there
//   or not readable — the message names the RESOLVED path, which is the U2 failure caught in one line
//   instead of after a `/tmp` listing. `findings <n>` comes from `countFindings` — the one definition
//   on `parseRecord`, the same number `--check` reads, never a second implementation. `--json` prints
//   one object instead of the line (on every exit: a refusal and an unreadable file carry their
//   `reasons[]` there too).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
	HEAD_RE,
	MERGEABLE_VERDICTS,
	checkHeadShape,
	checkRecord,
	parseRecord,
	renderRecord,
	validateSpec,
	verifyRendered,
} from "./lib/record-fields.mjs";

export const USAGE =
	"usage: review-record.mjs --pr <n> --verdict <approve|approve-with-nits|changes-requested> " +
	'--head <sha> --risk <C1|C2|C3> --recheck "<jev line>" --findings <path|-> ' +
	'[--conductor-verified "<text>"] [--out <path>] [--new-head]';

export const CHECK_USAGE = "usage: review-record.mjs --check <record> [--pr <n>] [--head <sha>]";

export const VERIFY_USAGE = "usage: review-record.mjs --verify <record> [--json]";

/** Exit codes, named so the docs and the tests cannot drift from the script. */
export const EXIT = Object.freeze({ WRITTEN: 0, REFUSED: 1, USAGE: 2 });

/** The value-taking flags of each mode, one map apiece — no second list to keep in sync. */
const WRITE_FLAGS = new Map([
	["--pr", "pr"],
	["--verdict", "verdict"],
	["--head", "head"],
	["--risk", "risk"],
	["--recheck", "recheck"],
	["--findings", "findings"],
	["--conductor-verified", "conductorVerified"],
	["--out", "out"],
]);
const CHECK_FLAGS = new Map([
	["--pr", "pr"],
	["--head", "head"],
]);

/** `{ ok: true, spec, newHead }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	const spec = { pr: "", verdict: "", head: "", risk: "", recheck: "", findings: "", conductorVerified: "", out: "" };
	let newHead = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--new-head") {
			newHead = true;
			continue;
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
	if (spec.out === "") spec.out = join(tmpdir(), `REVIEW_${spec.pr}.md`);
	return { ok: true, spec, newHead };
}

/** `{ ok: true, file, pr, head }` or `{ ok: false, message }` for `--check`. */
export function parseCheckArgs(argv) {
	const parsed = { file: "", pr: "", head: "" };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
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
	if (parsed.pr !== "" && !/^[0-9]+$/.test(parsed.pr)) return { ok: false, message: "--pr must be a PR number" };
	if (parsed.head !== "" && !HEAD_RE.test(parsed.head)) {
		return { ok: false, message: `--head must be a commit sha, 7-40 hex chars (got "${parsed.head}")` };
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

/** The head and supersede chain already on disk, or `null` when there is no record yet. */
function readPrior(file) {
	if (!existsSync(file)) return null;
	const facts = parseRecord(readFileSync(file, "utf8"));
	return { head: facts.head, supersededHeads: facts.supersededHeads };
}

function refuse(err, code, message) {
	err(`review-record: refused (${code}): ${message}`);
	return EXIT.REFUSED;
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
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
export function recordCheck(argv, { out = console.log, err = console.error } = {}) {
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
	const facts = parseRecord(text);
	const disposition = MERGEABLE_VERDICTS.includes(facts.verdict)
		? facts.verdict
		: `${facts.verdict} — well-formed, but the gate blocks the merge until the head is re-reviewed`;
	out(`record-check: OK — ${parsed.file} (${disposition}; Risk class ${facts.risk}; head ${facts.head.slice(0, 12)})`);
	return EXIT.WRITTEN;
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
		report({ ok: false, path, verdict: facts.verdict, head: facts.head, findings: facts.findings, sha256, reasons: problems });
		return EXIT.REFUSED;
	}

	if (parsed.json) {
		report({ ok: true, path, verdict: facts.verdict, head: facts.head, findings: facts.findings, sha256, reasons: [] });
	} else {
		out(`record: ${path} · verdict ${facts.verdict} · head ${facts.head} · findings ${facts.findings} · sha256 ${sha256}`);
	}
	return EXIT.WRITTEN;
}

/** The generator. Returns the exit code; stdout / stderr / stdin go through `out` / `err` / `readStdin`. */
export function writeRecord(
	argv,
	{ out = (chunk) => process.stdout.write(chunk), err = console.error, readStdin = () => readFileSync(0, "utf8") } = {},
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

	let findings;
	try {
		findings = spec.findings === "-" ? readStdin() : readFileSync(spec.findings, "utf8");
	} catch (error) {
		err(`review-record: cannot read the findings (${describe(error)})`);
		return EXIT.USAGE;
	}

	let prior;
	try {
		prior = readPrior(spec.out);
	} catch (error) {
		err(`review-record: cannot read the existing record ${spec.out} (${describe(error)})`);
		return EXIT.USAGE;
	}
	const supersededHeads = prior === null ? [] : [...prior.supersededHeads];
	if (prior !== null && prior.head !== "" && !sameCommit(prior.head, spec.head)) {
		if (!newHead) {
			return refuse(
				err,
				"head-mismatch",
				`${spec.out} already covers head ${prior.head} and --head is ${spec.head} — a retry must not ` +
					'silently mint a newer record; re-run with --new-head to supersede it (the old head is kept on a "Superseded head:" line)',
			);
		}
		supersededHeads.push(prior.head);
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

	// Crash recovery is contractual, not atomic: this is a plain write, so a kill between render and
	// write can leave a partial file. Re-running the identical command rewrites it byte-identically
	// (the output is deterministic), and `--check` fails closed on any partial residue.
	try {
		writeFileSync(spec.out, record);
	} catch (error) {
		err(`review-record: cannot write ${spec.out} (${describe(error)})`);
		return EXIT.USAGE;
	}
	out(record);
	const head = spec.head.toLowerCase();
	err(
		`review-record: wrote ${spec.out} (PR #${spec.pr}, head ${head.slice(0, 12)}, verdict ${spec.verdict}, ` +
			`Risk class ${spec.risk.toUpperCase()}${supersededHeads.length > 0 ? `, supersedes ${supersededHeads[supersededHeads.length - 1]}` : ""})`,
	);
	err(`review-record: verify with: bash .pi/skills/worktree/merge-guard.sh --check-record ${spec.out} --pr ${spec.pr} --head ${head}`);
	return EXIT.WRITTEN;
}

/** `--check` selects the offline field check, `--verify` the record line; anything else generates. */
export function main(argv = process.argv.slice(2), io = {}) {
	if (argv[0] === "--check") return recordCheck(argv.slice(1), io);
	if (argv[0] === "--verify") return recordVerify(argv.slice(1), io);
	return writeRecord(argv, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
