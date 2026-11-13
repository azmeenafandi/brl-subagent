/**
 * Issue #511 (U5) — the guard that keeps the shipped tree out of the system
 * temp directory.
 *
 * U4 repointed the preflight's probe and deleted the last `os.tmpdir()` call, so
 * "no shipped path under the system temp dir" is now TRUE of the tree. A
 * property that is true only because nobody has typed the old shape yet is not a
 * property, it is a coincidence — this is the ratchet (the #166 docs-pinning
 * class): the next module that reaches for `os.tmpdir()` or hardcodes `/tmp`
 * fails here, at the seam where the convention was decided.
 *
 * WHAT IT PINS, on every `src/**\/*.ts` outside a `__tests__` segment:
 *
 *   1. the identifier `tmpdir`, in any position — a call (`os.tmpdir()`,
 *      `tmpdir()`) and an aliased import (`import { tmpdir as t }`) both carry
 *      it, so the import line itself is a hit;
 *   2. a `/tmp` path in code text — single, double or template quoted, and a
 *      bare `"/tmp"` as well, because the trailing separator is not what makes
 *      the path unsafe.
 *
 * NOT IN SCOPE, deliberately: `TMPDIR` itself stays available to the SDK, so a
 * direct write or edit of that variable is not a hit — this guard is about a
 * PATH we choose, not about an environment variable a dependency reads.
 *
 * HOW THE MASK WORKS, AND ITS LIMITS. Comments are blanked before the scan, so
 * prose that mentions the old convention (`scratch-root.ts` explains why `/tmp`
 * is refused) is not a hit; the masker tracks quotes so a `//` inside a string
 * cannot start a comment and hide a real literal later on the same line. It is a
 * small character scanner, NOT a parser, and the honest limits are:
 *
 *   - a CONSTRUCTED path is out of scope: `"/" + "tmp"`, `path.join("/", "tmp")`,
 *     `String.fromCharCode(47) + "tmp"`. This is a grep-class guard; an AST would
 *     not catch the last two either, since it is a data-flow question.
 *   - a regex literal is not modelled: `/\/tmp\//` reaches the rule only
 *     accidentally (it contains no quoted text), and is not relied on.
 *   - a template SUBSTITUTION (`${…}`) is treated as literal text, so a comment
 *     written inside one is not masked (a `/tmp` there would be a false
 *     positive, never a false negative);
 *   - only `*.ts` under `src` is scanned, and any `__tests__` path segment is
 *     excluded — tests legitimately build fixtures with `os.tmpdir()`, and the
 *     shipped artifact is `src/` minus `__tests__` (`package.json.files`).
 *
 * The reviewer may ask for an AST guard instead. TypeScript 7 in this repo has
 * no compiler API on its root export (`scripts/ts-ast.mjs` is the one adapter
 * over the unstable subpaths), and none of the three limits above — a built
 * string, a regex, a substitution — is a syntax question.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = "src";

/** A hit: which file, which 1-based line, which forbidden form, and the line itself. */
interface TempPathHit {
	file: string;
	line: number;
	form: string;
	text: string;
}

/**
 * Blank comment characters (to spaces) while leaving EVERY other byte in place,
 * so line numbers survive the mask. Strings and template literals are kept
 * intact — a `//` inside one does not open a comment — and a block comment's
 * newlines are preserved for the same reason.
 */
function maskComments(source: string): string {
	type State = "code" | "line" | "block" | "single" | "double" | "template";
	const out: string[] = [];
	let state: State = "code";

	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		const next = source[i + 1];

		if (state === "code") {
			if (ch === "/" && next === "/") {
				state = "line";
				out.push(" ", " ");
				i += 1;
				continue;
			}
			if (ch === "/" && next === "*") {
				state = "block";
				out.push(" ", " ");
				i += 1;
				continue;
			}
			if (ch === "'") state = "single";
			else if (ch === '"') state = "double";
			else if (ch === "`") state = "template";
			out.push(ch);
			continue;
		}

		if (state === "line") {
			if (ch === "\n") {
				state = "code";
				out.push(ch);
			} else {
				out.push(" ");
			}
			continue;
		}

		if (state === "block") {
			if (ch === "*" && next === "/") {
				state = "code";
				out.push(" ", " ");
				i += 1;
				continue;
			}
			out.push(ch === "\n" ? ch : " ");
			continue;
		}

		// Inside a string or template literal: the bytes are kept, and an escape
		// consumes the character after it so `\'` cannot close the literal early.
		out.push(ch);
		if (ch === "\\" && next !== undefined) {
			out.push(next);
			i += 1;
			continue;
		}
		if (state === "single" && ch === "'") state = "code";
		else if (state === "double" && ch === '"') state = "code";
		else if (state === "template" && ch === "`") state = "code";
	}

	return out.join("");
}

/** Form 1 — the identifier, which a call site and an aliased import both carry. */
const TMPDIR_IDENTIFIER = /\btmpdir\b/;

/** Form 2 — a `/tmp` path: `/tmp`, `/tmp/…`, `/tmp"`, `` /tmp` ``; not `/tmpfs`. */
const TMP_PATH = /\/tmp\b/;

/** Scan one source's text for both forms, reporting the first hit per form per line. */
function scanSource(file: string, source: string): TempPathHit[] {
	const lines = source.split("\n");
	const masked = maskComments(source).split("\n");
	const hits: TempPathHit[] = [];

	for (const [index, lineText] of masked.entries()) {
		const text = (lines[index] ?? "").trim();
		if (TMPDIR_IDENTIFIER.test(lineText)) {
			hits.push({ file, line: index + 1, form: "the `tmpdir` identifier", text });
		}
		if (TMP_PATH.test(lineText)) {
			hits.push({ file, line: index + 1, form: "a `/tmp` path", text });
		}
	}

	return hits;
}

/** One line per hit: file, line, forbidden form — the report a failure shows. */
function format(hits: TempPathHit[]): string {
	return hits.map((hit) => `${hit.file}:${hit.line} — ${hit.form}: ${hit.text}`).join("\n");
}

/** Every shipped `*.ts` under `dir`: no `__tests__` segment, recursively. */
function shippedSources(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__tests__") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...shippedSources(full));
		else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
	}
	return found;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

describe("no shipped module uses the system temp directory (issue #511, U5)", () => {
	it("scans the real shipped tree (the walk cannot pass by finding nothing)", () => {
		const files = shippedSources(SRC);
		expect(files.length).toBeGreaterThan(40);
		expect(files).toContain(join(SRC, "preflight.ts"));
		expect(files.filter((file) => file.includes("__tests__"))).toEqual([]);
	});

	it("finds no `tmpdir` identifier and no `/tmp` path outside `__tests__`", () => {
		const files = shippedSources(SRC);
		const hits = files.flatMap((file) => scanSource(file, readFileSync(file, "utf8")));
		expect(hits, `forbidden system-temp forms:\n${format(hits)}`).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The scanner — both arms, plus the exemptions, proven rather than assumed
// ---------------------------------------------------------------------------

describe("the scanner's two arms", () => {
	it("flags `os.tmpdir()`", () => {
		const hits = scanSource("probe.ts", "const dir = os.tmpdir();");
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(1);
		expect(hits[0].form).toContain("tmpdir");
	});

	it("flags an unqualified `tmpdir()` call", () => {
		const hits = scanSource("probe.ts", "const dir = tmpdir();");
		expect(hits.map((hit) => hit.form)).toContain("the `tmpdir` identifier");
	});

	it("flags an aliased import on its own line", () => {
		const source = 'import { tmpdir as t } from "node:os";\nconst dir = t();\n';
		const hits = scanSource("probe.ts", source);
		expect(hits).toEqual([
			{ file: "probe.ts", line: 1, form: "the `tmpdir` identifier", text: 'import { tmpdir as t } from "node:os";' },
		]);
	});

	it("flags a `/tmp` path in single, double and template quotes — and a bare `/tmp`", () => {
		const cases = [
			'const bank = "/tmp/brl-x-bank.md";',
			"const bank = '/tmp/brl-x-bank.md';",
			"const bank = `/tmp/brl-x-bank.md`;",
			'const dir = "/tmp";',
		];
		for (const source of cases) {
			const hits = scanSource("probe.ts", source);
			expect(hits.map((hit) => hit.form), source).toContain("a `/tmp` path");
		}
	});

	it("does not flag `/tmpfs`, which is not the system temp directory", () => {
		expect(scanSource("probe.ts", 'const kind = "/tmpfs";')).toEqual([]);
	});
});

describe("the scanner's exemptions", () => {
	it("does not flag a comment that mentions the old path or the old call", () => {
		const source = [
			"// The bank used to live at /tmp/brl-<label>-bank.md.",
			"/* os.tmpdir() would reintroduce exactly the defect this module removes,",
			"   and `/tmp` is world-writable. */",
			"const keep = 1;",
		].join("\n");
		expect(scanSource("probe.ts", source)).toEqual([]);
	});

	it("does not treat a `//` inside a string as a comment (the masker is quote-aware)", () => {
		// The URL on line 1 must not swallow the literal on line 2: a masker that
		// simply truncated at `//` would miss a real hit here.
		const source = 'const url = "https://example.invalid/x";\nconst bank = "/tmp/bank.md";\n';
		const hits = scanSource("probe.ts", source);
		expect(hits).toEqual([{ file: "probe.ts", line: 2, form: "a `/tmp` path", text: 'const bank = "/tmp/bank.md";' }]);
	});

	it("names the file, the line and the forbidden form in the report", () => {
		const hits = scanSource("probe.ts", "\nconst dir = os.tmpdir();");
		expect(format(hits)).toBe("probe.ts:2 — the `tmpdir` identifier: const dir = os.tmpdir();");
	});
});
