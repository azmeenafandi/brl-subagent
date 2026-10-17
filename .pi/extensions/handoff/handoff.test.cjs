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
	isSubagent,
	messageText,
	parseVerified,
	replaceVerified,
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
