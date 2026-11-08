#!/usr/bin/env node
/**
 * Import convention guard (issue #476) — the executable half of the import rule.
 *
 * THE SAFETY RULE. No statement that can emit a module request may move, merge,
 * or change liveness. Only a statement-level `import type` is erased by every
 * loader this repo runs (tsc with `erasableSyntaxOnly`, jiti, vitest/esbuild,
 * Node's type stripping), so only it may be hoisted and sorted. A type name
 * folds into a value statement as an inline `type` modifier *at that statement's
 * existing position* — inline types never force an emit, so the value statement's
 * module request and its order in the request sequence are untouched. Value
 * statements are never reordered, never merged with each other, and never merged
 * with a namespace, side-effect or `with { … }` attribute statement.
 *
 * Rules:
 * - `type-block-order` — every statement-level `import type` precedes the first
 *   value statement of the import block.
 * - `type-block-sorted` — the type block is sorted by module specifier
 *   (codepoint order on the specifier text, quotes excluded).
 * - `duplicate` — one specifier, two statements: `type` + `type` must be one
 *   type statement, and `type` + `value` must fold the type names into the value
 *   statement as inline `type` modifiers. Two *value* statements of one specifier
 *   are reported (never auto-merged — that would be an unsafe "fix"). Exempt:
 *   any group holding a namespace, side-effect or attribute statement, a
 *   statement-level `import type` with a default binding (no inline form exists
 *   for a default binding), or a statement with a comment inside it.
 * - `wrap` — a statement whose canonical single-line rendering exceeds 140
 *   characters must be multi-line with one named binding per line. Statements
 *   with no named-binding list (side-effect, namespace-only, default-only) have
 *   nothing to split and are exempt. Attribute statements are exempt.
 * - `collapse` — a statement rendering at 140 characters or less must be one
 *   line. Exempt: a comment inside the statement, and attribute statements.
 *
 * Canonical form (built from the AST, never from source whitespace):
 *   `import ` + [`type `] + [default] + [`, `] + [`{ a, b }` | `* as ns`]
 *   + ` from ` + <raw specifier token, quotes included> + `;`
 * and, when multi-line, one binding per line inside `{ … }` with a trailing comma.
 *
 * BOUNDARIES (stated, not implied):
 * - covers `<dir>/*.ts` (default `src`), non-recursive: `src/__tests__/**`,
 *   `.pi/extensions/**`, presets, templates and `.github` are not inspected;
 * - ignores `export … from`, `import x = require()`, and dynamic `import()`;
 * - imports after the first non-import statement are out of scope (they are not
 *   part of the import block, and moving them would change execution order);
 * - the adapter does not expose parse diagnostics, so malformed syntax is not
 *   reported as a violation — an unreadable file/dir is a usage failure (exit 2);
 * - specifier spelling and quote style are not rewritten or enforced;
 * - there is NO `--fix`. Normalisation is a reviewed change, not a code path.
 *
 * Usage: node scripts/check-imports.mjs [--dir <path>]
 * Exit: 0 clean · 1 violations · 2 usage error, unreadable dir, empty corpus.
 *
 * The single TypeScript entry point is `./ts-ast.mjs` (ADR 0013) — this file
 * never imports `typescript` directly.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isImportDeclaration, isNamedImports, isNamespaceImport, parseTexts } from "./ts-ast.mjs";

/** Render length above which an import must be split, one binding per line. */
const LINE_LIMIT = 140;

/** Rule ids, in report order — each is a mutant-killed contract (see the test file). */
export const RULES = Object.freeze({
	TYPE_BLOCK_ORDER: "type-block-order",
	TYPE_BLOCK_SORTED: "type-block-sorted",
	DUPLICATE: "duplicate",
	WRAP: "wrap",
	COLLAPSE: "collapse",
});

/**
 * @typedef {object} ImportBinding
 * @property {boolean} typeOnly Inline `type` modifier on this binding.
 * @property {string | undefined} propertyName The `as` source name, if aliased.
 * @property {string} name The bound name.
 */

/**
 * @typedef {object} ImportStatement
 * @property {string} specifier Module specifier text, quotes excluded.
 * @property {string} specifierToken Raw specifier token, quotes included.
 * @property {number} line 1-based line of the `import` keyword.
 * @property {string} raw Statement source, keyword to semicolon.
 * @property {boolean} statementTypeOnly Statement-level `import type`.
 * @property {string | undefined} defaultName Default binding name.
 * @property {boolean} namespace `* as ns` binding.
 * @property {string | undefined} namespaceName The `ns` of `* as ns`.
 * @property {boolean} named Has a named-bindings list.
 * @property {ImportBinding[]} bindings Named bindings in source order.
 * @property {boolean} sideEffect No import clause at all.
 * @property {boolean} hasAttributes `with { … }` / `assert { … }` present.
 * @property {boolean} hasComment A comment inside the statement.
 * @property {boolean} multiline Statement source spans more than one line.
 */

/**
 * @typedef {object} Violation
 * @property {string} path
 * @property {number} line
 * @property {string} rule
 * @property {string} message
 */

// ---------------------------------------------------------------------------
// AST -> statement model
// ---------------------------------------------------------------------------

/**
 * The file's import block: the leading run of `import` declarations, in source
 * order. Anything after the first non-import statement is deliberately absent —
 * it is out of scope (see BOUNDARIES) and must stay where it is.
 *
 * @param {import("typescript/unstable/ast").SourceFile} sourceFile
 * @returns {import("typescript/unstable/ast").ImportDeclaration[]}
 */
function importBlock(sourceFile) {
	const block = [];
	for (const statement of sourceFile.statements) {
		if (!isImportDeclaration(statement)) break;
		block.push(statement);
	}
	return block;
}

/**
 * Map one import declaration to the statement model every rule reasons about.
 *
 * @param {import("typescript/unstable/ast").ImportDeclaration} statement
 * @param {string} text Whole-file source, for the statement's own slice and lines.
 * @param {import("typescript/unstable/ast").SourceFile} sourceFile
 * @returns {ImportStatement}
 */
function describeImport(statement, text, sourceFile) {
	const clause = statement.importClause;
	const start = statement.getStart();
	const raw = text.slice(start, statement.end);
	const namedBindings = clause?.namedBindings;
	const named = Boolean(namedBindings && isNamedImports(namedBindings));
	const namespace = Boolean(namedBindings && isNamespaceImport(namedBindings));
	return {
		specifier: statement.moduleSpecifier.text,
		specifierToken: statement.moduleSpecifier.getText(),
		line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
		raw,
		statementTypeOnly: Boolean(clause?.isTypeOnly),
		defaultName: clause?.name?.text,
		namespace,
		namespaceName: namespace ? namedBindings.name.text : undefined,
		named,
		bindings: named
			? namedBindings.elements.map((element) => ({
					typeOnly: element.isTypeOnly,
					propertyName: element.propertyName?.text,
					name: element.name.text,
				}))
			: [],
		sideEffect: !clause,
		hasAttributes: Boolean(statement.attributes),
		hasComment: hasCommentOutsideStrings(raw),
		multiline: raw.includes("\n"),
	};
}

/**
 * True when `raw` holds a `//` or `/*` comment outside its string literals.
 * A hand-rolled scan rather than a regex so a specifier like `'a//b'` cannot
 * masquerade as a comment; the adapter exposes no comment-range helper.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function hasCommentOutsideStrings(raw) {
	let quote;
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];
		if (quote) {
			if (char === "\\") index += 1;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "/" && (raw[index + 1] === "/" || raw[index + 1] === "*")) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Canonical rendering
// ---------------------------------------------------------------------------

/**
 * @param {ImportBinding} binding
 * @returns {string}
 */
function renderBinding(binding) {
	const text = binding.propertyName ? `${binding.propertyName} as ${binding.name}` : binding.name;
	return binding.typeOnly ? `type ${text}` : text;
}

/**
 * @param {ImportBinding[]} bindings
 * @returns {string}
 */
function renderNamedList(bindings) {
	return bindings.length === 0 ? "{}" : `{ ${bindings.map(renderBinding).join(", ")} }`;
}

/**
 * The canonical single-line rendering — the render `wrap`/`collapse` measure.
 * Attribute text is not rendered (those statements are exempt); it is measured
 * without it, which is the conservative direction.
 *
 * @param {ImportStatement} desc
 * @returns {string}
 */
function renderSingleLine(desc) {
	if (desc.sideEffect) return `import ${desc.specifierToken};`;
	const bindings = [];
	if (desc.defaultName) bindings.push(desc.defaultName);
	if (desc.namespace) bindings.push(`* as ${desc.namespaceName}`);
	if (desc.named) bindings.push(renderNamedList(desc.bindings));
	return `import ${desc.statementTypeOnly ? "type " : ""}${bindings.join(", ")} from ${desc.specifierToken};`;
}

/**
 * The canonical multi-line rendering, one line per binding — the only accepted
 * form above the limit when the statement has a named-bindings list.
 *
 * @param {ImportStatement} desc
 * @returns {string[]} Lines, without indentation (compared against trimmed source).
 */
function renderMultilineLines(desc) {
	const head = `import ${desc.statementTypeOnly ? "type " : ""}${desc.defaultName ? `${desc.defaultName}, ` : ""}{`;
	return [head, ...desc.bindings.map((binding) => `${renderBinding(binding)},`), `} from ${desc.specifierToken};`];
}

/**
 * @param {ImportStatement} desc
 * @returns {boolean}
 */
function isCanonicalMultiline(desc) {
	const actual = desc.raw.split("\n").map((line) => line.trim());
	const expected = renderMultilineLines(desc);
	return actual.length === expected.length && actual.every((line, index) => line === expected[index]);
}

/**
 * Codepoint order on the specifier text — deterministic, locale-independent,
 * and trivially checkable by eye.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareSpecifiers(left, right) {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * @param {string} path
 * @param {number} line
 * @param {string} rule
 * @param {string} message
 * @returns {Violation}
 */
function violation(path, line, rule, message) {
	return { path, line, rule, message };
}

/**
 * Every statement-level `import type` must precede the value statements. Type
 * statements are erased, so hoisting one never changes a module request.
 *
 * @param {ImportStatement[]} descs
 * @param {string} path
 * @returns {Violation[]}
 */
function orderViolations(descs, path) {
	const violations = [];
	let firstValueSeen = false;
	for (const desc of descs) {
		if (!desc.statementTypeOnly) {
			firstValueSeen = true;
			continue;
		}
		if (!firstValueSeen) continue;
		violations.push(
			violation(
				path,
				desc.line,
				RULES.TYPE_BLOCK_ORDER,
				`import type from '${desc.specifier}' must sit in the type block above every value import (type statements emit nothing, so hoisting is safe).`,
			),
		);
	}
	return violations;
}

/**
 * The type block is sorted by specifier. Reported as the adjacent inversion, so
 * the message names the pair that has to swap.
 *
 * @param {ImportStatement[]} descs
 * @param {string} path
 * @returns {Violation[]}
 */
function sortViolations(descs, path) {
	const types = descs.filter((desc) => desc.statementTypeOnly);
	const violations = [];
	for (let index = 1; index < types.length; index += 1) {
		const previous = types[index - 1];
		const current = types[index];
		if (compareSpecifiers(previous.specifier, current.specifier) <= 0) continue;
		violations.push(
			violation(
				path,
				current.line,
				RULES.TYPE_BLOCK_SORTED,
				`type import of '${current.specifier}' must sort before '${previous.specifier}' (the type block is sorted by specifier).`,
			),
		);
	}
	return violations;
}

/**
 * Is this same-specifier group outside the merge rule? A namespace, side-effect
 * or attribute statement is never merged; a type statement with a default
 * binding has no inline form to fold into; a statement with a comment inside it
 * would lose the comment.
 *
 * @param {ImportStatement[]} group
 * @returns {boolean}
 */
function isMergeExempt(group) {
	return group.some(
		(desc) =>
			desc.sideEffect ||
			desc.namespace ||
			desc.hasAttributes ||
			desc.hasComment ||
			(desc.statementTypeOnly && (desc.defaultName !== undefined || !desc.named)),
	);
}

/**
 * Duplicate specifiers: type+type and type+value are mergeable and therefore
 * required; value+value is reported and never merged (that is the unsafe fix).
 *
 * @param {ImportStatement[]} descs
 * @param {string} path
 * @returns {Violation[]}
 */
function duplicateViolations(descs, path) {
	/** @type {Map<string, ImportStatement[]>} */
	const groups = new Map();
	for (const desc of descs) {
		const group = groups.get(desc.specifier);
		if (group) group.push(desc);
		else groups.set(desc.specifier, [desc]);
	}
	const violations = [];
	for (const [specifier, group] of groups) {
		if (group.length < 2 || isMergeExempt(group)) continue;
		const types = group.filter((desc) => desc.statementTypeOnly);
		const values = group.filter((desc) => !desc.statementTypeOnly);
		if (values.length > 1) {
			violations.push(
				violation(
					path,
					values[1].line,
					RULES.DUPLICATE,
					`${values.length} value imports of '${specifier}' — merging value statements would change module-request order, so they are reported, never auto-merged; keep one value statement.`,
				),
			);
		}
		if (types.length === 0) continue;
		if (values.length === 1) {
			violations.push(
				violation(
					path,
					types[0].line,
					RULES.DUPLICATE,
					`type import of '${specifier}' must fold into the value import as inline \`type\` modifiers (same statement, same position).`,
				),
			);
		} else if (values.length === 0 && types.length > 1) {
			violations.push(
				violation(
					path,
					types[1].line,
					RULES.DUPLICATE,
					`${types.length} import type statements of '${specifier}' must be one statement.`,
				),
			);
		}
	}
	return violations;
}

/**
 * Wrap and collapse: one canonical width rule in both directions.
 *
 * @param {ImportStatement[]} descs
 * @param {string} path
 * @returns {Violation[]}
 */
function layoutViolations(descs, path) {
	const violations = [];
	for (const desc of descs) {
		if (desc.hasAttributes || desc.hasComment) continue;
		const rendered = renderSingleLine(desc);
		if (rendered.length > LINE_LIMIT) {
			if (!desc.named) continue;
			if (!desc.multiline) {
				violations.push(
					violation(
						path,
						desc.line,
						RULES.WRAP,
						`import of '${desc.specifier}' renders at ${rendered.length} chars (limit ${LINE_LIMIT}) and must be multi-line with one binding per line.`,
					),
				);
			} else if (!isCanonicalMultiline(desc)) {
				violations.push(
					violation(
						path,
						desc.line,
						RULES.WRAP,
						`import of '${desc.specifier}' must put one binding per line inside the braces (canonical multi-line form).`,
					),
				);
			}
			continue;
		}
		if (!desc.multiline) continue;
		violations.push(
			violation(
				path,
				desc.line,
				RULES.COLLAPSE,
				`import of '${desc.specifier}' renders at ${rendered.length} chars (limit ${LINE_LIMIT}) and must be a single line.`,
			),
		);
	}
	return violations;
}

/**
 * All violations in one file, ordered by line then rule id.
 *
 * @param {import("typescript/unstable/ast").SourceFile} sourceFile
 * @param {string} text
 * @param {string} path
 * @returns {Violation[]}
 */
function fileViolations(sourceFile, text, path) {
	const descs = importBlock(sourceFile).map((statement) => describeImport(statement, text, sourceFile));
	return [
		...orderViolations(descs, path),
		...sortViolations(descs, path),
		...duplicateViolations(descs, path),
		...layoutViolations(descs, path),
	].sort((left, right) => left.line - right.line || compareSpecifiers(left.rule, right.rule));
}

/**
 * The one entry point tests use: in-memory `{ path, text }` pairs in, violations
 * out. An empty corpus yields no violations — refusing an empty scan is the
 * CLI's job (exit 2), not this function's.
 *
 * @param {readonly { path: string, text: string }[]} files
 * @returns {Violation[]}
 */
export function collectViolations(files) {
	if (files.length === 0) return [];
	const parsed = parseTexts(files);
	const violations = [];
	for (const file of files) {
		const sourceFile = parsed.get(resolve(file.path));
		if (!sourceFile) throw new Error(`check-imports: TypeScript did not parse ${file.path}`);
		violations.push(...fileViolations(sourceFile, file.text, file.path));
	}
	return violations;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/check-imports.mjs [--dir <path>]

Import convention guard (issue #476). Inspects <path>/*.ts (default: src).

Rules: ${Object.values(RULES).join(", ")}.

Boundaries:
  - <path>/*.ts only, non-recursive: src/__tests__/**, .pi/extensions/**,
    presets/ and templates/ are not inspected;
  - \`export … from\`, \`import x = require()\` and dynamic \`import()\` are ignored;
  - imports after the first non-import statement are out of scope;
  - malformed syntax is not detected (the AST adapter exposes no diagnostics);
  - specifier spelling and quote style are not rewritten or enforced;
  - there is no --fix: normalisation is a reviewed change.

Exit: 0 clean · 1 violations · 2 usage error, unreadable directory, empty corpus.`;

/**
 * @param {string} message
 * @returns {never}
 */
function usageError(message) {
	console.error(`check-imports: ${message}\n\n${USAGE}`);
	process.exit(2);
}

/**
 * @param {string[]} argv
 * @returns {{ dir: string, help: boolean }}
 */
function parseArgs(argv) {
	let dir = "src";
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") help = true;
		else if (arg === "--dir") {
			const value = argv[index + 1];
			if (!value) usageError("--dir needs a path");
			dir = value;
			index += 1;
		} else if (arg.startsWith("--dir=")) dir = arg.slice("--dir=".length);
		else usageError(`unknown argument: ${arg}`);
	}
	return { dir, help };
}

/**
 * Read the corpus. A missing/unreadable directory or an empty corpus is a hard
 * failure: a clean scan over nothing would be a false pass.
 *
 * @param {string} dir
 * @returns {{ path: string, text: string }[]}
 */
function readCorpus(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		usageError(`cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const files = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		const path = join(dir, entry.name);
		try {
			files.push({ path, text: readFileSync(path, "utf8") });
		} catch (error) {
			usageError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (files.length === 0) usageError(`${dir}: no .ts files — an empty corpus is not a clean corpus`);
	return files.sort((left, right) => compareSpecifiers(left.path, right.path));
}

function main() {
	const { dir, help } = parseArgs(process.argv.slice(2));
	if (help) {
		console.log(USAGE);
		return;
	}
	const files = readCorpus(dir);
	const violations = collectViolations(files);
	if (violations.length === 0) {
		console.log(`imports: ${files.length} files, 0 violations`);
		return;
	}
	for (const item of violations) console.error(`${item.path}:${item.line} ${item.rule}: ${item.message}`);
	console.error(`imports: ${files.length} files, ${violations.length} violations`);
	process.exitCode = 1;
}

// Importing this module (the test file does) must not run the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
