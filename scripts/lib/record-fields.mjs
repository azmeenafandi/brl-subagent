// Purpose: The single definition of the review-record fields `merge-guard.sh` parses (issue #487).
//
// Why this file exists: three merged units in a row reached the merge gate in a shape it could not
// read — S4 (#484) had no `jev-recheck:` line, S5 (#485) fused `Risk class:` and `jev-recheck:` onto
// one line, S6 (#486) was a findings bank with no `Verdict:`. The gate was right every time and
// closed every time; the *shape* was authored by prose. So the record became a generated artifact,
// and the field rules live here once: `scripts/review-record.mjs` renders with them, and
// `merge-guard.sh --check-record` checks with them. Two copies of a regex set is how a field drifts
// from its parser, which is the defect this unit exists to remove.
//
// Fidelity is the contract: every function below reproduces what the bash gate ACTUALLY does — front
// decoration stripped, fenced blocks inert, the last line-start field wins, a >=7-hex PREFIX counts
// as the head — including the parts that look odd. A friendlier parser here would accept a record the
// gate rejects, and that is the one failure mode this module must never have.
//
// The CLI that `merge-guard.sh --check-record` runs lives in `scripts/review-record.mjs` (`--check`),
// so this file stays pure: no filesystem, no argv, no exit codes — every rule is a value in and a
// list of named problems out, which is what lets the tests drive it without a subprocess.
//   node scripts/review-record.mjs --check <record> [--pr <n>] [--head <sha>]
//   exit 0 every field rule holds · 1 a named reason failed · 2 usage / unreadable file.
//   No network: (a) CI and (f)'s `recheck-<pr>` provenance row are the full gate's job, and an
//   unmergeable verdict (`changes-requested`) is a merge decision, not a shape fault — it is
//   reported, not failed, because that record is exactly the one a reviewer must be able to write.

/** The field labels, byte-for-byte the ones the gate greps for (each ends with the colon). */
export const FIELD = Object.freeze({
	head: "Reviewed head:",
	supersededHead: "Superseded head:",
	verdict: "Verdict:",
	risk: "Risk class:",
	recheck: "jev-recheck:",
	conductorVerified: "conductor-verified:",
});

/** The closed verdict vocabulary. `approve-with-nits` merges; `changes-requested` does not. */
export const VERDICTS = Object.freeze(["approve", "approve-with-nits", "changes-requested"]);

/** The verdicts a record may carry and still clear the gate. */
export const MERGEABLE_VERDICTS = Object.freeze(["approve", "approve-with-nits"]);

/** What `parseVerdict` returns when the last disposition names two verdicts (an echoed template). */
export const AMBIGUOUS = "ambiguous";

/** Risk tiers. `RISK_RANK` is the gate's ordering — C1 strongest, never inverted. */
export const RISK_CLASSES = Object.freeze(["C1", "C2", "C3"]);
export const RISK_RANK = Object.freeze({ C1: 3, C2: 2, C3: 1 });

/** The recheck line's shape, character for character the gate's `RE_RECHECK`. */
export const RECHECK_RE = /^jev: (off|minimal|low|medium|high|xhigh) \([01](\.[0-9]+)?\) · C[123] · worktree [yn]$/;

/** A head the gate can match: hex, at least the gate's 7 chars, never longer than a sha. */
export const HEAD_RE = /^[0-9a-f]{7,40}$/i;

// The bash primitives, transcribed. `[[:space:]]` in sed/grep is this class, not JS `\s` (which also
// swallows non-breaking spaces the gate would keep).
const SPACE_CHARS = " \\t\\v\\f\\r";
const FENCE_RE = new RegExp("^[" + SPACE_CHARS + "]*(?:```|~~~)");
const DECORATION_RE = new RegExp("^[" + SPACE_CHARS + "#*`]+");
const EDGE_SPACE_RE = new RegExp("^[" + SPACE_CHARS + "]+|[" + SPACE_CHARS + "]+$", "g");
const SHA_TOKEN_RE = /[0-9a-f]{7,40}/gi;
const PR_NUMBER_RE = /^[0-9]+$/;
/** One line with its front decoration (`spaces # * backtick`) stripped — the gate's sed. */
export function stripDecoration(line) {
	return line.replace(DECORATION_RE, "");
}

/**
 * The record's lines with fenced blocks removed — the gate's `in_fence` scan. A line that starts
 * (after spaces) with ``` or ~~~ toggles the fence in either direction, exactly as the gate does.
 */
export function recordLines(text) {
	const lines = [];
	let inFence = false;
	for (const raw of String(text).split("\n")) {
		if (FENCE_RE.test(raw)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) lines.push(raw);
	}
	return lines;
}

/** Every `<label>: value` occurrence outside fences, in document order, values trimmed. */
export function lineFieldAll(text, label) {
	const wanted = label.toLowerCase();
	const found = [];
	for (const raw of recordLines(text)) {
		const stripped = stripDecoration(raw);
		if (!stripped.toLowerCase().startsWith(wanted)) continue;
		found.push(stripped.slice(stripped.indexOf(":") + 1).replace(EDGE_SPACE_RE, ""));
	}
	return found;
}

/** A line-start `<label>: value` field, the last one wins — the gate's `record_line_field`. */
export function lineField(text, label) {
	const found = lineFieldAll(text, label);
	return found.length === 0 ? "" : found[found.length - 1];
}

/**
 * The disposition: the LAST line-start `Verdict:` outside fences, reduced to its leading
 * `[-A-Za-z]` token. `ambiguous` when that line names more than one verdict — fail-closed, never a
 * guess. Empty when the record states no disposition at all.
 */
export function parseVerdict(text) {
	const stated = lineFieldAll(text, FIELD.verdict);
	if (stated.length === 0) return "";
	const rest = stated[stated.length - 1].replace(/^[Vv][Ee][Rr][Dd][Ii][Cc][Tt]:/, "");
	const lower = rest.toLowerCase();
	const named = [
		lower.includes("changes-requested"),
		lower.includes("approve-with-nits"),
		/(^|[^-a-z])approve([^-a-z]|$)/.test(lower),
	].filter(Boolean).length;
	if (named > 1) return AMBIGUOUS;
	const token = /^[A-Za-z][-A-Za-z]*/.exec(rest.replace(/^[^A-Za-z]*/, ""));
	return token === null ? "" : token[0].toLowerCase();
}

/** Does the record name `#<pr>`? `#39` must not match PR 395 — a digit may not follow. */
export function mentionsPr(text, pr) {
	return new RegExp(`#${pr}([^0-9]|$)`).test(String(text));
}

/** Every PR number the record names, in document order. */
export function namedPrs(text) {
	return [...String(text).matchAll(/#([0-9]+)(?![0-9])/g)].map((match) => Number(match[1]));
}

/**
 * The FIRST `>=7`-char hex run in a value — the token a head field or a marker names. `[0-9a-f]{7,40}`
 * with `i`, one definition shared by the reviewed-head rule and the marker rule.
 */
function firstSha(value) {
	const [token] = String(value).match(SHA_TOKEN_RE) ?? [];
	return token === undefined ? "" : token;
}

/** Is `sha` a >=7-char prefix of `head`? Both sides lowercased: a record may write either case. */
function prefixes(sha, head) {
	return String(head).toLowerCase().startsWith(String(sha).toLowerCase());
}

/** `—`, `-`, `:` and spaces separate the marker's sha from its evidence. */
const SEPARATOR_RE = /^[ \t\u2014\u2013:-]+/;

/** Three ASCII LETTERS, not three characters containing one (spec v4 §C). */
const EVIDENCE_LETTER_RE = /[A-Za-z]{3}/;

/**
 * The marker's evidence: after the sha and its separator, at least TWO `[ \t]`-separated tokens, at
 * least one of which carries a three-letter run. `abc` (one token), `ab`, `!!!` and `a!! x` (no
 * three-letter run) all fail; `tsc: clean`, `suite 3296/0 failed` and `suite 90/1798, mutation-proven
 * guard` pass.
 *
 * A FORMAT CHECK, not proof: this cannot show the named command ran, only that the line says what it
 * did. Stated here so nobody reads it as more than it is.
 */
function hasEvidence(value) {
	const tokens = String(value).replace(SEPARATOR_RE, "").split(/[ \t]+/).filter((token) => token !== "");
	return tokens.length >= 2 && tokens.some((token) => EVIDENCE_LETTER_RE.test(token));
}

/**
 * The reviewed head the record STATES, with the source it came from — `""` when it states none.
 *
 * Two of the three accepted shapes (#583, spec v2 §2.1 + v3 §2.2a):
 *   1. an unfenced, line-start `Reviewed head:` field whose FIRST >=7-char hex token prefixes `head`;
 *   2. the documented title form — the record's FIRST line carrying `@ <hex>=7` (unfenced by
 *      construction).
 * A head mentioned anywhere else is neither: prose, a fence, a quoted command or a `Superseded head:`
 * line names a commit without saying the verdict covers it, which is exactly the F01 defect — a prose
 * sentence mentioning the marker cleared an unreviewed head.
 */
export function reviewedHead(text, head) {
	const value = lineField(text, FIELD.head);
	const fieldSha = firstSha(value);
	if (fieldSha !== "" && (head === "" || prefixes(fieldSha, head))) return { source: "field", sha: fieldSha };
	const title = String(text).split("\n")[0];
	const titleMatch = /@[ \t]+([0-9a-f]{7,40})/i.exec(title);
	if (titleMatch !== null && (head === "" || prefixes(titleMatch[1], head))) {
		return { source: "title", sha: titleMatch[1] };
	}
	return "";
}

/**
 * Why a `conductor-verified:` marker does not clear check (d), or `""` when it does — the third
 * accepted shape, and the offline half of the rule the shell gate implements:
 *
 *   1. it is an unfenced, line-start field (the module's own reader, never a regex over the text);
 *   2. its value carries a >=7-char hex token that PREFIXES the PR head — a marker for another commit
 *      is not a marker for this one;
 *   3. after that token and its separator there is evidence (`hasEvidence`).
 *
 * With `head === ""` (the shape-only `--check`) requirement 2 cannot be judged, so only the sha's
 * presence is required. Reasons name WHICH requirement failed, so `head-mismatch` and `missing-head`
 * stay distinguishable to the reader.
 */
export function conductorVerifiedProblem(text, head) {
	const value = lineField(text, FIELD.conductorVerified);
	if (value === "") return "no-marker";
	const sha = firstSha(value);
	if (sha === "") return "no-sha";
	if (head !== "" && !prefixes(sha, head)) return "wrong-sha";
	return hasEvidence(value.slice(value.indexOf(sha) + sha.length)) ? "" : "no-evidence";
}

/** Does the record carry a marker that clears the PR head? The predicate `checkRecord` applies. */
export function hasConductorVerified(text, head = "") {
	return conductorVerifiedProblem(text, head) === "";
}

/** C1 > C2 > C3, `0` for anything else — the gate's `risk_rank`. */
export function riskRank(value) {
	return RISK_RANK[String(value).toUpperCase()] ?? 0;
}

/** The `Cx` a well-formed recheck line classified, or "" — the gate's `${stripped##*· }`. */
export function recheckRisk(line) {
	const text = String(line);
	const tail = text.lastIndexOf(" · worktree ");
	const stripped = tail === -1 ? text : text.slice(0, tail);
	const middle = stripped.lastIndexOf("· ");
	return middle === -1 ? "" : stripped.slice(middle + 2);
}

/** The generator's explicit empty body — a stated absence, not one finding. */
export const NO_FINDINGS = "No findings recorded.";

// A line-start ATX heading naming `Findings`, on the RAW line: the body is verbatim, fences included.
const FINDINGS_HEADING_RE = /^#{1,6}[ \t]*Findings[ \t]*$/i;
// A markdown table's rule row — only pipes, dashes, colons and spaces.
const TABLE_RULE_RE = /^\|?[\s:|-]+\|?$/;
// An ATX heading inside the body (a sub-section, not a finding).
const ATX_RE = /^#{1,6}(\s|$)/;

/**
 * The findings body, verbatim: everything after the LAST `## Findings` heading, fences included (a
 * quoted block in the body is content, not a field), or `[]` when the record has no such heading.
 */
export function findingsBody(text) {
	const lines = String(text).split("\n");
	let start = -1;
	for (let index = 0; index < lines.length; index += 1) {
		if (FINDINGS_HEADING_RE.test(lines[index].trim())) start = index;
	}
	return start === -1 ? [] : lines.slice(start + 1);
}

/**
 * Non-empty, non-header finding lines in the findings body — the ONE definition of "how many
 * findings" (#503), exposed on `parseRecord` so `--check` and `--verify` read the same number
 * instead of each counting for itself. "Header" is the table's own header: the rule row and the row
 * above it; an ATX heading in the body is not a finding either. The generator's
 * `No findings recorded.` is a stated absence and counts zero.
 */
export function countFindings(text) {
	const body = findingsBody(text);
	let count = 0;
	for (let index = 0; index < body.length; index += 1) {
		const line = body[index].trim();
		if (line === "" || line === NO_FINDINGS || ATX_RE.test(line) || TABLE_RULE_RE.test(line)) continue;
		// A gate field line is not a finding: `conductor-verified:` can legally sit in the body (the
		// other four are refused at generation), and counting it inflated `findings` by one.
		if (FIELD.conductorVerified && line.toLowerCase().startsWith(FIELD.conductorVerified)) continue;
		const next = body[index + 1];
		if (next !== undefined && TABLE_RULE_RE.test(next.trim())) continue; // the table's header row
		count += 1;
	}
	return count;
}

/** Everything the gate can read off a record, in one pass. Deterministic, no IO. */
export function parseRecord(text) {
	const recheck = lineField(text, FIELD.recheck);
	return {
		prs: namedPrs(text),
		verdict: parseVerdict(text),
		head: lineField(text, FIELD.head),
		supersededHeads: lineFieldAll(text, FIELD.supersededHead),
		conductorVerified: lineField(text, FIELD.conductorVerified),
		risk: lineField(text, FIELD.risk),
		recheck,
		recheckRisk: recheckRisk(recheck),
		findings: countFindings(text),
	};
}

/** A named reason: `kind` decides the exit code — `usage` is 2 (bad invocation), `refused` is 1. */
function problem(code, message, kind = "refused") {
	return { code, message, kind };
}

function shortHead(head) {
	return head.slice(0, 12);
}

/** How a marker's failure reads in a refusal — one phrase per requirement, so the fix is obvious. */
const MARKER_REASONS = Object.freeze({
	"no-marker": "the record has no unfenced line-start \"conductor-verified:\" line",
	"no-sha": "the \"conductor-verified:\" line carries no >=7-char sha",
	"wrong-sha": "the \"conductor-verified:\" line names another commit",
	"no-evidence": "the \"conductor-verified:\" line carries no evidence after the sha",
});

/**
 * The gate's field rules as named problems, empty when the record satisfies all of them:
 *   (b) it names the PR        (c) one recognised disposition   (d) the reviewed head, or the
 *   `conductor-verified:` marker        (f) recheck shape, declared tier, tier not weaker.
 * `pr` / `head` are optional — omit them for the offline shape check. (f)'s provenance row is NOT
 * here: it needs the local log, so the full `merge-guard.sh` run stays the authority on it.
 *
 * (d) is the #583 rule, identical to the shell gate's: a HEAD is a field, a MARKER is a line with the
 * head AND evidence, and a mention anywhere else (prose, a fence, a quoted command) is neither. Before
 * this, a single prose sentence — `the token \`conductor-verified:\` means nothing here` — cleared any
 * unreviewed head, which is what F01 measured.
 */
export function checkRecord(text, { pr = "", head = "" } = {}) {
	const facts = parseRecord(text);
	const problems = [];

	if (pr === "") {
		if (facts.prs.length === 0) {
			problems.push(problem("missing-pr", 'the record names no PR number — the gate needs a "#<pr>"'));
		}
	} else if (!mentionsPr(text, pr)) {
		problems.push(
			problem("wrong-pr", `the record never mentions #${pr} — it is a verdict for some other PR (or none)`),
		);
	}

	if (facts.verdict === "") {
		problems.push(
			problem(
				"missing-verdict",
				'the record has no line-start "Verdict:" disposition (a bullet, "- Verdict: …", is not decoration: the line must start with the field)',
			),
		);
	} else if (facts.verdict === AMBIGUOUS) {
		problems.push(
			problem(
				"ambiguous-verdict",
				"the record's last line-start disposition names more than one verdict (an echoed template?) — state one disposition",
			),
		);
	} else if (!VERDICTS.includes(facts.verdict)) {
		problems.push(
			problem(
				"unrecognised-verdict",
				`unrecognised verdict "${facts.verdict}" — expected approve, approve-with-nits or changes-requested`,
			),
		);
	}

	// (d) A head is a FIELD, a marker is a LINE with the head AND evidence. Both are read through the
	// module's fence-aware readers, never a whole-text search: that is the F01 defect in one sentence.
	const reviewed = reviewedHead(text, head);
	const markerProblem = conductorVerifiedProblem(text, head);
	if (reviewed === "" && markerProblem !== "") {
		const why = MARKER_REASONS[markerProblem];
		problems.push(
			head === ""
				? problem(
						"missing-head",
						`the record carries no "${FIELD.head} <sha>" line, no title-form "@ <sha>", and no usable "conductor-verified:" line — ${why}`,
					)
				: problem(
						"head-mismatch",
						`the PR head ${shortHead(head)} is not covered — expected an unfenced line-start "${FIELD.head} ${shortHead(head)}…", the title form "# … @ ${shortHead(head)}…", or "conductor-verified: ${shortHead(head)}… — <what was verified and how>" with evidence; ${why} — the reviewed commit and the merge commit differ`,
					),
		);
	}

	if (facts.recheck === "") {
		problems.push(
			problem(
				"missing-recheck",
				'the record has no line-start "jev-recheck:" — run the classifier on the DISPATCH text at review time',
			),
		);
	} else if (!RECHECK_RE.test(facts.recheck)) {
		problems.push(
			problem(
				"malformed-recheck",
				`malformed jev-recheck line "${facts.recheck}" — expected "jev-recheck: jev: <level> (<conf>) · Cx · worktree <y|n>"`,
			),
		);
	}

	if (riskRank(facts.risk) === 0) {
		const state =
			facts.risk === "" ? "the record has no" : `the record's "${facts.risk}" is not a`;
		problems.push(
			problem(
				facts.risk === "" ? "missing-risk" : "malformed-risk",
				`${state} "Risk class: C1|C2|C3" line — the review tier must be stated on a bare line next to the recheck`,
			),
		);
	} else if (RECHECK_RE.test(facts.recheck) && riskRank(facts.risk) < riskRank(facts.recheckRisk)) {
		problems.push(
			problem(
				"risk-weaker-than-recheck",
				`the record declares Risk class ${String(facts.risk).toUpperCase()} but the recheck classified ${facts.recheckRisk} — the review depth understates the risk`,
			),
		);
	}

	return problems;
}

/**
 * The `--verify` head rule: the record must state a head a `record:` line can print and a conductor
 * can compare — 7-40 hex, the generator's own `HEAD_RE`. It is NOT folded into `checkRecord`: the
 * `--check` rules are frozen (#487, #494) and the gate itself accepts a >=7-char prefix, so this is
 * `--verify`'s extra requirement (the U2 artifact's hand-written `Reviewed head:` was 41 chars).
 */
export function checkHeadShape(text) {
	const head = parseRecord(text).head;
	if (head === "") {
		return [
			problem("missing-head", `the record carries no "${FIELD.head} <sha>" line — a record: line needs a head`),
		];
	}
	if (!HEAD_RE.test(head)) {
		return [
			problem(
				"invalid-head",
				`"${FIELD.head} ${head}" is ${String(head).length} characters, not 7-40 hex — that is not a commit sha (the #503/U2 record's 41-character head is this failure)`,
			),
		];
	}
	return [];
}

/**
 * The recheck line's two rules — its shape, and the declared tier that may not be weaker than it.
 *
 * One definition, applied where the line ENTERS the record: the writer resolves the line from the
 * ledger's newest `recheck-<pr>` row and runs this on it before rendering (#596; `--recheck` is gone,
 * so the message names the ledger's printer, not a flag). `checkRecord` applies the same two rules to
 * a written record's copy — a row is not a promise, so the resolved value is validated like any other
 * input.
 */
export function recheckProblems(risk, line) {
	const problems = [];
	if (!RECHECK_RE.test(String(line))) {
		problems.push(
			problem(
				"invalid-recheck",
				`the recheck line must be "jev: <level> (<conf>) · Cx · worktree <y|n>" (resolved "${line}") — print it with: jev-check --classifier '<raw answers>' --label recheck-<pr>`,
				"usage",
			),
		);
		return problems;
	}
	if (riskRank(risk) > 0 && riskRank(risk) < riskRank(recheckRisk(line))) {
		problems.push(
			problem(
				"risk-weaker-than-recheck",
				`declared Risk class ${String(risk).toUpperCase()} is weaker than the recheck's ${recheckRisk(line)} — state the tier the review actually ran at`,
			),
		);
	}
	return problems;
}

/**
 * The generator's pre-flight — the same vocabulary and shape rules the gate applies, run before a
 * byte is written. A shape fault is `usage` (exit 2: fix the invocation); a declared tier weaker than
 * the recheck is `refused` (exit 1: rule (f) caught at authoring time, which is the point).
 *
 * `spec.recheck` is optional here: the writer validates its invocation BEFORE it reads the ledger (a
 * bad `--verdict` must not touch the disk), then runs `recheckProblems` on the line it resolved.
 * Callers that hold a complete spec still get both rules from one pass.
 */
export function validateSpec(spec) {
	const problems = [];
	// A PR number is a positive integer: `0` has no `recheck-0` label to bind and no record path.
	if (!PR_NUMBER_RE.test(String(spec.pr)) || Number(spec.pr) < 1) {
		problems.push(problem("invalid-pr", `--pr must be a PR number (got "${spec.pr}")`, "usage"));
	}
	if (!VERDICTS.includes(spec.verdict)) {
		problems.push(
			problem("invalid-verdict", `--verdict must be one of ${VERDICTS.join(", ")} (got "${spec.verdict}")`, "usage"),
		);
	}
	if (!HEAD_RE.test(spec.head)) {
		problems.push(problem("invalid-head", `--head must be a commit sha, 7-40 hex chars (got "${spec.head}")`, "usage"));
	}
	if (riskRank(spec.risk) === 0) {
		problems.push(problem("invalid-risk", `--risk must be C1, C2 or C3 (got "${spec.risk}")`, "usage"));
	}
	const resolved = spec.recheck ?? "";
	if (resolved !== "") problems.push(...recheckProblems(spec.risk, resolved));
	return problems;
}

/** The canonical values a record is written with: a machine artifact, so one case per field. */
export function canonicalSpec(spec) {
	return {
		pr: String(spec.pr),
		verdict: String(spec.verdict).toLowerCase(),
		head: String(spec.head).toLowerCase(),
		risk: String(spec.risk).toUpperCase(),
		recheck: spec.recheck,
		findings: spec.findings ?? "",
		conductorVerified: spec.conductorVerified ?? "",
		supersededHeads: (spec.supersededHeads ?? []).map((value) => String(value).toLowerCase()),
	};
}

/**
 * The block the gate parses: header, the four bare field lines (`Reviewed head:`, `Verdict:`,
 * `Risk class:`, `jev-recheck:`), the optional supersede chain and `conductor-verified:` marker, then
 * the findings body verbatim. No timestamps and no ordering choice — identical inputs produce
 * identical bytes, which is what makes the golden test a contract rather than a snapshot.
 */
export function renderRecord(spec) {
	const record = canonicalSpec(spec);
	const body = record.findings.replace(/\n+$/, "");
	const lines = [
		`# Review record — PR #${record.pr}`,
		"",
		`${FIELD.head} ${record.head}`,
		...record.supersededHeads.map((head) => `${FIELD.supersededHead} ${head}`),
		`${FIELD.verdict} ${record.verdict}`,
		`${FIELD.risk} ${record.risk}`,
		`${FIELD.recheck} ${record.recheck}`,
	];
	if (record.conductorVerified !== "") lines.push(`${FIELD.conductorVerified} ${record.conductorVerified}`);
	lines.push("", "## Findings", "", body === "" ? "No findings recorded." : body);
	return `${lines.join("\n")}\n`;
}

/**
 * The render→parse round trip. `renderRecord`'s output must read back as the spec it was given: a
 * findings body carrying its own bare `Verdict:` / `Risk class:` / `jev-recheck:` line would silently
 * become the disposition the gate reads. That refusal belongs HERE — at generation time, with the
 * field named — not at the merge point, which is the whole reason the record stopped being prose.
 */
export function verifyRendered(text, spec) {
	const record = canonicalSpec(spec);
	const facts = parseRecord(text);
	const problems = checkRecord(text, { pr: record.pr, head: record.head });
	const comparisons = [
		{ code: "findings-overshadows-verdict", label: FIELD.verdict, read: facts.verdict, wrote: record.verdict },
		{ code: "findings-overshadows-risk", label: FIELD.risk, read: facts.risk, wrote: record.risk },
		{ code: "findings-overshadows-recheck", label: FIELD.recheck, read: facts.recheck, wrote: record.recheck },
		{ code: "findings-overshadows-head", label: FIELD.head, read: facts.head, wrote: record.head },
	];
	for (const comparison of comparisons) {
		if (comparison.read === comparison.wrote) continue;
		problems.push(
			problem(
				comparison.code,
				`the findings body carries its own line-start "${comparison.label}" that the gate reads instead of the recorded field — fence or indent that line, then re-run`,
			),
		);
	}
	return problems;
}
