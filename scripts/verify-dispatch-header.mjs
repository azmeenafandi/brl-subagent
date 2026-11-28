#!/usr/bin/env node
// Purpose: The executable evidence table for issue #606 §Evidence — one case per row, each asserting its pass state and the fail state it rules out.
/**
 * Issue #606, Unit 1 — the dispatch gate's evidence table.
 *
 * Every row of the spec's §Evidence table is a CASE here, and every case runs
 * the REAL code: `validatePreTask` / `resolveDispatchPreset` / the template
 * renderer are loaded from `src/` through jiti, exactly as the extension loads
 * them. Fixtures are throwaway trees under the OS temp dir; an opted-in tree
 * carries `package.json` with `{"brl-subagent":{"processChecks":true}}`.
 *
 * TWO ASSERTIONS PER CASE, because a pass that cannot fail proves nothing:
 *   - the PASS assertion the spec names (e.g. "the gate refuses and the message
 *     names the form"), and
 *   - the FAIL state it rules out — stated in the output as `rules out:`, so a
 *     reader can see which wrong implementation this case would have caught.
 *
 * `gate: exit N` is the dispatch's verdict translated to an exit code (0 =
 * the dispatch would have spawned, 1 = the validator refused), which is the
 * "exit 1 / exit 0" the spec's table speaks in. The SCRIPT's own exit code
 * answers a different question: 0 when every requested case's assertions held,
 * 1 when one did not, 2 for usage. A case that PASSES can therefore print
 * `gate: exit 1` — that is a refusal doing its job.
 *
 * Usage:
 *   node scripts/verify-dispatch-header.mjs --list
 *   node scripts/verify-dispatch-header.mjs --case header-missing
 *   node scripts/verify-dispatch-header.mjs --all
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createJiti } from "jiti";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Loading the real seams
// ---------------------------------------------------------------------------

const jiti = createJiti(import.meta.url, { interopDefault: true });

/** Loading is lazy so `--list` stays instant and a broken module fails per case. */
const modules = {
	get validate() {
		return jiti.import(join(ROOT, "src", "validate.ts"));
	},
	get brief() {
		return jiti.import(join(ROOT, "src", "brief.ts"));
	},
};

const trees = [];

function tree({ optedIn = true, briefs = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "brl-606-"));
	trees.push(dir);
	if (optedIn) {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "verify-606", "brl-subagent": { processChecks: true } }, null, 2),
			"utf8",
		);
	}
	for (const [slug, text] of Object.entries(briefs)) {
		mkdirSync(join(dir, "briefs"), { recursive: true });
		writeFileSync(join(dir, "briefs", `${slug}.md`), text, "utf8");
	}
	return dir;
}

function cleanup() {
	for (const dir of trees.splice(0)) rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A valid Jev line: every integration case carries one, so the pre-existing
 * rejection cannot mask the result this case is about. */
const JEV = "jev: high (0.44) · C2 · worktree y";

const SIGNED_BRIEF = [
	"## Want",
	"",
	"Make the factory's front door enforceable.",
	"",
	"## Facts",
	"",
	"- src/validate.ts is the pre-spawn seam.",
	"",
	"## Settled decisions",
	"",
	"| Decision | Answer | Rationale |",
	"| --- | --- | --- |",
	"| Gate scope | the code-writing dispatch | boundary A |",
	"",
	"confirmed: 2026-11-28 by azmeen",
].join("\n");

/** A brief that satisfies every predicate EXCEPT the confirmation marker. */
const UNSIGNED_BRIEF = SIGNED_BRIEF.replace("\nconfirmed: 2026-11-28 by azmeen", "");

/** A brief with an `## Want` heading whose section body is empty. */
const HOLLOW_BRIEF = SIGNED_BRIEF.replace("Make the factory's front door enforceable.\n", "");

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function check(ok, label) {
	return { ok: Boolean(ok), label };
}

/** Run the real gate and translate its verdict into the case's facts. */
async function gate(task, cwd) {
	const { validatePreTask } = await modules.validate;
	const { isProcessChecksEnabled } = await jiti.import(join(ROOT, "src", "project-flags.ts"));
	const result = validatePreTask({ task, cwd });
	const errors = result.errors ?? [];
	const warnings = result.warnings ?? [];
	return {
		exit: result.valid ? 0 : 1,
		optedIn: isProcessChecksEnabled(cwd),
		message: [...errors, ...warnings].join("\n"),
		errors,
		warnings,
	};
}

function cwdLabel(outed) {
	return outed.optedIn ? "opted in (processChecks on)" : "no check (processChecks absent)";
}

/** A refusal case: the gate exits 1 and the message carries `fragments`. */
function refusal(outed, fragments) {
	return [
		check(outed.exit === 1, "exit 1 (the dispatch is refused)"),
		...fragments.map(([pattern, label]) => check(pattern.test(outed.message), label)),
	];
}

/** An acceptance case: the gate exits 0 (the dispatch would have spawned). */
function acceptance(outed, fragments = []) {
	return [
		check(outed.exit === 0, "exit 0 (the dispatch would proceed)"),
		check(outed.errors.length === 0, "no refusal"),
		...fragments.map(([pattern, label]) => check(pattern.test(outed.message), label)),
	];
}

// ---------------------------------------------------------------------------
// The cases — one per §Evidence row
// ---------------------------------------------------------------------------

export const CASES = {
	// P1
	"header-missing": {
		row: "P1",
		rulesOut: "the gate is off",
		async run() {
			const outed = await gate(`${JEV}\n\nImplement the thing.`, tree());
			return { outed, checks: refusal(outed, [[/dispatch: impl \| review \| probe \| docs/, "names the `dispatch:` form"]]) };
		},
	},

	// P2
	"impl-no-brief": {
		row: "P2",
		rulesOut: "the brief line is ignored",
		async run() {
			const outed = await gate(`dispatch: impl\n${JEV}\n\nImplement the thing.`, tree());
			return {
				outed,
				checks: refusal(outed, [
					[/requires a brief/, "names the missing `brief:` line"],
					[/brief: <slug>/, "quotes the required form verbatim"],
				]),
			};
		},
	},

	// P3
	"brief-unsigned": {
		row: "P3",
		rulesOut: "the confirmation marker is unchecked",
		async run() {
			const root = tree({ briefs: { unsigned: UNSIGNED_BRIEF } });
			const outed = await gate(`dispatch: impl\nbrief: unsigned\n${JEV}\n\nImplement it.`, root);
			return {
				outed,
				checks: refusal(outed, [
					[new RegExp(join("briefs", "unsigned.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "names the brief path"],
					[/confirmed: <YYYY-MM-DD> by <name>/, "names the marker"],
				]),
			};
		},
	},

	// P4
	"brief-hollow": {
		row: "P4",
		rulesOut: "the brief's structure is unchecked",
		async run() {
			const root = tree({ briefs: { hollow: HOLLOW_BRIEF } });
			const outed = await gate(`dispatch: impl\nbrief: hollow\n${JEV}\n\nImplement it.`, root);
			return { outed, checks: refusal(outed, [[/## Want.* (empty|missing)/, "names the empty `## Want` (predicate 1)"]]) };
		},
	},

	// P5 — a DELIBERATELY invalid header must be accepted because the flag is off.
	"flag-absent": {
		row: "P5",
		rulesOut: "the check leaking into a non-opted-in tree",
		async run() {
			const outed = await gate(`dispatch: impl\n${JEV}\n\nImplement the thing.`, tree({ optedIn: false }));
			return {
				outed,
				checks: [
					...acceptance(outed),
					check(!outed.optedIn, "prints `no check (processChecks absent)`"),
				],
			};
		},
	},

	// P6
	"review-header": {
		row: "P6",
		rulesOut: "the gate being too wide (a review dispatch refused)",
		async run() {
			const outed = await gate(`dispatch: review\n${JEV}\n\nReview the change.`, tree());
			return { outed, checks: acceptance(outed) };
		},
	},

	// P7 — three slug shapes; reachable as `--case 'slug-../x'` etc.
	...Object.fromEntries(
		[
			["slug-../x", "../x", /single path component/, "traversal (`../x`)"],
			["slug-a/b", "a/b", /single path component/, "a separator (`a/b`)"],
			["slug-none", "none", /brief: none — <reason>/, "the reserved token (`none`)"],
		].map(([name, value, pattern, label]) => [
			name,
			{
				row: "P7",
				rulesOut: "a slug that is a path (traversal, separators, the reserved token)",
				async run() {
					const outed = await gate(`dispatch: impl\nbrief: ${value}\n${JEV}\n\nImplement it.`, tree());
					return {
						outed,
						checks: refusal(outed, [
							[/brief slug|brief escape/, "names the grammar"],
							[pattern, `refuses ${label}`],
						]),
					};
				},
			},
		]),
	),

	// P8 — the stale tree, and the control that proves there is no fallback.
	"stale-tree": {
		row: "P8",
		rulesOut: "a brief the dispatch cwd's tree does not carry",
		async run() {
			const root = tree();
			const outed = await gate(`dispatch: impl\nbrief: consider-tax\n${JEV}\n\nImplement it.`, root);
			return {
				outed,
				checks: refusal(outed, [
					[new RegExp(escapeRegExp(join(root, "briefs", "consider-tax.md"))), "names the cwd's brief path"],
				]),
			};
		},
	},

	control: {
		row: "P8 (control)",
		rulesOut: "a silent fallback to another tree that has the brief",
		async run() {
			const stale = tree();
			const fallback = tree({ briefs: { "consider-tax": SIGNED_BRIEF } });
			const outed = await gate(`dispatch: impl\nbrief: consider-tax\n${JEV}\n\nImplement it.`, stale);
			return {
				outed,
				checks: refusal(outed, [
					[new RegExp(escapeRegExp(join(stale, "briefs", "consider-tax.md"))), "still names the DISPATCH cwd's path"],
					[
						{ test: (text) => !text.includes(join(fallback, "briefs", "consider-tax.md")) },
						"never names the fallback tree's path",
					],
				]),
			};
		},
	},

	// P9 — routing must classify the BODY, never the header (§3b).
	routing: {
		row: "P9",
		rulesOut: "the §3b contamination (a header silently re-routing a dispatch)",
		async run() {
			const { resolveDispatchPreset } = await jiti.import(join(ROOT, "src", "params.ts"));
			const { classifyTask } = await jiti.import(join(ROOT, "src", "router.ts"));
			const presets = [
				{ name: "code-reviewer" },
				{ name: "test-engineer" },
				{ name: "dev-agent" },
			];
			const state = { builtinPresets: presets, customPresets: [] };
			const body = "write tests for the dispatch header";
			const whole = `dispatch: review\njev: medium (0.58) · C2 · worktree y\n\n${body}`;

			const bodyOnly = resolveDispatchPreset({ task: body }, state);
			const headered = resolveDispatchPreset({ task: whole }, state);
			const wholeClassified = classifyTask(whole, presets);

			return {
				lines: [
					`body-only control:  resolveDispatchPreset(body) = ${bodyOnly.name}`,
					`with the header:    resolveDispatchPreset(task) = ${headered.name}`,
					`the hazard:         classifyTask(whole task)   = ${wholeClassified && wholeClassified.preset}`,
				],
				checks: [
					check(headered.name === bodyOnly.name, "selects the SAME preset as the body-only control"),
					check(headered.keyword === bodyOnly.keyword, "selects the same matched keyword"),
					check(
						wholeClassified !== undefined && wholeClassified.preset !== bodyOnly.name,
						"classifyTask(whole) selects a DIFFERENT preset (the hazard is real; the fix is in the caller)",
					),
				],
			};
		},
	},

	// P11
	"dispatch-with-comment": {
		row: "P11",
		rulesOut: "ambiguous trailing text accepted as a declaration",
		async run() {
			const outed = await gate(`dispatch: impl   # note\n${JEV}\n\nImplement it.`, tree());
			return { outed, checks: refusal(outed, [[/exactly one token/, "names the one-token rule"]]) };
		},
	},

	// P12
	"title-first": {
		row: "P12",
		rulesOut: "a title silently accepted before the block",
		async run() {
			// The Jev line is LATER in the body, so the pre-existing check passes
			// and `title-first` is the only thing that can fail.
			const outed = await gate(`# Task\n\ndispatch: probe\n\nDo the work.\n\n${JEV}`, tree());
			return {
				outed,
				checks: refusal(outed, [[/the block must be the first content/, 'names "the block must be the first content"']]),
			};
		},
	},
};

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WIDTH = Math.max(...Object.keys(CASES).map((name) => name.length));

export async function runCase(name) {
	const entry = CASES[name];
	if (!entry) {
		process.stderr.write(`verify-dispatch-header: unknown case "${name}"\n\nusage: --list | --all | --case <name>\n`);
		process.exitCode = 2;
		return "missing";
	}
	const body = await entry.run();
	const { outed, checks } = body;
	const failed = checks.filter((c) => !c.ok);
	const verdict = failed.length === 0 ? "PASS" : "FAIL";
	process.stdout.write(`${entry.row.padEnd(11)} ${name.padEnd(WIDTH)} ${verdict}\n`);
	process.stdout.write(`            rules out: ${entry.rulesOut}\n`);
	if (body.lines !== undefined) {
		for (const line of body.lines) process.stdout.write(`            ${line}\n`);
	} else {
		process.stdout.write(`            cwd:       ${cwdLabel(outed)}\n`);
		process.stdout.write(`            gate:      exit ${outed.exit}\n`);
		for (const line of outed.message.split("\n").filter((l) => l.trim() !== "")) {
			process.stdout.write(`            message:   ${line}\n`);
		}
	}
	for (const item of checks) {
		process.stdout.write(`            ${item.ok ? "ok  " : "FAIL"} ${item.label}\n`);
	}
	return verdict === "PASS" ? "pass" : "fail";
}

export async function main(argv) {
	const cases = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--list") {
			for (const [name, entry] of Object.entries(CASES)) process.stdout.write(`${entry.row.padEnd(11)} ${name}\n`);
			return 0;
		}
		if (arg === "--all") {
			cases.push(...Object.keys(CASES));
			continue;
		}
		if (arg === "--case") {
			const name = argv[i + 1];
			if (!name) {
				process.stderr.write("verify-dispatch-header: --case needs a name (see --list)\n");
				return 2;
			}
			cases.push(name);
			i += 1;
			continue;
		}
		process.stderr.write(`verify-dispatch-header: unknown argument "${arg}"\nusage: --list | --all | --case <name>\n`);
		return 2;
	}
	if (cases.length === 0) {
		process.stderr.write("verify-dispatch-header: nothing to run — pass --all or --case <name> (see --list)\n");
		return 2;
	}

	const results = [];
	try {
		for (const name of cases) results.push(await runCase(name));
	} finally {
		cleanup();
	}
	if (results.includes("missing")) return 2;
	if (results.includes("fail")) {
		const failed = results.filter((r) => r !== "pass").length;
		process.stdout.write(`\n${failed} of ${results.length} case(s) FAILED\n`);
		return 1;
	}
	process.stdout.write(`\n${results.length} case(s) passed\n`);
	return 0;
}

// A CLI, not a library: nothing runs when a test imports this file (the
// test-budget floor requires an import edge, and a module that exits on import
// has no test that can import it).
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
