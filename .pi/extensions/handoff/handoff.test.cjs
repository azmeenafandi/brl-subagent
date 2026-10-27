#!/usr/bin/env node
/**
 * Regression tests for the handoff extension's pure helpers.
 *
 * Run from the cockpit checkout (dev):
 *   node .pi/extensions/handoff/handoff.test.cjs
 *
 * The extension is a pi extension; its pure helpers live in lib.ts and are
 * exported for this script. jiti loads the TypeScript without a build step (the
 * same mechanism the worktree-guard test uses).
 */
const jiti = require("jiti")(__filename);
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const lib = jiti("./lib.ts");
const {
	buildInjection,
	buildStaleness,
	dedupeKey,
	extractStateSection,
	hasInjected,
	isHandoffOwnCommit,
	isHandoffOwnPath,
	isSubagent,
	messageText,
	parseDiffPaths,
	parseRevList,
	parseVerified,
	replaceVerified,
	sameRevision,
	shouldInject,
	shortSha,
	VERIFY_COMMANDS,
} = lib;

let failures = 0;
function check(name, actual, expected) {
	const same = JSON.stringify(actual) === JSON.stringify(expected);
	if (same) {
		console.log(`ok   ${name}`);
	} else {
		failures += 1;
		console.log(`FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
	}
}

const HEAD = "f4e518b08dcbe7dae3fc89e36017b3673be8fa9a";

/**
 * Mirror of `resolveDelta` in index.ts: `git rev-list --parents` for the range,
 * then one `--name-status -M -z` diff per commit, keyed by sha. The walk stops
 * at the first commit that is not the handoff's own. `diffs` values are the raw
 * NUL-separated git output; a missing one stands for a diff that git could not
 * produce.
 */
function deltaFrom(revList, diffs) {
	const commits = [];
	for (const entry of parseRevList(revList)) {
		const commit = { sha: entry.sha, paths: parseDiffPaths(diffs[entry.sha] ?? "") ?? [] };
		commits.push(commit);
		if (!isHandoffOwnCommit(commit)) break;
	}
	return { ancestor: true, commits };
}

console.log("-- extract: §STATE markers");

const full = [
	"# Handoff",
	"",
	"## STATE (2026-10-17, post-compaction)",
	"Verified: f4e518b (2026-10-17)",
	"",
	"- dev @ f4e518b",
	"",
	"## Open items",
	"- none",
].join("\n");
check(
	"heading with a trailing qualifier + body, ending at the next ## heading",
	extractStateSection(full),
	["## STATE (2026-10-17, post-compaction)", "Verified: f4e518b (2026-10-17)", "", "- dev @ f4e518b"].join("\n"),
);
check("no §STATE heading → null", extractStateSection("# Handoff\n\n## Open items\n- none\n"), null);
check(
	"truncated file (no following ## heading) → section runs to EOF",
	extractStateSection("## STATE\nVerified: abc1234\n- dev"),
	"## STATE\nVerified: abc1234\n- dev",
);
check("heading with an empty body keeps the heading only", extractStateSection("## STATE\n\n## Pointers\n"), "## STATE");
check("lowercase heading is accepted", extractStateSection("## state\n- x\n"), "## state\n- x");
check(
	"a ### subheading does not end the section",
	extractStateSection("## STATE\n### Since\n- x\n\n## Next\n"),
	"## STATE\n### Since\n- x",
);

console.log("-- parse: the Verified: line");

check("40-char sha", parseVerified("Verified: f4e518b08dcbe7dae3fc89e36017b3673be8fa9a"), HEAD);
check("short sha with a date suffix", parseVerified("Verified: f4e518b (2026-10-17)"), "f4e518b");
check("backticked sha", parseVerified("Verified: `f4e518b` (2026-10-17)"), "f4e518b");
check("uppercase sha is normalized", parseVerified("Verified: F4E518B"), "f4e518b");
check("absent → null", parseVerified("## STATE\n- dev @ f4e518b\n"), null);
check("non-hex → null", parseVerified("Verified: xyz1234"), null);
check("too short (6 hex) → null", parseVerified("Verified: f4e518"), null);
check("too long (41 hex) → null", parseVerified("Verified: f4e518b08dcbe7dae3fc89e36017b3673be8fa9ab"), null);
check("malformed first line is not skipped for a later valid one", parseVerified("Verified: nope\nVerified: f4e518b"), null);

console.log("-- staleness: match / stale / unverified");

check("short sha matching a full HEAD", buildStaleness("f4e518b", HEAD), {
	status: "current",
	line: "Handoff verified at f4e518b — matches HEAD.",
});
check("full sha matching HEAD", buildStaleness(HEAD, HEAD).status, "current");
check("no Verified line → unverified with the no-line banner", buildStaleness(null, HEAD), {
	status: "unverified",
	line: "Handoff has no Verified: line — verify §STATE against the repo before trusting it.",
});
const stale = buildStaleness("ae7c488", HEAD);
check("divergent sha → stale + RECONCILE", stale.status, "stale");
check("stale banner names both sides", stale.line, "Handoff verified at ae7c488 but HEAD is f4e518b — RECONCILE before trusting §STATE.");
check("unreadable HEAD → unverified, never a false match", buildStaleness("f4e518b", null), {
	status: "unverified",
	line: "Handoff verified at f4e518b but HEAD could not be read — verify §STATE against the repo before trusting it.",
});
check("shortSha leaves short input alone", shortSha("abc1234"), "abc1234");
check("shortSha truncates", shortSha(HEAD), "f4e518b");
check("sameRevision: short vs full", sameRevision("f4e518b", HEAD), true);
check("sameRevision: full vs short", sameRevision(HEAD, "f4e518b"), true);
check("sameRevision: divergent", sameRevision("ae7c488", HEAD), false);
check("sameRevision: missing sides are never a match", [sameRevision(null, HEAD), sameRevision("f4e518b", null), sameRevision("", "")], [false, false, false]);

console.log("-- staleness: ignoring the handoff's own commit (#393)");

// Real shape: `Verified: f1ece22`, then one commit that only writes HANDOFF.md.
const HANDOFF_ONLY = { ancestor: true, commits: [{ sha: "aaaaaaa", paths: [".development/HANDOFF.md"] }] };
check("handoff-only range → current, says it ignored the handoff's own commit", buildStaleness("ae7c488", HEAD, HANDOFF_ONLY), {
	status: "current",
	line: "Handoff verified at ae7c488 — matches HEAD (ignoring the handoff's own commit).",
});
check(
	"an archive-only commit is the handoff's own too",
	buildStaleness("ae7c488", HEAD, {
		ancestor: true,
		commits: [{ sha: "b", paths: [".development/HANDOFF-ARCHIVE-2026-10-17.md"] }],
	}).status,
	"current",
);
check(
	"several handoff-only commits (file + archive) still match",
	buildStaleness("ae7c488", HEAD, {
		ancestor: true,
		commits: [
			{ sha: "b", paths: [".development/HANDOFF.md", ".development/HANDOFF-ARCHIVE-2026-10-16.md"] },
			{ sha: "c", paths: [".development/HANDOFF.md"] },
		],
	}).status,
	"current",
);
check(
	"a merge commit whose resolution adds a foreign file → RECONCILE (#395)",
	buildStaleness(
		"ae7c488",
		HEAD,
		// The first-parent diff carries the resolution AND what the merge brought
		// in. `git log --name-only` printed nothing for the merge itself, so this
		// range used to read as handoff-only (a vacuous `every()` of no paths).
		deltaFrom("mm1 b1 b2\n", { mm1: "A\0.development/HANDOFF.md\0A\0src/merge-fix.ts\0" }),
	),
	{ status: "stale", line: "Handoff verified at ae7c488 but HEAD is f4e518b — RECONCILE before trusting §STATE." },
);

const FOREIGN = { ancestor: true, commits: [{ sha: "f", paths: ["src/runner.ts"] }] };
check("a foreign-file range → RECONCILE, unchanged wording", buildStaleness("ae7c488", HEAD, FOREIGN), {
	status: "stale",
	line: "Handoff verified at ae7c488 but HEAD is f4e518b — RECONCILE before trusting §STATE.",
});
check(
	"mixed range (handoff-only + other commit) → RECONCILE",
	buildStaleness("ae7c488", HEAD, {
		ancestor: true,
		commits: [{ sha: "a", paths: [".development/HANDOFF.md"] }, { sha: "f", paths: ["package.json"] }],
	}).status,
	"stale",
);
check(
	"a commit touching HANDOFF.md AND source → RECONCILE",
	buildStaleness("ae7c488", HEAD, {
		ancestor: true,
		commits: [{ sha: "a", paths: [".development/HANDOFF.md", "src/index.ts"] }],
	}).status,
	"stale",
);
check(
	"a near-miss path is not the handoff's own",
	buildStaleness("ae7c488", HEAD, {
		ancestor: true,
		commits: [{ sha: "a", paths: [".development/HANDOFF.md.bak"] }],
	}).status,
	"stale",
);
check(
	"non-ancestor Verified → RECONCILE even when the range is handoff-only",
	buildStaleness("ae7c488", HEAD, { ancestor: false, commits: [{ sha: "a", paths: [".development/HANDOFF.md"] }] }),
	{ status: "stale", line: "Handoff verified at ae7c488 but HEAD is f4e518b — RECONCILE before trusting §STATE." },
);
check("empty range (Verified == HEAD) → plain match", buildStaleness("ae7c488", "ae7c4880", { ancestor: true, commits: [] }), {
	status: "current",
	line: "Handoff verified at ae7c488 — matches HEAD.",
});
check("an unresolved delta (null) keeps the sha-only verdict", buildStaleness("ae7c488", HEAD, null).status, "stale");
check("no delta at all keeps the sha-only verdict", buildStaleness("ae7c488", HEAD).status, "stale");

console.log("-- parse: the range listing (rev-list --parents)");

// Real shape: one line per commit, newest first — sha, then its parents.
check("one entry per commit, with its parents", parseRevList("mmm1 aaa1 bbb1\nccc1 aaa1\n"), [
	{ sha: "mmm1", parents: ["aaa1", "bbb1"] },
	{ sha: "ccc1", parents: ["aaa1"] },
]);
check("a root commit has no parents", parseRevList("aaa1\n"), [{ sha: "aaa1", parents: [] }]);
check("empty output → no commits (an empty range)", parseRevList(""), []);
check("blank lines and CRLF are tolerated", parseRevList("\r\n aaa1   bbb1 \r\n\n"), [{ sha: "aaa1", parents: ["bbb1"] }]);

console.log("-- parse: one commit's --name-status -M -z diff");

// Real shape: each field NUL-terminated — `STATUS\0path\0`, and two paths for
// a rename/copy (`R100\0old\0new\0`).
check("adds and modifies: one path per record", parseDiffPaths("A\0a.txt\0M\0b.txt\0"), ["a.txt", "b.txt"]);
check("a delete keeps its path", parseDiffPaths("D\0gone.txt\0"), ["gone.txt"]);
check("a rename yields BOTH paths", parseDiffPaths("R100\0src/runner.ts\0.development/HANDOFF.md\0"), [
	"src/runner.ts",
	".development/HANDOFF.md",
]);
check("a scored rename yields both paths", parseDiffPaths("R087\0a.md\0b.md\0"), ["a.md", "b.md"]);
check("a copy yields both paths", parseDiffPaths("C75\0old.md\0new.md\0"), ["old.md", "new.md"]);
check("an empty diff → no paths", parseDiffPaths(""), []);
check("a truncated stream (no final NUL) → null, never a vacuous path list", parseDiffPaths("M\0.development/HANDOFF.md"), null);
check("a truncated rename record → null", parseDiffPaths("R100\0a.md\0b.md"), null);
check("a trailing space is part of the path, never trimmed", parseDiffPaths("A\0.development/HANDOFF.md \0"), [
	".development/HANDOFF.md ",
]);
check("a path with an embedded newline survives", parseDiffPaths("A\0weird\nname.md\0"), ["weird\nname.md"]);
check("an unknown status → null (unparseable)", parseDiffPaths("Q\0a.txt\0"), null);
check("a record with no status → null", parseDiffPaths("nonsense"), null);
check("truncated records → null, never a partial match", ["M\0", "R100\0only-old.txt\0", "A\0a.txt\0M\0"].map(parseDiffPaths), [
	null,
	null,
	null,
]);

console.log("-- ownership: the handoff's own paths");

check("isHandoffOwnPath: the file and its archives", [".development/HANDOFF.md", ".development/HANDOFF-ARCHIVE-2026-10-17.md"].map(isHandoffOwnPath), [true, true]);
check(
	"isHandoffOwnPath: anything else is foreign",
	["src/runner.ts", ".development/HANDOFF.md.bak", ".development/HANDOFF-ARCHIVE-2026-10-17.md/x", "README.md", "HANDOFF.md"].map(
		isHandoffOwnPath,
	),
	[false, false, false, false, false],
);
check("isHandoffOwnPath never trims (a trailing space is another file)", isHandoffOwnPath(".development/HANDOFF.md "), false);
check("isHandoffOwnCommit: a wholly handoff-owned commit", isHandoffOwnCommit({ sha: "a", paths: [".development/HANDOFF.md"] }), true);
check("isHandoffOwnCommit: one foreign path spoils it", isHandoffOwnCommit({ sha: "a", paths: [".development/HANDOFF.md", "src/x.ts"] }), false);
check("isHandoffOwnCommit: no paths is NOT the handoff's own (never vacuous)", isHandoffOwnCommit({ sha: "a", paths: [] }), false);

console.log("-- range → verdict, through the real parsers (#395)");

check("one handoff-only commit → current", buildStaleness("ae7c488", HEAD, deltaFrom("h1 p0\n", { h1: "M\0.development/HANDOFF.md\0" })).status, "current");

// Finding 1a: a foreign file renamed INTO the handoff. A name-only listing shows
// only the destination, so the foreign deletion used to vanish.
const RENAMED_INTO = deltaFrom("r1 p0\n", { r1: "R100\0src/runner.ts\0.development/HANDOFF.md\0" });
check("foreign → HANDOFF.md rename → RECONCILE", buildStaleness("ae7c488", HEAD, RENAMED_INTO).status, "stale");
check("…and the delta still names the foreign side", RENAMED_INTO.commits[0].paths, ["src/runner.ts", ".development/HANDOFF.md"]);
check(
	"HANDOFF.md → foreign rename → RECONCILE",
	buildStaleness("ae7c488", HEAD, deltaFrom("r2 p0\n", { r2: "R100\0.development/HANDOFF.md\0docs/handoff.md\0" })).status,
	"stale",
);

// Finding 2: a path that only LOOKS like the handoff — `-z` tokens are never
// trimmed, so the trailing space keeps it a different file.
check(
	"a path with a trailing space → RECONCILE",
	buildStaleness("ae7c488", HEAD, deltaFrom("s1 p0\n", { s1: "A\0.development/HANDOFF.md \0" })).status,
	"stale",
);

// Never a vacuous match: an empty list is what a failed or unreadable diff looks
// like, so it counts as foreign. Only a non-empty, wholly own list matches.
check("an empty path list → RECONCILE (no vacuous match)", buildStaleness("ae7c488", HEAD, deltaFrom("e1 p0\n", { e1: "" })).status, "stale");
check("a commit with no paths at all → RECONCILE", buildStaleness("ae7c488", HEAD, { ancestor: true, commits: [{ sha: "e2", paths: [] }] }).status, "stale");
check(
	"a diff git could not produce → RECONCILE",
	buildStaleness("ae7c488", HEAD, deltaFrom("e3 p0\n", {})).status,
	"stale",
);
check(
	"an unparseable diff → RECONCILE",
	buildStaleness("ae7c488", HEAD, deltaFrom("u1 p0\n", { u1: "Q\0weird\0" })).status,
	"stale",
);

// The walk stops at the first foreign commit: the verdict cannot improve after
// it, so a long drifted range does not pay for every diff.
check(
	"the walk stops after the first foreign commit",
	deltaFrom("c1 c0\nc2 c1\nc3 c2\n", { c1: "M\0.development/HANDOFF.md\0", c2: "M\0src/x.ts\0", c3: "M\0.development/HANDOFF.md\0" }).commits.length,
	2,
);

console.log("-- guards: subagent / branch / file");

check("a depth marker means subagent", isSubagent({ BRL_SUBAGENT_DEPTH: "1" }), true);
check("an empty depth marker is not a subagent", isSubagent({ BRL_SUBAGENT_DEPTH: "  " }), false);
check("no depth marker is not a subagent", isSubagent({}), false);
check("dev + file + normal process → inject", shouldInject({}, "dev", true), true);
check("a subagent never injects", shouldInject({ BRL_SUBAGENT_DEPTH: "2" }, "dev", true), false);
check("a non-dev branch never injects (worktree)", shouldInject({}, "feat/handoff-mechanism", true), false);
check("a detached HEAD never injects", shouldInject({}, null, true), false);
check("a missing handoff file never injects", shouldInject({}, "dev", false), false);
check("WORKTREE_ROOT-style depth leak cannot pass the branch gate", shouldInject({}, "dev", true) && !shouldInject({}, "dev", false), true);

console.log("-- dedupe: branch entries");

check("dedupeKey is the custom message type", dedupeKey(), "handoff-state");
check("empty branch → not injected", hasInjected([]), false);
const injected = [{ type: "message", message: {} }, { type: "custom_message", customType: "handoff-state", content: "snap A" }];
check("presence-only check finds the snapshot", hasInjected(injected), true);
check("identical content is deduped", hasInjected(injected, "snap A"), true);
check("changed content is NOT deduped (reload after drift)", hasInjected(injected, "snap B"), false);
check("array content is compared by its text parts", hasInjected([{ type: "custom_message", customType: "handoff-state", content: [{ type: "text", text: "snap A" }] }], "snap A"), true);
check("a different customType is ignored", hasInjected([{ type: "custom_message", customType: "other", content: "snap A" }], "snap A"), false);
check("the LAST snapshot decides", hasInjected([...injected, { type: "custom_message", customType: "handoff-state", content: "snap B" }], "snap A"), false);
check("malformed entries are skipped", hasInjected([null, "x", 42], "snap A"), false);
check("messageText joins text parts", messageText([{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }]), "a\nb");

console.log("-- injection composition");

const state = "## STATE\nVerified: f4e518b (2026-10-17)\n- dev @ f4e518b";
const content = buildInjection(buildStaleness("f4e518b", HEAD), state);
check("staleness line comes first", content.startsWith("Handoff verified at f4e518b — matches HEAD.\n\n"), true);
check("§STATE follows the banner", content.endsWith(state), true);

console.log("-- /handoff mark: rewrite the Verified line only");

const doc = [
	"# Handoff",
	"",
	"## STATE",
	"Verified: ae7c488 (2026-10-16)",
	"",
	"- dev @ ae7c488",
	"",
	"## Pointers",
	"Verified: not-state (historical)",
	"",
].join("\n");
const marked = replaceVerified(doc, HEAD, "2026-10-17");
check("rewrites §STATE's line with the full sha + date", marked.includes("Verified: f4e518b08dcbe7dae3fc89e36017b3673be8fa9a (2026-10-17)"), true);
check("does not touch a Verified line outside §STATE", marked.includes("Verified: not-state (historical)"), true);
check("leaves the rest of the document intact", marked.includes("## STATE\nVerified:") && marked.endsWith("## Pointers\nVerified: not-state (historical)\n"), true);
const inserted = replaceVerified("## STATE\n- dev @ f4e518b\n\n## Pointers\n", "f4e518b", "2026-10-17");
check("inserts a Verified line when §STATE has none", inserted, "## STATE\nVerified: f4e518b (2026-10-17)\n- dev @ f4e518b\n\n## Pointers\n");
check("no §STATE → null (never a guessed rewrite)", replaceVerified("# Handoff\n\n## Pointers\n", "f4e518b", "2026-10-17"), null);

console.log("-- verify table: mirrors the reference (handoff.md)");

// The reference table is the source of truth; the constant must not drift from
// it silently. Parse the reference's rows after its own heading (other tables in
// the file have lowercase first cells too, e.g. `| preamble |`).
const reference = readFileSync(join(__dirname, "..", "..", "skills", "handoff", "references", "handoff.md"), "utf8");
const referenceTable = reference.slice(reference.indexOf("## Verify-command table"));
const referenceLabels = referenceTable
	.split("\n")
	.map((line) => /^\|\s*([a-z]+)\s*\|/.exec(line))
	.filter((match) => match !== null)
	.map((match) => match[1]);
const constantLabels = VERIFY_COMMANDS.map((row) => row.split(/\s+/)[0]);

check("the reference table still has 7 claims", referenceLabels.length, 7);
check("one constant row per claim", VERIFY_COMMANDS.length, referenceLabels.length);
check("labels match the reference table, in order", constantLabels, referenceLabels);
const hygiene = VERIFY_COMMANDS.find((row) => row.startsWith("hygiene ")) ?? "";
check(
	"the hygiene row names all three commands",
	["npx tsc --noEmit", "node scripts/docs-arch.mjs", "node scripts/docs-decisions.mjs"].filter((command) => hygiene.includes(command))
		.length,
	3,
);

console.log(failures === 0 ? "\nAll handoff checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
