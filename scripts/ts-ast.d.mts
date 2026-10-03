/**
 * Types for the TS 7 AST adapter (`scripts/ts-ast.mjs`). Re-exports the node
 * types and predicate signatures from `typescript/unstable/ast` so the guard
 * tests can type their walks without importing the unstable path directly (and
 * without falling back to `any`). See `.development/decisions/0013-typescript-7-unstable-ast.md`.
 */

import type { SourceFile } from "typescript/unstable/ast";

export { SyntaxKind } from "typescript/unstable/ast";
export type {
	ArrayLiteralExpression,
	BinaryExpression,
	ExportDeclaration,
	ImportClause,
	Node,
	SourceFile,
} from "typescript/unstable/ast";
export {
	isArrayLiteralExpression,
	isBinaryExpression,
	isCallExpression,
	isCaseClause,
	isExportDeclaration,
	isExternalModuleReference,
	isIdentifier,
	isImportDeclaration,
	isImportEqualsDeclaration,
	isNamedExports,
	isNamedImports,
	isNamespaceImport,
	isNewExpression,
	isNoSubstitutionTemplateLiteral,
	isNumericLiteral,
	isParenthesizedExpression,
	isPrefixUnaryExpression,
	isPropertyAccessExpression,
	isStringLiteral,
	isSwitchStatement,
	isTemplateExpression,
	isTypeNode,
} from "typescript/unstable/ast/is";

/**
 * Parse in-memory sources through one synthetic TypeScript project, returning a
 * `Map<absolutePath, SourceFile>`.
 */
export function parseTexts(
	entries: readonly { path: string; text: string }[],
): Map<string, SourceFile>;
