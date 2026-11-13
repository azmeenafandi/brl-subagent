#!/usr/bin/env node
// Purpose: Reports each surface's test:source LOC ratio (with a warning band) and gates the per-PR
// test-budget FLOW and both surfaces' module floors (issues #368, #490, and the policy v2 unit).
//
// THE POLICY (v2). A stock ratio cannot tell a PR that adds 40 test lines for 200 new source lines
// from one that adds 400 for none — it only knows the tree total, so it charges the second PR for the
// first PR's thrift, and a tree sitting at 1.99 against a hard 2.0 blocks the next honest unit. So:
//
//   * THE RATIO IS REPORTED, NOT ENFORCED. `src` is measured against a 2.0 REFERENCE with a 1.95
//     warning band; `scripts` against 1.0. Crossing one prints a warning and still exits 0. The
//     numbers stay on every CI run because the trend is information, not a gate.
//   * THE FLOW RULE GATES EACH PR (`--flow`): allowance(surface) = 120 + 2 × max(Δsource, 0) net test
//     lines, per surface, measured from `git diff --no-renames --numstat <base>...<head>`. The merge
//     gate runs it from the trusted cockpit copy (see `.pi/skills/worktree/merge-guard.sh`), and an
//     over-allowance PR needs an explicit `Test budget:` line in its body.
//   * THE WALL CEILING STAYS (60 s, global): it is one suite on one runner, so it is still a ceiling.
//   * THE FLOORS GATE, on both surfaces: every non-test source module must be REACHABLE from a
//     `*.test.ts` through import edges. A ratio cannot see an untested module — adding source lowers
//     it — and a direct-import floor cannot see a module reached only through another module. A
//     comment, a string, `import type … from` and `export … from` are not edges: a barrel would
//     otherwise make every module reachable and the floor would prove nothing.
//
// TWO SURFACES since #490. 2.0/1.0 were always meant per surface; the cycle's tooling lives in
// `scripts/**/*.mjs`, which the old single-surface guard could not see. So each surface is measured
// and reported on its own (src 58 modules, scripts 18 at the time of writing):
//
//   src      source `src/**/*.ts` minus `__tests__`; tests `src/**/__tests__/**/*.ts`
//   scripts  source `scripts/**/*.mjs` minus `__tests__`; tests `scripts/__tests__/**/*.ts`
//
// A `__tests__` path segment is the classifier — never the extension — because on the `scripts`
// surface tests are `.ts` and sources are `.mjs`.
//
// ACCEPTED LIMITS, stated so nobody reads them as gaps: (1) +120 test lines per test-only PR
// accumulates — the flow rule judges each PR's purchase, and the reported ratio is what makes the
// accumulation visible; (2) replacement measures ZERO (net lines), so a rewrite is never a spending
// event; (3) a path containing a tab or a non-ASCII byte is git-quoted in `--numstat` and is not
// re-unescaped here.
//
// Output is deterministic: surfaces are reported in name order, floors in surface order, and no
// timestamp or duration of this check appears anywhere. Counts are read from disk (the real tree),
// never hardcoded.
//
// Usage: node scripts/check-test-budget.mjs <vitest-json-report>
//        node scripts/check-test-budget.mjs --report <vitest-json-report>
//        node scripts/check-test-budget.mjs --flow [--base <ref>] [--head <sha>] [--json]
//        node scripts/check-test-budget.mjs --declaration [<pr-body-file>]   (stdin when no path)
//   CI: npx vitest run --reporter=default --reporter=json --outputFile=vitest-report.json
//   The merge gate: --flow --base dev --head <sha> (run it in the repository root)
// Exit: 0 within budget/within the flow · 1 a finding (or an over-allowance flow) · 2 usage, an
//       unreadable report/tree, or a flow that cannot be computed (unknown head, already-merged,
//       a failed diff) — fail closed, never a silent pass.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanBlocks } from "./lib/pr-evidence.mjs";
import { FLOW, FLOW_CODES, FLOW_EXIT, computeFlow, formatFlowLine } from "./lib/test-budget-flow.mjs";

/** Local suite wall-time ceiling (ms). Current local wall: ~18 s. Global to every surface. */
export const WALL_CEILING_MS = 60_000;

/** The path segment that classifies a file as a test. Shared by every surface. */
export const TEST_DIR_NAME = "__tests__";

/**
 * The measured surfaces, widest first (the flow line prints in this order, `src` leading; the report
 * sorts by name). `sourceExtension` / `testExtension` are exact extensions:
 * `scripts/check-imports.d.mts` is `.mts` and belongs to neither surface — a declaration file carries
 * no logic to test.
 *
 * `reference` is a REFERENCE RATIO, not a ceiling: crossing it is reported and never fails the run.
 * `warnAt` is the band that starts BEFORE the reference where a surface declares one (a surface with
 * `warnAt: null` has no band — its reference crossing is the only signal it makes).
 *
 * `floorCorpus` is how much of the surface the floor JUDGES: `"tree"` = every module below it, `"top"`
 * = its top-level entry scripts. `src` has no nested source directories, so the two are one set (58);
 * `scripts` does (`lib/`), and its corpus stays the entry scripts (12) — the set the previous
 * direct-import floor named. A `scripts/lib/**` module is still TRAVERSED (a test reaches it through
 * an entry script, and the edge is what the floor follows); it is not a finding on its own, which is
 * a stated limit of this unit rather than a silent exemption.
 */
export const SURFACES = Object.freeze([
	Object.freeze({
		name: "src",
		dir: "src",
		sourceExtension: ".ts",
		testExtension: ".ts",
		reference: 2.0,
		warnAt: 1.95,
		floorCorpus: "tree",
	}),
	Object.freeze({
		name: "scripts",
		dir: "scripts",
		sourceExtension: ".mjs",
		testExtension: ".ts",
		reference: 1.0,
		warnAt: null,
		floorCorpus: "top",
	}),
]);

export const USAGE =
	"usage: check-test-budget.mjs <vitest-json-report> | --report <vitest-json-report> | " +
	"--flow [--base <ref>] [--head <sha>] [--json] | --declaration [<pr-body-file>]";

/**
 * The floor's constants. The corpus is every non-test source module on every surface; the roots are
 * the `*.test.ts` files; the edges are runtime import specifiers (no re-exports, no type-only forms).
 */
export const FLOOR = Object.freeze({
	/** The suffix that marks a floor ROOT — the files reachability is measured from. */
	testSuffix: ".test.ts",
	/** Extensions a specifier may name; the first one that exists in the graph wins. */
	candidateExtensions: [".ts", ".mjs", ".mts"],
	/** Directory entry points, tried last. */
	indexNames: ["index.ts", "index.mjs"],
});

function message(error) {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Report — wall time from the JSON reporter, start to the last file end.
// ---------------------------------------------------------------------------

/** Wall time of the run the report describes, in ms. Throws on anything that is not that report. */
export function readWallMs(reportPath) {
	let text;
	try {
		text = readFileSync(reportPath, "utf8");
	} catch (error) {
		throw new Error(`${reportPath}: cannot read the vitest JSON report (${message(error)}).`);
	}
	let report;
	try {
		report = JSON.parse(text);
	} catch (error) {
		throw new Error(`${reportPath}: not JSON (${message(error)}).`);
	}
	const results = report?.testResults;
	if (typeof report?.startTime !== "number" || !Array.isArray(results) || results.length === 0) {
		throw new Error(`${reportPath}: no startTime/testResults — is this vitest's json reporter output?`);
	}
	const endTimes = results.map((result) => result?.endTime).filter((value) => typeof value === "number" && Number.isFinite(value));
	if (endTimes.length === 0) {
		throw new Error(`${reportPath}: testResults carry no endTime — is this vitest's json reporter output?`);
	}
	return Math.max(...endTimes) - report.startTime;
}

// ---------------------------------------------------------------------------
// Surfaces — counted from disk (the real tree), never hardcoded.
// ---------------------------------------------------------------------------

/** Every file under `dir`, recursively, as sorted `join(dir, …)` paths. */
export function collectFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectFiles(full));
		else if (entry.isFile()) files.push(full);
	}
	return files.sort();
}

/** Physical lines, matching `wc -l` (a trailing newline starts no extra line). */
export function countLines(file) {
	const text = readFileSync(file, "utf8");
	const newlines = text.match(/\n/g);
	return newlines ? newlines.length : 0;
}

/**
 * Measure one surface under `root`: its source and test files (both sorted) and their LOC.
 * Throws when the tree is unreadable or holds no source — an empty numerator would make the ratio
 * a meaningless pass, so the guard refuses to compute it.
 */
export function measureSurface(surface, root = process.cwd()) {
	let files;
	try {
		files = collectFiles(join(root, surface.dir));
	} catch (error) {
		throw new Error(`${surface.dir}: cannot read the tree (${message(error)}).`);
	}
	const sourceFiles = [];
	const testFiles = [];
	for (const file of files) {
		const extension = extname(file);
		if (file.split(/[\\/]/).includes(TEST_DIR_NAME)) {
			if (extension === surface.testExtension) testFiles.push(file);
		} else if (extension === surface.sourceExtension) {
			sourceFiles.push(file);
		}
	}
	const sourceLoc = sourceFiles.reduce((total, file) => total + countLines(file), 0);
	if (sourceLoc === 0) {
		throw new Error(`${surface.dir}: no source (${surface.sourceExtension} outside ${TEST_DIR_NAME}) lines found — cannot compute the ratio.`);
	}
	const testLoc = testFiles.reduce((total, file) => total + countLines(file), 0);
	return {
		name: surface.name,
		sourceFiles,
		testFiles,
		sourceLoc,
		testLoc,
		ratio: testLoc / sourceLoc,
		reference: surface.reference,
		warnAt: surface.warnAt,
	};
}

/**
 * One line per surface: numerator, denominator, the reference ratio, and the band when the surface
 * declares one. The word is `reference`, not `ceiling`: nothing fails on it (the flow rule is the
 * gate), and a line that said `ceiling` would be the old policy in a string.
 */
export function formatSurface(surface) {
	const band = surface.warnAt === null ? "" : `, warn at ${surface.warnAt.toFixed(2)}`;
	return (
		`test-budget: ${surface.name} ${surface.ratio.toFixed(2)} ` +
		`(${surface.testLoc} test / ${surface.sourceLoc} source LOC, reference ${surface.reference.toFixed(1)}${band})`
	);
}

function formatMs(ms) {
	return `${(ms / 1000).toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// Parser — module requests, read from CODE only.
// ---------------------------------------------------------------------------

/** The placeholder that replaces a literal: `"<NUL>3<NUL>"`, carrying its value in `literals`. */
const MARK = "\u0000";

/** Any module request in masked code — the shape unchanged from the pre-hardening regex. */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/g;
const PLACEHOLDER_RE = new RegExp(`^${MARK}(\\d+)${MARK}$`);
const TYPE_ONLY_RE = /^\s*(?:import|export)\s+type\b/;
const REEXPORT_RE = /^\s*export\b/;

/**
 * `text` in two halves: `code`, with every comment blanked and every literal replaced by an inert
 * placeholder, and `literals`, the values in placeholder order. Nothing a line comment, a block
 * comment, a single-quoted, double-quoted or template literal contains can then be read as a module
 * request — the old regex read code and quoted text alike, so a path named in a comment satisfied the
 * floor and a path named in a fixture string satisfied it too.
 *
 * A regex literal containing a quote desynchronises this scanner (it is not a JavaScript parser): the
 * swallowed region is reported as inert, so a real import inside it is LOST. That is the fail-closed
 * direction — a module wrongly reads as unreachable and the floor fires; it can never read as
 * reachable on the strength of a string.
 */
export function maskNonCode(text) {
	const literals = [];
	let code = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		const next = text[index + 1];
		if (char === "/" && next === "/") {
			while (index < text.length && text[index] !== "\n") index += 1;
			code += " ";
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
				code += text[index] === "\n" ? "\n" : " ";
				index += 1;
			}
			index += 2;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			let value = "";
			index += 1;
			while (index < text.length) {
				if (text[index] === "\\") {
					value += text[index + 1] ?? "";
					index += 2;
					continue;
				}
				if (text[index] === quote) {
					index += 1;
					break;
				}
				value += text[index];
				index += 1;
			}
			literals.push(value);
			code += `"${MARK}${literals.length - 1}${MARK}"`;
			continue;
		}
		code += char;
		index += 1;
	}
	return { code, literals };
}

/**
 * Every module request in `text`, as `{ specifier, reexport }`. Statements are split on `;` in the
 * MASKED text (a literal can no longer contain one), which is what lets a type-only form be skipped
 * whole: `import type { A } from "./a"` and `export type { A } from "./a"` carry a `from` that the
 * runtime regex would otherwise match.
 */
function collectSpecifiers(text) {
	const { code, literals } = maskNonCode(text);
	const found = [];
	for (const statement of code.split(";")) {
		if (TYPE_ONLY_RE.test(statement)) continue;
		const reexport = REEXPORT_RE.test(statement);
		for (const match of statement.matchAll(SPECIFIER_RE)) {
			const placeholder = PLACEHOLDER_RE.exec(match[2]);
			if (placeholder === null) continue; // impossible after masking; fail closed regardless
			found.push({ specifier: literals[Number(placeholder[1])], reexport });
		}
	}
	return found;
}

/**
 * The module specifiers a source text imports or requires at RUNTIME: `from "x"`, a side-effect
 * `import "x"`, a dynamic `import("x")` and `require("x")`. Type-only forms are absent because every
 * loader erases them; a re-export is present (it IS a module request) and the floor drops it itself.
 */
export function importSpecifiers(text) {
	return collectSpecifiers(text).map((entry) => entry.specifier);
}

/** The specifiers that create a REACHABILITY edge: runtime imports, minus `export … from` barrels. */
export function reachabilitySpecifiers(text) {
	return collectSpecifiers(text)
		.filter((entry) => !entry.reexport)
		.map((entry) => entry.specifier);
}

// ---------------------------------------------------------------------------
// Floor — a module no test can reach is a module no test runs.
// ---------------------------------------------------------------------------

function isTestPath(file) {
	return file.split(/[\\/]/).includes(TEST_DIR_NAME);
}

/**
 * Resolve `specifier` against the importing file's directory, restricted to paths already in the
 * module graph: `<base>`, `<base><ext>`, `<base-with-.js-replaced><ext>` (TypeScript's
 * `./x.js` → `./x.ts` convention) and `<base>/index.<ext>`. A bare specifier is a package.
 */
function resolveEdge(fromFile, specifier, modules) {
	if (!specifier.startsWith(".")) return null;
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [base];
	for (const extension of FLOOR.candidateExtensions) candidates.push(`${base}${extension}`);
	const withoutJs = base.replace(/\.js$/, "");
	if (withoutJs !== base) for (const extension of FLOOR.candidateExtensions) candidates.push(`${withoutJs}${extension}`);
	for (const name of FLOOR.indexNames) candidates.push(join(base, name));
	for (const candidate of candidates) {
		if (modules.has(candidate)) return candidate;
	}
	return null;
}

/**
 * One surface's floor: `{ name, total, reached, unreachable, testFiles }`. `unreachable` holds the
 * non-test source modules no `*.test.ts` reaches through import edges (transitive — a helper is only
 * traversed when a test reaches it), sorted, as paths relative to `root` (`src/a.ts`) so the finding
 * names something the reader can open.
 *
 * A missing directory or a tree with no tests is a floor failure (nothing is reachable), not an IO
 * error: `${surface.dir}: cannot read the tree` is thrown only when the directory itself is absent.
 */
export function measureFloor(surface, root = process.cwd()) {
	let files;
	try {
		files = collectFiles(join(root, surface.dir));
	} catch (error) {
		throw new Error(`${surface.dir}: cannot read the tree (${message(error)}).`);
	}
	const modules = new Set(
		files.filter((file) => [surface.sourceExtension, surface.testExtension].includes(extname(file))),
	);
	const sources = [...modules]
		.filter((file) => !isTestPath(file))
		.filter((file) => surface.floorCorpus === "tree" || dirname(file) === join(root, surface.dir))
		.sort();
	const roots = [...modules].filter((file) => isTestPath(file) && file.endsWith(FLOOR.testSuffix)).sort();

	const reached = new Set();
	const queue = [...roots];
	while (queue.length > 0) {
		const file = queue.pop();
		if (reached.has(file)) continue;
		reached.add(file);
		for (const specifier of reachabilitySpecifiers(readFileSync(file, "utf8"))) {
			const target = resolveEdge(file, specifier, modules);
			if (target !== null) queue.push(target);
		}
	}
	const unreachable = sources.filter((file) => !reached.has(file)).map((file) => relative(root, file));
	return {
		name: surface.name,
		total: sources.length,
		reached: sources.length - unreachable.length,
		unreachable,
		testFiles: roots.length,
	};
}

/** Every surface's floor, in surface order. */
export function measureFloors(root = process.cwd(), surfaces = SURFACES) {
	return surfaces.map((surface) => measureFloor(surface, root));
}

// ---------------------------------------------------------------------------
// The over-allowance declaration — the one line that authorises a flow verdict of `over`.
// ---------------------------------------------------------------------------

/**
 * A line-start `Test budget: <reason>` — `[ \t]*` after the colon, never `\s*` — because
 * `Test budget:` followed by a blank line and unrelated prose is not a declaration, it is a heading.
 */
export const TEST_BUDGET_DECLARATION = /^[ \t]*Test budget:[ \t]*\S/;

const FENCE_RE = /^(`{3,}|~{3,})/;

/**
 * The declaration line in `body`, trimmed, or `null`. Fenced code, blockquotes and the
 * `<!-- pr-evidence:block -->` are inert: the first two are how a body QUOTES a format, and the third
 * is generated (`pr-evidence --apply`) so it cannot carry a judgement. Mirrors the ban list's
 * exemptions in `scripts/lib/pr-evidence.mjs` — that module is imported, never modified.
 */
export function findTestBudgetDeclaration(body) {
	const lines = String(body).split("\n");
	const { ranges } = scanBlocks(lines);
	const inside = new Set();
	for (const range of ranges) for (let index = range.begin; index <= range.end; index += 1) inside.add(index);
	let fence = "";
	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = lines[index].trim();
		const marker = FENCE_RE.exec(trimmed);
		if (fence !== "") {
			if (marker !== null && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
			continue;
		}
		if (marker !== null) {
			fence = marker[1];
			continue;
		}
		if (inside.has(index) || trimmed.startsWith(">")) continue;
		if (TEST_BUDGET_DECLARATION.test(lines[index])) return trimmed;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Verdict — report every breach, then one summary. Pure: no IO, no exits.
// ---------------------------------------------------------------------------

/** Test lines still available before the surface reaches its reference ratio. */
function headroom(surface) {
	return Math.max(0, Math.floor(surface.reference * surface.sourceLoc) - surface.testLoc);
}

function lines(count) {
	return `${count} test line${count === 1 ? "" : "s"}`;
}

/**
 * The report-mode verdict. `findings` fail the run; `warnings` do not. The ratio only ever produces a
 * warning (policy v2): the reference ratio and its band are signals, and the flow rule is what gates
 * a change. The wall ceiling and the floors are still findings, because each of them can be a fact
 * about THIS run — one suite on one runner, and a module nothing reaches.
 */
export function evaluate({ reportPath, wallMs, wallCeilingMs = WALL_CEILING_MS, surfaces, floors = [] }) {
	const findings = [];
	const warnings = [];
	if (wallMs > wallCeilingMs) {
		findings.push(
			`wall time ${formatMs(wallMs)} exceeds the ${formatMs(wallCeilingMs)} ceiling by ${wallMs - wallCeilingMs} ms ` +
				`(report: ${reportPath}; the ceiling is a limit, not a target).`,
		);
	}
	for (const surface of surfaces) {
		const band = surface.warnAt;
		if (surface.ratio > surface.reference) {
			// The overage is stated in whole lines: a ratio printed to two decimals can round to the
			// reference it just passed (56198/28097 = 2.0004 prints as 2.00), and "2.00 is above 2.0"
			// reads as a bug in the guard. The exact line count cannot round away.
			warnings.push(
				`surface "${surface.name}" test:source LOC ratio ${surface.ratio.toFixed(2)} ` +
					`(${surface.testLoc} test / ${surface.sourceLoc} source) is above the ${surface.reference.toFixed(1)} reference ` +
					`by ${lines(surface.testLoc - Math.floor(surface.reference * surface.sourceLoc))} — reported, not enforced ` +
					"(the per-PR flow rule gates the delta; --flow).",
			);
		} else if (band !== null && surface.ratio >= band) {
			warnings.push(
				`surface "${surface.name}" test:source LOC ratio ${surface.ratio.toFixed(2)} ` +
					`(${surface.testLoc} test / ${surface.sourceLoc} source) is inside the ${band.toFixed(2)} warning band — ` +
					`${headroom(surface)} test lines of headroom under the ${surface.reference.toFixed(1)} reference ` +
					"(reported, not enforced).",
			);
		}
	}
	for (const floor of floors) {
		if (floor.unreachable.length === 0) continue;
		findings.push(
			`${floor.name} floor: ${floor.unreachable.length} of ${floor.total} source modules are unreachable from any ` +
				`${FLOOR.testSuffix} — ${floor.unreachable.join(", ")} (a test must import it, directly or through a module ` +
				"a test imports; a comment, a string, `import type` and a re-export are not edges).",
		);
	}
	return { findings, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Report mode: `{ ok: true, reportPath }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	let reportPath;
	const takePath = (value) => {
		if (value === undefined || value.startsWith("--")) return "--report needs a path";
		if (reportPath !== undefined) return `unexpected argument: ${value}`;
		reportPath = value;
		return undefined;
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--report") {
			const error = takePath(argv[index + 1]);
			if (error !== undefined) return { ok: false, message: error };
			index += 1;
		} else if (arg.startsWith("--")) {
			return { ok: false, message: `unknown flag: ${arg}` };
		} else {
			const error = takePath(arg);
			if (error !== undefined) return { ok: false, message: error };
		}
	}
	if (reportPath === undefined) return { ok: false, message: "missing the vitest JSON report path" };
	return { ok: true, reportPath };
}

/** Flow mode: `{ ok: true, base, head, json }` or `{ ok: false, message }`. `--head` is required. */
export function parseFlowArgs(argv) {
	let base = FLOW.base;
	let head = "";
	let json = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--flow") continue;
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--base" || arg === "--head") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) return { ok: false, message: `${arg} needs a value` };
			if (arg === "--base") base = value;
			else head = value;
			index += 1;
			continue;
		}
		return { ok: false, message: `unknown flow argument: ${arg}` };
	}
	if (head === "") return { ok: false, message: "--head needs a sha (the PR head, which need not be checked out)" };
	return { ok: true, base, head, json };
}

/** `git -C <root> <args…>` — never throws; a failed spawn is a non-zero status with its message. */
function git(root, args) {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (result.error) return { status: -1, stdout: "", stderr: message(result.error) };
	return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitDetail(result) {
	const text = `${result.stderr}${result.stdout}`.trim().replace(/\n/g, " ");
	return text === "" ? `git exited ${result.status}` : text;
}

/**
 * `--flow`: the per-PR verdict. Every question git cannot answer is exit 2 with a named code — a
 * post-merge replay (`already-merged`) must never read as a pass, and an unknown head must never read
 * as "no change". Returns the exit code; every line of output goes through `out` / `err`.
 */
export function runFlow(argv, { root = process.cwd(), out = console.log, err = console.error } = {}) {
	const parsed = parseFlowArgs(argv);
	if (!parsed.ok) {
		err(`${USAGE}\ntest-flow: ${FLOW_CODES.usage} — ${parsed.message}`);
		return FLOW_EXIT.ERROR;
	}
	const { base, head, json } = parsed;

	const known = git(root, ["cat-file", "-e", `${head}^{commit}`]);
	if (known.status !== 0) {
		err(`test-flow: ${FLOW_CODES.unknownHead} — head ${head} is not a commit in ${root} (${gitDetail(known)})`);
		return FLOW_EXIT.ERROR;
	}
	const resolvedHead = git(root, ["rev-parse", `${head}^{commit}`]).stdout.trim();
	const mergeBase = git(root, ["merge-base", base, head]);
	if (mergeBase.status !== 0) {
		err(`test-flow: ${FLOW_CODES.diffFailed} — no merge base for ${base} and ${head} (${gitDetail(mergeBase)})`);
		return FLOW_EXIT.ERROR;
	}
	const baseSha = mergeBase.stdout.trim();
	if (baseSha === resolvedHead) {
		err(
			`test-flow: ${FLOW_CODES.alreadyMerged} (base ${baseSha.slice(0, 7)}) — ${head} is already an ancestor of ` +
				`${base}; a post-merge replay must not silently pass.`,
		);
		return FLOW_EXIT.ERROR;
	}
	const dirs = SURFACES.map((surface) => surface.dir);
	const diff = git(root, ["diff", "--no-renames", "--numstat", `${base}...${head}`, "--", ...dirs]);
	if (diff.status !== 0) {
		err(`test-flow: ${FLOW_CODES.diffFailed} — git diff --no-renames --numstat ${base}...${head} (${gitDetail(diff)})`);
		return FLOW_EXIT.ERROR;
	}

	const flow = computeFlow(diff.stdout, { surfaces: SURFACES, testDirName: TEST_DIR_NAME });
	if (json) {
		out(JSON.stringify({ base: baseSha, head: resolvedHead, rows: flow.rows, verdict: flow.verdict }));
	} else {
		out(formatFlowLine(flow, baseSha));
	}
	return flow.verdict === "within" ? FLOW_EXIT.WITHIN : FLOW_EXIT.OVER;
}

/**
 * `--declaration [<body-file>]`: the one line that authorises an `over` flow. Prints it and exits 0;
 * prints nothing and exits 1 when the body carries none; exit 2 when the body cannot be read. The
 * merge gate reads the exit status, so "no declaration" is a distinguishable answer, not empty output.
 */
export function runDeclaration(argv, { out = console.log, err = console.error, stdin = () => readFileSync(0, "utf8") } = {}) {
	const paths = argv.filter((arg) => arg !== "--declaration");
	if (paths.length > 1) {
		err(`${USAGE}\ntest-budget-declaration: usage — expected at most one body path (got ${paths.length})`);
		return 2;
	}
	let body;
	try {
		body = paths.length === 1 ? readFileSync(paths[0], "utf8") : stdin();
	} catch (error) {
		err(`test-budget-declaration: ${paths[0] ?? "stdin"}: cannot read the PR body (${message(error)})`);
		return 2;
	}
	const line = findTestBudgetDeclaration(body);
	if (line === null) return 1;
	out(line);
	return 0;
}

/** Run the guard. Returns the exit code; every line of output goes through `out` / `err`. */
export function main(argv = process.argv.slice(2), { root = process.cwd(), out = console.log, err = console.error } = {}) {
	if (argv.includes("--flow")) return runFlow(argv, { root, out, err });
	if (argv.includes("--declaration")) return runDeclaration(argv, { out, err });

	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		err(`${USAGE}\n${parsed.message}`);
		return 2;
	}
	const { reportPath } = parsed;

	let wallMs;
	let surfaces;
	let floors;
	try {
		wallMs = readWallMs(reportPath);
		surfaces = [...SURFACES].sort((a, b) => (a.name < b.name ? -1 : 1)).map((surface) => measureSurface(surface, root));
		floors = measureFloors(root);
	} catch (error) {
		err(`test-budget: ${message(error)}`);
		return 2;
	}

	const { findings, warnings } = evaluate({ reportPath, wallMs, surfaces, floors });

	out(`test-budget: wall ${formatMs(wallMs)} (<= ${formatMs(WALL_CEILING_MS)}, report: ${reportPath})`);
	for (const surface of surfaces) out(formatSurface(surface));
	out(`test-budget: floors — ${floors.map((floor) => `${floor.name} ${floor.reached}/${floor.total} reachable`).join(" · ")}`);
	for (const warning of warnings) err(`test-budget: warning: ${warning}`);
	for (const finding of findings) err(`test-budget: ${finding}`);
	if (findings.length > 0) return 1;
	out("test-budget: OK.");
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
