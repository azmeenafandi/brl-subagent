/**
 * Runtime-string vocabulary ratchet — issue #183.
 *
 * Issue #174 removed three runtime strings that leaked internal development
 * vocabulary into user-visible output: the completion directive carried "retry
 * taxonomy" and "Rule 18" (from a gitignored process doc), the retry-run-id
 * tool result carried "(issue #98)", and a template-preset warning carried
 * "(issue #81)". Nothing stopped the next leak. This test makes that class a
 * build failure instead of a review responsibility.
 *
 * Why an AST scan and not a grep: one of the ad-hoc greps run during #174
 * matched only double-quoted strings and missed `src/index.ts`'s
 * template-literal leak — the very string a live probe had just printed. The
 * TypeScript compiler API sees string literals in every form (single/double
 * quoted, template literals with and without substitutions, and concatenations)
 * and sees comments/type positions not at all, which is exactly the coverage
 * boundary this ratchet needs.
 *
 * Scope: runtime string literals in `src/**`, excluding `src/__tests__/**` (the
 * fixtures in this file necessarily contain the forbidden terms) and type-only
 * positions (a `type T = "handoff"` is erased, so it never reaches a user).
 *
 * Exceptions require a RECORDED decision, in the spirit of
 * `KNOWN_DELEGATE_KEYS` (src/params.ts): an allow-list entry must state why the
 * string is legitimately not a leak. The list is intentionally empty today —
 * the tree is clean — and should stay that way.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Forbidden vocabulary (the list comes from issue #183)
// ---------------------------------------------------------------------------

/** Placeholder standing in for a `${…}` substitution inside a template literal. */
const SUBSTITUTION = "\u0000";

/**
 * Internal process vocabulary and public issue references that must never
 * appear in a runtime string. Each pattern matches the term as it would reach
 * a user; `SUBSTITUTION` lets a template interpolation stand in for a number so
 * `issue #${n}` is caught alongside `issue #99`.
 */
const FORBIDDEN_TERMS: ReadonlyArray<{ term: string; pattern: RegExp }> = [
	{ term: "Rule <n>", pattern: /\brule\s+(?:\d+|\u0000)/i },
	{ term: "retry taxonomy", pattern: /retry taxonomy/i },
	{ term: "friction log", pattern: /friction log/i },
	{ term: "handoff", pattern: /handoff/i },
	{ term: "worktree", pattern: /worktree/i },
	{ term: "E<nn>", pattern: /\bE\d{1,2}\b/ },
	{ term: "issue #<n>", pattern: /issue #(?:\d+|\u0000)/i },
];

/**
 * Recorded exceptions, keyed by `"<repo-relative path>|<term>"`. Every entry
 * MUST carry a reason: an omission is a bug, a documented decision is not.
 *
 * Empty by design — verified on the tree this ratchet landed against.
 */
const VOCABULARY_ALLOWLIST = new Map<string, string>([
	// `"src/example.ts|worktree": "why this string is not user-visible"`,
]);

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export interface VocabularyHit {
	/** Repo-relative path with `/` separators. */
	file: string;
	/** 1-based line of the offending literal/expression. */
	line: number;
	/** The forbidden term that matched. */
	term: string;
	/** Flattened literal text (substitutions shown as `\u0000`). */
	text: string;
}

const isPlusConcatenation = (node: ts.Node): node is ts.BinaryExpression =>
	ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;

/** Nearest non-parenthesised ancestor satisfying `pred`, if any. */
function closestAncestor(node: ts.Node, pred: (n: ts.Node) => boolean): ts.Node | undefined {
	let parent = node.parent as ts.Node | undefined;
	while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
	return parent && pred(parent) ? parent : undefined;
}

/**
 * Flatten an expression to the literal text it will produce where statically
 * knowable. Parenthesised expressions and `+` concatenations compose; any
 * non-literal operand becomes `SUBSTITUTION`, which keeps the surrounding text
 * scannable without pretending to know the runtime value.
 */
function flattenLiteralText(node: ts.Node): string {
	if (ts.isParenthesizedExpression(node)) return flattenLiteralText(node.expression);
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isTemplateExpression(node)) {
		let text = node.head.text;
		for (const span of node.templateSpans) text += SUBSTITUTION + span.literal.text;
		return text;
	}
	if (isPlusConcatenation(node)) return flattenLiteralText(node.left) + flattenLiteralText(node.right);
	return SUBSTITUTION;
}

/**
 * Scan one TypeScript source for forbidden vocabulary in runtime string
 * literals. Comments are excluded by the parser; type-only positions are
 * pruned before descending.
 */
export function scanRuntimeVocabulary(source: string, file: string): VocabularyHit[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const hits: VocabularyHit[] = [];

	const record = (node: ts.Node, text: string): void => {
		for (const { term, pattern } of FORBIDDEN_TERMS) {
			if (!pattern.test(text)) continue;
			const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			hits.push({ file, line: position.line + 1, term, text });
		}
	};

	const visit = (node: ts.Node): void => {
		// Type-only string positions (`type T = "handoff"`) are erased at
		// compile time and can never reach a user; skip their whole subtree.
		if (ts.isTypeNode(node)) return;

		const literal =
			ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
		if (literal) {
			// An outermost `+` concatenation is scanned as a whole; a literal
			// that is one of its operands would otherwise double-report.
			if (!closestAncestor(node, isPlusConcatenation)) record(node, flattenLiteralText(node));
		} else if (isPlusConcatenation(node) && !closestAncestor(node, isPlusConcatenation)) {
			record(node, flattenLiteralText(node));
		}

		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return hits;
}

/** Repo root, resolved from this test file (`src/__tests__/…`). */
const REPO_ROOT = join(__dirname, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");

/** Every non-test `.ts` file shipped from `src/`, sorted for stable output. */
function runtimeSourceFiles(): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (entry.name === "__tests__") continue;
				walk(join(dir, entry.name));
			} else if (entry.isFile() && entry.name.endsWith(".ts")) {
				files.push(join(dir, entry.name));
			}
		}
	};
	walk(SRC_DIR);
	return files.sort();
}

const toRepoPath = (absolute: string): string => relative(REPO_ROOT, absolute).split(sep).join("/");

const allowlistKey = (hit: VocabularyHit): string => `${hit.file}|${hit.term}`;

/** Scan the real tree and drop any hit with a recorded allow-list reason. */
function scanTree(): VocabularyHit[] {
	const violations: VocabularyHit[] = [];
	for (const absolute of runtimeSourceFiles()) {
		const file = toRepoPath(absolute);
		for (const hit of scanRuntimeVocabulary(readFileSync(absolute, "utf8"), file)) {
			if (VOCABULARY_ALLOWLIST.has(allowlistKey(hit))) continue;
			violations.push(hit);
		}
	}
	return violations;
}

const formatHits = (hits: VocabularyHit[]): string =>
	hits.map((hit) => `  ${hit.file}:${hit.line}  [${hit.term}]  ${JSON.stringify(hit.text)}`).join("\n");

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

describe("runtime-string vocabulary ratchet (#183)", () => {
	it("finds no internal vocabulary or issue reference in src/** runtime strings", () => {
		const violations = scanTree();
		expect(
			violations,
			`Internal vocabulary leaked into a runtime string. Reword the string (state the intent directly) or, if the string genuinely cannot reach a user, add a RECORDED reason to VOCABULARY_ALLOWLIST.\n${formatHits(violations)}`,
		).toEqual([]);
	});

	it("scans a non-empty set of source files (guards against a vacuous pass)", () => {
		const files = runtimeSourceFiles().map(toRepoPath);
		// A wrong path or an over-broad exclusion would silently make the
		// ratchet scan nothing and pass forever. Pin the entry point and a
		// conservative floor.
		expect(files).toContain("src/index.ts");
		expect(files.length).toBeGreaterThan(20);
	});
});

// ---------------------------------------------------------------------------
// Scanner coverage — the crux of issue #183. A ratchet that cannot fail is
// indistinguishable from no ratchet, so each literal form the #174 grep missed
// is pinned here independently.
// ---------------------------------------------------------------------------

const scanFixture = (source: string): VocabularyHit[] => scanRuntimeVocabulary(source, "fixture.ts");

describe("scanner coverage — every runtime literal form is seen (#183)", () => {
	it("catches a double-quoted literal", () => {
		expect(scanFixture(`const a = "issue #98";`).map((h) => h.term)).toEqual(["issue #<n>"]);
	});

	it("catches a single-quoted literal", () => {
		expect(scanFixture(`const a = 'retry taxonomy';`).map((h) => h.term)).toEqual(["retry taxonomy"]);
	});

	it("catches a template literal without substitutions", () => {
		expect(scanFixture("const a = `the friction log`;").map((h) => h.term)).toEqual(["friction log"]);
	});

	it("catches a template literal with substitutions", () => {
		// The exact #174 miss: the leak sat in a template literal with `${…}`.
		const source = "const a = `Retry run ID not found: ${id}. (issue #98)`;";
		expect(scanFixture(source).map((h) => h.term)).toEqual(["issue #<n>"]);
	});

	it("catches a concatenation whose term spans literal boundaries", () => {
		expect(scanFixture(`const a = "issue " + "#98";`).map((h) => h.term)).toEqual(["issue #<n>"]);
	});

	it("catches a leak inside one fragment of a longer concatenation", () => {
		const source = `const a = "prefix " + "worktree" + " suffix";`;
		expect(scanFixture(source).map((h) => h.term)).toEqual(["worktree"]);
	});

	it("reports the offending file and line", () => {
		const source = `const clean = "ok";\nconst leak = "handoff";`;
		expect(scanFixture(source)).toEqual([
			{ file: "fixture.ts", line: 2, term: "handoff", text: "handoff" },
		]);
	});

	it("catches each forbidden term", () => {
		const sources: Array<[string, string]> = [
			["Rule <n>", "Rule 18"],
			["retry taxonomy", "the retry taxonomy"],
			["friction log", "friction log"],
			["handoff", "handoff"],
			["worktree", "worktree"],
			["E<nn>", "E10"],
			["issue #<n>", "issue #183"],
		];
		for (const [term, text] of sources) {
			expect(scanFixture(`const a = ${JSON.stringify(text)};`).map((h) => h.term), text).toContain(term);
		}
	});
});

describe("scanner coverage — non-runtime positions are excluded (#183)", () => {
	it("ignores comments", () => {
		expect(scanFixture(`// worktree handoff\n/* issue #99 */\nconst a = "clean";`)).toEqual([]);
	});

	it("ignores type-only string positions", () => {
		expect(scanFixture(`type Internal = "handoff" | "worktree";`)).toEqual([]);
	});

	it("does not flag an unrelated marker that merely resembles E<nn>", () => {
		// `E2E` and `0xE4` are word-bounded / numeric, so the intercom-marker
		// pattern must not fire on them.
		expect(scanFixture(`const a = "E2E test"; const b = 0xE4;`)).toEqual([]);
	});

	it("passes a clean runtime string", () => {
		expect(scanFixture(`const a = \`Model \${id} finished in \${ms}ms\`;`)).toEqual([]);
	});
});

describe("scanner coverage — regresses the #174 leaks (#183)", () => {
	it("would have flagged the completion directive", () => {
		const directive =
			"Process this completion silently unless action is needed. If the run failed, apply the retry taxonomy: " +
			"a re-dispatch is not a retry, and Rule 18 governs terminations — ask the user before terminating anything.";
		expect(scanFixture(`const a = ${JSON.stringify(directive)};`).map((h) => h.term)).toEqual([
			"Rule <n>",
			"retry taxonomy",
		]);
	});

	it("would have flagged the retry-run-id tool result", () => {
		const text =
			"Retry run ID not found: id. The run may have been pruned, or it was a background run created before the run-entry fix (issue #98).";
		expect(scanFixture(`const a = \`${text}\`;`).map((h) => h.term)).toEqual(["issue #<n>"]);
	});

	it("would have flagged the dangling-template-preset warning", () => {
		const text = 'template "x" references preset "y" — auto-route suppressed (issue #81)';
		expect(scanFixture(`log.warn(${JSON.stringify(text)});`).map((h) => h.term)).toEqual(["issue #<n>"]);
	});
});
