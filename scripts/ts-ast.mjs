/**
 * TypeScript AST adapter — the single containment boundary for the unstable
 * TypeScript 7 AST API (issue #256).
 *
 * TS 7 removed the long-standing root export's AST surface (`createSourceFile`,
 * `SyntaxKind`, `ts.is*`): `import ts from "typescript"` now resolves to a
 * version-only module. The replacement lives under the explicitly unstable
 * `typescript/unstable/*` subpaths. Rather than let that churn spread through
 * every guard, every `unstable/*` import in this repo lives HERE.
 *
 * Consumers (the architecture, vocabulary and terminal-status ratchets, plus
 * the packaging smoke scanner) import their predicates and the one parse helper
 * from this module. A future TS major then costs a one-file migration here, not
 * four. See `.development/decisions/0013-typescript-7-unstable-ast.md`.
 *
 * Plain ESM: importable from the `.ts` test files (via vitest) and from
 * `.github/scripts/smoke-artifact.mjs` alike.
 */

import { resolve } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import {
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
import { API } from "typescript/unstable/sync";

export {
	SyntaxKind,
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
};

/** A synthetic project filename that cannot collide with a real source file. */
const CONFIG_PATH = resolve(process.cwd(), ".ts-ast-virtual-project.json");

/**
 * Parse in-memory sources through one synthetic TypeScript project.
 *
 * `entries` are `{ path, text }` pairs; `path` may be absolute or relative to
 * `process.cwd()`. Returns a `Map<absolutePath, SourceFile>`. All contents are
 * served through the API's `fs` hooks and `noResolve`/`noLib`/`types: []` keep
 * the program to exactly these files, so the real filesystem is only touched
 * for the paths actually requested.
 *
 * The API client is always closed before returning (or throwing) so a caller
 * cannot leak a worker process.
 *
 * @param {readonly { path: string, text: string }[]} entries
 * @returns {Map<string, import("typescript/unstable/ast").SourceFile>}
 */
export function parseTexts(entries) {
	/** @type {Map<string, string>} */
	const virtual = new Map();
	/** @type {string[]} */
	const files = [];
	for (const entry of entries) {
		const absolute = resolve(entry.path);
		virtual.set(absolute, entry.text);
		files.push(absolute);
	}
	const config = JSON.stringify({
		compilerOptions: { noResolve: true, noLib: true, types: [] },
		files,
	});

	const api = new API({
		cwd: process.cwd(),
		fs: {
			fileExists: (fileName) => (resolve(fileName) === CONFIG_PATH || virtual.has(resolve(fileName)) ? true : undefined),
			readFile: (fileName) => {
				const request = resolve(fileName);
				if (request === CONFIG_PATH) return config;
				return virtual.get(request);
			},
		},
	});

	try {
		const program = api.updateSnapshot({ openProjects: [CONFIG_PATH] }).getProject(CONFIG_PATH).program;
		/** @type {Map<string, import("typescript/unstable/ast").SourceFile>} */
		const parsed = new Map();
		for (const absolute of files) {
			const sourceFile = program.getSourceFile(absolute);
			if (!sourceFile) {
				throw new Error(`ts-ast: TypeScript did not parse ${absolute} into the synthetic program`);
			}
			parsed.set(absolute, sourceFile);
		}
		return parsed;
	} finally {
		api.close();
	}
}
