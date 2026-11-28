/**
 * Tests for `scripts/check-vocabulary.mjs` (#606 Unit 3) — the factory vocabulary's mechanism, not its
 * lexicon.
 *
 * TWO JOBS, TWO EXIT CODES, AND THE DIFFERENCE IS THE POINT. The data file (`.development/VOCABULARY.md`) is
 * the single source of truth, so its own shape rules are enforced: a duplicate concept, a term canonical in
 * one row and banned in another, a `status` outside the enum, an empty `canonical`, two rows sharing one
 * canonical term. Those are exit 1 (a readable file that is wrong) and every case below pins one of them.
 * A file that cannot be read or parsed is exit 2 (cannot check) — never merged with 1, because "could not
 * check" passing as "clean" is how a fence around nothing gets certified.
 *
 * THE PROSE RULE. A banned term in narrative prose fails with `path:line` and the canonical term to use;
 * fenced blocks, inline code, URLs and path-like tokens are exempt; blockquotes are NOT exempt (the fence
 * rule skips fences, not quotes). The dead-row rule (Q15) fails a canonical term used nowhere, and a
 * `forward` row is the marked exception — that status is the whole meaning of the row.
 *
 * Fixtures are throwaway trees under the repository's `.tmp/` (never the real corpus), each shaped like a
 * checkout: the two named files and the three corpus directories, so a case can seed exactly one violation
 * and nothing else. The last case runs the guard on the real tree: the guard has to be green the day it
 * lands, and a fixture cannot prove that.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CORPUS, DATA_PATH, EXIT, ROOT, main, maskProse, parseVocabulary, termForms } from "../check-vocabulary.mjs";

const BASE = join(ROOT, ".tmp");
mkdirSync(BASE, { recursive: true });
const WORK = mkdtempSync(join(BASE, "check-vocabulary-"));
let counter = 0;

afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
});

const TABLE_HEADER = [
	"| concept | canonical | banned | status | notes |",
	"| --- | --- | --- | --- | --- |",
].join("\n");

/** The shipped four rows, verbatim in shape. Every fixture starts here and seeds one violation. */
const DEFAULT_ROWS = [
	"| dispatch | dispatch | | canonical | one request to delegate |",
	"| spawn | spawn | | canonical | one attempt to start a subagent |",
	"| run | run | | canonical | one execution at any level |",
	"| subagent | subagent | worker | canonical | the agent a spawn starts |",
];

/** The data file with the given rows. A fixture that wants a malformed file passes its own text instead. */
function dataFile(rows: string[] = DEFAULT_ROWS): string {
	return `# Vocabulary\n\n${TABLE_HEADER}\n${rows.join("\n")}\n`;
}

/** Prose that uses all four canonical terms, so the default table has no dead row. */
const CLEAN_PROSE = "A dispatch spawns a subagent; a run is one execution.\n";

type Fixture = { rows?: string[]; files?: Record<string, string>; data?: string | null };

/**
 * A checkout-shaped temp root: `AGENT.md`, `README.md`, and one `.md` under each corpus directory. `data`
 * overrides the data file's text; `data: null` removes it (the unreadable-input case).
 */
function checkout({ rows, files = {}, data }: Fixture = {}): string {
	const root = join(WORK, `root-${(counter += 1)}`);
	mkdirSync(root, { recursive: true });
	const seeds: Record<string, string> = {
		"AGENT.md": CLEAN_PROSE,
		"README.md": "# Readme\n\nNothing here.\n",
		[join(".pi", "skills", "SKILL.md")]: "# Skill\n\nNothing here.\n",
		[join("presets", "a-preset.md")]: "# Preset\n\nNothing here.\n",
		[join("templates", "a-template.md")]: "# Template\n\nNothing here.\n",
	};
	if (data !== null) seeds[DATA_PATH] = data ?? dataFile(rows);
	for (const [path, body] of Object.entries({ ...seeds, ...files })) {
		const target = join(root, path);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, body);
	}
	return root;
}

/** Run the guard against a fixture root, collecting both sinks so a message can be asserted. */
function run(root: string) {
	const out: string[] = [];
	const err: string[] = [];
	const code = main(["--root", root], {
		out: (line: string) => void out.push(line),
		err: (line: string) => void err.push(line),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("the corpus — a banned term in prose fails, the exemptions pass", () => {
	it("is clean when the prose uses only canonical terms", () => {
		const result = run(checkout());
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain("0 violation(s)");
	});

	it("fails a banned term in narrative prose, naming the term and the canonical one", () => {
		const result = run(checkout({ files: { "README.md": "# Readme\n\nA worker starts.\n" } }));
		expect(result.code).toBe(EXIT.VIOLATIONS);
		expect(result.out).toContain('README.md:3: banned term "worker" — use "subagent" instead');
	});

	it("matches case-insensitively and through inflections", () => {
		const result = run(checkout({ files: { "README.md": "# Readme\n\nWorkers start.\n" } }));
		expect(result.code).toBe(EXIT.VIOLATIONS);
		expect(result.out).toContain("README.md:3:");
	});

	it("skips a banned term inside a fenced block", () => {
		const result = run(checkout({ files: { "README.md": "# Readme\n\n```\na worker starts\n```\n" } }));
		expect(result.code).toBe(EXIT.OK);
	});

	it("skips a banned term inside inline backticks", () => {
		const result = run(checkout({ files: { "README.md": "# Readme\n\nA `worker` starts.\n" } }));
		expect(result.code).toBe(EXIT.OK);
	});

	it("skips a banned term inside a URL or a path-like token", () => {
		const result = run(
			checkout({ files: { "README.md": "# Readme\n\nSee https://example.com/worker and src/worker.ts.\n" } }),
		);
		expect(result.code).toBe(EXIT.OK);
	});

	it("does NOT exempt a blockquote — the fence rule skips fences, not quotes", () => {
		const result = run(checkout({ files: { "README.md": "# Readme\n\n> a worker starts\n" } }));
		expect(result.code).toBe(EXIT.VIOLATIONS);
		expect(result.out).toContain("README.md:3:");
	});
});

describe("the data file — its own shape rules are violations", () => {
	it("fails a duplicate concept", () => {
		const result = run(
			checkout({
				rows: [...DEFAULT_ROWS, "| dispatch | dispatch | | canonical | a duplicate |"],
			}),
		);
		expect(result.code).toBe(EXIT.VIOLATIONS);
		expect(result.out).toContain('concept "dispatch" is declared twice');
	});

	it("fails a term that is canonical in one row and banned in another", () => {
		const result = run(
			checkout({
				rows: [...DEFAULT_ROWS, "| execution | execution | run | canonical | a cross-row ban |"],
			}),
		);
		expect(result.code).toBe(EXIT.VIOLATIONS);
		expect(result.out).toContain('"run" is canonical in one row and banned in another');
	});

	it("fails a status outside the enum", () => {
		const result = run(
			checkout({
				rows: ["| dispatch | dispatch | | official | one request |", ...DEFAULT_ROWS.slice(1)],
			}),
		);
		expect(result.code).toBe(EXIT.VIOLATIONS);
		expect(result.out).toContain('status "official" is not canonical or forward');
	});

	it("fails an empty canonical term", () => {
		const result = run(checkout({ rows: [...DEFAULT_ROWS, "| ghost | | | canonical | no canonical |"] }));
		expect(result.code).toBe(EXIT.VIOLATIONS);
		expect(result.out).toContain('empty canonical term for concept "ghost"');
	});

	it("fails two rows sharing one canonical term", () => {
		const result = run(checkout({ rows: [...DEFAULT_ROWS, "| another | run | | canonical | a second run |"] }));
		expect(result.code).toBe(EXIT.VIOLATIONS);
		expect(result.out).toContain('canonical "run" is declared in two rows');
	});
});

describe("the dead-row check — a canonical term must be used, unless it is forward", () => {
	it("fails a canonical row that appears nowhere in the corpus", () => {
		const result = run(checkout({ rows: [...DEFAULT_ROWS, "| phantom | phantom | | canonical | unused |"] }));
		expect(result.code).toBe(EXIT.VIOLATIONS);
		expect(result.out).toContain('canonical "phantom" appears nowhere in the corpus — use it, or mark the row forward');
	});

	it("exempts a forward row from the dead-row check", () => {
		const result = run(checkout({ rows: [...DEFAULT_ROWS, "| phantom | phantom | | forward | defined ahead of use |"] }));
		expect(result.code).toBe(EXIT.OK);
	});
});

describe("input that cannot be checked is exit 2, never exit 1", () => {
	it("exits 2 when the data file is missing", () => {
		const result = run(checkout({ data: null }));
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("cannot read the data file");
	});

	it("exits 2 when the data file has no table header", () => {
		const result = run(checkout({ data: "# Vocabulary\n\nNo table here.\n" }));
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("no table header");
	});

	it("exits 2 when a corpus directory is missing", () => {
		const root = checkout();
		rmSync(join(root, "templates"), { recursive: true, force: true });
		const result = run(root);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("templates: cannot read the corpus directory");
	});
});

describe("the parser and maskers — the pieces, pinned", () => {
	it("parses the shipped table into four rows and one ban", () => {
		const parsed = parseVocabulary(readFileSync(join(ROOT, DATA_PATH), "utf8"));
		expect(parsed.error).toBeNull();
		expect(parsed.rows.map((row: { canonical: string }) => row.canonical)).toEqual([
			"dispatch",
			"spawn",
			"run",
			"subagent",
		]);
		expect(parsed.rows.flatMap((row: { banned: string[] }) => row.banned)).toEqual(["worker"]);
	});

	it("masks fences and inline code but leaves blockquote text", () => {
		const masked = maskProse("```\na worker\n```\nA `worker` and a worker\n> a worker\n");
		expect(masked).not.toContain("```");
		expect(masked).not.toContain("`worker`");
		expect(masked.split("\n").filter((line) => line.includes("worker"))).toHaveLength(2);
	});

	it("inflects a single word but not a phrase", () => {
		expect(termForms("worker")).toEqual(["worker", "workers"]);
		expect(termForms("ticket tracker")).toEqual(["ticket tracker"]);
	});

	it("names every corpus directory so its absence is an error, not a silent skip", () => {
		expect(CORPUS).toEqual(["AGENT.md", "README.md", join(".pi", "skills"), "presets", "templates"]);
	});
});

describe("cannot check — the summary never claims clean", () => {
	// The defect this pins (#606 Unit 3, found in review): an unreadable corpus entry used to skip the
	// scan entirely, so a real violation in a file that WAS read went unreported under the word "clean".
	it("still reports a real violation, and says cannot check, when part of the corpus is unreadable", () => {
		const root = checkout({ files: { "AGENT.md": "A worker did it. " + CLEAN_PROSE } });
		rmSync(join(root, "presets"), { recursive: true, force: true });
		const result = run(root);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.out).toContain('banned term "worker"');
		expect(result.out).toContain("cannot check");
		expect(result.out).not.toContain("\u2014 clean");
	});

	it("does not call a missing data file clean", () => {
		const result = run(checkout({ data: null }));
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.out).toContain("cannot check");
		expect(result.out).not.toContain("\u2014 clean");
	});
});

describe("the real tree — the guard is green the day it lands", () => {
	it("reports zero violations on this checkout", () => {
		const result = run(ROOT);
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain("0 violation(s)");
	});
});
