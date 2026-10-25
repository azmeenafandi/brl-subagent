/**
 * Near-duplicate prose guard — issue #375 (the smell audit's §8.4 "cheapest
 * concrete borrow").
 *
 * The class this kills: the `retryOnTimeout` prose (pr370) lived, slightly
 * reworded, in the tool guideline AND the schema description — a review caught
 * it by reading, and nothing made the second copy a build failure. Five
 * surfaces have to stay in sync (tool guideline, schema description, `AGENT.md`,
 * `README.md`, `CHANGELOG.md`), so the same drift keeps shipping.
 *
 * Why an AST scan and not a grep: the prose is split across `+` concatenations
 * (e.g. `src/schema.ts`'s descriptions), and a text search would also match
 * comments, which are not shipped prose. `parseTexts` sees every literal form
 * and no comments — the same coverage boundary as `runtime-vocabulary.test.ts`
 * (#183), which is the sibling this file follows.
 *
 * Scope: every string literal ≥ `MIN_LENGTH` characters across `src/**`,
 * excluding `src/__tests__/**` (fixtures here necessarily repeat prose).
 * CROSS-FILE pairs only — the drift class is one piece of prose living on two
 * surfaces, and an intra-file repeat is already visible on screen. The
 * intra-file clusters the audit did find (schema step shapes, §8.5 D7) are a
 * known backlog item; allow-listing them here would make the guard lie.
 *
 * Detection = whitespace-normalised EQUALITY, or word-token Jaccard ≥ 0.80.
 * Measured ceiling on the tree this guard landed against: 0.667
 * (`src/index.ts:2867` ↔ `src/schema.ts:168`; the `retryOnTimeout` pair now
 * 0.619). 0.80 clears that ceiling with margin and still catches a one-word
 * edit: a ~12-token literal with one token changed scores ≈0.85.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
	flattenLiteralText,
	isBinaryExpression,
	isNoSubstitutionTemplateLiteral,
	isParenthesizedExpression,
	isStringLiteral,
	isTemplateExpression,
	isTypeNode,
	parseTexts,
	SUBSTITUTION,
	SyntaxKind,
} from "../../scripts/ts-ast.mjs";
import type { Node, SourceFile } from "../../scripts/ts-ast.mjs";

/** Shorter literals are field names, error codes and unit suffixes, not prose. */
const MIN_LENGTH = 80;

/** Word-token Jaccard at or above this counts as near-identical. */
const OVERLAP_THRESHOLD = 0.8;

interface Literal {
	/** Repo-relative path with `/` separators. */
	file: string;
	/** 1-based line of the literal. */
	line: number;
	/** The literal text as produced, substitutions flattened. */
	text: string;
}

interface DuplicatePair {
	left: Literal;
	right: Literal;
	/** `1` for normalised equality, otherwise the token Jaccard. */
	overlap: number;
}

/** Collapse runs of whitespace so indentation and line wrapping cannot hide a copy. */
const normalizeProse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Lower-cased word tokens; punctuation is a boundary, not content. */
const tokensOf = (text: string): Set<string> =>
	new Set(
		normalizeProse(text)
			.toLowerCase()
			.split(/[^a-z0-9\u0000]+/)
			.filter((token) => token.length > 0),
	);

const isPlusConcatenation = (node: Node): node is Node & { left: Node; right: Node } =>
	isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken;

/** Nearest non-parenthesised ancestor satisfying `pred`, if any. */
function closestAncestor(node: Node, pred: (candidate: Node) => boolean): Node | undefined {
	let parent = node.parent as Node | undefined;
	while (parent && isParenthesizedExpression(parent)) parent = parent.parent;
	return parent && pred(parent) ? parent : undefined;
}

/**
 * Collect the shipped prose of one parsed source file.
 *
 * A `+` concatenation is recorded as ONE literal (its operands are skipped), so
 * a description split across lines compares as the sentence it actually renders.
 */
function collectLiterals(sourceFile: SourceFile, file: string): Literal[] {
	const literals: Literal[] = [];

	const record = (node: Node): void => {
		const text = flattenLiteralText(node);
		if (normalizeProse(text).length < MIN_LENGTH) return;
		const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		literals.push({ file, line: line + 1, text });
	};

	const visit = (node: Node): void => {
		// Type positions are erased at compile time — `type T = "…"` is not prose.
		if (isTypeNode(node)) return;
		if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isTemplateExpression(node)) {
			if (!closestAncestor(node, isPlusConcatenation)) record(node);
		} else if (isPlusConcatenation(node) && !closestAncestor(node, isPlusConcatenation)) {
			record(node);
		}
		node.forEachChild(visit);
	};

	sourceFile.forEachChild(visit);
	return literals;
}

/** Normalised equality short-circuits to 1 — it is the strictest form of "same prose". */
function overlapBetween(left: Literal, right: Literal): number {
	if (normalizeProse(left.text) === normalizeProse(right.text)) return 1;
	const a = tokensOf(left.text);
	const b = tokensOf(right.text);
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / (a.size + b.size - shared);
}

/** Every cross-file pair whose prose is near-identical, most similar first. */
function findNearDuplicates(literals: readonly Literal[]): DuplicatePair[] {
	const duplicates: DuplicatePair[] = [];
	for (let i = 0; i < literals.length; i++) {
		for (let j = i + 1; j < literals.length; j++) {
			const left = literals[i]!;
			const right = literals[j]!;
			if (left.file === right.file) continue;
			const overlap = overlapBetween(left, right);
			if (overlap >= OVERLAP_THRESHOLD) duplicates.push({ left, right, overlap });
		}
	}
	return duplicates.sort((a, b) => b.overlap - a.overlap);
}

const formatDuplicates = (duplicates: readonly DuplicatePair[]): string =>
	duplicates
		.map(
			({ left, right, overlap }) =>
				`  ${overlap.toFixed(2)}  ${left.file}:${left.line} <-> ${right.file}:${right.line}\n` +
				`      ${JSON.stringify(normalizeProse(left.text))}\n` +
				`      ${JSON.stringify(normalizeProse(right.text))}`,
		)
		.join("\n");

// ---------------------------------------------------------------------------
// The tree sweep
// ---------------------------------------------------------------------------

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

/** ONE parse for the whole sweep — the sources do not change during a run. */
function shippedLiterals(): Literal[] {
	const files = runtimeSourceFiles();
	const parsed = parseTexts(files.map((absolute) => ({ path: absolute, text: readFileSync(absolute, "utf8") })));
	return files.flatMap((absolute) => {
		const file = toRepoPath(absolute);
		const sourceFile = parsed.get(resolve(absolute));
		if (!sourceFile) throw new Error(`prose-duplication: no parsed source file for ${file}`);
		return collectLiterals(sourceFile, file);
	});
}

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

describe("near-duplicate prose guard (#375)", () => {
	it("collects a non-empty set of shipped prose literals (guards against a vacuous pass)", () => {
		const literals = shippedLiterals();
		// A wrong path or an over-broad exclusion would make the guard scan
		// nothing and pass forever — the exact silent pass this guard exists to
		// kill. Pin the entry points and a conservative floor.
		expect(literals.length).toBeGreaterThan(40);
		expect(literals.some((literal) => literal.file === "src/index.ts")).toBe(true);
		expect(literals.some((literal) => literal.file === "src/schema.ts")).toBe(true);
	});

	it("finds no near-duplicate prose across shipped surfaces", () => {
		const duplicates = findNearDuplicates(shippedLiterals());
		expect(
			duplicates,
			`The same prose shipped on two surfaces. Keep ONE authoritative description and have the other surface reference it (or genuinely reword it — see the review dispatch's guide shape).\n${formatDuplicates(duplicates)}`,
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Detector coverage — a ratchet that cannot fail is indistinguishable from no
// ratchet, so the detector's positive and negative cases are pinned directly.
// ---------------------------------------------------------------------------

/** The pristine sentence the fixture pairs are built from. */
const FIXTURE_SENTENCE =
	"The timeout applies to foreground runs only and never restores the explicit-only retry flag on a retry";

const fixtureFile = (name: string, body: string): { sourceFile: SourceFile; file: string } => {
	const sourceFile = parseTexts([{ path: name, text: body }]).get(resolve(name));
	if (!sourceFile) throw new Error(`prose-duplication: no parsed fixture for ${name}`);
	return { sourceFile, file: name };
};

describe("prose-duplication detector coverage", () => {
	it("normalised-equality pair is a duplicate", () => {
		const left = fixtureFile("one.ts", `const a = "${FIXTURE_SENTENCE}";`);
		const right = fixtureFile("two.ts", `const b =\n\t"${FIXTURE_SENTENCE}";`);
		const literals = [...collectLiterals(left.sourceFile, left.file), ...collectLiterals(right.sourceFile, right.file)];
		const duplicates = findNearDuplicates(literals);
		expect(duplicates).toHaveLength(1);
		expect(duplicates[0]!.overlap).toBe(1);
	});

	it("a one-word edit is still near-identical", () => {
		// The retryOnTimeout shape: the same prose, reworded for a second surface.
		const edited = FIXTURE_SENTENCE.replace("foreground", "background");
		const left = fixtureFile("one.ts", `const a = "${FIXTURE_SENTENCE}";`);
		const right = fixtureFile("two.ts", `const b = "${edited}";`);
		const literals = [...collectLiterals(left.sourceFile, left.file), ...collectLiterals(right.sourceFile, right.file)];
		expect(findNearDuplicates(literals)).toHaveLength(1);
	});

	it("literals on the same topic but genuinely different prose are not duplicates", () => {
		const unrelated = "A background run that dies on a dropped connection is replayed once and announced with a warning";
		const left = fixtureFile("one.ts", `const a = "${FIXTURE_SENTENCE}";`);
		const right = fixtureFile("two.ts", `const b = "${unrelated}";`);
		const literals = [...collectLiterals(left.sourceFile, left.file), ...collectLiterals(right.sourceFile, right.file)];
		expect(findNearDuplicates(literals)).toEqual([]);
	});

	it("a `+` concatenation compares as the sentence it renders", () => {
		const left = fixtureFile("one.ts", `const a = "${FIXTURE_SENTENCE}";`);
		const right = fixtureFile("two.ts", `const b = "${FIXTURE_SENTENCE.slice(0, 40)} " + "${FIXTURE_SENTENCE.slice(41)}";`);
		const literals = [...collectLiterals(left.sourceFile, left.file), ...collectLiterals(right.sourceFile, right.file)];
		expect(findNearDuplicates(literals)).toHaveLength(1);
	});

	it("collects a no-substitution template literal verbatim", () => {
		// The extractor sees backtick literals with no `${…}` as prose, not as
		// syntax. Break that branch and this fixture collects nothing.
		const fixture = fixtureFile("one.ts", `const a = \`${FIXTURE_SENTENCE}\`;`);
		const literals = collectLiterals(fixture.sourceFile, fixture.file);
		expect(literals).toHaveLength(1);
		expect(literals[0]!.text).toBe(FIXTURE_SENTENCE);
	});

	it("collects a template expression with its substitution flattened", () => {
		// `${…}` is a placeholder, not prose: the surrounding text must survive
		// and compare with a plain literal. Break the substitution flattening and
		// the collected text loses the head/tail it should frame.
		const head = "The timeout applies to foreground runs only and never restores";
		const tail = "the explicit-only retry flag on a retry";
		const fixture = fixtureFile("one.ts", `const a = \`${head} \${value} ${tail}\`;`);
		const literals = collectLiterals(fixture.sourceFile, fixture.file);
		expect(literals).toHaveLength(1);
		expect(literals[0]!.text).toBe(`${head} ${SUBSTITUTION} ${tail}`);
	});

	it("comments and type positions are not prose", () => {
		const fixture = fixtureFile(
			"one.ts",
			[
				`// ${FIXTURE_SENTENCE}`,
				`/* ${FIXTURE_SENTENCE} */`,
				`export type T = "${FIXTURE_SENTENCE}";`,
				`const b = 1;`,
			].join("\n"),
		);
		// The only long string is in a type position; the comments never reach the AST.
		expect(collectLiterals(fixture.sourceFile, fixture.file)).toEqual([]);
	});

	it("a literal below the length floor is ignored", () => {
		const fixture = fixtureFile("one.ts", `const a = "${FIXTURE_SENTENCE.slice(0, MIN_LENGTH - 1)}";`);
		expect(collectLiterals(fixture.sourceFile, fixture.file)).toEqual([]);
	});
});
