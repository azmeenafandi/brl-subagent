/**
 * Tests for `jev-check.mjs --match-row` and for the two callers that now ask it instead of keeping a
 * second ledger implementation (issue #596 U0). The predicate's own unit tests live with the module
 * (`scripts/__tests__/provenance-ledger.test.ts`); what only this file can pin is the CLI's exit
 * contract and the DIFFERENTIAL: the verb against the `awk -F'\t' 'NF >= 3 && $2 == label && $3 == want'`
 * it replaces.
 *
 * THE ORACLE IS awk ITSELF, spawned per pair, not a JavaScript restatement of the predicate. A third
 * implementation written here would be the very thing U0 exists to delete, and it would agree with
 * `matchRow` by construction. If awk is missing the suite fails loudly: a differential that silently
 * stopped comparing would look exactly like a differential that passed.
 *
 * THE CORPUS IS SYNTHETIC and built in a `mkdtemp` directory — never `.pi/jev-lines.log`, which is
 * gitignored operational history carrying model ids and dispatch text. Its shapes are the ones where
 * a tolerant reader and a byte-exact one diverge: 3/4/5/6 columns, CRLF pairs, a `#`-prefixed row
 * carrying three tabs, a trailing-space label, and an unterminated final row.
 *
 * Lines carry no backslash: `awk -v want=…` interprets escape sequences, so a corpus with one would
 * be measuring awk's unescaping rather than the predicate's comparison.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `.pi/skills/worktree` — the tree whose scripts these rows run. */
const SKILL_DIR = dirname(HERE);
const JEV_CHECK = join(SKILL_DIR, "jev-check.mjs");
const MERGE_GUARD = join(SKILL_DIR, "merge-guard.sh");

const SCRATCH = mkdtempSync(join(tmpdir(), "provenance-match-row-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const ISO = "2026-11-04T00:00:00.000Z";
const LINE_A = "jev: medium (0.63) · C1 · worktree y";
const LINE_B = "jev: high (0.87) · C2 · worktree n";

/** The oracle, exactly as the gate ran it: `-v want` / `-v label`, exit 0 match, 1 no match. */
function awkPredicate(path: string, label: string, line: string): number {
	const result = spawnSync("awk", ["-F", "\t", "-v", `want=${line}`, "-v", `label=${label}`, 'NF >= 3 && $2 == label && $3 == want { found = 1 } END { exit(found ? 0 : 1) }', path], {
		encoding: "utf8",
	});
	if (result.error) throw new Error(`the differential needs awk as its oracle: ${result.error.message}`);
	return result.status ?? -1;
}

/** The verb under test. Silent on 0 and 1, so the exit status is the whole report. */
function matchRowVerb(path: string, label: string, line: string) {
	const result = spawnSync(process.execPath, [JEV_CHECK, "--match-row", label, line, "--provenance", path], { encoding: "utf8" });
	return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/**
 * The corpus. Every row is a shape the ledger legitimately holds, plus the three shapes a byte-exact
 * predicate must refuse where a tolerant one would accept (or vice versa):
 *   - CRLF rows: their third column ends in `\r`, so `--match-row` refuses a line without it — the
 *     same refusal the gate's awk produced by splitting on `\n` alone;
 *   - a `#`-prefixed row carrying three tabs: awk never skipped comments, so neither does the verb
 *     (the PARSER skips it, which is why the file is still valid);
 *   - a trailing-space label and an unterminated final row.
 */
const CORPUS_ROWS = [
	`# jev-lines provenance — cutoff ${ISO}`,
	`${ISO}\timpl-3\t${LINE_A}`,
	`${ISO}\timpl-4\t${LINE_B}\tstated:worktree`,
	`${ISO}\timpl-5\t${LINE_A}\tstated:worktree\tmodel:openrouter/~typesafe/jev-latest`,
	`${ISO}\timpl-6\t${LINE_B}\tstated:worktree\tmodel:deepseek/deepseek-flash\tlevel-model:low (0.4)`,
	`${ISO}\tcrlf-1\t${LINE_A}\r`,
	`${ISO}\tcrlf-2\t${LINE_B}\r`,
	`# draft\tcommented\t${LINE_A}`,
	`${ISO}\tspaced \t${LINE_B}`,
	`${ISO}\tunterminated\t${LINE_A}`,
];

const CORPUS = join(SCRATCH, "corpus.log");
writeFileSync(CORPUS, CORPUS_ROWS.join("\n"));

const LABELS = ["impl-3", "impl-4", "impl-5", "impl-6", "crlf-1", "crlf-2", "commented", "spaced", "spaced ", "unterminated", "recheck-412"];
const LINES = [LINE_A, LINE_B, `${LINE_A}\r`, `${LINE_A} `, "jev: medium (0.64) · C1 · worktree y"];

describe("--match-row and the awk predicate it replaces agree on every pair (U0-3)", () => {
	it("agrees pair for pair over the synthetic corpus, and refuses where both refuse", () => {
		let agreed = 0;
		let refused = 0;
		for (const label of LABELS) {
			for (const line of LINES) {
				const oracle = awkPredicate(CORPUS, label, line);
				const { code, output } = matchRowVerb(CORPUS, label, line);
				// A structurally valid corpus: the verb may never answer 2 here, whatever the pair.
				expect([label, line, code], output).toEqual([label, line, oracle]);
				agreed += 1;
				refused += oracle === 1 ? 1 : 0;
			}
		}
		// Vacuity controls: the matrix really did exercise both answers, not just agreement on refusals.
		expect(agreed).toBe(LABELS.length * LINES.length);
		expect(refused).toBeGreaterThan(0);
		expect(refused).toBeLessThan(agreed);
	});

	it("refuses a CRLF 3-column row in BOTH — the control", () => {
		// awk's `\n` record separator leaves the `\r` on `$3`; `matchRow` splits on `\n` too.
		expect(awkPredicate(CORPUS, "crlf-1", LINE_A)).toBe(1);
		expect(matchRowVerb(CORPUS, "crlf-1", LINE_A)).toEqual({ code: 1, output: "" });
		// …and accepts it in both when the wanted line carries the `\r` itself.
		expect(awkPredicate(CORPUS, "crlf-1", `${LINE_A}\r`)).toBe(0);
		expect(matchRowVerb(CORPUS, "crlf-1", `${LINE_A}\r`).code).toBe(0);
	});

	it("accepts a `#`-prefixed row carrying three tabs in BOTH — the control", () => {
		expect(awkPredicate(CORPUS, "commented", LINE_A)).toBe(0);
		expect(matchRowVerb(CORPUS, "commented", LINE_A)).toEqual({ code: 0, output: "" });
	});

	it("trims nothing in BOTH: a trailing-space label is a different label", () => {
		expect(awkPredicate(CORPUS, "spaced", LINE_B)).toBe(1);
		expect(matchRowVerb(CORPUS, "spaced", LINE_B).code).toBe(1);
		expect(awkPredicate(CORPUS, "spaced ", LINE_B)).toBe(0);
		expect(matchRowVerb(CORPUS, "spaced ", LINE_B).code).toBe(0);
	});

	it("matches an unterminated final row in BOTH", () => {
		expect(awkPredicate(CORPUS, "unterminated", LINE_A)).toBe(0);
		expect(matchRowVerb(CORPUS, "unterminated", LINE_A).code).toBe(0);
	});
});

describe("--match-row's structural exit (U0-7) — the one place it must DIVERGE from the awk", () => {
	it("answers 2, not 0, when a matching row sits in a ledger that cannot be read", () => {
		// The ledger that motivated #596's fail-closed rule: the row IS there (the awk finds it and the
		// gate passes) and the file is corrupt. "Found it" from an unvalidated file is not an answer.
		const path = join(SCRATCH, "corrupt-with-match.log");
		writeFileSync(path, `${ISO}\trecheck-412\t${LINE_A}\nnot-a-row\n`);
		expect(awkPredicate(path, "recheck-412", LINE_A)).toBe(0);
		const { code, output } = matchRowVerb(path, "recheck-412", LINE_A);
		expect(code).toBe(2);
		expect(output).toContain("provenance log line 2 is malformed");
	});

	it("prints the reader's reason for a missing ledger and never answers 1", () => {
		const { code, output } = matchRowVerb(join(SCRATCH, "absent.log"), "impl", LINE_A);
		expect(code).toBe(2);
		expect(output).toContain("cannot read the provenance log");
	});

	it("accepts an empty-but-valid ledger as no match (1), and a usage fault as 2", () => {
		const path = join(SCRATCH, "header-only.log");
		writeFileSync(path, `# jev-lines provenance — cutoff ${ISO}\n`);
		expect(matchRowVerb(path, "impl", LINE_A).code).toBe(1);
		const usage = spawnSync(process.execPath, [JEV_CHECK, "--match-row", "impl"], { encoding: "utf8" });
		expect(usage.status).toBe(2);
		expect(`${usage.stdout}${usage.stderr}`).toContain("--match-row needs <label> <line>");
	});
});

describe("the callers ask the module, not a copy of it (U0-1, U0-2)", () => {
	it("jev-check keeps no local definition of the moved functions or constants", () => {
		const source = readFileSync(JEV_CHECK, "utf8");
		// M3's killer: a local copy alongside the import is a second implementation whatever it says.
		expect(source).not.toMatch(/^function (parseProvenanceLog|parseProvenanceRow|formatProvenanceEntry|appendProvenanceEntry|loadProvenance)\(/m);
		expect(source).not.toMatch(/^const (PROVENANCE_CUTOFF_PREFIX|PROVENANCE_COLUMN_HELP|LEVELS|MODEL_ID_PATTERN) =/m);
		expect(source).toContain('from "../../../scripts/lib/provenance-ledger.mjs"');
	});

	it("merge-guard asks the verb and holds no awk row matcher", () => {
		const source = readFileSync(MERGE_GUARD, "utf8");
		expect(source).not.toContain("awk -F'");
		expect(source).toContain('--match-row "recheck-${pr}"');
		// The structural branch exists: without it, exit 2 would collapse into "no match".
		expect(source).toContain("PROVENANCE_READER_FAILURE");
	});
});
