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
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRecord, parseRecord, recordLines, renderRecord, verifyRendered } from "../lib/record-fields.mjs";
import { EXIT, recordCheck, recordVerify, writeRecord } from "../review-record.mjs";

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
