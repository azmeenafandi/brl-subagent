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
 * Does the record carry the head? The full sha (any case) as a substring, or any 7–40 hex token that
 * is a PREFIX of the head — the gate accepts a short sha, so this must too.
 */
export function mentionsHead(text, head) {
	if (!head) return false;
	const needle = head.toLowerCase();
	const haystack = String(text).toLowerCase();
	if (haystack.includes(needle)) return true;
	for (const token of haystack.match(SHA_TOKEN_RE) ?? []) {
		if (needle.startsWith(token)) return true;
	}
	return false;
}

/** The documented post-verdict-commit marker — the gate greps the whole record, fences included. */
export function hasConductorVerified(text) {
	return /conductor-verified:/i.test(String(text));
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

/**
 * The gate's field rules as named problems, empty when the record satisfies all of them:
 *   (b) it names the PR        (c) one recognised disposition   (d) the reviewed head, or the
 *   `conductor-verified:` marker        (f) recheck shape, declared tier, tier not weaker.
 * `pr` / `head` are optional — omit them for the offline shape check. (f)'s provenance row is NOT
 * here: it needs the local log, so the full `merge-guard.sh` run stays the authority on it.
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

	if (head !== "") {
		if (!mentionsHead(text, head) && !hasConductorVerified(text)) {
			problems.push(
				problem(
					"head-mismatch",
					`the PR head ${shortHead(head)} is not in the record and there is no "conductor-verified:" line — the reviewed commit and the merge commit differ`,
				),
			);
		}
	} else if (facts.head === "" && !hasConductorVerified(text)) {
		problems.push(
			problem("missing-head", `the record carries no "${FIELD.head} <sha>" line and no "conductor-verified:" line`),
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
 * The generator's pre-flight — the same vocabulary and shape rules the gate applies, run before a
 * byte is written. A shape fault is `usage` (exit 2: fix the invocation); a declared tier weaker than
 * the recheck is `refused` (exit 1: rule (f) caught at authoring time, which is the point).
 */
export function validateSpec(spec) {
	const problems = [];
	if (!PR_NUMBER_RE.test(String(spec.pr))) {
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
	if (!RECHECK_RE.test(spec.recheck)) {
		problems.push(
			problem(
				"invalid-recheck",
				`--recheck must be "jev: <level> (<conf>) · Cx · worktree <y|n>" (got "${spec.recheck}")`,
				"usage",
			),
		);
	}
	if (problems.length === 0 && riskRank(spec.risk) < riskRank(recheckRisk(spec.recheck))) {
		problems.push(
			problem(
				"risk-weaker-than-recheck",
				`declared Risk class ${String(spec.risk).toUpperCase()} is weaker than the recheck's ${recheckRisk(spec.recheck)} — state the tier the review actually ran at`,
			),
		);
	}
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
