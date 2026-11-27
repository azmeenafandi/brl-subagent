/**
 * Tests for the review-record tool (issue #487) — the mechanical half of "the gate could not read
 * the record".
 *
 * Three merged units in a row arrived with a shape `merge-guard.sh` could not parse (S4 #484: no
 * `jev-recheck:` line; S5 #485: `Risk class:` and `jev-recheck:` fused on one line; S6 #486: a
 * findings bank with no `Verdict:`). The gate was right; the shape was prose. So the record is
 * generated now, and this file pins the contract from both ends:
 *
 * 1. the emitted block — byte-exact golden, idempotent on a second run, stdout === the file, the
 *    findings body verbatim (and inert);
 * 2. the refusals — a record that already covers another head, a declared tier weaker than the
 *    recheck, a findings body that would overshadow a field;
 * 3. the gate's own rules — the fixtures are the three historical shapes, one named reason each,
 *    asserted through `checkRecord` (the definition) and once through the real
 *    `merge-guard.sh --check-record` (the acceptance criterion: no network, no `gh`);
 * 4. the private root and the lock (#512) — the record's identity is the PR, not the run, so it lives
 *    at `<root>/review-<pr>/REVIEW_<pr>.md`, and EVERY path that reads prior state and then writes
 *    takes the lock first. The falsifiers are real child processes: a `SIGKILL`ed lock holder, two
 *    concurrent generator runs, and a delayed writer that must never erase a committed supersede.
 *
 * The scratch directory is `<repo>/.tmp/…`, NOT `/tmp`: the private-root predicate refuses a root
 * whose directory chain is group/other-writable, which `/tmp` is — so a `/tmp` scratch dir here would
 * make every write a test of the refusal. `.tmp/` is gitignored and its chain is uid-owned and 0755.
 * `--verify`/`--check` remain readable from anywhere: one test writes a legacy record under `/tmp` and
 * verifies it, because an old record must not become unreadable when the path moves.
 *
 * Every fixture lives in `scripts/__tests__/fixtures/review-records/` as a `.md` file: a shape that
 * cost a merge is worth grepping for, and an `.md` is invisible to the `scripts` surface's LOC
 * ceiling (which counts `.mjs` sources and `.ts` tests).
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkRecord, parseRecord, recordLines, renderRecord, verifyRendered } from "../lib/record-fields.mjs";
import { acquireLock, lockPath, recordPath, TMPFS_MAGIC } from "../lib/scratch-root.mjs";
import { EXIT, recordBreakLock, recordCheck, recordVerify, writeRecord } from "../review-record.mjs";

const ROOT = process.cwd();
const TOOL = join(ROOT, "scripts", "review-record.mjs");
const LIB = join(ROOT, "scripts", "lib", "scratch-root.mjs");
const GUARD = join(ROOT, ".pi", "skills", "worktree", "merge-guard.sh");
const FIXTURES = join(ROOT, "scripts", "__tests__", "fixtures", "review-records");
/** The synthetic ledgers (#596) — small, hand-checked rows. Never a copy of a live ledger. */
const LEDGERS = join(ROOT, "scripts", "__tests__", "fixtures", "review-logs");
const TMP = (() => {
	const base = join(ROOT, ".tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "review-record-"));
})();
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const HEAD = "4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90";
const NEXT = "9b2e4f6801a2b3c4d5e6f708192a3b4c5d6e7f80";
const RECHECK = "jev: medium (0.63) · C1 · worktree y";
const FINDINGS = [
	"| Severity | Smell | file:line | One-liner |",
	"|---|---|---|---|",
	"| nit | `duplicated-code` | `scripts/lib/record-fields.mjs:12` | two spellings of the same label |",
	"",
	"Verified: the gate's field rules are transcribed, not paraphrased.",
].join("\n");

const GOLDEN = `# Review record — PR #412

Reviewed head: ${HEAD}
Verdict: approve-with-nits
Risk class: C1
jev-recheck: ${RECHECK}

## Findings

${FINDINGS}
`;

interface Captured {
	code: number;
	stdout: string;
	stderr: string;
}

function spec(overrides: Record<string, unknown> = {}) {
	return { pr: "412", verdict: "approve-with-nits", head: HEAD, risk: "C1", recheck: RECHECK, findings: FINDINGS, ...overrides };
}

/** Write through the module, capturing both streams (no subprocess needed for the contract). */
function write(argv: string[], stdin = "", io: Record<string, unknown> = {}): Captured {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = writeRecord(argv, {
		out: (chunk: string) => void stdout.push(chunk),
		err: (line: string) => void stderr.push(line),
		readStdin: () => stdin,
		...io,
	});
	return { code, stdout: stdout.join(""), stderr: stderr.join("\n") };
}

/**
 * The generator's argv for a spec, with `--out` pointed at a scratch file and `--log` at a scratch
 * ledger carrying the spec's line under `recheck-<pr>` (#596: the line is RESOLVED from the ledger,
 * never passed — `--recheck` is gone). An override that is not a recheck line is still written to
 * the ledger, so the resolution-then-validation path is what the malformed case exercises.
 */
let findingsCounter = 0;
let ledgerCounter = 0;
function ledgerFor(line: string, pr: string): string {
	const path = scratch(`ledger-${(ledgerCounter += 1)}.log`);
	writeFileSync(path, `2026-11-04T00:00:00.000Z\trecheck-${pr}\t${line}\n`);
	return path;
}
function argvFor(overrides: Record<string, unknown> = {}, out: string, extra: string[] = []): string[] {
	const value = spec(overrides);
	const findings = String(value.findings);
	let findingsArg = findings;
	if (findings !== "-") {
		// `--findings` is a path, so the fixture text goes to a scratch file first.
		findingsArg = scratch(`findings-${(findingsCounter += 1)}.md`);
		writeFileSync(findingsArg, findings);
	}
	return [
		"--pr",
		String(value.pr),
		"--verdict",
		String(value.verdict),
		"--head",
		String(value.head),
		"--risk",
		String(value.risk),
		"--log",
		ledgerFor(String(value.recheck), String(value.pr)),
		"--findings",
		findingsArg,
		"--out",
		out,
		...extra,
	];
}

function scratch(name: string): string {
	return join(TMP, name);
}

/** A private directory inside the scratch tree — its 0700 mode is what makes it a legal record dir. */
let dirCounter = 0;
function scratchDir(label: string): string {
	const dir = scratch(`${label}-${(dirCounter += 1)}`);
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}

/** The generator without `--out`: the private default path (`<root>/review-<pr>/REVIEW_<pr>.md`). */
function argvDefault(overrides: Record<string, unknown> = {}, extra: string[] = []): string[] {
	const withOut = argvFor(overrides, "PLACEHOLDER", extra);
	const index = withOut.indexOf("--out");
	return [...withOut.slice(0, index), ...withOut.slice(index + 2)];
}

/** The real CLI, as a child process — the exit code a conductor's one-liner sees. */
function cliRun(args: string[], stdin = ""): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", input: stdin });
	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Names in a directory, sorted — what a lock or a temp file would show up in. */
function list(dir: string): string[] {
	return readdirSync(dir).sort();
}

function codes(text: string, options: { pr?: string; head?: string } = {}): string[] {
	return checkRecord(text, options).map((item: { code: string }) => item.code);
}

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, `${name}.md`), "utf8");
}

/**
 * The recomputation the mode exists for: the REAL `sha256sum`, not a second copy of node's crypto —
 * the conductor runs exactly this command against the pasted line, so the test runs it too.
 */
function sha256sum(path: string): string {
	const result = spawnSync("sha256sum", [path], { encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
	return result.stdout.trim().split(/\s+/)[0];
}

/** `--verify` in-process, both streams captured. */
function verify(argv: string[]): Captured {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = recordVerify(argv, {
		out: (chunk: string) => void stdout.push(chunk),
		err: (line: string) => void stderr.push(line),
	});
	return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("review-record — the emitted block", () => {
	it("renders the golden record byte for byte", () => {
		expect(renderRecord(spec())).toBe(GOLDEN);
	});

	it("writes the same bytes to stdout and to --out", () => {
		const out = scratch("golden.md");
		const result = write(argvFor({}, out));
		expect(result.code).toBe(EXIT.WRITTEN);
		expect(result.stdout).toBe(GOLDEN);
		expect(readFileSync(out, "utf8")).toBe(GOLDEN);
		// The record is private by mode, not by convention: 0600 inside a 0700 directory.
		expect(lstatSync(out).mode & 0o777).toBe(0o600);
	});

	it("is idempotent: a second run with identical inputs rewrites the identical file", () => {
		const out = scratch("idempotent.md");
		expect(write(argvFor({}, out)).code).toBe(EXIT.WRITTEN);
		const first = readFileSync(out, "utf8");
		const second = write(argvFor({}, out));
		expect(second.code).toBe(EXIT.WRITTEN);
		expect(second.stdout).toBe(GOLDEN);
		expect(readFileSync(out, "utf8")).toBe(first);
	});

	it("normalises one case per field, so the same review reads the same twice", () => {
		// The gate is case-insensitive; the artifact should not be. Uppercase in, canonical out.
		const out = scratch("canonical.md");
		expect(write(argvFor({ head: HEAD.toUpperCase(), risk: "c1" }, out)).code).toBe(EXIT.WRITTEN);
		expect(readFileSync(out, "utf8")).toBe(GOLDEN);
	});

	it("keeps the findings body verbatim and states the empty case explicitly", () => {
		expect(renderRecord(spec())).toContain(`## Findings\n\n${FINDINGS}\n`);
		expect(renderRecord(spec({ findings: "" }))).toContain("## Findings\n\nNo findings recorded.\n");
		// A trailing blank line in the body is not a second newline in the record: one '\n' ends it.
		expect(renderRecord(spec({ findings: "one line\n\n\n" }))).toContain("## Findings\n\none line\n");
	});

	it("counts findings without counting the conductor-verified marker", () => {
		const withMarker = renderRecord(spec({ findings: "one finding\n\nconductor-verified: ecb411a — a doc-only nit" }));
		expect(parseRecord(withMarker).findings).toBe(1);
		expect(parseRecord(renderRecord(spec({ findings: "one finding" }))).findings).toBe(1);
	});

	it("reads stdin when --findings is `-` (the reviewer has bash and no write tool)", () => {
		const out = scratch("stdin.md");
		const result = write(argvFor({ findings: "-" }, out), FINDINGS);
		expect(result.code).toBe(EXIT.WRITTEN);
		expect(readFileSync(out, "utf8")).toBe(GOLDEN);
	});

	it("carries a conductor-verified line when one is given, and it clears only with the head and evidence", () => {
		const out = scratch("conductor.md");
		const marker = `${NEXT.slice(0, 7)} — suite green on the final commit`;
		expect(write(argvFor({}, out, ["--conductor-verified", marker])).code).toBe(EXIT.WRITTEN);
		const record = readFileSync(out, "utf8");
		expect(record).toContain(`conductor-verified: ${marker}\n`);
		// #583: the marker is the post-verdict disposition, so it clears the POST-verdict head — not any head.
		expect(codes(record, { pr: "412", head: NEXT })).toEqual([]);
		expect(codes(record, { pr: "412", head: HEAD })).toEqual([]);
		// A marker with no sha names nothing, so it clears nothing: the record's own head (HEAD) does not
		// cover NEXT, and the marker cannot stand in for it.
		const bare = scratch("conductor-bare.md");
		expect(write(argvFor({}, bare, ["--conductor-verified", "suite green on the final commit"])).code).toBe(EXIT.WRITTEN);
		expect(codes(readFileSync(bare, "utf8"), { pr: "412", head: NEXT })).toEqual(["head-mismatch"]);
	});
});

/**
 * #583 / spec v2 §2.4 + v3 §2.4a — check (d) is a LINE, not a word, on BOTH head-aware surfaces. This is
 * the offline one: `node scripts/review-record.mjs --check --pr <n> --head <sha> <record>`, which is what
 * `merge-guard.sh --check-record` delegates to. The shell half of the same matrix lives in
 * `merge-guard.sh --selftest` (rows U2-1…U2-9); a row that passes one surface and fails the other is the
 * parity defect this unit exists to remove.
 *
 * Every fixture states an EARLIER `Reviewed head:` (the F01 shape: the verdict covers an old commit and a
 * later one landed), so the marker is the only path to (d) — which is exactly the case a prose mention
 * used to clear.
 */
describe("review-record — (d) is a line, not a word (#583)", () => {
	const STALE = "1111111111111111111111111111111111111111";

	let counter = 0;
	function check(text: string, head = HEAD): { code: number; out: string; err: string } {
		const path = scratch(`check-${(counter += 1)}.md`);
		writeFileSync(path, text);
		const out: string[] = [];
		const err: string[] = [];
		const code = recordCheck([path, "--pr", "412", "--head", head, "--shape-only"], { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) });
		return { code, out: out.join("\n"), err: err.join("\n") };
	}

	/** A record whose `Reviewed head:` names an earlier commit; `lines` is what is being pinned. */
	function record(lines: string[]): string {
		return ["# Review — PR #412", "", ...lines, "Verdict: approve", "Risk class: C1", `jev-recheck: ${RECHECK}`].join("\n");
	}

	const matrix: [string, string, number][] = [
		["U2-1 a marker for this head, with evidence, clears (d)", record([`Reviewed head: ${STALE}`, `conductor-verified: ${HEAD.slice(0, 7)} — tsc clean, suite 3296`]), EXIT.WRITTEN],
		["U2-2 a marker with no sha fails (d)", record([`Reviewed head: ${STALE}`, "conductor-verified: — tsc clean"]), EXIT.REFUSED],
		["U2-3 a marker for another commit fails (d)", record([`Reviewed head: ${STALE}`, `conductor-verified: ${NEXT.slice(0, 7)} — tsc clean`]), EXIT.REFUSED],
		["U2-4 a fenced marker fails (d)", record([`Reviewed head: ${STALE}`, "```", `conductor-verified: ${HEAD.slice(0, 7)} — tsc clean`, "```"]), EXIT.REFUSED],
		["U2-5 a prose mention of the marker fails (d)", record([`Reviewed head: ${STALE}`, "the token `conductor-verified:` means nothing here"]), EXIT.REFUSED],
		["U2-6 a marker with no evidence fails (d)", record([`Reviewed head: ${STALE}`, `conductor-verified: ${HEAD.slice(0, 7)} — !!!`]), EXIT.REFUSED],
		["U2-7 the head in prose only fails (d)", record([`The review covered ${HEAD} on the worktree branch.`]), EXIT.REFUSED],
		["U2-8 'Reviewed head:' alone clears (d)", record([`Reviewed head: ${HEAD.slice(0, 7)}`]), EXIT.WRITTEN],
		["U2-9 a fenced 'Reviewed head:' fails (d)", record(["```", `Reviewed head: ${HEAD.slice(0, 7)}`, "```"]), EXIT.REFUSED],
		["the label keeps its colon — 'Reviewed headlong:' is not the field", record([`Reviewed headlong: ${HEAD}`]), EXIT.REFUSED],
		["the title form clears (d)", ["# Review of PR #412 @ " + HEAD.slice(0, 7), "", "Verdict: approve", "Risk class: C1", `jev-recheck: ${RECHECK}`].join("\n"), EXIT.WRITTEN],
	];

	for (const [label, text, expected] of matrix) {
		it(label, () => {
			expect(check(text).code).toBe(expected);
		});
	}

	it("names head-mismatch with the three acceptable shapes, so the message teaches the format", () => {
		const result = check(record(["the token `conductor-verified:` means nothing here"]));
		expect(result.code).toBe(EXIT.REFUSED);
		expect(result.err).toContain("head-mismatch");
		expect(result.err).toContain("Reviewed head: ");
		expect(result.err).toContain("the title form");
		expect(result.err).toContain("conductor-verified: ");
	});

	/** spec v4 §C — the evidence grammar: two tokens, one with three LETTERS. A format check, not proof. */
	it("refuses the evidence shapes that carry no information", () => {
		for (const evidence of ["abc", "ab", "!!!", "a!! x", ""]) {
			const marker = `conductor-verified: ${HEAD.slice(0, 7)} — ${evidence}`.replace(/ — $/, "");
			expect(check(record([`Reviewed head: ${STALE}`, marker])).code, evidence || "bare sha").toBe(EXIT.REFUSED);
		}
	});

	it("accepts the documented evidence shapes", () => {
		for (const evidence of ["tsc: clean", "suite 3296/0 failed", "suite 90/1798, mutation-proven guard"]) {
			const result = check(record([`Reviewed head: ${STALE}`, `conductor-verified: ${HEAD.slice(0, 7)} — ${evidence}`]));
			expect(result.code, evidence).toBe(EXIT.WRITTEN);
		}
	});
});

describe("review-record — refusals (exit 1) and input errors (exit 2)", () => {
	it("refuses to re-mint a record that covers another head", () => {
		const out = scratch("mismatch.md");
		expect(write(argvFor({}, out)).code).toBe(EXIT.WRITTEN);
		const before = readFileSync(out, "utf8");
		const result = write(argvFor({ head: NEXT }, out));
		expect(result.code).toBe(EXIT.REFUSED);
		expect(result.stderr).toContain("head-mismatch");
		expect(result.stdout).toBe("");
		expect(readFileSync(out, "utf8")).toBe(before);
		// The refusal happens INSIDE the lock, so it must also release it — a refusal that left the
		// lock behind would wedge every later review of the same PR.
		expect(readdirSync(TMP).filter((name) => name.endsWith(".lock"))).toEqual([]);
	});

	it("supersedes that head under --new-head, keeping the chain readable", () => {
		const out = scratch("superseded.md");
		expect(write(argvFor({}, out)).code).toBe(EXIT.WRITTEN);
		expect(write(argvFor({ head: NEXT }, out, ["--new-head"])).code).toBe(EXIT.WRITTEN);
		const record = readFileSync(out, "utf8");
		expect(record).toContain(`Reviewed head: ${NEXT}\nSuperseded head: ${HEAD}\n`);
		expect(parseRecord(record).supersededHeads).toEqual([HEAD]);
		// Re-running the supersede is a no-op, not a second chain entry.
		expect(write(argvFor({ head: NEXT }, out, ["--new-head"])).code).toBe(EXIT.WRITTEN);
		expect(parseRecord(readFileSync(out, "utf8")).supersededHeads).toEqual([HEAD]);
	});

	it("refuses a declared Risk class weaker than the recheck — rule (f), caught at authoring time", () => {
		const out = scratch("weak.md");
		const result = write(argvFor({ risk: "C2", recheck: "jev: high (0.44) · C1 · worktree y" }, out));
		expect(result.code).toBe(EXIT.REFUSED);
		expect(result.stderr).toContain("risk-weaker-than-recheck");
		expect(() => readFileSync(out, "utf8")).toThrow();
	});

	it("refuses a findings body that would become the disposition the gate reads", () => {
		const out = scratch("shadow.md");
		const result = write(argvFor({ findings: "Notes.\nVerdict: changes-requested" }, out));
		expect(result.code).toBe(EXIT.REFUSED);
		expect(result.stderr).toContain("findings-overshadows-verdict");
		expect(() => readFileSync(out, "utf8")).toThrow();
	});

	it("rejects an out-of-vocabulary verdict, a non-hex head, a bad tier and a malformed recheck", () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ verdict: "looks-good" }, "invalid-verdict"],
			[{ head: "not-a-sha" }, "invalid-head"],
			[{ head: `${HEAD}a` }, "invalid-head"],
			[{ risk: "C4" }, "invalid-risk"],
			[{ recheck: "jev: medium · C1" }, "invalid-recheck"],
			[{ recheck: "jev: medium (0.63) · C1" }, "invalid-recheck"],
		];
		for (const [overrides, code] of cases) {
			const result = write(argvFor(overrides, scratch("bad-args.md")));
			expect(result.code, JSON.stringify(overrides)).toBe(EXIT.USAGE);
			expect(result.stderr).toContain(code);
		}
	});

	it("rejects an unknown flag and a missing --findings", () => {
		expect(write(["--pr", "412", "--nope", "x"]).code).toBe(EXIT.USAGE);
		expect(write(["--pr", "412"]).stderr).toContain("--findings");
	});
});

describe("review-record — the recheck line is RESOLVED from the ledger (#596)", () => {
	const LEDGER = join(LEDGERS, "recheck-592.log");
	const TWO = join(LEDGERS, "two-rows.log");
	const TRUNCATED = join(LEDGERS, "truncated.log");
	const EMPTY = join(LEDGERS, "empty.log");
	const SIX = join(LEDGERS, "three-and-six-column.log");
	const CRLF = join(LEDGERS, "crlf-mixed.log");
	const RECORD = join(LEDGERS, "p596-r592.md");
	const MUTATED = join(LEDGERS, "p596-r592-mutated.md");

	/** The generator's argv against a chosen ledger; `--out` is explicit unless a test wants the default. */
	function args(log: string, extra: string[] = [], out?: string): string[] {
		return [
			"--pr", "592", "--verdict", "approve", "--head", HEAD, "--risk", "C2",
			"--log", log, "--findings", "-",
			...(out === undefined ? [] : ["--out", out]),
			...extra,
		];
	}

	/** `--check` in-process, both streams captured, env/cwd seams explicit where a test needs them. */
	function check(argv: string[], io: Record<string, unknown> = {}) {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = recordCheck(argv, {
			out: (line: string) => void stdout.push(line),
			err: (line: string) => void stderr.push(line),
			...io,
		});
		return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
	}

	it("U1-1 resolves the newest recheck-592 row, and prints the ISO and ledger on stderr only", () => {
		const out = scratch("u1-1.md");
		const result = write(args(LEDGER, [], out));
		expect(result.code, result.stderr).toBe(EXIT.WRITTEN);
		expect(result.stdout).toContain("jev-recheck: jev: medium (0.87) · C2 · worktree n\n");
		// The row's ISO is the review-time classification instant — stderr, never the record's bytes.
		expect(result.stderr).toContain("2026-11-04T00:00:00.000Z");
		expect(result.stderr).toContain(LEDGER);
		expect(result.stdout).not.toContain("2026-11-04T00:00:00.000Z");
		expect(readFileSync(out, "utf8")).toBe(result.stdout);
	});

	it("U1-2 the NEWEST row wins, not the first", () => {
		const out = scratch("u1-2.md");
		const result = write(args(TWO, [], out));
		expect(result.code, result.stderr).toBe(EXIT.WRITTEN);
		expect(result.stdout).toContain("jev: medium (0.90)");
		expect(result.stdout).not.toContain("jev: medium (0.81)");
		expect(result.stderr).toContain("2026-11-04T00:00:05.000Z");
		expect(result.stderr).toContain("2 rows — the newest wins");
	});

	it("U1-3 no recheck row is exit 2 naming the label — and creates no directory before it refuses", () => {
		// No `--out`: the destination is the DEFAULT root, so a resolution moved below `ensureDir`
		// would leave `<root>/review-592` behind. The empty root is the assertion.
		const root = scratchDir("u1-3-root");
		const result = write(args(EMPTY), "", { root });
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.stderr).toContain("--label recheck-592");
		expect(result.stdout).toBe("");
		expect(list(root)).toEqual([]);
	});

	it("U1-4 a truncated row is exit 2 with the parser's line number; control: the intact fixture exits 0", () => {
		const broken = write(args(TRUNCATED, [], scratch("u1-4-broken.md")));
		expect(broken.code).toBe(EXIT.USAGE);
		expect(broken.stderr).toContain("provenance log line 2");
		expect(broken.stderr).toContain("malformed");
		expect(broken.stdout).toBe("");
		const intact = write(args(LEDGER, [], scratch("u1-4-ok.md")));
		expect(intact.code, intact.stderr).toBe(EXIT.WRITTEN);
	});

	it("U1-5 a relative --log and a missing ledger are both exit 2, and the message names --log", () => {
		// The dangerous shape: the relative name EXISTS next to the caller's cwd. A resolver that
		// joined it (mutant M4) would find a valid ledger and write; the refusal is by NAME, never
		// by "the file I guessed was not there".
		const cwd = scratchDir("u1-5-cwd");
		writeFileSync(join(cwd, "relative.log"), `2026-11-04T00:00:00.000Z\trecheck-592\t${RECHECK.replace("medium (0.63)", "medium (0.87)").replace("C1", "C2").replace("worktree y", "worktree n")}\n`);
		const relative = write(args("relative.log", [], scratch("u1-5-relative.md")), "", { cwd });
		expect(relative.code).toBe(EXIT.USAGE);
		expect(relative.stderr).toContain("--log");
		expect(relative.stderr).toContain("relative ledger names nothing");
		expect(relative.stdout).toBe("");
		const missing = write(args("/nonexistent/jev-lines.log", [], scratch("u1-5-missing.md")));
		expect(missing.code).toBe(EXIT.USAGE);
		expect(missing.stderr).toContain("--log");
		expect(missing.stderr).toContain("/nonexistent/jev-lines.log");
	});

	it("U1-6 --recheck is refused by name (exit 2), and PR 0 has no label to bind", () => {
		const gone = write([...args(LEDGER, [], scratch("u1-6.md")), "--recheck", RECHECK]);
		expect(gone.code).toBe(EXIT.USAGE);
		expect(gone.stderr).toContain("--recheck is gone (#596)");
		expect(gone.stdout).toBe("");
		const zero = write(["--pr", "0", "--verdict", "approve", "--head", HEAD, "--risk", "C2", "--findings", "-"]);
		expect(zero.code).toBe(EXIT.USAGE);
		expect(zero.stderr).toContain("invalid-pr");
	});

	it("U1-7 the same head with a DIFFERENT resolved line is refused, naming both lines and the record", () => {
		const out = scratch("u1-7.md");
		expect(write(args(LEDGER, [], out)).code).toBe(EXIT.WRITTEN);
		const before = readFileSync(out, "utf8");
		const changed = scratch("u1-7-other.log");
		writeFileSync(changed, "2026-11-04T00:00:09.000Z\trecheck-592\tjev: medium (0.91) · C2 · worktree n\n");
		const refused = write(args(changed, [], out));
		expect(refused.code).toBe(EXIT.REFUSED);
		expect(refused.stderr).toContain("line-mismatch");
		expect(refused.stderr).toContain("0.87");
		expect(refused.stderr).toContain("0.91");
		expect(refused.stderr).toContain(out);
		expect(refused.stdout).toBe("");
		expect(readFileSync(out, "utf8")).toBe(before);
		// There is no override: `--new-head` is for a head that MOVED, not for a second line here.
		expect(write(args(changed, ["--new-head"], out)).code).toBe(EXIT.REFUSED);
		// Control: the identical ledger is idempotent, byte for byte, and leaves no lock behind.
		const again = write(args(LEDGER, [], out));
		expect(again.code, again.stderr).toBe(EXIT.WRITTEN);
		expect(again.stdout).toBe(before);
		expect(readdirSync(dirname(out)).filter((name) => name.endsWith(".lock"))).toEqual([]);
	});

	it("U1-8 --check binds the record's line to ANY row: mutated exit 1, original exit 0", () => {
		const ok = check([RECORD, "--pr", "592", "--log", LEDGER]);
		expect(ok.code, ok.stderr).toBe(EXIT.WRITTEN);
		const mutated = check([MUTATED, "--pr", "592", "--log", LEDGER]);
		expect(mutated.code).toBe(EXIT.REFUSED);
		expect(mutated.stderr).toContain("no provenance row");
		expect(mutated.stdout).toBe("");
		// ANY row, not the newest: the 0.81 record binds to the first of two rows and passes.
		const older = scratch("u1-8-older.md");
		writeFileSync(older, readFileSync(RECORD, "utf8").replace("(0.87)", "(0.81)"));
		expect(check([older, "--pr", "592", "--log", TWO]).code).toBe(EXIT.WRITTEN);
		// A label mismatch is a row that is not there: #591's record against the recheck-592 ledger.
		const otherPr = scratch("u1-8-591.md");
		writeFileSync(otherPr, readFileSync(RECORD, "utf8").replace("#592", "#591"));
		const wrongLabel = check([otherPr, "--pr", "591", "--log", LEDGER]);
		expect(wrongLabel.code).toBe(EXIT.REFUSED);
		expect(wrongLabel.stderr).toContain("no provenance row");
		expect(wrongLabel.stderr).toContain("recheck-591");
	});

	it("U1-9 merge-guard --check-record forwards --provenance and --shape-only", () => {
		const bad = spawnSync("bash", [GUARD, "--check-record", MUTATED, "--pr", "592", "--provenance", LEDGER], { encoding: "utf8" });
		expect(bad.status, bad.stderr).toBe(EXIT.REFUSED);
		expect(bad.stderr).toContain("no provenance row");
		const good = spawnSync("bash", [GUARD, "--check-record", RECORD, "--pr", "592", "--provenance", LEDGER], { encoding: "utf8" });
		expect(good.status, good.stderr).toBe(EXIT.WRITTEN);
		// --shape-only is the pre-#596 output, byte for byte: the same stdout as the tool's own
		// shape-only run, and no ledger read at all (the mutated record passes it).
		const shape = spawnSync("bash", [GUARD, "--check-record", MUTATED, "--pr", "592", "--shape-only"], { encoding: "utf8" });
		expect(shape.status, shape.stderr).toBe(EXIT.WRITTEN);
		const base = spawnSync(process.execPath, [TOOL, "--check", MUTATED, "--pr", "592", "--shape-only"], { encoding: "utf8" });
		expect(shape.stdout).toBe(base.stdout);
	});

	it("U1-10 --log without --pr is exit 2 naming --pr; a relative --log is exit 2 too", () => {
		const noPr = check([RECORD, "--log", LEDGER]);
		expect(noPr.code).toBe(EXIT.USAGE);
		expect(noPr.stderr).toContain("--pr");
		const relative = check([RECORD, "--pr", "592", "--log", "relative.log"]);
		expect(relative.code).toBe(EXIT.USAGE);
		expect(relative.stderr).toContain("relative ledger names nothing");
	});

	it("a six-column ledger row binds like a three-column one", () => {
		// U0-3's corpus, asked through U1's two questions: the parser reads all six columns, and
		// `matchRow` needs only the first three.
		const out = scratch("six-columns.md");
		const written = write(args(SIX, [], out));
		expect(written.code, written.stderr).toBe(EXIT.WRITTEN);
		expect(written.stdout).toContain("jev: medium (0.88)");
		expect(check([out, "--pr", "592", "--log", SIX]).code).toBe(EXIT.WRITTEN);
	});

	it("a CRLF row resolves in the parser but is refused before it can mint an unmatched record", () => {
		// The parser trims and `matchRow` does not (the gate matched awk's bytes), so a CRLF row is a
		// row the gate cannot find. The writer asks the gate's question before it writes, rather than
		// emitting a record that only fails at the merge point.
		const refused = write(args(CRLF, [], scratch("crlf.md")));
		expect(refused.code).toBe(EXIT.USAGE);
		expect(refused.stderr).toContain("cannot bind");
		expect(refused.stderr).toContain("--label recheck-592");
	});

	it("a missing row is exit 2 when the ledger is not given and the cwd default is absent", () => {
		// Decision 1: no discovery. With no --log and no JEV_PROVENANCE the path is
		// `<cwd>/.pi/jev-lines.log`; an empty cwd (`env: {}`) has no such file, and the message names --log.
		const cwd = scratchDir("u1-empty-cwd");
		const io = { env: {}, cwd };
		const generated = write(["--pr", "592", "--verdict", "approve", "--head", HEAD, "--risk", "C2", "--findings", "-"], "", io);
		expect(generated.code).toBe(EXIT.USAGE);
		expect(generated.stderr).toContain("--log");
		expect(generated.stderr).toContain(join(cwd, ".pi", "jev-lines.log"));
		expect(list(cwd)).toEqual([]);
	});
});

describe("review-record — the gate's rules, one definition", () => {
	it("parses the field rules the way the bash gate does", () => {
		const record = [
			"# Review — PR #412",
			"",
			"**Verdict: approve** — decorated on purpose.",
			"",
			"```",
			"Verdict: changes-requested",
			"```",
			`Reviewed head: ${HEAD.slice(0, 7)}`,
			`jev-recheck: ${RECHECK}`,
			"Risk class: C1",
		].join("\n");
		const facts = parseRecord(record);
		expect(facts.verdict).toBe("approve");
		expect(facts.head).toBe(HEAD.slice(0, 7));
		expect(facts.prs).toEqual([412]);
		expect(recordLines("a\n```\nb\n```\nc")).toEqual(["a", "c"]);
		// A >=7-char prefix of the head is the head; an unrelated sha is not.
		expect(codes(record, { pr: "412", head: HEAD })).toEqual([]);
		expect(codes(record, { pr: "412", head: NEXT })).toContain("head-mismatch");
	});

	it("reads a bulleted disposition as no disposition (the #446/#455/#457 class)", () => {
		const record = `# Review — PR #412\n\n- Verdict: approve\n\nReviewed head: ${HEAD}\n\njev-recheck: ${RECHECK}\nRisk class: C1\n`;
		expect(codes(record)).toEqual(["missing-verdict"]);
	});

	it("S4 (#484): a record with no jev-recheck line is rejected as missing-recheck", () => {
		expect(codes(fixture("s4-no-recheck"), { pr: "484" })).toEqual(["missing-recheck"]);
	});

	it("S5 (#485): Risk class and jev-recheck fused on one line lose BOTH fields", () => {
		expect(codes(fixture("s5-fused-fields"), { pr: "485" })).toEqual(["missing-recheck", "malformed-risk"]);
	});

	it("S6 (#486): a findings bank with no PR number and no disposition fails naming both", () => {
		expect(codes(fixture("s6-findings-bank"), { pr: "486" })).toEqual([
			"wrong-pr",
			"missing-verdict",
			"missing-recheck",
			"malformed-risk",
		]);
	});

	it("verifyRendered is the same rules plus the spec it was asked to write", () => {
		expect(verifyRendered(GOLDEN, spec())).toEqual([]);
		const drifted = verifyRendered(GOLDEN, spec({ risk: "C2" }));
		expect(drifted.map((item: { code: string }) => item.code)).toEqual(["findings-overshadows-risk"]);
	});

	it("reports rather than fails a changes-requested record: that one must still be writable", () => {
		const out = scratch("changes-requested.md");
		expect(write(argvFor({ verdict: "changes-requested" }, out)).code).toBe(EXIT.WRITTEN);
		const stdout: string[] = [];
		expect(recordCheck([out], { out: (line: string) => void stdout.push(line), err: () => {} })).toBe(EXIT.WRITTEN);
		expect(stdout.join("")).toContain("the gate blocks the merge");
	});
});

describe("review-record — --verify: the record file is the proof (#503)", () => {
	// Generated once for the block: the file a reviewer would hand over and the conductor recompute.
	const out = scratch("verify.md");
	write(argvFor({}, out));
	// The exact U2 artifact: hand-written, `Reviewed head:` 41 characters long.
	const mangled = scratch("verify-head41.md");
	writeFileSync(mangled, GOLDEN.replace(`Reviewed head: ${HEAD}`, `Reviewed head: ${HEAD}a`));

	it("prints one line a third party recomputes: path, verdict, head, findings, sha256", () => {
		const result = verify([out]);
		expect(result.code).toBe(EXIT.WRITTEN);
		expect(result.stderr).toBe("");
		const parsed = /^record: (.*) · verdict (\S+) · head (\S+) · findings (\S+) · sha256 (\S+)$/.exec(result.stdout);
		expect(parsed, result.stdout).not.toBeNull();
		const [, path, verdict, head, findings, sha] = parsed as RegExpExecArray;
		expect(path).toBe(out);
		expect(verdict).toBe("approve-with-nits");
		expect(head).toBe(HEAD);
		expect(findings).toBe("2");
		// sha256sum <path> — the conductor's one command, and the only reason the line is evidence.
		expect(sha).toBe(sha256sum(out));
	});

	it("gives one changed byte in the findings a different sha (and counts the new row)", () => {
		const changed = scratch("verify-changed.md");
		const extra = "| nit | `oversized-file` | `scripts/lib/record-fields.mjs:9` | one more row |";
		write(argvFor({ findings: `${FINDINGS}\n${extra}` }, changed));
		const before = verify([out]);
		const after = verify([changed]);
		expect(after.code).toBe(EXIT.WRITTEN);
		expect(after.stdout).not.toBe(before.stdout);
		expect(after.stdout).toContain("findings 3");
		expect(after.stdout.endsWith(`sha256 ${sha256sum(changed)}`)).toBe(true);
		expect(sha256sum(changed)).not.toBe(sha256sum(out));
	});

	it("exits 1 with the head reason on the U2 artifact: a 41-character head", () => {
		const result = verify([mangled]);
		expect(result.code).toBe(EXIT.REFUSED);
		expect(result.stderr).toContain("invalid-head");
		expect(result.stderr).toContain("41 characters");
		expect(result.stdout).toBe("");
		// The CLI reports the same code and reason — that is the exit a conductor's one-liner sees.
		const cli = spawnSync(process.execPath, [TOOL, "--verify", mangled], { encoding: "utf8" });
		expect(cli.status).toBe(1);
		expect(cli.stderr).toContain("invalid-head");
	});

	it("exits 2 naming the RESOLVED path when the file is not there (no file, no claim)", () => {
		const missing = join(TMP, "never-written.md");
		// The same file named with a `..` detour (built as text: `join` would normalise it away):
		// the message must print the resolved path, because the conductor recomputes the sha from it.
		const given = `${TMP}/../${basename(TMP)}/never-written.md`;
		expect(given).not.toBe(missing);
		const result = verify([given]);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.stderr).toContain(missing);
		expect(result.stderr).not.toContain("..");
		expect(result.stdout).toBe("");
		expect(spawnSync(process.execPath, [TOOL, "--verify", given], { encoding: "utf8" }).status).toBe(2);
	});

	it("--json is one object carrying the same facts, and the reasons on a refusal", () => {
		const ok = verify([out, "--json"]);
		expect(ok.code).toBe(EXIT.WRITTEN);
		expect(JSON.parse(ok.stdout)).toEqual({
			ok: true,
			path: out,
			verdict: "approve-with-nits",
			head: HEAD,
			findings: 2,
			sha256: sha256sum(out),
			reasons: [],
		});
		const bad = verify([mangled, "--json"]);
		const payload = JSON.parse(bad.stdout);
		expect(bad.code).toBe(EXIT.REFUSED);
		expect(payload.ok).toBe(false);
		expect(payload.path).toBe(mangled);
		expect(payload.sha256).toBe(sha256sum(mangled));
		expect(payload.reasons.map((reason: { code: string }) => reason.code)).toEqual(["invalid-head"]);
	});

	it("counts findings from the one definition: rows, not the table header; the empty sentinel is zero", () => {
		const none = scratch("verify-none.md");
		write(argvFor({ findings: "" }, none));
		expect(verify([none]).stdout).toContain("findings 0");
		// Same definition, other reader: the count comes off parseRecord, not a second implementation.
		expect(parseRecord(readFileSync(none, "utf8")).findings).toBe(0);
		expect(parseRecord(readFileSync(out, "utf8")).findings).toBe(2);
	});

	it("rejects a missing path and an unknown flag as usage (exit 2)", () => {
		const none = verify([]);
		expect(none.code).toBe(EXIT.USAGE);
		expect(none.stderr).toContain("missing the record path");
		const unknown = verify([out, "--nope"]);
		expect(unknown.code).toBe(EXIT.USAGE);
		expect(unknown.stderr).toContain("unknown argument: --nope");
	});
});

describe("review-record — the acceptance run (no network, no gh)", () => {
	const out = scratch("acceptance.md");
	write(argvFor({}, out));
	// #596: the record's line is bound to a `recheck-412` row, so the offline half is given the
	// ledger the writer resolved from — the same row, the same bytes.
	const LEDGER = scratch("acceptance-ledger.log");
	writeFileSync(LEDGER, `2026-11-04T00:00:00.000Z\trecheck-412\t${RECHECK}\n`);

	it("a generated record passes merge-guard.sh --check-record", () => {
		const result = spawnSync(
			"bash",
			[GUARD, "--check-record", out, "--pr", "412", "--head", HEAD, "--provenance", LEDGER],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("record-check: OK");
	});

	it("the same mode rejects a historical shape, so the acceptance run can fail", () => {
		const result = spawnSync("bash", [GUARD, "--check-record", join(FIXTURES, "s6-findings-bank.md")], { encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("missing-verdict");
	});

	it("exits 2 on an unreadable record and on no record at all", () => {
		expect(spawnSync("bash", [GUARD, "--check-record", join(TMP, "absent.md")], { encoding: "utf8" }).status).toBe(2);
		expect(spawnSync("bash", [GUARD, "--check-record"], { encoding: "utf8" }).status).toBe(2);
	});

	it("is the tool the reviewer runs: the CLI writes what the module renders", () => {
		const cliOut = scratch("cli.md");
		const result = spawnSync(process.execPath, [TOOL, ...argvFor({}, cliOut)], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(GOLDEN);
		expect(readFileSync(cliOut, "utf8")).toBe(GOLDEN);
		const checked = spawnSync(process.execPath, [TOOL, "--check", cliOut, "--pr", "412", "--log", LEDGER], { encoding: "utf8" });
		expect(checked.status).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// #512 — the record lives in a private root, and every write path takes the lock
// ---------------------------------------------------------------------------

/** A helper script the probes spawn; written once, so both probes use the same one. */
function helperScript(name: string, lines: string[]): string {
	const path = scratch(name);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

/** The delayed writer: take the lock, READ the prior record, sleep, then write a stale body. */
const DELAYED_WRITER = helperScript("delayed-writer.mjs", [
	'import { readFileSync } from "node:fs";',
	`import { acquireLock, atomicReplace, readRegular } from ${JSON.stringify(pathToFileURL(LIB).href)};`,
	"const [dir, name, delayMs, bodyPath] = process.argv.slice(2);",
	'const target = dir + "/" + name;',
	"const held = acquireLock(dir, name, { root: dir });",
	'if (!held.ok) { process.stderr.write(held.code + "\\n"); process.exit(3); }',
	"const prior = readRegular(target, { root: dir });",
	'const text = prior.ok ? prior.bytes.toString("utf8") : "";',
	"const match = /Reviewed head: (\\w+)/.exec(text);",
	'process.stdout.write("read:" + (match ? match[1] : "none") + "\\n");',
	"await new Promise((resolve) => setTimeout(resolve, Number(delayMs)));",
	'atomicReplace(dir, target, readFileSync(bodyPath, "utf8"), { root: dir });',
	"held.release();",
]);

/** The holder that dies between acquiring the lock and replacing the record. */
const KILLED_HOLDER = helperScript("killed-holder.mjs", [
	`import { acquireLock } from ${JSON.stringify(pathToFileURL(LIB).href)};`,
	"const [dir, name] = process.argv.slice(2);",
	"const held = acquireLock(dir, name, { root: dir });",
	'if (!held.ok) { process.stderr.write(held.code + "\\n"); process.exit(3); }',
	'process.kill(process.pid, "SIGKILL");',
]);

/** Spawn a helper, collecting both streams; `onLine` sees each stdout line as it arrives. */
function spawnHelper(script: string, args: string[], onLine?: (line: string) => void) {
	const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
	const stderr: string[] = [];
	let pending = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		pending += chunk;
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) onLine?.(line);
	});
	child.stderr.on("data", (chunk: string) => void stderr.push(chunk));
	const done = new Promise<{ status: number | null; signal: string | null }>((resolve) => {
		child.on("close", (status, signal) => resolve({ status, signal }));
	});
	return { child, done, stderr };
}

describe("review-record — the private root replaces /tmp (#512)", () => {
	const PR = "990512";

	it("writes <root>/review-<pr>/REVIEW_<pr>.md at 0600 in a 0700 directory, and verifies there", () => {
		const file = recordPath(PR);
		// A stale directory from an interrupted run must not decide this test.
		rmSync(dirname(file), { recursive: true, force: true });
		try {
			const written = cliRun(argvDefault({ pr: PR }));
			expect(written.status, written.stderr).toBe(EXIT.WRITTEN);
			expect(file).toContain(join(".cache", "brl-subagent", `review-${PR}`));
			expect(lstatSync(dirname(file)).mode & 0o777).toBe(0o700);
			expect(lstatSync(file).mode & 0o777).toBe(0o600);
			// Not the worktree: removing the worktree cannot take the record with it.
			expect(relative(ROOT, file).startsWith("..")).toBe(true);

			const verified = cliRun(["--verify", file]);
			expect(verified.status).toBe(EXIT.WRITTEN);
			expect(verified.stdout).toContain(`record: ${file}`);

			// The record's identity is the PR: a second review meets the same prior record and the
			// same supersede chain, on the default path as much as on an explicit one.
			expect(cliRun(argvDefault({ pr: PR, head: NEXT }, ["--new-head"])).status).toBe(EXIT.WRITTEN);
			expect(parseRecord(readFileSync(file, "utf8")).supersededHeads).toEqual([HEAD]);
		} finally {
			rmSync(dirname(file), { recursive: true, force: true });
		}
	});

	it("refuses an --out in a directory others can write, naming the private default", () => {
		const open = scratchDir("open-dir");
		chmodSync(open, 0o777);
		try {
			const result = cliRun(argvFor({ pr: "783" }, join(open, "REVIEW_783.md")));
			expect(result.status).toBe(EXIT.REFUSED);
			expect(result.stderr).toContain("ancestor-writable");
			expect(result.stderr).toContain(recordPath("783"));
			expect(list(open)).toEqual([]);
		} finally {
			chmodSync(open, 0o700);
		}
	});

	it.runIf((lstatSync(tmpdir()).mode & 0o022) !== 0)("refuses the old /tmp record path, by name", () => {
		const result = cliRun(argvFor({ pr: "784" }, join(tmpdir(), "REVIEW_784.md")));
		expect(result.status).toBe(EXIT.REFUSED);
		expect(result.stderr).toContain("ancestor-writable");
		expect(result.stderr).toContain(recordPath("784"));
	});

	it("still verifies a legacy record OUTSIDE the private root: reading stays unrestricted", () => {
		const legacyDir = mkdtempSync(join(tmpdir(), "brl-legacy-"));
		try {
			const legacy = join(legacyDir, "REVIEW_412.md");
			writeFileSync(legacy, GOLDEN);
			const verified = cliRun(["--verify", legacy]);
			expect(verified.status).toBe(EXIT.WRITTEN);
			expect(verified.stdout).toContain(`record: ${legacy}`);
			// Reading is unrestricted (#512): a legacy record outside the private root still verifies.
			// `--shape-only` here because this row is about the PATH, not about a ledger row.
			expect(cliRun(["--check", legacy, "--pr", "412", "--shape-only"]).status).toBe(EXIT.WRITTEN);
		} finally {
			rmSync(legacyDir, { recursive: true, force: true });
		}
	});
});

describe("review-record — an --out on a tmpfs is warned about, never refused (#518)", () => {
	const TMPFS = { statfs: () => ({ type: TMPFS_MAGIC }), platform: "linux" };

	it("prints one warning on stderr, leaves stdout byte-identical to the record, and still exits 0", () => {
		const dir = scratchDir("out-tmpfs");
		const file = join(dir, "REVIEW_518.md");
		const result = write(argvFor({ pr: "518" }, file), "", TMPFS);

		expect(result.code, result.stderr).toBe(EXIT.WRITTEN);
		// Exactly one, and it names the probed directory: the warning is a line, not a paragraph.
		const warnings = result.stderr.split("\n").filter((line) => line.startsWith("review-record: warning: "));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(dir);
		expect(warnings[0]).toContain("tmpfs");
		// stdout IS the record: a warning printed there would land in the pasted block.
		expect(result.stdout).not.toContain("warning");
		expect(result.stdout).toBe(readFileSync(file, "utf8"));
	});

	it("says nothing when the destination's filesystem is not a tmpfs", () => {
		const dir = scratchDir("out-ext4");
		const file = join(dir, "REVIEW_519.md");
		const result = write(argvFor({ pr: "519" }, file), "", { statfs: () => ({ type: 0xef53 }), platform: "linux" });

		expect(result.code, result.stderr).toBe(EXIT.WRITTEN);
		expect(result.stderr).not.toContain("warning:");
		expect(result.stdout).toBe(readFileSync(file, "utf8"));
	});

	it("says nothing for the DEFAULT destination even when the probe would report a tmpfs", () => {
		// The ladder's other half: `ensureRoot` refuses a tmpfs root, so the default branch can never
		// reach a destination that carries a warning.
		const root = scratchDir("default-tmpfs-root");
		const result = write(argvDefault({ pr: "520" }), "", { root, ...TMPFS });
		expect(result.code).toBe(EXIT.REFUSED);
		expect(result.stderr).toContain("tmpfs");
		expect(result.stderr).not.toContain("warning:");
		expect(result.stdout).toBe("");
	});
});

describe("review-record — every write path takes the lock (#512)", () => {
	it("refuses a held lock with the holder's evidence, and changes nothing", () => {
		const dir = scratchDir("held-lock");
		const file = join(dir, "REVIEW_785.md");
		const held = acquireLock(dir, basename(file), { root: dir });
		if (!held.ok) throw new Error(held.message ?? held.code);
		try {
			// `timeoutMs: 0` is the seam: the CLI polls for 2 s by default, which a unit test should
			// not pay for when the evidence — not the waiting — is what is under test.
			const result = write(argvFor({ pr: "785" }, file), "", { lock: { timeoutMs: 0 } });
			expect(result.code).toBe(EXIT.REFUSED);
			expect(result.stderr).toContain("lock-held");
			expect(result.stderr).toContain(`pid ${process.pid}`);
			expect(result.stdout).toBe("");
			expect(list(dir)).toEqual([basename(lockPath(dir, basename(file)))]);
			expect(readFileSync(lockPath(dir, basename(file)), "utf8")).toContain(`"pid":${process.pid}`);
		} finally {
			held.release();
		}
	});

	it("serializes two concurrent generator runs: one wins, the other serializes or names lock-held", async () => {
		const dir = scratchDir("concurrent");
		const name = "REVIEW_786.md";
		const file = join(dir, name);
		const args = argvFor({ pr: "786" }, file);
		const runOnce = () =>
			new Promise<{ status: number; stderr: string }>((resolve) => {
				const child = spawn(process.execPath, [TOOL, ...args], { stdio: ["ignore", "ignore", "pipe"] });
				let stderr = "";
				child.stderr.setEncoding("utf8");
				child.stderr.on("data", (chunk: string) => void (stderr += chunk));
				child.on("close", (status) => resolve({ status: status ?? -1, stderr }));
			});
		const runs = await Promise.all([runOnce(), runOnce()]);
		expect(runs.map((run) => run.status)).toContain(EXIT.WRITTEN);
		for (const run of runs) {
			if (run.status === EXIT.WRITTEN) continue;
			expect(run.stderr).toContain("lock-held");
		}
		// No half-written record, no lost head, and nothing left behind.
		expect(readFileSync(file, "utf8")).toBe(renderRecord(spec({ pr: "786" })));
		expect(list(dir)).toEqual([name]);
	});

	it("a delayed writer cannot erase a committed supersede — it queues on the lock", async () => {
		const dir = scratchDir("delayed");
		const name = "REVIEW_787.md";
		const file = join(dir, name);
		// What is on disk when the delayed writer starts: head A.
		expect(cliRun(argvFor({ pr: "787" }, file)).status).toBe(EXIT.WRITTEN);
		const staleBody = scratch("delayed-body.md");
		writeFileSync(staleBody, renderRecord(spec({ pr: "787" })));

		let announce: (line: string) => void = () => {};
		const readSeen = new Promise<string>((resolve) => {
			announce = resolve;
		});
		const helper = spawnHelper(DELAYED_WRITER, [dir, name, "400", staleBody], (line) => {
			if (line.startsWith("read:")) announce(line);
		});
		// The child holds the lock and has read head A. The supersede starts NOW — and must wait.
		const readLine = await readSeen;
		expect(readLine).toContain(HEAD);
		const superseded = cliRun(argvFor({ pr: "787", head: NEXT }, file, ["--new-head"]));
		expect(superseded.status, superseded.stderr).toBe(EXIT.WRITTEN);
		expect((await helper.done).status).toBe(0);

		// Unlocked, this is the round-3 probe's erased head: A read, B committed, A written last.
		const finalText = readFileSync(file, "utf8");
		expect(parseRecord(finalText).head).toBe(NEXT);
		expect(parseRecord(finalText).supersededHeads).toEqual([HEAD]);
		expect(list(dir)).toEqual([name]);
	});

	it("a SIGKILLed holder is reported with pid and boot evidence; only --break-lock --yes recovers it", async () => {
		const dir = scratchDir("killed");
		const name = "REVIEW_788.md";
		const file = join(dir, name);
		const helper = spawnHelper(KILLED_HOLDER, [dir, name]);
		const pid = helper.child.pid as number;
		expect((await helper.done).signal).toBe("SIGKILL");
		expect(list(dir)).toEqual([`.${name}.lock`]);

		// 1. The next writer reports the holder and refuses — it does NOT remove the lock.
		const blocked = cliRun(argvFor({ pr: "788" }, file));
		expect(blocked.status).toBe(EXIT.REFUSED);
		expect(blocked.stderr).toContain("lock-held");
		expect(blocked.stderr).toContain(`pid ${pid}`);
		expect(blocked.stderr).toContain("boot ");
		expect(blocked.stderr).toContain("gone (pid-not-alive)");
		expect(list(dir)).toEqual([`.${name}.lock`]);

		// 2. Without --yes, --break-lock prints the evidence and refuses.
		const unconfirmed = cliRun(["--break-lock", file]);
		expect(unconfirmed.status).toBe(EXIT.REFUSED);
		expect(unconfirmed.stderr).toContain(`pid ${pid}`);
		expect(unconfirmed.stderr).toContain("--yes");
		expect(list(dir)).toEqual([`.${name}.lock`]);

		// 3. With --yes and evidence of staleness, it unlinks and says what it removed.
		const confirmed = cliRun(["--break-lock", file, "--yes"]);
		expect(confirmed.status, confirmed.stderr).toBe(EXIT.WRITTEN);
		expect(confirmed.stdout).toContain(`pid ${pid}`);
		expect(list(dir)).toEqual([]);

		// 4. The writer proceeds.
		expect(cliRun(argvFor({ pr: "788" }, file)).status).toBe(EXIT.WRITTEN);
		expect(parseRecord(readFileSync(file, "utf8")).head).toBe(HEAD);
		expect(list(dir)).toEqual([name]);
	});

	it("--break-lock refuses a live holder even with --yes, and reports a lock that is not there", () => {
		const dir = scratchDir("live");
		const name = "REVIEW_789.md";
		const file = join(dir, name);
		const capture = () => {
			const stdout: string[] = [];
			const stderr: string[] = [];
			const io = {
				out: (line: string) => void stdout.push(line),
				err: (line: string) => void stderr.push(line),
			};
			return { io, stdout, stderr };
		};
		const none = capture();
		expect(recordBreakLock([file], none.io)).toBe(EXIT.REFUSED);
		expect(none.stderr.join("\n")).toContain("no-lock");

		const held = acquireLock(dir, name, { root: dir });
		if (!held.ok) throw new Error(held.message ?? held.code);
		try {
			const live = capture();
			expect(recordBreakLock([file, "--yes"], live.io)).toBe(EXIT.REFUSED);
			expect(live.stderr.join("\n")).toContain("live holder is never removed");
			expect(live.stderr.join("\n")).toContain(`pid ${process.pid}`);
			expect(list(dir)).toEqual([`.${name}.lock`]);
		} finally {
			held.release();
		}
		expect(recordBreakLock([], { out: () => {}, err: () => {} })).toBe(EXIT.USAGE);
		expect(recordBreakLock([file, "--nope"], { out: () => {}, err: () => {} })).toBe(EXIT.USAGE);
	});

	it("never mistakes a leftover temporary file for a record", () => {
		const dir = scratchDir("leftover");
		const name = "REVIEW_790.md";
		const file = join(dir, name);
		const residue = join(dir, `.${name}.tmp-999999-deadbeef`);
		writeFileSync(residue, "not a record\n");
		expect(cliRun(argvFor({ pr: "790" }, file)).status).toBe(EXIT.WRITTEN);
		expect(readFileSync(file, "utf8")).toBe(renderRecord(spec({ pr: "790" })));
		// The residue is neither read as prior state nor cleaned up by someone else's write.
		expect(list(dir)).toEqual([`.${name}.tmp-999999-deadbeef`, name].sort());
		expect(cliRun(["--check", residue]).status).toBe(EXIT.REFUSED);
	});
});
