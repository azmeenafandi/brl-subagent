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

/**
 * The one long-lived TS7 API client for this process/worker, created lazily on
 * first use. Constructing an `API` spawns the tsgo native compiler
 * (`typescript/unstable/sync` -> `@typescript/typescript-linux-x64/lib/tsc`)
 * and `close()` kills it, so a per-call instance meant one spawn/kill per
 * `parseTexts()` call (~92 per full suite run, plus a stderr race that leaks
 * the Go `context canceled` string). One client per worker removes ~90
 * startups and nearly all of the kill races. See issue #284.
 *
 * @type {API | undefined}
 */
let api;

/**
 * The in-flight `parseTexts` request, if any. The API's `fs` hooks are
 * registered once when the client is constructed, so they cannot close over a
 * single call's virtual project; instead they read this module-level slot.
 *
 * This is safe because the TS7 *sync* API is synchronous and single-threaded
 * per worker: `updateSnapshot(...)` and the `getSourceFile(...)` loop for a
 * call run to completion before any other `parseTexts()` can start, so two
 * requests can never interleave in the slot.
 *
 * @type {{ virtual: Map<string, string>, config: string, configPath: string } | undefined}
 */
let currentRequest;

/** Starts at 0 and increments once per `parseTexts` call. */
let configCounter = 0;

/**
 * Returns the process-wide API client, constructing it (and its tsgo child) on
 * first use. Registers a once-only `exit` hook so the child cannot outlive the
 * worker.
 */
function getApi() {
	if (!api) {
		const client = new API({
			cwd: process.cwd(),
			fs: {
				fileExists: (fileName) => {
					if (!currentRequest) return undefined;
					const request = resolve(fileName);
					return request === currentRequest.configPath || currentRequest.virtual.has(request) ? true : undefined;
				},
				readFile: (fileName) => {
					if (!currentRequest) return undefined;
					const request = resolve(fileName);
					if (request === currentRequest.configPath) return currentRequest.config;
					return currentRequest.virtual.get(request);
				},
			},
		});
		api = client;
		process.once("exit", () => client.close());
	}
	return api;
}

/**
 * Parse in-memory sources through one synthetic TypeScript project.
 *
 * `entries` are `{ path, text }` pairs; `path` may be absolute or relative to
 * `process.cwd()`. Returns a `Map<absolutePath, SourceFile>`. All contents are
 * served through the API's `fs` hooks and `noResolve`/`noLib`/`types: []` keep
 * the program to exactly these files, so the real filesystem is only touched
 * for the paths actually requested.
 *
 * The shared API client is reused across calls and closed once on process exit,
 * so callers need not (and cannot) release it per call.
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
	// A UNIQUE synthetic project path per call. The shared API keeps project and
	// source-file state between `updateSnapshot` calls; reusing one path with a
	// different file set could let the unstable API serve a stale program. A
	// fresh path makes each call an independent project while the process (and
	// its one tsgo child) is reused. The path is virtual — it is served by the
	// fs hooks below and never touches disk.
	const configPath = resolve(process.cwd(), `.ts-ast-virtual-project-${configCounter++}.json`);

	currentRequest = { virtual, config, configPath };
	try {
		// `fileChanges.changed` is REQUIRED because the client is long-lived: the
		// server caches file content by path, so a path reused across calls with
		// new text (e.g. the `fixture.ts` scans) is otherwise served stale. It is
		// accurate per call — both the config and every entry are re-supplied —
		// and a per-call API never needed it only because a fresh tsgo child
		// started with an empty cache.
		const program = getApi()
			.updateSnapshot({ openProjects: [configPath], fileChanges: { changed: files } })
			.getProject(configPath).program;
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
		currentRequest = undefined;
	}
}
