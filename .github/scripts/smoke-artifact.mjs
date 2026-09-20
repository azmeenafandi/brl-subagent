#!/usr/bin/env node
/**
 * Packaging smoke test — issue #176.
 *
 * `tsc --noEmit` and `vitest run` both execute against the *dev checkout*, so
 * neither can observe what `package.json`'s `files` allowlist actually ships.
 * Issue #158 was exactly that blind spot: AGENT.md was absent from `files`, so
 * it was missing from the published tarball, invisible to the whole test suite
 * and caught only by a manual install.
 *
 * This script closes that gap by treating the packed tarball as ground truth:
 * it runs `npm pack`, extracts the result, and asserts the runtime contract
 * against the extracted tree. It is deliberately model-free (no LLM/provider)
 * and registry-independent (the tarball is extracted inside the repo tree so
 * Node resolves the repo's locked SDK — never `npm install --omit=dev`, whose
 * peer resolution could redden a release with no change on our side).
 *
 * Run locally from the repo root: `node .github/scripts/smoke-artifact.mjs`.
 *
 * `.github/` is outside the `files` allowlist, so this script never ships.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createJiti } from "jiti";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

// ---------------------------------------------------------------------------
// Tiny result harness. Every check records a named pass/fail so a failure can
// never be a bare try/catch that hides *why* the artifact is broken.
// ---------------------------------------------------------------------------

/** @type {{ ok: boolean, name: string, detail?: string }[]} */
const checks = [];

/**
 * @param {boolean} ok
 * @param {string} name
 * @param {string} [detail]
 */
function record(ok, name, detail) {
	checks.push({ ok, name, detail });
}

/**
 * Run one assertion. `fn` returns an optional success detail and throws an
 * Error with a specific message on failure.
 *
 * @param {string} name
 * @param {() => string | void} fn
 */
function check(name, fn) {
	try {
		const detail = fn();
		record(true, name, typeof detail === "string" ? detail : undefined);
	} catch (err) {
		record(false, name, err instanceof Error ? err.message : String(err));
	}
}

// ---------------------------------------------------------------------------
// Pack + extract
// ---------------------------------------------------------------------------

/**
 * `npm pack` the current checkout into `tempRoot`, returning the tarball path.
 *
 * @param {string} tempRoot
 * @returns {string}
 */
function packToTemp(tempRoot) {
	const packDir = join(tempRoot, "pack");
	mkdirSync(packDir, { recursive: true });
	let stdout;
	try {
		stdout = execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		const stderr = /** @type {{ stderr?: Buffer | string }} */ (err).stderr;
		throw new Error(
			`npm pack failed: ${err instanceof Error ? err.message : String(err)}${stderr ? `\n${String(stderr).trim()}` : ""}`,
		);
	}
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`npm pack produced unparseable --json output:\n${stdout.slice(0, 1000)}`);
	}
	const filename = Array.isArray(parsed) ? parsed[0]?.filename : undefined;
	if (typeof filename !== "string" || filename.length === 0) {
		throw new Error(`npm pack --json did not report a tarball filename:\n${stdout.slice(0, 1000)}`);
	}
	return join(packDir, filename);
}

/**
 * Extract the tarball into `tempRoot/extracted` and return the package root.
 *
 * @param {string} tarballPath
 * @param {string} tempRoot
 * @returns {string}
 */
function extractTarball(tarballPath, tempRoot) {
	const extractDir = join(tempRoot, "extracted");
	mkdirSync(extractDir, { recursive: true });
	try {
		execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], { stdio: ["ignore", "pipe", "pipe"] });
	} catch (err) {
		throw new Error(`failed to extract ${basename(tarballPath)}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const packageRoot = join(extractDir, "package");
	if (!existsSync(join(packageRoot, "package.json"))) {
		throw new Error(`extracted tarball has no package/package.json at ${packageRoot}`);
	}
	return packageRoot;
}

// ---------------------------------------------------------------------------
// Static import analysis (runtime specifiers only)
// ---------------------------------------------------------------------------

/**
 * @param {string} dir
 * @param {string} ext
 * @returns {string[]}
 */
function walkFiles(dir, ext) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkFiles(full, ext));
		else if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
	}
	return out;
}

/**
 * True when an import clause actually loads something at runtime. `import type`
 * and fully type-only named imports are erased at compile time, so they impose
 * no runtime dependency.
 *
 * @param {ts.ImportClause | undefined} clause
 */
function isRuntimeImportClause(clause) {
	if (!clause) return true; // `import "x"` — side-effect import
	if (clause.isTypeOnly) return false;
	if (clause.name) return true; // default binding
	const bindings = clause.namedBindings;
	if (!bindings) return true;
	if (ts.isNamespaceImport(bindings)) return true;
	// NamedImports: runtime if it has any value binding (or is a bare `import {}`).
	return bindings.elements.length === 0 || bindings.elements.some((el) => !el.isTypeOnly);
}

/**
 * @param {ts.ExportDeclaration} node
 */
function isTypeOnlyExport(node) {
	if (node.isTypeOnly) return true;
	const clause = node.exportClause;
	if (clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly)) {
		return true;
	}
	return false;
}

/**
 * The specifier of a statically resolvable CommonJS `require("spec")` call, or
 * undefined for any other node. The callee must be the bare `require`
 * identifier and the first argument a string literal — a computed argument
 * (`require(name)`) cannot be classified. A dynamic `import()` is a different
 * callee (`ImportKeyword`) and is handled separately, so the two never double
 * count.
 *
 * @param {ts.Node} node
 * @returns {string | undefined}
 */
function requireSpecifier(node) {
	if (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "require" &&
		node.arguments.length > 0 &&
		ts.isStringLiteral(node.arguments[0])
	) {
		return node.arguments[0].text;
	}
	return undefined;
}

/**
 * The specifier of a runtime `import x = require("spec")` declaration, or
 * undefined for any other node. `import type x = require("spec")` is erased at
 * compile time and imposes no runtime dependency, so it is excluded like the
 * other type-only forms.
 *
 * @param {ts.Node} node
 * @returns {string | undefined}
 */
function importEqualsSpecifier(node) {
	if (!ts.isImportEqualsDeclaration(node) || node.isTypeOnly) return undefined;
	const ref = node.moduleReference;
	if (ts.isExternalModuleReference(ref) && ref.expression && ts.isStringLiteral(ref.expression)) {
		return ref.expression.text;
	}
	return undefined;
}

/**
 * Collect every runtime import specifier in a source file — static `import`
 * / `export … from` statements, dynamic `import()` expressions, and CommonJS
 * `require()` calls (both `require("x")` and `import x = require("x")`).
 * Type-only imports/exports and `import("x").T` type references are ignored.
 *
 * @param {string} filePath
 * @param {string} source
 * @returns {string[]}
 */
function collectRuntimeSpecifiers(filePath, source) {
	const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	/** @type {string[]} */
	const specifiers = [];

	/** @param {ts.Node} node */
	const visit = (node) => {
		/** @type {string | undefined} */
		let specifier;
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			isRuntimeImportClause(node.importClause)
		) {
			specifier = node.moduleSpecifier.text;
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			!isTypeOnlyExport(node)
		) {
			specifier = node.moduleSpecifier.text;
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const [arg] = node.arguments;
			if (arg && ts.isStringLiteral(arg)) specifier = arg.text;
		} else {
			specifier = requireSpecifier(node) ?? importEqualsSpecifier(node);
		}
		if (specifier !== undefined) specifiers.push(specifier);
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return specifiers;
}

/**
 * Runtime dependency specifiers in a source file, paired with the package name
 * each belongs to. Relative (`./`, `../`, `/`), builtin (`node:fs`, `fs`), and
 * package subpath (`#internal`) specifiers resolve inside the package or in
 * Node, so they impose no external dependency and are dropped. This is the
 * exact classification the declaration check applies.
 *
 * @param {string} filePath
 * @param {string} source
 * @returns {{ specifier: string, packageName: string }[]}
 */
function classifyRuntimeSpecifiers(filePath, source) {
	/** @type {{ specifier: string, packageName: string }[]} */
	const out = [];
	for (const specifier of collectRuntimeSpecifiers(filePath, source)) {
		if (isRelativeSpecifier(specifier) || isBuiltinSpecifier(specifier) || specifier.startsWith("#")) continue;
		out.push({ specifier, packageName: packageNameOf(specifier) });
	}
	return out;
}

/** @param {string} spec */
const isRelativeSpecifier = (spec) => spec.startsWith(".") || spec.startsWith("/");

/** @param {string} spec */
const isBuiltinSpecifier = (spec) => spec.startsWith("node:") || builtinModules.includes(spec);

/**
 * Reduce a bare import specifier to its package name (`@scope/pkg/sub` →
 * `@scope/pkg`, `pkg/sub` → `pkg`).
 *
 * @param {string} spec
 */
function packageNameOf(spec) {
	if (spec.startsWith("@")) {
		const parts = spec.split("/");
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
	}
	return spec.split("/")[0];
}

export { collectRuntimeSpecifiers, classifyRuntimeSpecifiers };

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @param {string} packageRoot
 */
function runArtifactChecks(packageRoot) {
	const manifestPath = join(packageRoot, "package.json");
	if (!existsSync(manifestPath)) {
		record(false, "package.json is present in the tarball", `no file at ${manifestPath}`);
		return;
	}
	/** @type {any} */
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (err) {
		record(false, "package.json is present and valid JSON", err instanceof Error ? err.message : String(err));
		return;
	}
	record(true, "package.json is present and valid JSON");

	// ── pi.extensions[0] resolves to a file inside the tarball ──────────
	check('pi.extensions[0] resolves to a file inside the tarball', () => {
		const entry = manifest?.pi?.extensions?.[0];
		if (typeof entry !== "string" || entry.length === 0) {
			throw new Error(
				`package.json pi.extensions[0] is missing or not a non-empty string (got ${JSON.stringify(entry)})`,
			);
		}
		const entryPath = resolve(packageRoot, entry);
		if (entryPath !== packageRoot && !entryPath.startsWith(packageRoot + sep)) {
			throw new Error(`pi.extensions[0] "${entry}" escapes the package root`);
		}
		if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
			throw new Error(`pi.extensions[0] "${entry}" does not resolve to a file inside the tarball`);
		}
		return entry;
	});

	// ── AGENT.md (#158) ─────────────────────────────────────────────────
	check("AGENT.md is present in the tarball (issue #158)", () => {
		if (!existsSync(join(packageRoot, "AGENT.md"))) {
			throw new Error('AGENT.md is missing from the packed tarball — it must be listed in package.json "files"');
		}
	});

	// ── presets/ and templates/ exist and are non-empty ─────────────────
	check("presets/ exists and is non-empty in the tarball", () => {
		const dir = join(packageRoot, "presets");
		if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error("presets/ is missing from the packed tarball");
		const files = readdirSync(dir).filter((name) => name.endsWith(".md"));
		if (files.length === 0) throw new Error("presets/ is empty in the packed tarball");
		return `${files.length} preset(s)`;
	});

	check("templates/ exists and is non-empty in the tarball", () => {
		const dir = join(packageRoot, "templates");
		if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error("templates/ is missing from the packed tarball");
		const files = readdirSync(dir).filter((name) => name.endsWith(".md"));
		if (files.length === 0) throw new Error("templates/ is empty in the packed tarball");
		return `${files.length} template(s)`;
	});

	// ── src/__tests__ exclusion holds ───────────────────────────────────
	check("src/__tests__/ is absent from the tarball", () => {
		if (existsSync(join(packageRoot, "src", "__tests__"))) {
			throw new Error('src/__tests__/ is present in the tarball — the "!src/__tests__/" exclusion no longer holds');
		}
	});

	// ── Declaration check: runtime imports must be declared deps ────────
	check("every runtime import in packed src/** is a declared dependency", () => {
		const declared = new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
		]);
		const srcDir = join(packageRoot, "src");
		const srcFiles = existsSync(srcDir) ? walkFiles(srcDir, ".ts") : [];
		/** @type {string[]} */
		const missing = [];
		const used = new Set();
		for (const file of srcFiles) {
			const source = readFileSync(file, "utf8");
			for (const { specifier, packageName } of classifyRuntimeSpecifiers(file, source)) {
				used.add(packageName);
				if (!declared.has(packageName)) {
					missing.push(
						`${relative(packageRoot, file)} imports "${specifier}" but "${packageName}" is not declared in dependencies/peerDependencies/optionalDependencies`,
					);
				}
			}
		}
		if (missing.length > 0) {
			throw new Error(`undeclared runtime import(s):\n      ${missing.join("\n      ")}`);
		}
		return `${used.size} runtime package(s): ${[...used].sort().join(", ")}`;
	});

	// ── Load check: the packed entry actually loads via jiti ────────────
	check("packed src/index.ts loads via jiti and default-exports a function", () => {
		const srcDir = join(packageRoot, "src");
		const entrySpecifier = manifest?.pi?.extensions?.[0];
		if (typeof entrySpecifier !== "string") throw new Error("cannot run load check: pi.extensions[0] is not a string");
		const entryFile = resolve(packageRoot, entrySpecifier);
		// Mirror src/__tests__/e2e.test.ts exactly: jiti is created against the
		// src directory and the entry is required relative to it.
		const jiti = createJiti(srcDir, { interopDefault: true, moduleCache: false });
		const relativeEntry = `./${relative(srcDir, entryFile).replace(/\\/g, "/").replace(/\.ts$/, "")}`;
		let mod;
		try {
			mod = jiti(relativeEntry);
		} catch (err) {
			throw new Error(
				`${entrySpecifier} failed to load via jiti: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const defaultExport = mod?.default ?? mod;
		if (typeof defaultExport !== "function") {
			const keys = mod && typeof mod === "object" ? Object.keys(mod).join(", ") : "<none>";
			throw new Error(
				`${entrySpecifier} default export is not a function (got ${typeof defaultExport}; module keys: ${keys})`,
			);
		}
		return entrySpecifier;
	});
}

function report() {
	const failed = checks.filter((c) => !c.ok);
	const passed = checks.filter((c) => c.ok);
	if (failed.length > 0) {
		console.error("");
		console.error(`smoke-artifact: FAILED — ${failed.length} check(s) failed`);
		console.error("");
		for (const c of passed) console.error(`  ✓ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
		for (const c of failed) {
			console.error(`  ✗ ${c.name}`);
			if (c.detail) console.error(`      ${c.detail}`);
		}
		console.error("");
		process.exitCode = 1;
		return;
	}
	if ((process.exitCode ?? 0) !== 0) {
		// A non-zero code with no recorded failure means the run threw before it
		// could finish. On a release gate that must never render as "OK".
		console.error("");
		console.error(
			`smoke-artifact: ABNORMAL EXIT (code ${process.exitCode}) — no check recorded a failure, but the run did not complete cleanly`,
		);
		console.error("");
		for (const c of passed) console.error(`  ✓ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
		console.error("");
		return;
	}
	console.log("");
	console.log(`smoke-artifact: OK — ${passed.length} check(s) passed`);
	console.log("");
	for (const c of passed) console.log(`  ✓ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
	console.log("");
}

function main() {
	// Keep the scratch tree inside the repo so Node's module resolution climbs
	// to the repo's locked node_modules for the jiti load check.
	mkdirSync(join(REPO_ROOT, ".tmp"), { recursive: true });
	const tempRoot = mkdtempSync(join(REPO_ROOT, ".tmp", "smoke-artifact-"));
	try {
		/** @type {string} */
		let tarballPath;
		try {
			tarballPath = packToTemp(tempRoot);
		} catch (err) {
			record(false, "npm pack produced a tarball", err instanceof Error ? err.message : String(err));
			return;
		}
		record(true, "npm pack produced a tarball", basename(tarballPath));

		/** @type {string} */
		let packageRoot;
		try {
			packageRoot = extractTarball(tarballPath, tempRoot);
		} catch (err) {
			record(false, "tarball extracted", err instanceof Error ? err.message : String(err));
			return;
		}
		record(true, "tarball extracted");

		runArtifactChecks(packageRoot);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

// Only run the smoke test when this file is the entry point (`node
// .github/scripts/smoke-artifact.mjs`). Importing it from the scanner unit test
// must not pack, extract, or exit the worker.
const isDirectRun =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
	try {
		main();
	} catch (err) {
		console.error("smoke-artifact: unexpected error");
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		process.exitCode = 1;
	} finally {
		report();
	}
}
