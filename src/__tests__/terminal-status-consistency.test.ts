/**
 * Issue #179 — the terminal-status consistency ratchet (item 5 of the C1 review response).
 *
 * WHY THIS EXISTS
 * The #179 fix widened the failure predicate in `isSubagentError`. Several other places kept
 * their OWN copy of that predicate (`exitCode !== 0 || stopReason === "error" || "aborted"`)
 * and were not widened with it — so a subtask ending `length` / `toolUse` / `deferred` /
 * `pending` was recorded FAILED but rendered as a SUCCESS in the TUI and counted as succeeded
 * in the parallel header. That is the very defect #179 exists to remove, reintroduced by
 * silent divergence between copies of one rule.
 *
 * TWO GUARDS
 *   1. BEHAVIOURAL — for every member of the SDK's StopReason union, the shared predicate and
 *      the shared tally must agree on the verdict.
 *   2. STRUCTURAL — no module outside `types.ts` may reimplement the predicate. This is the
 *      durable half: it fails the moment someone writes a private copy, rather than waiting
 *      for the copies to disagree in production.
 *
 * Issue #186 hardened the STRUCTURAL guard. The original line-regex matched only the exact
 * double-quoted inline form (`stopReason === "error"`), so 4 of the 8 spellings evaded it:
 * single quotes, an aliased/destructured identifier, array/`Set` membership, and a helper
 * that re-hard-codes the list in another module. It also did not guard `exitCode === 0`-as-
 * success at all. The guard is now an AST walk (TypeScript compiler API) over every non-test
 * `src/*.ts` top-level module. Each genuine exemption is an explicit `STRUCTURAL_ALLOWLIST`
 * entry with a RECORDED reason — in the spirit of `KNOWN_DELEGATE_KEYS` (src/params.ts) — so
 * an exception is a decision someone made, never a silently-tolerated omission.
 *
 * The scanner lives in this test file rather than in `src/`: `src/__tests__/**` is excluded
 * from the published tarball, so test-only data must not drag a module into the shipped tree.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import {
	isSubagentError,
	countSubagentOutcomes,
	EMPTY_USAGE,
	type SubagentResult,
} from "../types";

/** Build a minimal result — `isSubagentError` reads only `exitCode` and `stopReason`. */
function result(exitCode: number, stopReason?: string): SubagentResult {
	return {
		task: "probe",
		exitCode,
		messages: [],
		stderr: "",
		usage: { ...EMPTY_USAGE },
		...(stopReason ? { stopReason } : {}),
	} as SubagentResult;
}

/**
 * The SDK's StopReason union (@earendil-works/pi-ai): "pending" | "stop" | "length" |
 * "toolUse" | "error" | "aborted" | "deferred". Listed explicitly so the expectations are
 * readable; the structural guard below is what catches a future divergence.
 */
const CASES: Array<{ stopReason: string | undefined; exitCode: number; isError: boolean }> = [
	{ stopReason: "stop", exitCode: 0, isError: false },
	{ stopReason: undefined, exitCode: 0, isError: false },
	{ stopReason: "error", exitCode: 0, isError: true },
	{ stopReason: "aborted", exitCode: 0, isError: true },
	{ stopReason: "length", exitCode: 0, isError: true },
	{ stopReason: "toolUse", exitCode: 0, isError: true },
	{ stopReason: "deferred", exitCode: 0, isError: true },
	{ stopReason: "pending", exitCode: 0, isError: true },
	// exitCode still counts, independently of the stop reason
	{ stopReason: "stop", exitCode: 1, isError: true },
	{ stopReason: undefined, exitCode: 1, isError: true },
];

describe("terminal-status consistency (issue #179)", () => {
	it("isSubagentError classifies every StopReason as expected", () => {
		for (const c of CASES) {
			const label = `stopReason=${c.stopReason ?? "(none)"} exitCode=${c.exitCode}`;
			expect(isSubagentError(result(c.exitCode, c.stopReason)), label).toBe(c.isError);
		}
	});

	it("countSubagentOutcomes agrees with isSubagentError for every StopReason", () => {
		for (const c of CASES) {
			const r = result(c.exitCode, c.stopReason);
			const tally = countSubagentOutcomes([r]);
			const label = `stopReason=${c.stopReason ?? "(none)"} exitCode=${c.exitCode}`;
			expect({ succeeded: tally.succeeded, failed: tally.failed }, label).toEqual(
				c.isError ? { succeeded: 0, failed: 1 } : { succeeded: 1, failed: 0 },
			);
		}
	});

	it("countSubagentOutcomes totals a mixed batch and ignores undefined", () => {
		const tally = countSubagentOutcomes([
			result(0, "stop"),
			result(0, "length"),
			result(0, "toolUse"),
			result(0, "aborted"),
			undefined,
		]);
		expect(tally).toEqual({ succeeded: 1, failed: 3 });
	});
});

// ---------------------------------------------------------------------------
// Structural guard (#179, hardened by #186): the AST scanner
// ---------------------------------------------------------------------------

/**
 * The terminal-reason literals whose private re-use outside `types.ts` is the
 * fault class. `stop` is deliberately absent — it is the SUCCESS reason, so a
 * `stopReason === "stop"` check cannot desync the failure predicate.
 */
const FAILURE_REASONS = ["error", "aborted", "length", "toolUse", "deferred", "pending"] as const;
const FAILURE_REASON_SET: ReadonlySet<string> = new Set<string>(FAILURE_REASONS);

/** The full StopReason vocabulary — failures plus the success reason `stop`. */
const STOP_REASON_SET: ReadonlySet<string> = new Set<string>([...FAILURE_REASONS, "stop"]);

/** What made a node a reimplementation — carried into the failure message. */
type ReimplementationKind = "comparison" | "membership" | "failure-list" | "exit-code";

export interface ReimplementationHit {
	/** Repo-relative path with `/` separators. */
	file: string;
	/** 1-based line of the offending expression. */
	line: number;
	kind: ReimplementationKind;
	/** Short tag for the message/allow-list: the literal(s) that triggered it. */
	literal: string;
	/** Whitespace-normalised source text of the offending expression. */
	code: string;
}

const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** `node`'s text as a failure reason — string literal (either quote) or a no-substitution template. */
function failureLiteralText(node: ts.Node): string | undefined {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return FAILURE_REASON_SET.has(node.text) ? node.text : undefined;
	}
	return undefined;
}

/** Numeric literal text, including the `-1` prefix form used for the unset sentinel. */
function numericLiteralText(node: ts.Node): string | undefined {
	if (ts.isNumericLiteral(node)) return node.text;
	if (
		ts.isPrefixUnaryExpression(node) &&
		(node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
		ts.isNumericLiteral(node.operand)
	) {
		return node.operator === ts.SyntaxKind.MinusToken ? `-${node.operand.text}` : node.operand.text;
	}
	return undefined;
}

/** `exitCode` as a bare identifier or a `.exitCode` property read. */
function isExitCodeExpression(node: ts.Node): boolean {
	if (ts.isIdentifier(node) && node.text === "exitCode") return true;
	if (ts.isPropertyAccessExpression(node) && node.name.text === "exitCode") return true;
	return false;
}

/**
 * The array literal behind a list-shaped receiver: the literal itself, or the
 * array argument of a `new Set([...])` construction. Returns undefined for any
 * other receiver (an identifier, a call, a string), which keeps membership
 * checks on message CONTENT (e.g. `msg.includes("aborted")`) out of scope.
 */
function listLiteral(node: ts.Node): ts.ArrayLiteralExpression | undefined {
	if (ts.isArrayLiteralExpression(node)) return node;
	if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Set") {
		const [arg] = node.arguments ?? [];
		if (arg && ts.isArrayLiteralExpression(arg)) return arg;
	}
	return undefined;
}

/** Failure reasons among an array literal's direct elements. */
function failureLiteralsIn(array: ts.ArrayLiteralExpression): string[] {
	const literals: string[] = [];
	for (const element of array.elements) {
		const text = failureLiteralText(element);
		if (text !== undefined) literals.push(text);
	}
	return literals;
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Scan one TypeScript source for terminal-status reimplementations. Pure and
 * exported so the evasion classes the #186 issue enumerates are pinned as
 * fixture tests below — a ratchet that cannot fail is indistinguishable from no
 * ratchet, and that is exactly what the original regex-only guard was.
 */
export function scanReimplementations(source: string, file: string): ReimplementationHit[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const hits: ReimplementationHit[] = [];
	// Array literals already covered by a membership hit, so a `[...].includes(x)`
	// is reported once (at the call) rather than twice (call + literal).
	const coveredLists = new Set<ts.Node>();

	const record = (node: ts.Node, kind: ReimplementationKind, literal: string): void => {
		const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		hits.push({
			file,
			line: position.line + 1,
			kind,
			literal,
			code: normalize(node.getText(sourceFile)),
		});
	};

	const visit = (node: ts.Node): void => {
		// Rules 1 & 4: equality comparisons against a failure reason / exitCode.
		// The failure-reason arm deliberately ignores the OTHER operand's name —
		// that is what catches a renamed/aliased identifier.
		if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
			const { left, right } = node;
			const leftReason = failureLiteralText(left);
			const rightReason = failureLiteralText(right);
			if (leftReason !== undefined || rightReason !== undefined) {
				record(node, "comparison", leftReason ?? (rightReason as string));
			}
			const leftIsExit = isExitCodeExpression(left);
			const rightIsExit = isExitCodeExpression(right);
			if (leftIsExit || rightIsExit) {
				const numeric = numericLiteralText(leftIsExit ? right : left);
				if (numeric !== undefined) record(node, "exit-code", numeric);
			}
		}

		// Rule 2: membership against an inline failure-reason list.
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			if (method === "includes" || method === "has") {
				const array = listLiteral(node.expression.expression);
				if (array) {
					const literals = failureLiteralsIn(array);
					if (literals.length > 0) {
						coveredLists.add(array);
						record(node, "membership", literals.join(", "));
					}
				}
			}
		}

		// Rule 3: a re-hard-coded failure-reason list, even when the comparison
		// happens in another module. A list "of failure reasons" is one where the
		// failure reasons dominate (at least two) or where every element is stop
		// vocabulary (`["error", "stop"]`) — a keyword list that merely contains
		// the word "error" is neither.
		if (ts.isArrayLiteralExpression(node) && !coveredLists.has(node)) {
			const literals = failureLiteralsIn(node);
			const allStopVocabulary = node.elements.every(
				(element) => ts.isStringLiteral(element) && STOP_REASON_SET.has(element.text),
			);
			if (literals.length > 0 && (literals.length >= 2 || allStopVocabulary)) {
				record(node, "failure-list", literals.join(", "));
			}
		}

		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return hits;
}

// ---------------------------------------------------------------------------
// Tree sweep
// ---------------------------------------------------------------------------

/** Repo root, resolved from this test file (`src/__tests__/…`). */
const REPO_ROOT = join(__dirname, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");

/**
 * Every non-test top-level `src/*.ts` module EXCEPT `types.ts` — the one
 * legitimate home of the predicate (`isSubagentError`, `classifyError`,
 * `classifyTerminalOutcome`).
 */
function scannedSourceFiles(): string[] {
	return readdirSync(SRC_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "types.ts")
		.map((entry) => join(SRC_DIR, entry.name))
		.sort();
}

const toRepoPath = (absolute: string): string => relative(REPO_ROOT, absolute).split(sep).join("/");

// ---------------------------------------------------------------------------
// Recorded exceptions
// ---------------------------------------------------------------------------

interface StructuralException {
	/** Repo-relative path the hit must come from. */
	file: string;
	/** Whitespace-normalised substring of the offending expression. */
	snippet: string;
	/** Why this is genuinely NOT a terminal-status classification. */
	reason: string;
}

/**
 * Every entry is a RECORDED decision: an exception must name the exact
 * expression it excuses and say why it cannot desync from the shared predicate.
 * Unused entries are tolerated on purpose — other work in flight moves code
 * between modules, and a stale entry is a documentation bug, not a build break.
 */
const STRUCTURAL_ALLOWLIST: readonly StructuralException[] = [
	{
		file: "src/logging.ts",
		snippet: 'level === "error"',
		reason:
			'LogLevel vocabulary ("debug" | "info" | "warn" | "error"), not a terminal status. ' +
			"No stopReason or exitCode is compared, so it cannot desync from isSubagentError().",
	},
	{
		file: "src/session-manager.ts",
		snippet: "errorCategory === 'aborted'",
		reason:
			"ErrorCategory vocabulary inside coherentFailureReason — picks the failure reason to " +
			"record after the failure verdict is already known, not a pass/fail classification.",
	},
	{
		file: "src/session-manager.ts",
		snippet: "terminalStopReason === 'aborted'",
		reason:
			"Abort-routing probe (`agent.status === 'stopped' || terminalStopReason === 'aborted'`) " +
			"that selects the stopped settlement branch. It does not derive a verdict — aborted is " +
			"already a failure in isSubagentError, and the success/failure split is decided by " +
			"classifyTerminalOutcome.",
	},
	{
		file: "src/tui.ts",
		snippet: "details.exitCode === -1",
		reason:
			"Sentinel probe for a run that has not settled yet (exitCode is unset = -1), used to " +
			"render the running header. It reads no stopReason and decides no verdict.",
	},
];

function isAllowed(hit: ReimplementationHit): boolean {
	return STRUCTURAL_ALLOWLIST.some(
		(entry) => entry.file === hit.file && hit.code.includes(normalize(entry.snippet)),
	);
}

/** Scan the real tree and drop any hit with a recorded allow-list reason. */
function scanTree(): ReimplementationHit[] {
	const violations: ReimplementationHit[] = [];
	for (const absolute of scannedSourceFiles()) {
		const file = toRepoPath(absolute);
		for (const hit of scanReimplementations(readFileSync(absolute, "utf8"), file)) {
			if (!isAllowed(hit)) violations.push(hit);
		}
	}
	return violations;
}

const formatHits = (hits: ReimplementationHit[]): string =>
	hits
		.map((hit) => `  ${hit.file}:${hit.line}  [${hit.kind}:${hit.literal}]  ${hit.code}`)
		.join("\n");

describe("terminal-status consistency — structural guard", () => {
	it("no module outside types.ts reimplements the failure predicate", () => {
		const violations = scanTree();
		expect(
			violations,
			"These reimplement the terminal-status classification instead of calling " +
				"isSubagentError() / countSubagentOutcomes() / classifyTerminalOutcome(). A private " +
				"copy silently desyncs when the shared predicate is widened (issue #179). Route them " +
				"through the shared helper, or add a RECORDED reason to STRUCTURAL_ALLOWLIST.\n" +
				formatHits(violations),
		).toEqual([]);
	});

	it("scans a non-empty set of modules (guards against a vacuous pass)", () => {
		const files = scannedSourceFiles().map(toRepoPath);
		// A wrong path or an over-broad exclusion would silently make the ratchet
		// scan nothing and pass forever. Pin the entry point, a floor, and the
		// types.ts exemption.
		expect(files).toContain("src/index.ts");
		expect(files).toContain("src/session-manager.ts");
		expect(files).not.toContain("src/types.ts");
		expect(files.length).toBeGreaterThan(20);
	});
});

// ---------------------------------------------------------------------------
// Scanner coverage — the evasion set from issue #186. Every form the original
// regex missed is pinned independently here AND exercised against the real tree
// by the teeth probes recorded on the PR.
// ---------------------------------------------------------------------------

const scanFixture = (source: string): ReimplementationHit[] =>
	scanReimplementations(source, "fixture.ts");

const kindsOf = (source: string): ReimplementationKind[] => scanFixture(source).map((h) => h.kind);

describe("scanner coverage — spellings the original regex missed (#186)", () => {
	it("(a) catches a single-quoted comparison", () => {
		expect(kindsOf(`if (r.stopReason === 'error') {}`)).toContain("comparison");
	});

	it("(b) catches a comparison through a destructured alias", () => {
		const source = `const { stopReason: sr } = r;\nif (sr === "error") {}`;
		expect(kindsOf(source)).toContain("comparison");
	});

	it("(c) catches array membership", () => {
		expect(kindsOf(`if (["error", "aborted"].includes(r.stopReason)) {}`)).toContain("membership");
	});

	it("(d) catches a helper in a different module that re-hard-codes the list", () => {
		const source = `export function failed(x: string): boolean {\n  return ["error", "length"].includes(x);\n}`;
		expect(kindsOf(source)).toContain("membership");
	});

	it("(e) catches exitCode === 0 as success", () => {
		expect(kindsOf(`if (r.exitCode === 0) return "ok";`)).toContain("exit-code");
	});

	it("catches a no-substitution template literal", () => {
		expect(kindsOf("if (r.stopReason === `error`) {}")).toContain("comparison");
	});

	it("catches Set membership", () => {
		expect(kindsOf(`if (new Set(["error"]).has(r.stopReason)) {}`)).toContain("membership");
	});

	it("catches the negated comparison operators", () => {
		for (const op of ["!==", "!=", "===", "=="]) {
			expect(kindsOf(`if (r.stopReason ${op} "aborted") {}`), op).toContain("comparison");
		}
	});

	it("catches a re-hard-coded failure list even when compared elsewhere", () => {
		expect(kindsOf(`export const FAILURES = ["error", "aborted", "length"];`)).toContain(
			"failure-list",
		);
	});

	it("catches a single-element all-failure list", () => {
		expect(kindsOf(`const ONLY = ["aborted"];`)).toContain("failure-list");
	});

	it("catches a reason list mixing a failure and the success reason", () => {
		expect(kindsOf(`const REASONS = ["error", "stop"];`)).toContain("failure-list");
	});

	it("catches a numeric sentinel exitCode comparison", () => {
		expect(kindsOf(`if (d.exitCode === -1) return "running";`)).toContain("exit-code");
	});

	it("reports the offending file and line", () => {
		expect(scanFixture(`const ok = true;\nif (r.exitCode === 0) {}\n`)).toEqual([
			{
				file: "fixture.ts",
				line: 2,
				kind: "exit-code",
				literal: "0",
				code: "r.exitCode === 0",
			},
		]);
	});
});

describe("scanner coverage — legitimate code is not flagged (#186)", () => {
	it("ignores the success reason 'stop'", () => {
		expect(scanFixture(`if (r.stopReason === "stop") {}`)).toEqual([]);
	});

	it("ignores a message-content substring check", () => {
		// runner.ts's `msg.includes("aborted")` is a check on message TEXT, not a
		// terminal-status membership test — the receiver is a string, not a list.
		expect(scanFixture(`if (msg.includes("aborted")) return;`)).toEqual([]);
	});

	it("ignores membership against a list held in an identifier", () => {
		// The list's DEFINITION is what rule 3 catches; an opaque identifier here
		// is not itself a reimplementation.
		expect(scanFixture(`if (knownReasons.includes(r.stopReason)) {}`)).toEqual([]);
	});

	it("ignores an exitCode comparison against a non-literal", () => {
		expect(scanFixture(`if (r.exitCode === expected) {}`)).toEqual([]);
	});

	it("ignores a keyword list that merely contains the word 'error'", () => {
		// router.ts's auto-route keywords: the failure reason does not dominate.
		expect(scanFixture(`const keywords = ["debug", "bug", "fix", "crash", "error", "trace"];`)).toEqual([]);
	});

	it("matches the allow-list only on an exact file+snippet", () => {
		const hit = scanFixture(`if (r.stopReason === "error") {}`)[0];
		expect(hit).toBeDefined();
		expect(isAllowed(hit)).toBe(false);
		// And the recorded exceptions do suppress their own hits.
		const loggingHit = scanReimplementations(`const m = level === "error" ? 1 : 0;`, "src/logging.ts")[0];
		expect(isAllowed(loggingHit)).toBe(true);
	});
});
