// Purpose: The per-PR test-budget flow rule (test-budget policy v2) — pure, so the verdict is testable
// without a repo, a checkout or a subprocess.
//
// WHY A FLOW RULE AND NOT A STOCK CEILING. A stock test:source ratio cannot tell a PR that adds 40
// test lines for 200 new source lines from one that adds 400 lines for none; it only knows the tree
// total, and it punishes the second PR for the first PR's thrift. So the ratio is REPORTED (with a
// warning band) and each PR's DELTA is what this rule gates:
//
//   allowance(surface) = 120 + 2 × max(Δsource, 0)      — per surface, on NET lines
//
// `net` (Σadded − Σdeleted), not gross: replacing a test measures ZERO, so a rewrite is never a
// spending event. The 120 is a fixed "a small change may come with a small test" floor; the 2× term
// means source growth pays for its own coverage at the same rate the old `src` ceiling allowed. An
// ACCEPTED LIMIT, said out loud: two test-only PRs of +120 each accumulate +240 with no source change
// and remain "within" — the flow rule measures each PR's purchase, not the tree's total, and the
// stock report (with its warning band) is what makes the accumulation visible.
//
// A PR is `within` only when EVERY surface with a nonzero delta is within; a surface with no change is
// not printed at all (it had no purchase to judge). A PR that touches neither surface says so.
//
// The diff comes from GIT (`--no-renames`, so a source↔test move shows as a deletion plus an addition
// — a rename would otherwise hide the reclassification), never from the working tree: the head does
// not have to be checked out, which is what lets the merge gate measure a PR from the cockpit.
import { extname } from "node:path";

/** The rule's numbers, named so the fixture, the message and `--json` cannot disagree. */
export const FLOW = Object.freeze({
	/** The fixed part of every surface's allowance, in test lines. */
	baseAllowance: 120,
	/** Test lines an added source line pays for. */
	sourceMultiplier: 2,
	/** The default base ref; `--base` overrides it. */
	base: "dev",
});

/** Named exit codes: 0 within · 1 over · 2 usage or an unanswerable question (fail closed). */
export const FLOW_EXIT = Object.freeze({ WITHIN: 0, OVER: 1, ERROR: 2 });

/**
 * The reasons this mode refuses to answer. A named code, never a silent pass: the merge gate reads
 * the exit status, and an unanswerable flow is a block, not a zero.
 */
export const FLOW_CODES = Object.freeze({
	usage: "usage",
	unknownHead: "unknown-head",
	alreadyMerged: "already-merged",
	diffFailed: "diff-failed",
});

/**
 * One row per `--numstat` line: `{ added, deleted, path }`. A binary file reports `-` instead of a
 * count and contributes zero lines (it can carry no test LOC either way).
 */
export function parseNumstat(text) {
	const rows = [];
	for (const line of String(text).split("\n")) {
		if (line.trim() === "") continue;
		const [added, deleted, ...tail] = line.split("\t");
		const path = tail.join("\t");
		if (path === "") continue;
		rows.push({ added: toCount(added), deleted: toCount(deleted), path });
	}
	return rows;
}

function toCount(value) {
	return /^\d+$/.test(String(value)) ? Number(value) : 0;
}

/**
 * `"source"` or `"test"` for a path that belongs to `surface`, `null` for anything else — another
 * surface's directory, a declaration file, a `.json` fixture. A `__tests__` segment classifies a
 * file as a test, never the extension: on the `scripts` surface the tests are `.ts` and the sources
 * are `.mjs`, so the extension alone cannot answer.
 */
export function classifyPath(path, surface, testDirName) {
	if (!path.startsWith(`${surface.dir}/`)) return null;
	const extension = extname(path);
	const isTest = path.split("/").includes(testDirName);
	if (isTest) return extension === surface.testExtension ? "test" : null;
	return extension === surface.sourceExtension ? "source" : null;
}

/**
 * The rule's verdict over a `--numstat` text: `{ rows, verdict }`, where each row is a surface with a
 * nonzero NET delta — `{ name, source, test, allowance, verdict }` — and `verdict` is `within` only
 * when every printed row is.
 */
export function computeFlow(numstatText, { surfaces, testDirName }) {
	const deltas = new Map(surfaces.map((surface) => [surface.name, { surface, source: 0, test: 0 }]));
	for (const row of parseNumstat(numstatText)) {
		for (const surface of surfaces) {
			const kind = classifyPath(row.path, surface, testDirName);
			if (kind === null) continue;
			const delta = deltas.get(surface.name);
			delta[kind] += row.added - row.deleted;
			break;
		}
	}
	const rows = [];
	for (const { surface, source, test } of deltas.values()) {
		if (source === 0 && test === 0) continue;
		const allowance = FLOW.baseAllowance + FLOW.sourceMultiplier * Math.max(source, 0);
		rows.push({ name: surface.name, source, test, allowance, verdict: test <= allowance ? "within" : "over" });
	}
	return { rows, verdict: rows.every((row) => row.verdict === "within") ? "within" : "over" };
}

/** `+500`, `-40`, `0` — a sign on growth only, so a zero delta cannot read as growth. */
function signed(value) {
	return value > 0 ? `+${value}` : String(value);
}

/**
 * The contract line: one `+test/+source <surface> (allowance <n>) — within|over` clause per changed
 * surface, joined by ` · `, with the resolved merge base beside the numbers as provenance (the same
 * head measured against a different base is a different number). The verdict is per surface — a line
 * that reads `within · over` IS an over, and the exit status carries the same answer.
 */
export function formatFlowLine(flow, baseSha) {
	const provenance = ` (base ${String(baseSha).slice(0, 7)})`;
	if (flow.rows.length === 0) return `test-flow: no source or test change — within${provenance}`;
	const parts = flow.rows.map(
		(row) => `${signed(row.test)}/${signed(row.source)} ${row.name} (allowance ${row.allowance}) — ${row.verdict}`,
	);
	return `test-flow: ${parts.join(" · ")}${provenance}`;
}
