/**
 * Architecture rules — executable fitness functions (issue #251).
 *
 * `ARCHITECTURE.md` (rewritten by #249) describes the structure. This file makes the load-bearing half of
 * that description a build failure when violated, so it cannot silently stop being true. The class this
 * targets is coupling that is legal to write and only caught by review: the #179 terminal-predicate copies
 * (the TUI and the aggregates drifting from the one shared policy) and the #124 tui.ts SDK drift.
 *
 * Why the TypeScript compiler API and not grep: the distinction that matters most here is invisible to
 * text search — `types.ts` references `schema.ts` in a TYPE position (`import type`, erased at runtime,
 * #239) while `schema.ts` imports runtime VALUES from `types.ts`. A regex survey of this tree reports a
 * cycle between the two; the actual RUNTIME graph is acyclic. These rules encode what executes.
 *
 * Coverage boundaries: this is an import-graph audit (static imports, `export … from`, dynamic `import()`),
 * not call-graph or data-flow analysis. A rule passes when the imports obey it; whether the imported code
 * is used well is out of scope. Repositories are read from the filesystem — audit is independent of the
 * knowledge graph, so a graph that is stale (or a cycle that would corrupt the source list) cannot make
 * this suite skip a file.
 *
 * Allow-lists require a recorded decision, in the spirit of `KNOWN_DELEGATE_KEYS` (src/params.ts): an entry
 * states why the exception is legitimate. Keep them small.
 */

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const SRC = "src";

// ---------------------------------------------------------------------------
// Recorded allow-lists
// ---------------------------------------------------------------------------

/** Modules allowed to import `child_process` — process execution is confined to these two. */
const PROCESS_EXECUTION_MODULES = new Set(["runner.ts", "git.ts"]);

/** Modules whose whole point is to stay dependency-free so they remain unit-testable. */
const PURE_HELPER_MODULES = new Set(["tui-format.ts", "transcript-tail.ts"]);

/**
 * The reader API of `session-manager.ts` that non-entry modules may import. `tui.ts` reads live agent
 * records through `getAgent` (the monitor); lifecycle mutators (spawn/stop/steer/settle) belong to the
 * entry point's handlers, not to the TUI. Extend deliberately — every entry is a decision.
 */
const SESSION_MANAGER_READER_API = new Set(["getAgent", "listAgents"]);

// ---------------------------------------------------------------------------
// Import extraction (the one parser every rule shares)
// ---------------------------------------------------------------------------

interface ImportEdge {
	from: string;
	/** The raw module specifier as written. */
	specifier: string;
	/** `import type` / `export type` — erased at runtime, so it is not a runtime edge. */
	typeOnly: boolean;
	/** Named bindings (empty for default/namespace/side-effect imports). */
	names: string[];
}

function listModules(): string[] {
	return readdirSync(SRC)
		.filter((f) => f.endsWith(".ts"))
		.sort();
}

function parseImports(file: string): ImportEdge[] {
	const text = readFileSync(join(SRC, file), "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const edges: ImportEdge[] = [];

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.importClause;
			const names: string[] = [];
			if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements) names.push((element.propertyName ?? element.name).text);
			}
			edges.push({
				from: file,
				specifier: node.moduleSpecifier.text,
				typeOnly: clause?.isTypeOnly ?? false,
				names,
			});
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			edges.push({ from: file, specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, names: [] });
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length > 0 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			edges.push({ from: file, specifier: node.arguments[0].text, typeOnly: false, names: [] });
		}
		node.forEachChild(visit);
	};
	source.forEachChild(visit);
	return edges;
}

function allEdges(): ImportEdge[] {
	return listModules().flatMap(parseImports);
}

/** Resolve a relative specifier to a `src/` module filename, or `null` when it points elsewhere. */
function resolveModule(specifier: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const candidate = specifier.replace(/^\.\//, "").replace(/\.ts$/, "") + ".ts";
	return listModules().includes(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe("architecture rules (issue #251)", () => {
	it("no runtime import cycles (type-only imports are erased and do not count)", () => {
		const modules = listModules();
		const valueEdges = new Map<string, Set<string>>(modules.map((m) => [m, new Set<string>()]));
		for (const edge of allEdges()) {
			if (edge.typeOnly) continue;
			const target = resolveModule(edge.specifier);
			if (target) valueEdges.get(edge.from)!.add(target);
		}

		const WHITE = 0;
		const GREY = 1;
		const BLACK = 2;
		const color = new Map<string, number>(modules.map((m) => [m, WHITE]));
		const cycles: string[][] = [];
		const stack: string[] = [];
		const visit = (module: string): void => {
			color.set(module, GREY);
			stack.push(module);
			for (const next of [...valueEdges.get(module)!].sort()) {
				const state = color.get(next);
				if (state === GREY) cycles.push([...stack.slice(stack.indexOf(next)), next]);
				else if (state === WHITE) visit(next);
			}
			stack.pop();
			color.set(module, BLACK);
		};
		for (const module of modules) if (color.get(module) === WHITE) visit(module);

		expect(cycles, `runtime import cycle(s): ${JSON.stringify(cycles)} — break the cycle or make the edge type-only`).toEqual([]);
	});

	it("the entry point is not a library (only tests import index.ts)", () => {
		const offenders = allEdges()
			.filter((edge) => edge.from !== "index.ts" && resolveModule(edge.specifier) === "index.ts")
			.map((edge) => `${edge.from} → ${edge.specifier}`);
		expect(offenders, "index.ts is the pi entry point — importing it as a library creates hidden startup coupling").toEqual([]);
	});

	it("types.ts references schema.ts only in type positions (#239)", () => {
		// schema.ts is the RUNTIME source of the delegate_task shape (values flow types ← schema); types.ts
		// derives DelegateTaskParams from it in type-space only. A value import here would close a runtime
		// cycle (and defeat the single-source-of-truth design).
		const offenders = allEdges()
			.filter((edge) => edge.from === "types.ts" && resolveModule(edge.specifier) === "schema.ts" && !edge.typeOnly)
			.map((edge) => `${edge.from} value-imports ${edge.specifier}`);
		expect(offenders, "use `import type` — types.ts must never take runtime values from schema.ts").toEqual([]);
	});

	it("pure helper modules import nothing but ./types and no bare specifiers", () => {
		const offenders: string[] = [];
		for (const edge of allEdges()) {
			if (!PURE_HELPER_MODULES.has(edge.from)) continue;
			const target = resolveModule(edge.specifier);
			const isAllowedTypeImport = target === "types.ts";
			if (!isAllowedTypeImport) offenders.push(`${edge.from} → ${edge.specifier}`);
		}
		expect(
			offenders,
			"tui-format.ts / transcript-tail.ts are kept free of pi-tui and other dependencies so they stay unit-testable",
		).toEqual([]);
	});

	it("process execution is confined to runner.ts and git.ts", () => {
		const offenders = allEdges()
			.filter((edge) => /^(node:)?child_process$/.test(edge.specifier) && !PROCESS_EXECUTION_MODULES.has(edge.from))
			.map((edge) => `${edge.from} → ${edge.specifier}`);
		expect(offenders, `only ${[...PROCESS_EXECUTION_MODULES].join(" and ")} may spawn processes`).toEqual([]);
	});

	it("every bare specifier is a node builtin or a declared peerDependency", () => {
		const peers = new Set(Object.keys(JSON.parse(readFileSync("package.json", "utf8")).peerDependencies ?? {}));
		const builtins = new Set(builtinModules);
		const offenders = allEdges()
			.filter((edge) => !edge.specifier.startsWith("."))
			.filter((edge) => !builtins.has(edge.specifier) && !builtins.has(edge.specifier.replace(/^node:/, "")) && !peers.has(edge.specifier))
			.map((edge) => `${edge.from} → ${edge.specifier}`);
		expect(
			offenders,
			"runtime imports must be node builtins or declared peerDependencies — devDependencies would be missing for `pi install --omit=dev` consumers",
		).toEqual([]);
	});

	it("non-entry modules take only the reader API from session-manager", () => {
		const offenders: string[] = [];
		for (const edge of allEdges()) {
			if (edge.from === "index.ts" || edge.typeOnly) continue;
			if (resolveModule(edge.specifier) !== "session-manager.ts") continue;
			for (const name of edge.names) {
				if (!SESSION_MANAGER_READER_API.has(name)) offenders.push(`${edge.from} → session-manager.${name}`);
			}
		}
		expect(
			offenders,
			`lifecycle mutators belong to the entry point: allowed from session-manager outside index.ts — ${[...SESSION_MANAGER_READER_API].join(", ")}`,
		).toEqual([]);
	});
});
