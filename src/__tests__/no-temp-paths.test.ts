/**
 * Issue #511 (U5) — the guard that keeps the shipped tree out of the system
 * temp directory.
 *
 * U4 repointed the preflight's probe and deleted the last `os.tmpdir()` call, so
 * "no shipped path under the system temp dir" is now TRUE of the tree. A
 * property that holds only because nobody has typed the old shape yet is a
 * coincidence, not a property — this is the ratchet (the #166 docs-pinning
 * class): the next module that reaches for `os.tmpdir()` or hardcodes `/tmp`
 * fails here, at the seam where the convention was decided.
 *
 * WHAT IT PINS, on every `src/**\/*.ts` outside a `__tests__` segment:
 *
 *   1. the identifier `tmpdir`, in any position — a call (`os.tmpdir()`,
 *      `tmpdir()`) and an aliased import (`import { tmpdir as t }`) both carry
 *      it, so the import line itself is a hit;
 *   2. a `/tmp` path in code text — single, double or template quoted, and a
 *      bare `"/tmp"` too, because the trailing separator is not what makes the
 *      path unsafe.
 *
 * NOT IN SCOPE, deliberately: `TMPDIR` itself stays available to the SDK, so a
 * direct write or edit of that variable is not a hit — this guard is about a
 * PATH we choose, not about an environment variable a dependency reads.
 *
 * HOW THE MASK WORKS, AND ITS LIMITS. Comments are blanked before the scan, so
 * prose that explains why `/tmp` is refused is not a hit, and the masker tracks
 * quotes so a `//` inside a string cannot open a comment and hide a real literal
 * later on the same line. It is a character scanner, NOT a parser: a CONSTRUCTED
 * path (`"/" + "tmp"`, `path.join`) is out of scope — a grep-class guard, and an
 * AST would not catch it either; a regex literal is not modelled; a template
 * SUBSTITUTION (`${…}`) is scanned as literal text, so a comment inside one is
 * not masked (a false positive, never a false negative); and only `*.ts` under
 * `src` outside `__tests__` is covered, because tests legitimately build
 * fixtures with `os.tmpdir()` and the shipped artifact is `src/` minus
 * `__tests__`. TypeScript 7 here has no compiler API on its root export
 * (`scripts/ts-ast.mjs` is the one adapter over the unstable subpaths), and none
 * of these limits is a syntax question anyway.
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

/** Form 1 — the identifier, which a call site and an aliased import both carry. */
const TMPDIR_IDENTIFIER = /\btmpdir\b/;

/** Form 2 — a `/tmp` path: `/tmp`, `/tmp/…`, `/tmp"`, `` /tmp` ``; not `/tmpfs`. */
const TMP_PATH = /\/tmp\b/;

/**
 * Blank comment characters (to spaces) while leaving every other byte in place,
 * so line numbers survive the mask. Strings and template literals are kept
 * intact — a `//` inside one does not open a comment — and a block comment's
 * newlines are preserved for the same reason.
 */
function maskComments(source: string): string {
	type State = "code" | "line" | "block" | "single" | "double" | "template";
	const out: string[] = [];
	let state: State = "code";
	const blank = (count: number) => {
		for (let i = 0; i < count; i += 1) out.push(" ");
	};

	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		const next = source[i + 1];

		if (state === "code") {
			const opener = ch === "/" && (next === "/" || next === "*") ? next : undefined;
			if (opener !== undefined) {
				state = opener === "/" ? "line" : "block";
				blank(2);
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
			} else blank(1);
			continue;
		}

		if (state === "block") {
			if (ch === "*" && next === "/") {
				state = "code";
				blank(2);
				i += 1;
				continue;
			}
			out.push(ch === "\n" ? ch : " ");
			continue;
		}

		// Inside a string or template literal: bytes are kept, and an escape
		// consumes the character after it so `\'` cannot close the literal early.
		out.push(ch);
		if (ch === "\\" && next !== undefined) {
			out.push(next);
			i += 1;
			continue;
		}
		if ((state === "single" && ch === "'") || (state === "double" && ch === '"') || (state === "template" && ch === "`")) {
			state = "code";
		}
	}

	return out.join("");
}

/** Scan one source's text for both forms, reporting each form once per line. */
function scanSource(file: string, source: string): TempPathHit[] {
	const lines = source.split("\n");
	const hits: TempPathHit[] = [];
	for (const [index, masked] of maskComments(source).split("\n").entries()) {
		const text = (lines[index] ?? "").trim();
		if (TMPDIR_IDENTIFIER.test(masked)) hits.push({ file, line: index + 1, form: "the `tmpdir` identifier", text });
		if (TMP_PATH.test(masked)) hits.push({ file, line: index + 1, form: "a `/tmp` path", text });
	}
	return hits;
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

/** The report a failure shows: file, line, forbidden form. */
const format = (hits: TempPathHit[]): string =>
	hits.map((hit) => `${hit.file}:${hit.line} — ${hit.form}: ${hit.text}`).join("\n");

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

describe("no shipped module uses the system temp directory (issue #511, U5)", () => {
	it("scans the real tree and finds no `tmpdir` identifier and no `/tmp` path", () => {
		// The walk assertions matter as much as the scan: a silently empty file list
		// would pass every other case in this file.
		const files = shippedSources(SRC);
		expect(files.length).toBeGreaterThan(40);
		expect(files).toContain(join(SRC, "preflight.ts"));
		const hits = files.flatMap((file) => scanSource(file, readFileSync(file, "utf8")));
		expect(hits, `forbidden system-temp forms:\n${format(hits)}`).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The scanner — both arms, plus the exemptions, proven rather than assumed
// ---------------------------------------------------------------------------

describe("the scanner", () => {
	it("flags the `tmpdir` identifier: a call, a bare call, and an aliased import", () => {
		expect(scanSource("probe.ts", "const dir = os.tmpdir();").map((hit) => hit.line)).toEqual([1]);
		expect(scanSource("probe.ts", "const dir = tmpdir();").map((hit) => hit.form)).toEqual([
			"the `tmpdir` identifier",
		]);
		// The import line carries the identifier, so it is the hit — not the `t()` call.
		expect(
			scanSource("probe.ts", 'import { tmpdir as t } from "node:os";\nconst dir = t();\n'),
		).toEqual([{ file: "probe.ts", line: 1, form: "the `tmpdir` identifier", text: 'import { tmpdir as t } from "node:os";' }]);
	});

	it("flags a `/tmp` path in every quote style, and a bare `/tmp` — but not `/tmpfs`", () => {
		const cases = ['const bank = "/tmp/brl-x-bank.md";', "const bank = '/tmp/x.md';", "const bank = `/tmp/x.md`;", 'const dir = "/tmp";'];
		for (const source of cases) {
			expect(scanSource("probe.ts", source).map((hit) => hit.form), source).toEqual(["a `/tmp` path"]);
		}
		expect(scanSource("probe.ts", 'const kind = "/tmpfs";')).toEqual([]);
	});

	it("does not flag a comment that mentions the old path or the old call", () => {
		const source = [
			"// The bank used to live at /tmp/brl-<label>-bank.md.",
			"/* os.tmpdir() would reintroduce exactly the defect this module removes,",
			"   and `/tmp` is world-writable. */",
			"const keep = 1;",
		].join("\n");
		expect(scanSource("probe.ts", source)).toEqual([]);
	});

	it("does not treat a `//` inside a string as a comment (the mask is quote-aware)", () => {
		// A masker that truncated at `//` would let the URL on line 1 swallow the
		// real hit on line 2 — which is why the masker tracks quotes.
		const source = 'const url = "https://example.invalid/x";\nconst bank = "/tmp/bank.md";\n';
		const hits = scanSource("probe.ts", source);
		expect(hits).toEqual([{ file: "probe.ts", line: 2, form: "a `/tmp` path", text: 'const bank = "/tmp/bank.md";' }]);
		// The report a failure shows: file, line, forbidden form.
		expect(format(scanSource("probe.ts", "\nconst dir = os.tmpdir();"))).toBe(
			"probe.ts:2 — the `tmpdir` identifier: const dir = os.tmpdir();",
		);
	});
});
