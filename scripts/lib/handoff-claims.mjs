// Purpose: The handoff STATE's claim grammar and the drift verdict — pure, so the verdict is testable
// without a repo, a network or a subprocess (issue #495).
//
// Why the handoff is checked at all: §STATE is injected into every session and after every compaction, so
// a stale claim is not a doc nit — it is a wrong premise the next session starts from. Every
// reconciliation at U1 was mechanical (a stale suite count, a closed issue still in `Open:`, a stale dev
// sha), and a mechanical error belongs to a script, not to prose that the next rewrite can drop again.
//
// This module is the mechanical half: it reads the shapes §STATE promises (and nothing else), compares
// them against facts the caller supplies, and names each drift. It never reads a file, never shells out
// and never writes — `scripts/handoff-verify.mjs` supplies the repo facts behind one probe object, and
// `scripts/__tests__/handoff-verify.test.ts` supplies a stub.
//
// Seven checks, all inside `## STATE` (so prose in `### Since the last handover` / `## Open items` is
// never parsed as a claim):
//   1 verified      `Verified:` is an ancestor of HEAD, and every commit after it touches only the handoff
//                   and its archives — the extension's own rule (`.pi/extensions/handoff/lib.ts`), so the
//                   staleness banner and this check agree by construction.
//   2 dev-sha       `dev @ <sha>` equals the dev CLAIM — `git rev-parse dev` with its trailing handoff commits
//                   walked back (#497), so the handoff commit on top of the merge is not drift (short or full
//                   form, prefix either way).
//   3 install       the `Running install:` path exists; a `dev @ <sha>` on that line equals the same claim.
//   4 open-set      the `Open:` issue set equals `gh issue list --state open` (a `PR #402` mention is not
//                   an issue). `--no-network` skips it — a SKIP is printed, never counted as a pass.
//   5 suite-count   `Suite: N files / M tests` equals the counts in a vitest JSON report, and the
//                   optional `(N passed, M failed, K skipped)` suffix equals the derived breakdown. A RED
//                   report certifies nothing, whatever the totals say: `failed > 0`, `failedSuites > 0`
//                   (a load error fails a file, not an assertion) or `success === false` is `suite-red`.
//   6 modules/adrs  `<n> modules` / `<n> ADRs` equal the repo's own counters (`docs-arch`,
//                   `docs-decisions`).
//   7 file-size     every `` `name.ts` <n> `` claim in STATE equals `wc -l` of that file.
//
// A single-value claim (dev, modules, ADRs) may be STATED MORE THAN ONCE — the shape an edit leaves when
// it adds a line instead of replacing one. Every occurrence is a claim, exactly as for file sizes, so a
// duplicate that agrees is one ✓ and a duplicate that DISAGREES is a named drift, never a silent
// first-wins. (`Open:` is last-wins by the record-fields convention; `Verified:`, the install line and
// `Suite:` are single-line fields.)
//
// OUT OF SCOPE BY DESIGN: narrative claims — the cycle queue, `### Next actions` and the
// `### Since the last handover` bullets. They are prose, and the only mechanical reading of them is a
// guess at which queue item is "current"; a heuristic there would fail closed on a legitimate rewrite,
// which is a worse trade than a human reading three lines. The spec's non-goals say the same.
//
// The drift codes, one per failure mode (the fixtures pin them):
//   verified-missing · verified-not-ancestor · verified-drift
//   dev-claim-missing · dev-sha-drift
//   install-claim-missing · install-missing · install-sha-drift
//   open-claim-missing · open-set-drift
//   suite-claim-missing · suite-count-drift · suite-red
//   modules-missing · modules-drift · adrs-missing · adrs-drift
//   file-missing · file-size-drift

/** "Cannot check" — no report, no `dev` ref, `gh` unavailable, an unreadable input. Exit 2, never drift. */
export class InputError extends Error {}

/** The drift codes, one per failure mode. A test asserts each one is reachable from a fixture. */
export const CODES = Object.freeze({
	verifiedMissing: "verified-missing",
	verifiedNotAncestor: "verified-not-ancestor",
	verifiedDrift: "verified-drift",
	devClaimMissing: "dev-claim-missing",
	devShaDrift: "dev-sha-drift",
	installClaimMissing: "install-claim-missing",
	installMissing: "install-missing",
	installShaDrift: "install-sha-drift",
	openClaimMissing: "open-claim-missing",
	openSetDrift: "open-set-drift",
	suiteClaimMissing: "suite-claim-missing",
	suiteCountDrift: "suite-count-drift",
	suiteRed: "suite-red",
	modulesMissing: "modules-missing",
	modulesDrift: "modules-drift",
	adrsMissing: "adrs-missing",
	adrsDrift: "adrs-drift",
	fileMissing: "file-missing",
	fileSizeDrift: "file-size-drift",
});

const SHA = "[0-9a-f]{7,40}";

/** Two shas name the same commit when one is a prefix of the other — `Verified:` may be short. */
export function sameRevision(left, right) {
	const a = String(left ?? "").toLowerCase();
	const b = String(right ?? "").toLowerCase();
	if (a === "" || b === "") return false;
	return a === b || b.startsWith(a) || a.startsWith(b);
}

/**
 * The paths a commit may touch without moving the tree §STATE describes: the handoff and its archives,
 * byte-for-byte the extension's `HANDOFF_OWN_PATH` (`.pi/extensions/handoff/lib.ts`). No trimming: a path
 * is matched exactly as git reports it, so `.development/HANDOFF.md ` (trailing space) stays foreign.
 */
export function isHandoffOwnPath(path) {
	return /^\.development\/HANDOFF(?:\.md|-ARCHIVE-[^/]+\.md)$/.test(path);
}

/**
 * A commit whose every path belongs to the handoff. A commit with NO paths is NOT handoff-only: an empty
 * list is also what a failed diff looks like, and a vacuous `every()` would report a merge that introduced
 * a foreign file as handoff-only. Same rule as the extension's `isHandoffOwnCommit`.
 */
export function isHandoffOwnCommit(commit) {
	return Array.isArray(commit.paths) && commit.paths.length > 0 && commit.paths.every(isHandoffOwnPath);
}

// ---------------------------------------------------------------------------
// Parsing — the STATE's fixed shapes, and nothing else.
// ---------------------------------------------------------------------------

/**
 * The `## STATE` section's body: from the `## STATE` heading to the next `## ` heading. `null` when the
 * file has no such section, which is a usage fault, not a drift (there is nothing to check).
 */
export function stateSection(text) {
	const lines = String(text).split("\n");
	const start = lines.findIndex((line) => /^##[ \t]+STATE[ \t]*$/.test(line));
	if (start === -1) return null;
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^##[ \t]/.test(lines[index])) {
			end = index;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n");
}

const VERIFIED_RE = new RegExp(`^Verified:[ \\t]*(${SHA})\\b`, "m");
// `dev @ <sha>` at line start, after an optional bullet — the shape of the STATE's dev line. The install
// line's own `dev @ <sha>` is mid-line, so it can never be mistaken for this one.
const DEV_RE = new RegExp(`^[ \\t]*[-*][ \\t]+\\**dev\\**[ \\t]*@[ \\t]*\`?(${SHA})`, "gm");
const INSTALL_LINE_RE = /Running install:/g;
const INSTALL_SHA_RE = new RegExp(`dev[ \\t]*@[ \\t]*\`?(${SHA})`);
// `Open:` as a CLAIM, not as a mention: the write-side vocabulary quotes the field ("the `Open:` list
// against `gh issue list`"), and a backticked field name in prose is not a board claim. Last claim wins,
// the record-fields convention.
const OPEN_RE = /(?<!`)\bOpen:[ \t]*(.+)$/gm;
const SUITE_RE = new RegExp(`\\bSuite:[ \\t]*\\**\\s*(\\d+)[ \\t]+files?[ \\t]*/[ \\t]*\\**\\s*([\\d,]+)`);
// The canonical breakdown suffix — `(N passed, M failed, K skipped)`, immediately after the totals, ASCII
// parentheses, comma+space, in that order (spec v4 §A). `\*{0,2}` tolerates the bold-close `**` of a
// `**3296**` line, the same tolerance SUITE_RE already gives the bold-open, and nothing else: the retired
// prose form `(3295 passed + 1 skipped, **0 failed** — …)` is NOT a claim after this change, so a handoff
// still carrying it is verified by totals only (archived handoffs, `--root <other checkout>`).
const SUITE_BREAKDOWN_RE = /^[ \t]*\*{0,2}[ \t]*\((\d[\d,]*) passed,[ \t]*(\d[\d,]*) failed,[ \t]*(\d[\d,]*) skipped\)/;
// Every occurrence is a claim, so a historical mention must not be one: `18/48 modules import the same
// specifier twice` states a ratio, not a module count, and the `/` before the number is what says so — the
// same exclusions the size regex makes by lookahead.
const MODULES_RE = /(?<![\d/])\b(\d+)[ \t]+modules\b/g;
const ADRS_RE = /(?<![\d/])\b(\d+)[ \t]+ADRs\b/g;
// `` `name.ts` (is) **N** ``, but never a historical shape: `**2,006 → 353**`, `5+/2−`, `(1,429)`
// (a parenthesis breaks the immediate-number rule), or a comparison (`2,249 vs 2,248`, #505). The
// lookahead is what keeps history out of a current-size check. `.ts|.mjs|.sh|.py` because the claim names
// `scripts/` files too — a `.mjs` row the old alternation could not see is a row nothing checked (#583).
// A size claim must CLAIM (#561). Three load-bearing pieces, each measured:
//   - digit-led: `(\d+(?:,\d{3})*)` — a bare comma is not a number (`parseCount(",")` was 0), and an
//     ungrouped integer (`3240`) is still a claim, so grouping is optional but never partial;
//   - indivisible: `(?!\d)(?!,\d)` — no digit and no `,`+digit may follow the token. Without it a
//     terminator lets the token backtrack and `3,240 tests` becomes the claim `3`;
//   - terminated: the number ends the line/section, or is followed by `;` `,` `)` `.` or `lines` — a
//     letter right after it disqualifies it (`2 call sites`, `3,240 tests`).
// Accepted residual (spec §4 R1): a comma or `lines` after a number still claims, so
// `` `a.ts` 3 lines changed `` is read as a size claim — indistinguishable from the legitimate forms.
const SIZE_RE = new RegExp(
	"`((?:[\\w.-]+/)*[\\w.-]+\\.(?:ts|mjs|sh|py))`(?:[ \\t]+is)?[ \\t]*\\*{0,2}(\\d+(?:,\\d{3})*)(?!\\d)(?!,\\d)\\*{0,2}" +
		"(?![\\d,]*[ \\t]*(?:→|->|\\+|/|versus\\b|vs\\b))" +
		"(?=[ \\t]*(?:\\r?\\n|$|[;,).]|lines\\b))",
	"g",
);

/** A number token in the handoff is prose: `2,249` is two thousand two hundred and forty-nine. */
function parseCount(text) {
	return Number(String(text).replace(/,/g, ""));
}

function lastMatch(re, text) {
	let found = null;
	for (const match of text.matchAll(re)) found = match;
	return found;
}

/** Every occurrence of a repeatable claim, in document order — the list a check iterates one by one. */
function allMatches(re, text) {
	return [...text.matchAll(re)].map((match) => match[1]);
}

/**
 * The `Running install:` claim: the line's text, the `<sha>` it states, its path (if any) and its package
 * (if any). A path is an explicit `/…/…`, `~/…/…` or `./…` token — `/reload` is a command, not a path,
 * which is why a token needs a second slash. "this repo" is the checkout the handoff lives in. The
 * `<dev path>` placeholder in the revert recipe names nothing to stat, so it is not a path either.
 */
export function parseInstall(section) {
	const match = lastMatch(INSTALL_LINE_RE, section);
	if (match === null) return null;
	const line = section.slice(match.index).split("\n")[0];
	const shaMatch = INSTALL_SHA_RE.exec(line);
	const packageMatch = /npm:([^\s`]+)/.exec(line);
	let path = null;
	if (/(^|[^\w])this repo\b/.test(line)) {
		path = { kind: "repo" };
	} else {
		for (const token of [...line.matchAll(/`([^`]+)`/g)].map((found) => found[1])) {
			// An absolute token needs a second slash (`/reload` is a command, `/home/x` is a path); `~/` and `./`
			// are paths on their own.
			const slashes = (token.match(/\//g) ?? []).length;
			const pathish = token.startsWith("/") ? slashes >= 2 : /^(?:~\/|\.\/)/.test(token) && slashes >= 1;
			if (pathish && !token.includes("<")) {
				// `~` is expanded here — the module's one ambient read — so `exists()` is handed a path a shell
				// would resolve, instead of reporting a live tree as missing.
				path = { kind: "path", value: token.replace(/^~\//, `${process.env.HOME ?? "~"}/`) };
				break;
			}
		}
	}
	return {
		line,
		sha: shaMatch === null ? null : shaMatch[1],
		path,
		package: packageMatch === null ? null : packageMatch[1],
	};
}

/** The `Open:` issue numbers: `PR #402` is a pull request, not an issue, and is not part of the set. */
export function parseOpen(section) {
	const match = lastMatch(OPEN_RE, section);
	if (match === null) return null;
	const text = match[1].replace(/\bPR[ \t]*#\d+/g, "");
	const numbers = [...text.matchAll(/#(\d+)/g)].map((found) => Number(found[1]));
	return [...new Set(numbers)].sort((left, right) => left - right);
}

/**
 * The `Suite:` claim: the totals always, the breakdown only when the canonical suffix is present. A line
 * with no suffix is a totals-only claim — the shape every archived handoff has — so history keeps
 * verifying; a line with the retired prose form reads the same way, because it is not a claim.
 */
function parseSuite(section, match) {
	const totals = { files: Number(match[1]), tests: parseCount(match[2]) };
	const breakdown = SUITE_BREAKDOWN_RE.exec(section.slice(match.index + match[0].length));
	if (breakdown === null) return totals;
	return {
		...totals,
		passed: parseCount(breakdown[1]),
		failed: parseCount(breakdown[2]),
		skipped: parseCount(breakdown[3]),
	};
}

/**
 * Every mechanical claim §STATE makes, in one pass. An absent claim is `null` — or `[]` for the
 * repeatable ones (`dev`, `modules`, `adrs`, `sizes`), which is a drift too: a mechanical claim that
 * vanished is a claim the next session cannot check. Not an error — the caller decides.
 */
export function parseClaims(text) {
	const section = stateSection(text);
	if (section === null) {
		return { state: null, verified: null, dev: [], install: null, open: null, suite: null, modules: [], adrs: [], sizes: [] };
	}
	const verified = VERIFIED_RE.exec(section);
	const suiteMatch = SUITE_RE.exec(section);
	const sizes = [];
	for (const match of section.matchAll(SIZE_RE)) sizes.push({ name: match[1], lines: parseCount(match[2]) });
	return {
		state: section,
		verified: verified === null ? null : { sha: verified[1] },
		dev: allMatches(DEV_RE, section),
		install: parseInstall(section),
		open: parseOpen(section),
		suite: suiteMatch === null ? null : parseSuite(section, suiteMatch),
		modules: allMatches(MODULES_RE, section).map(Number),
		adrs: allMatches(ADRS_RE, section).map(Number),
		sizes,
	};
}

// ---------------------------------------------------------------------------
// Verdict — claims and facts in, named results out. No IO, no exits.
//
// The probe is the seam the caller fills in:
//   headSha() devSha() devClaimSha() · isAncestor(sha) · commitsAfter(sha) -> [{sha, paths}] · exists(path)
//   lineCount(name) -> {path, lines} | null · modules() · adrs() · openIssues() -> number[]
//   report(expectHead) -> the validated snapshot from scripts/lib/suite-report.mjs | null · root
// `expectHead` is the `Verified:` sha of the handoff being checked — the report that proves a suite claim
// is the one captured at the tree the claim describes, so it is passed in rather than guessed at. The
// snapshot is `{path, files, tests, passed, failed, skipped, failedSuites, firstFailure, success, …}`,
// derived once from the assertion results: check 5 compares it and never re-derives anything.
// Every fact is a function so an unanswerable check fails at its own check, with its own message.
// ---------------------------------------------------------------------------

function pass(claim, detail) {
	return { ok: true, skipped: false, claim, line: `✓ ${detail}` };
}

function drift(code, claim, expected, actual, message) {
	return { ok: false, skipped: false, code, claim, expected, actual, line: `✗ ${code}: ${message}` };
}

function skip(claim, reason) {
	return { ok: true, skipped: true, claim, reason, line: `- ${claim} — skipped (${reason})` };
}

const list = (numbers) => numbers.map((number) => `#${number}`).join(", ");

function short(sha) {
	return String(sha).slice(0, 7);
}

function checkVerified(claims, probe) {
	if (claims.verified === null) {
		return drift(
			CODES.verifiedMissing,
			"Verified: <sha>",
			"a `Verified:` line as the first line of ## STATE",
			"none",
			"the STATE has no `Verified:` line, so §STATE names no tree it describes",
		);
	}
	const { sha } = claims.verified;
	const head = probe.headSha();
	if (!probe.isAncestor(sha)) {
		return drift(
			CODES.verifiedNotAncestor,
			`Verified: ${sha}`,
			`an ancestor of HEAD (${short(head)})`,
			sha,
			`Verified: ${sha} is not an ancestor of HEAD (${short(head)}) — a rebase, an amend or another branch; the extension prints RECONCILE here`,
		);
	}
	const foreign = probe.commitsAfter(sha).filter((commit) => !isHandoffOwnCommit(commit));
	if (foreign.length > 0) {
		const first = foreign[0];
		return drift(
			CODES.verifiedDrift,
			`Verified: ${sha}`,
			`no non-handoff commit on dev after ${sha}`,
			`${foreign.length} such commit(s)`,
			`${short(sha)}..dev has ${foreign.length} commit(s) outside the handoff, first ${short(first.sha)} touching ${first.paths[0] ?? "no path"} — §STATE describes another tree`,
		);
	}
	return pass(`Verified: ${sha}`, `Verified: ${sha} — an ancestor of HEAD; no non-handoff commit on dev after it`);
}

/**
 * A claim stated more than once, appended to the drift sentence: `(the STATE states 58 and 59)`. Without
 * it a disagreeing duplicate would read as a plain mismatch and hide the second line that caused it.
 */
function repeated(values) {
	return values.length < 2 ? "" : ` (the STATE states ${values.join(" and ")})`;
}

/**
 * The dev tip as the two facts checks 2 and 3 need, read ONCE: the ref itself (`devSha`) and the claim
 * resolved from it (`devClaimSha` — the last non-handoff commit, #497). One resolution for both checks, so a
 * `dev @` line and the install line can never be compared against two different tips.
 */
function devTip(probe) {
	return { raw: probe.devSha(), sha: probe.devClaimSha() };
}

/**
 * How a message names the dev tip it compared against. `git rev-parse dev` is a WRONG phrase once a handoff
 * commit sits on top of the merge the claim names — that phrasing was #497's false drift — so the raw ref is
 * only ever named when the two agree.
 */
function devPhrase({ raw, sha }) {
	return raw === sha ? `git rev-parse dev is ${sha}` : `the last non-handoff commit on dev is ${sha}`;
}

/** One result per `dev @ <sha>` line: a duplicate that agrees passes twice, one that disagrees drifts. */
function checkDev(claims, dev) {
	if (claims.dev.length === 0) {
		return [
			drift(
				CODES.devClaimMissing,
				"dev @ <sha>",
				`a dev line naming ${short(dev.sha)}`,
				"none",
				"the STATE has no `dev @ <sha>` line, so the snapshot names no dev tip",
			),
		];
	}
	return claims.dev.map((sha) =>
		sameRevision(sha, dev.sha)
			? pass(`dev @ ${sha}`, `dev @ ${sha} — ${devPhrase(dev)}`)
			: drift(
					CODES.devShaDrift,
					`dev @ ${sha}`,
					dev.sha,
					sha,
					`the STATE claims dev @ ${sha} but ${devPhrase(dev)} — the dev line is a snapshot of another tip${repeated(claims.dev)}`,
				),
	);
}

function checkInstall(claims, probe, dev) {
	if (claims.install === null) {
		return drift(
			CODES.installClaimMissing,
			"Running install: <path>",
			"a `Running install:` line",
			"none",
			"the STATE has no `Running install:` line, so the snapshot names no running install",
		);
	}
	const { install } = claims;
	if (install.path !== null && install.path.kind === "path" && !probe.exists(install.path.value)) {
		return drift(
			CODES.installMissing,
			`Running install: ${install.path.value}`,
			"an existing install path",
			install.path.value,
			`the Running install: path ${install.path.value} does not exist — the install recipe points at a tree that is gone`,
		);
	}
	if (install.sha !== null && !sameRevision(install.sha, dev.sha)) {
		return drift(
			CODES.installShaDrift,
			`Running install: dev @ ${install.sha}`,
			dev.sha,
			install.sha,
			`the Running install: line names dev @ ${install.sha} but ${devPhrase(dev)}`,
		);
	}
	const where =
		install.path === null
			? install.package === null
				? "no path named"
				: `npm:${install.package} (no local path)`
			: install.path.kind === "repo"
				? `this repo (${probe.root})`
				: install.path.value;
	return pass(
		`Running install: ${where}`,
		`Running install: ${where}${install.sha === null ? "" : ` — dev @ ${install.sha}`}`,
	);
}

function checkOpenSet(claims, probe, { noNetwork, injected }) {
	if (claims.open === null) {
		return drift(
			CODES.openClaimMissing,
			"Open: <issues>",
			"an `Open:` line naming the open issues",
			"none",
			"the STATE has no `Open:` line, so the board claim has nowhere to live",
		);
	}
	const claim = `Open: ${list(claims.open)}`;
	if (noNetwork && !injected) return skip(claim, "--no-network: the gh lookup is the only network check");
	const actual = [...new Set(probe.openIssues())].sort((left, right) => left - right);
	const missing = actual.filter((number) => !claims.open.includes(number));
	const extra = claims.open.filter((number) => !actual.includes(number));
	if (missing.length === 0 && extra.length === 0) {
		return pass(claim, `${claim} — ${actual.length} open issue${actual.length === 1 ? "" : "s"} on the board`);
	}
	const reasons = [];
	if (missing.length > 0) reasons.push(`${list(missing)} open and unclaimed`);
	if (extra.length > 0) reasons.push(`${list(extra)} claimed but closed`);
	return drift(
		CODES.openSetDrift,
		claim,
		list(actual),
		list(claims.open),
		`the STATE's ${claim} does not match the board (${list(actual) || "none open"}) — ${reasons.join("; ")}`,
	);
}

/**
 * Check 5. The probe returns the validated snapshot from `scripts/lib/suite-report.mjs`, so every count it
 * needs (`passed`, `failed`, `skipped`, `failedSuites`, `firstFailure`, `success`) is already derived from
 * the assertion results — this function compares, it never re-reads or re-derives.
 *
 * The red predicate is the reason: a report whose results contain a failure, whose FILE failed (a load
 * error writes `success: false`, `numFailedTests: 0` and no failed assertion), or whose own `success` is
 * false cannot certify a green snapshot at ANY total. Only then are the numbers compared, and only then
 * does the claim's optional breakdown get checked — a green report with a wrong breakdown is drift too.
 */
function checkSuite(claims, probe) {
	if (claims.suite === null) {
		return drift(
			CODES.suiteClaimMissing,
			"Suite: <n> files / <n> tests",
			"a `Suite:` line with file and test counts",
			"none",
			"the STATE has no `Suite: N files / M tests` line, so the snapshot names no suite",
		);
	}
	const report = probe.report(claims.verified === null ? "" : claims.verified.sha);
	if (report === null) {
		// "Cannot check" is never a pass: no report means the count has no evidence this run.
		throw new InputError(
			"no vitest JSON report found — capture one with `node scripts/suite-report.mjs --capture`, or pass --report <path>",
		);
	}
	// The provenance travels with the count (#513): a pass line that names only a path lets a report of
	// another tree, or of a dirty one, read as if it were this tree's.
	const provenance = typeof report.label === "string" && report.label !== "" ? ` (${report.label})` : "";
	const breakdown = `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`;
	const expected = `${report.files} file${report.files === 1 ? "" : "s"} / ${report.tests} test${report.tests === 1 ? "" : "s"}`;
	const claim = `Suite: ${claims.suite.files} files / ${claims.suite.tests} tests`;
	// A red run is never evidence of a green snapshot, whatever the totals say. The predicate is THREE
	// terms because vitest has three shapes of red: failed assertions, a failed FILE, and its own verdict
	// (a load error produces no failed assertion at all).
	if (report.failed > 0 || report.failedSuites > 0 || report.success === false) {
		const first = report.firstFailure === "" ? "(none recorded)" : report.firstFailure;
		return drift(
			CODES.suiteRed,
			claim,
			"a green vitest report",
			`${report.failed} failed test(s) in ${report.failedSuites} file(s)`,
			`the vitest report at ${report.path}${provenance} is RED — ${report.failed} failed test(s) in ${report.failedSuites} file(s), first: ${first}; capture a green run`,
		);
	}
	if (report.files === claims.suite.files && report.tests === claims.suite.tests) {
		// The canonical suffix is compared field by field, so a breakdown naming another run is drift even
		// when the totals happen to agree (#583). No suffix → totals only, and no breakdown claim.
		const stated = [
			["passed", claims.suite.passed, report.passed],
			["failed", claims.suite.failed, report.failed],
			["skipped", claims.suite.skipped, report.skipped],
		].filter(([, claimed]) => typeof claimed === "number");
		const disagreed = stated.find(([, claimed, actual]) => claimed !== actual);
		if (disagreed !== undefined) {
			const [field, claimed, actual] = disagreed;
			return drift(
				CODES.suiteCountDrift,
				claim,
				`${expected} (${breakdown})`,
				`${claims.suite.passed} passed, ${claims.suite.failed} failed, ${claims.suite.skipped} skipped`,
				`the STATE's breakdown claims ${field} ${claimed} but the vitest report at ${report.path}${provenance} has ${field} ${actual} — the breakdown names a different run`,
			);
		}
		return pass(claim, `${claim} — the vitest report at ${report.path}${provenance}; ${breakdown}`);
	}
	return drift(
		CODES.suiteCountDrift,
		claim,
		expected,
		`${claims.suite.files} files / ${claims.suite.tests} tests`,
		`the STATE claims ${claims.suite.files} files / ${claims.suite.tests} tests but the vitest report at ${report.path}${provenance} has ${expected}`,
	);
}

/**
 * The shared half of checks 6: each claimed count against the repo's own counter, one named reason each —
 * one result per occurrence, so a repeated claim is checked rather than silently first-wins.
 */
function compareCount(claimed, actual, { label, missingCode, driftCode, source }) {
	if (claimed.length === 0) {
		return [
			drift(
				missingCode,
				`${label}: <n>`,
				`a "${label}" count`,
				"none",
				`the STATE states no ${label} count, so the snapshot names no ${label} total`,
			),
		];
	}
	return claimed.map((value) =>
		value === actual
			? pass(`${value} ${label}`, `${value} ${label} — ${source}`)
			: drift(
					driftCode,
					`${value} ${label}`,
					String(actual),
					String(value),
					`the STATE claims ${value} ${label} but ${source} counts ${actual}${repeated(claimed)}`,
				),
	);
}

function checkModules(claims, probe) {
	return compareCount(claims.modules, probe.modules(), {
		label: "modules",
		missingCode: CODES.modulesMissing,
		driftCode: CODES.modulesDrift,
		source: "docs-arch",
	});
}

function checkAdrs(claims, probe) {
	return compareCount(claims.adrs, probe.adrs(), {
		label: "ADRs",
		missingCode: CODES.adrsMissing,
		driftCode: CODES.adrsDrift,
		source: "docs-decisions",
	});
}

function checkSizes(claims, probe) {
	return claims.sizes.map((size) => {
		const found = probe.lineCount(size.name);
		if (found === null) {
			return drift(
				CODES.fileMissing,
				`${size.name} ${size.lines}`,
				"an existing file",
				`${size.name} not found`,
				`the STATE gives ${size.name} as ${size.lines} lines but there is no such file under src/, scripts/ or the repo root`,
			);
		}
		const claim = `${size.name} ${size.lines}`;
		if (found.lines === size.lines) return pass(claim, `${claim} lines — wc -l ${found.path}`);
		return drift(
			CODES.fileSizeDrift,
			claim,
			`${found.lines} lines`,
			`${size.lines} lines`,
			`the STATE gives ${size.name} as ${size.lines} lines but wc -l ${found.path} is ${found.lines}`,
		);
	});
}

/**
 * Every check, in a fixed order (verified, dev, install, open, suite, modules, adrs, then each file-size
 * claim in the order STATE states them) — the order is what makes two runs print the same bytes.
 */
export function evaluate(claims, probe, options = {}) {
	const context = { noNetwork: options.noNetwork === true, injected: options.issuesInjected === true };
	// One resolution for both dev checks: resolving twice would let a `dev @` line and the install line be
	// compared against tips that moved between them (#497).
	const dev = devTip(probe);
	const results = [
		checkVerified(claims, probe),
		...checkDev(claims, dev),
		checkInstall(claims, probe, dev),
		checkOpenSet(claims, probe, context),
		checkSuite(claims, probe),
		...checkModules(claims, probe),
		...checkAdrs(claims, probe),
		...checkSizes(claims, probe),
	];
	const drifts = results
		.filter((result) => !result.ok)
		.map(({ code, claim, expected, actual }) => ({ code, claim, expected, actual }));
	return { results, drifts };
}
