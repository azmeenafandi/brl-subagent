/**
 * Tests for `scripts/lib/provenance-ledger.mjs` (issue #596) — the provenance ledger's ONE reader.
 *
 * The ledger grammar had two implementations (the merge gate's `awk`, `jev-check.mjs`'s parser) and a
 * third was about to be written, so most of the critique rounds were arguments about whether two
 * readers agree. After U0 there is one, and this file is what makes the move checkable rather than
 * asserted: the parser's refusals, the writer's header rule, and the gate's predicate are each pinned
 * here, in the module that owns them.
 *
 * TWO QUESTIONS, deliberately not one. `parseProvenanceRow` reads a row the way a writer meant it
 * (trims its columns, refuses a 4th positional field, validates keyed columns); `matchRow` answers the
 * GATE's question — are these exact bytes in this file for this label — and shares none of that
 * tolerance. The trailing-space and CRLF cases below are the pair: the parser accepts a padded row
 * that `matchRow` refuses, and that difference is the contract, not an inconsistency. The differential
 * against the `awk` predicate `matchRow` replaces lives beside the CLI verb that exposes it.
 *
 * Everything is synthetic and in a `mkdtemp` directory: the real ledger is gitignored operational
 * history (model ids, dispatch text), so no fixture here is a copy of it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	PROVENANCE_COLUMN_HELP,
	PROVENANCE_CUTOFF_PREFIX,
	StructuralError,
	appendProvenanceEntry,
	formatProvenanceEntry,
	loadProvenance,
	matchRow,
	parseProvenanceLog,
	parseProvenanceRow,
} from "../lib/provenance-ledger.mjs";

const SCRATCH = mkdtempSync(join(tmpdir(), "provenance-ledger-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const NOW = new Date("2026-11-07T13:00:00.000Z");
const ISO = "2026-11-07T13:00:00.000Z";
const LINE = "jev: medium (0.84) · C2 · worktree y";

/** A row as the ledger writes it: `<iso>\t<label>\t<line>` plus the given keyed columns. */
function row(...keyed: string[]): string {
	return [ISO, "impl", LINE, ...keyed].join("\t");
}

/** A fresh file name in the scratch; `body` (when given) is written with `\n` endings. */
function file(name: string, body?: string): string {
	const path = join(SCRATCH, name);
	mkdirSync(join(path, ".."), { recursive: true });
	if (body !== undefined) writeFileSync(path, body);
	return path;
}

/** The refusal a call must produce, so the assertion is the class AND the reason, never just a throw. */
function refusal(run: () => unknown): StructuralError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(StructuralError);
		return error as StructuralError;
	}
	throw new Error("expected a StructuralError, and the call returned");
}

describe("formatProvenanceEntry — the writer's half", () => {
	it("writes the three positional columns, ISO first", () => {
		expect(formatProvenanceEntry(LINE, "impl", NOW)).toBe(`${ISO}\timpl\t${LINE}`);
	});

	it("appends keyed columns in a fixed order: stated, model, level-model", () => {
		expect(
			formatProvenanceEntry(LINE, "impl-review", NOW, {
				stated: "worktree",
				model: "openrouter/~typesafe/jev-latest",
				levelModel: { level: "high", conf: 0.44 },
			}),
		).toBe(`${ISO}\timpl-review\t${LINE}\tstated:worktree\tmodel:openrouter/~typesafe/jev-latest\tlevel-model:high (0.44)`);
	});

	it("prints a confidence in the log's own style: 1 becomes 1.0, 0.9 stays 0.9", () => {
		const conf = (value: number) => formatProvenanceEntry(LINE, "impl", NOW, { levelModel: { level: "low", conf: value } }).split("\t")[3];
		expect(conf(1)).toBe("level-model:low (1.0)");
		expect(conf(0.9)).toBe("level-model:low (0.9)");
		expect(conf(0.84)).toBe("level-model:low (0.84)");
	});

	it("omits an unrecorded field rather than padding it", () => {
		// `stated:`, `model:` and `level-model:` are facts about the run: absent is absence, never a
		// placeholder a reader could mistake for a value.
		expect(formatProvenanceEntry(LINE, "impl", NOW, {})).not.toContain("stated:");
		expect(formatProvenanceEntry(LINE, "impl", NOW, { stated: "" })).toBe(`${ISO}\timpl\t${LINE}`);
	});
});

describe("parseProvenanceRow — fail-closed on every hand-edit a row can carry", () => {
	it("reads a 6-column row into its keyed facts", () => {
		expect(parseProvenanceRow(row("stated:worktree", "model:deepseek/deepseek-flash", "level-model:low (0.4)"), 7)).toEqual({
			at: ISO,
			label: "impl",
			line: LINE,
			stated: "worktree",
			model: "deepseek/deepseek-flash",
			levelModel: { level: "low", conf: 0.4 },
		});
	});

	it("trims the positional columns — this is the reader, not the gate predicate", () => {
		const padded = `  ${ISO}  \t  impl  \t  ${LINE}  `;
		expect(parseProvenanceRow(padded, 1)).toEqual({ at: ISO, label: "impl", line: LINE, stated: null, model: null, levelModel: null });
	});

	it("refuses every deviation, naming the line and the expected shape", () => {
		const cases: Array<[string, string, RegExp]> = [
			["two columns", `${ISO}\timpl`, /only 2 tab-separated column/],
			["seven columns", row("stated:worktree", "model:a/b", "level-model:low (0.4)", "stated:worktree"), /at most 6 \(the base 3 plus 3 keyed\)/],
			["empty label", `${ISO}\t\t${LINE}`, /the label or the line column is empty/],
			["empty line", `${ISO}\timpl\t   `, /the label or the line column is empty/],
			["keyed column before the line", `${ISO}\tstated:worktree\t${LINE}`, /appears before the line column/],
			["a tab inside the value (an extra column)", `${ISO}\timpl\t${LINE.split(" · ")[0]}\t(0.84) · C2 · worktree y`, /unknown column/],
			["duplicate stated", row("stated:worktree", "stated:worktree"), /duplicate `stated:`/],
			["an unsupported stated field", row("stated:risk"), /the stated column .* is not supported/],
			["a model id with no slash", row("model:jev-latest"), /is not <provider>\/<id>/],
			["an unknown level", row("level-model:ultra (0.5)"), /is not one of off \| minimal \| low \| medium \| high \| xhigh/],
			["a confidence outside [0, 1]", row("level-model:medium (1.5)"), /confidence 1\.5 is outside \[0, 1\]/],
			["a level-model column of the wrong shape", row("level-model:medium"), /is not "<level> \(<0\.\.1 conf>\)"/],
			["an unknown key", row("colour:blue"), /unknown column "colour:blue"/],
		];
		for (const [name, text, reason] of cases) {
			const error = refusal(() => parseProvenanceRow(text, 42));
			expect(error.message, name).toMatch(reason);
			expect(error.message, name).toContain("provenance log line 42 is malformed");
			expect(error.message, name).toContain(PROVENANCE_COLUMN_HELP);
		}
	});
});

describe("parseProvenanceLog — the file's shape", () => {
	it("reads the cutoff instant from the header and skips blanks and comments", () => {
		const text = `${PROVENANCE_CUTOFF_PREFIX}${ISO}\n\n# a note\n${row()}\n`;
		const parsed = parseProvenanceLog(text);
		expect(parsed.cutoff).toBe(ISO);
		expect(parsed.entries).toHaveLength(1);
	});

	it("refuses a date-only cutoff: it would exempt dispatches that predate the log", () => {
		expect(refusal(() => parseProvenanceLog(`${PROVENANCE_CUTOFF_PREFIX}2026-10-31\n${row()}\n`)).message).toMatch(/is date-only/);
	});

	it("parses CRLF rows — the reader splits on \\r?\\n, so the line column carries no \\r", () => {
		expect(parseProvenanceLog(`${row()}\r\n`).entries[0].line).toBe(LINE);
	});

	it("names the malformed row's own line number", () => {
		const text = `# jev-lines provenance — cutoff ${ISO}\n${row()}\n${ISO}\ttruncated\n`;
		expect(refusal(() => parseProvenanceLog(text)).message).toContain("line 3 is malformed");
	});

	it("returns an empty result for an empty log, and coerces no cutoff", () => {
		expect(parseProvenanceLog("")).toEqual({ cutoff: null, entries: [] });
	});
});

describe("loadProvenance — a log that cannot be read is never 'no entries'", () => {
	it("refuses a missing file, naming the path", () => {
		const path = join(SCRATCH, "absent", "jev-lines.log");
		const error = refusal(() => loadProvenance(path));
		expect(error.message).toContain(path);
		expect(error.message).toMatch(/cannot read the provenance log/);
	});

	it("refuses a file with no rows: a reader that verified nothing cannot pass", () => {
		const path = file("comment-only.log", `# jev-lines provenance — cutoff ${ISO}\n`);
		expect(refusal(() => loadProvenance(path)).message).toMatch(/no provenance entries/);
	});

	it("reads a healthy log", () => {
		const path = file("healthy.log", `${PROVENANCE_CUTOFF_PREFIX}${ISO}\n${row()}\n`);
		expect(loadProvenance(path).entries[0]).toMatchObject({ label: "impl", line: LINE });
	});
});

describe("appendProvenanceEntry — the writer creates its own header, once", () => {
	it("creates the file and its cutoff header on first use", () => {
		const path = join(SCRATCH, "fresh", "nested", "jev-lines.log");
		appendProvenanceEntry(path, LINE, "impl", NOW);
		expect(readFileSync(path, "utf8")).toBe(`${PROVENANCE_CUTOFF_PREFIX}${ISO}\n${ISO}\timpl\t${LINE}\n`);
	});

	it("appends a second row with no second header", () => {
		const path = join(SCRATCH, "twice.log");
		appendProvenanceEntry(path, LINE, "impl", NOW);
		appendProvenanceEntry(path, "jev: low (0.5) · C1 · worktree n", "review", NOW);
		const rows = readFileSync(path, "utf8").trim().split("\n");
		expect(rows.filter((line) => line.startsWith("#"))).toHaveLength(1);
		expect(rows).toHaveLength(3);
		expect(parseProvenanceLog(readFileSync(path, "utf8")).entries.map((entry: { label: string }) => entry.label)).toEqual(["impl", "review"]);
	});

	it("refuses to append into a path it cannot read as a log", () => {
		const path = join(SCRATCH, "a-directory.log");
		mkdirSync(path, { recursive: true });
		expect(refusal(() => appendProvenanceEntry(path, LINE, "impl", NOW)).message).toMatch(/cannot read the provenance log/);
	});
});

describe("matchRow — the gate's predicate, byte for byte", () => {
	const lines = (...rows: string[]) => rows;

	it("matches the third column of a 3-, 4-, 5- and 6-column row", () => {
		const corpus = lines(row(), row("stated:worktree"), row("stated:worktree", "model:a/b"), row("stated:worktree", "model:a/b", "level-model:low (0.4)"));
		for (const line of corpus) expect(matchRow([line], "impl", LINE), line).toBe(true);
	});

	it("refuses a CRLF row: the third column ends in \\r, so those are different bytes", () => {
		expect(matchRow([`${row()}\r`], "impl", LINE)).toBe(false);
	});

	it("matches a `#`-prefixed row carrying three tabs — the gate never skipped comments", () => {
		expect(matchRow([`# draft\timpl\t${LINE}`], "impl", LINE)).toBe(true);
	});

	it("trims nothing: a trailing space makes a different label, and a different line", () => {
		expect(matchRow([`${ISO}\timpl \t${LINE}`], "impl", LINE)).toBe(false);
		expect(matchRow([`${ISO}\timpl \t${LINE}`], "impl ", LINE)).toBe(true);
		expect(matchRow([`${ISO}\tim\tpl\t${LINE}`], "im\tpl", LINE)).toBe(false); // a tab in a label is a column, not a separator loophole
		expect(matchRow([`${ISO}\timpl\t${LINE} `], "impl", LINE)).toBe(false);
	});

	it("matches an unterminated final row — the ledger's last line needs no newline", () => {
		const text = `${PROVENANCE_CUTOFF_PREFIX}${ISO}\n${row()}`;
		expect(matchRow(text.split("\n"), "impl", LINE)).toBe(true);
	});

	it("refuses a 2-column row, an empty list, and a label that only prefixes the wanted one", () => {
		expect(matchRow([`${ISO}\timpl`], "impl", LINE)).toBe(false);
		expect(matchRow([], "impl", LINE)).toBe(false);
		expect(matchRow([row()], "impl-review", LINE)).toBe(false);
	});
});
