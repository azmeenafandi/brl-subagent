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
import { acquireLock, lockPath, recordPath } from "../lib/scratch-root.mjs";
import { EXIT, recordBreakLock, recordCheck, recordVerify, writeRecord } from "../review-record.mjs";

const ROOT = process.cwd();
const TOOL = join(ROOT, "scripts", "review-record.mjs");
const LIB = join(ROOT, "scripts", "lib", "scratch-root.mjs");
const GUARD = join(ROOT, ".pi", "skills", "worktree", "merge-guard.sh");
const FIXTURES = join(ROOT, "scripts", "__tests__", "fixtures", "review-records");
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
			expect(cliRun(["--check", legacy, "--pr", "412"]).status).toBe(EXIT.WRITTEN);
		} finally {
			rmSync(legacyDir, { recursive: true, force: true });
		}
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
