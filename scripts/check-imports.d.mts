/**
 * Types for the import convention guard (`scripts/check-imports.mjs`, issue #476).
 *
 * Same reason `scripts/ts-ast.d.mts` exists: the guard's test file imports the
 * `.mjs` directly, so it needs a declaration to stay typed without falling back
 * to `any`. The rule ids are the contract — `RULES` and this union must agree.
 */

/** The five rules the guard enforces. */
export type ImportRule = "type-block-order" | "type-block-sorted" | "duplicate" | "wrap" | "collapse";

/** One violation, positioned at the offending `import` keyword. */
export interface ImportViolation {
	path: string;
	/** 1-based line of the statement. */
	line: number;
	rule: ImportRule;
	message: string;
}

/** Rule ids, keyed by name. */
export declare const RULES: Readonly<Record<"TYPE_BLOCK_ORDER" | "TYPE_BLOCK_SORTED" | "DUPLICATE" | "WRAP" | "COLLAPSE", ImportRule>>;

/** All violations across the given in-memory corpus, ordered by line then rule. */
export declare function collectViolations(files: readonly { path: string; text: string }[]): ImportViolation[];
