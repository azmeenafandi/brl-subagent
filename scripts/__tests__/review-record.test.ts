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
 *    `merge-guard.sh --check-record` (the acceptance criterion: no network, no `gh`).
 *
 * Every fixture lives in `scripts/__tests__/fixtures/review-records/` as a `.md` file: a shape that
 * cost a merge is worth grepping for, and an `.md` is invisible to the `scripts` surface's LOC
 * ceiling (which counts `.mjs` sources and `.ts` tests).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRecord, parseRecord, recordLines, renderRecord, verifyRendered } from "../lib/record-fields.mjs";
import { EXIT, recordCheck, writeRecord } from "../review-record.mjs";

const ROOT = process.cwd();
const TOOL = join(ROOT, "scripts", "review-record.mjs");
const GUARD = join(ROOT, ".pi", "skills", "worktree", "merge-guard.sh");
const FIXTURES = join(ROOT, "scripts", "__tests__", "fixtures", "review-records");
const TMP = mkdtempSync(join(tmpdir(), "brl-review-record-"));

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
function write(argv: string[], stdin = ""): Captured {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = writeRecord(argv, {
		out: (chunk: string) => void stdout.push(chunk),
		err: (line: string) => void stderr.push(line),
		readStdin: () => stdin,
	});
	return { code, stdout: stdout.join(""), stderr: stderr.join("\n") };
}

/** The generator's argv for a spec, with `--out` pointed at a scratch file. */
let findingsCounter = 0;
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
		"--recheck",
		String(value.recheck),
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

function codes(text: string, options: { pr?: string; head?: string } = {}): string[] {
	return checkRecord(text, options).map((item: { code: string }) => item.code);
}

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, `${name}.md`), "utf8");
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

	it("reads stdin when --findings is `-` (the reviewer has bash and no write tool)", () => {
		const out = scratch("stdin.md");
		const result = write(argvFor({ findings: "-" }, out), FINDINGS);
		expect(result.code).toBe(EXIT.WRITTEN);
		expect(readFileSync(out, "utf8")).toBe(GOLDEN);
	});

	it("carries a conductor-verified line when one is given", () => {
		const out = scratch("conductor.md");
		expect(write(argvFor({}, out, ["--conductor-verified", "suite green on the final commit"])).code).toBe(EXIT.WRITTEN);
		const record = readFileSync(out, "utf8");
		expect(record).toContain("conductor-verified: suite green on the final commit\n");
		expect(codes(record, { pr: "412", head: NEXT })).toEqual([]);
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

describe("review-record — the acceptance run (no network, no gh)", () => {
	const out = scratch("acceptance.md");
	write(argvFor({}, out));

	it("a generated record passes merge-guard.sh --check-record", () => {
		const result = spawnSync("bash", [GUARD, "--check-record", out, "--pr", "412", "--head", HEAD], { encoding: "utf8" });
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
		const checked = spawnSync(process.execPath, [TOOL, "--check", cliOut, "--pr", "412"], { encoding: "utf8" });
		expect(checked.status).toBe(0);
	});
});
