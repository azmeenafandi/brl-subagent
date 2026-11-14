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
//     --findings <path|-> [--conductor-verified "<text>"] [--out <path>] [--new-head]
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
//   node scripts/review-record.mjs --check <record> [--pr <n>] [--head <sha>]
//
//   exit 0 every field rule holds · 1 a named reason failed · 2 usage or unreadable input. It reports
//   `changes-requested` as well-formed but unmergeable: the merge decision stays the full gate's, whose
//   (a) CI and (f) `recheck-<pr>` provenance checks need the network and the local log. Reading is
//   UNRESTRICTED by the private root: an old `/tmp/REVIEW_<n>.md` record must still verify.
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
import { basename, dirname, resolve } from "node:path";
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
	'--head <sha> --risk <C1|C2|C3> --recheck "<jev line>" --findings <path|-> ' +
	'[--conductor-verified "<text>"] [--out <path>] [--new-head]';

export const CHECK_USAGE = "usage: review-record.mjs --check <record> [--pr <n>] [--head <sha>]";

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
	// `spec.out === ""` means "the private default" — the path is resolved (and the root created and
	// validated) only once the invocation itself is well-formed, see `resolveDestination`.
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
function readPrior(file, { root }) {
	const read = readRegular(file, { root });
	if (!read.ok) {
		if (read.code === "missing") return null;
		throw new Error(read.message);
	}
	const facts = parseRecord(read.bytes.toString("utf8"));
	return { head: facts.head, supersededHeads: facts.supersededHeads };
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
		err(
			`review-record: wrote ${file} (PR #${spec.pr}, head ${head.slice(0, 12)}, verdict ${spec.verdict}, ` +
				`Risk class ${spec.risk.toUpperCase()}${supersededHeads.length > 0 ? `, supersedes ${supersededHeads[supersededHeads.length - 1]}` : ""})`,
		);
		err(
			`review-record: verify with: bash .pi/skills/worktree/merge-guard.sh --check-record ${file} --pr ${spec.pr} --head ${head}`,
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
