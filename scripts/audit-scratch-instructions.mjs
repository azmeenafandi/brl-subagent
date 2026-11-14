#!/usr/bin/env node
// Purpose: find instructions that send a durable artifact to a system temp directory — in the tracked
// dispatch contract (issues #513, #514).
//
// THE DEFECT. #512 established the private root (`~/.cache/brl-subagent`): 0700, owned by us, refused
// `tmpfs`. The instruction surfaces were not migrated with it, so a conductor reading
// `.pi/skills/worktree/SKILL.md` still told every implementation brief to bank its state in
// `/tmp/brl-<label>-bank.md` — a file that dies at reboot, that a second uid can pre-create, and that
// nobody can attribute. The bank exists precisely so a dropped run can be resumed; a bank on a tmpfs is
// the artifact this migration is about losing.
//
// ONE CORPUS, THREE DIRECTORIES (#514). Before this change there were two modes: the tracked skills
// (gated) and the gitignored `.pi/brl-subagent` overrides (warn-only, because "editing a local override
// is not enforcement"). That second label is now false — since #514 those presets and templates are
// TRACKED, they still take precedence over the shipped copies at dispatch time (an order, not an
// override), and a hit there is ours to fix now. So the corpus is one: `.pi/skills`,
// `.pi/brl-subagent/presets` and `.pi/brl-subagent/templates`, merged into a single report and a single
// exit status. The merge is also visible in the report: a file is listed with the corpus it came from,
// and the verdict counts every file scanned.
//
// THE DISTINCTION, PRINTED. A system-temp path in prose is one of three things, and only the first is a
// hit — the rule table is printed with every run so the distinction is auditable rather than implied:
//   artifact      a durable artifact is being placed there (a bank, a findings file, a report, a record).
//                 It must outlive the run, so `/tmp` is wrong: HIT.
//   refusal       the text says that location is REFUSED (the #512 predicate, quoted or explained). The
//                 mention is documentation of a boundary: not a hit.
//   probe-scratch real scratch for a probe — "scratch repos in /tmp, real commands". It is meant to be
//                 thrown away: not a hit.
// The classifier reads each line with the line before it, because a sentence wraps: the word "scratch"
// that decides the category is often on the previous line. It is deliberately crude and fails CLOSED —
// anything it cannot read as a refusal or as probe space is an `artifact`, so a new durable path cannot
// slip through by using vocabulary nobody taught it.
//
// A PATH IS NOT A WORD (#520). The vocabulary tests run on the line with every system-temp path span masked
// out (`/tmp/probe-519/x.md` → `<temp-path>`), because the words that decide the category are the words of
// the INSTRUCTION — what is being said about the location — and a filename is not a statement about
// anything. Before that mask, `/tmp/brl-probe-bank.md` classified every line naming it as probe space: the
// audit's own fail-closed claim ("anything it cannot read as a refusal or as probe space is an artifact")
// was defeated by a directory name, and the exact convention this cycle retired read as throwaway space.
// The fix is structural, not a denylist: masking removes the ambiguity for every vocabulary word at once,
// so no future filename can supply one. Surrounding prose is kept, which is why a genuine probe-scratch
// sentence — "`scratch` files go under /tmp/probe-519/" — still reads as one: its `scratch` is outside the
// path. The one thing masking makes STRICTER is a line whose only scratch word was inside the path; it is
// now a hit, which is the fail-closed direction and the sentence can be reworded.
//
// Exit: 0 clean · 1 a hit in any of the three directories · 2 usage, or a corpus that cannot be read,
// is missing or is empty (a scan of nothing is not a pass).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — every path below is relative to it, never absolute. */
export const ROOT = join(HERE, "..");

export const EXIT = Object.freeze({ OK: 0, HITS: 1, USAGE: 2 });

/**
 * The tracked corpus: the whole instruction surface a dispatch reads, in three directories —
 * `.pi/skills` (the rituals and references) and the project-local presets and templates that take
 * precedence over the shipped copies at dispatch time. Since #514 all three are tracked, so a hit in
 * any of them is a fix we own and can gate.
 */
export const TRACKED_CORPUS = Object.freeze([
	join(".pi", "skills"),
	join(".pi", "brl-subagent", "presets"),
	join(".pi", "brl-subagent", "templates"),
]);

/**
 * The paths a repository-wide scan WOULD catch and this tool deliberately does not treat as
 * instructions. Printed with every run: a corpus nobody states is a corpus the reader fills in.
 */
export const EXCLUSIONS = Object.freeze([
	Object.freeze({ path: ".development/**", why: "history — handoffs, transcripts and investigations quote old paths" }),
	Object.freeze({ path: "scripts/__tests__/fixtures", why: "planted strings — this audit's own subject matter" }),
	Object.freeze({ path: "CHANGELOG.md", why: "history — a released entry is not an instruction" }),
]);

/** The three categories. Only `artifact` is a hit; the other two are printed so the rule stays auditable. */
export const CATEGORIES = Object.freeze({
	ARTIFACT: "artifact",
	REFUSAL: "refusal",
	PROBE_SCRATCH: "probe-scratch",
});

/**
 * A system-temp path. `/var/tmp` first (so the alternation cannot match its tail), a boundary before the
 * slash so a relative path segment cannot pass for one, and no trailing word character so `/tmpdir` is
 * not `/tmp`. `$TMPDIR`, `%TEMP%` and `os.tmpdir()` are named because they are the same location spelled
 * three other ways — a scan that only knows the literal would miss an instruction written portably.
 */
export const TEMP_PATH = /(?<![\w./-])(?:\/var\/tmp|\/tmp|%TEMP%|\$TMPDIR|os\.tmpdir\(\))(?![\w])/;

/**
 * The same token with the rest of the path it starts: `/tmp/x/y.md`, `$TMPDIR/report.json`, `%TEMP%\a.md`.
 * The run stops at whitespace and at the punctuation that ends a path inside a sentence, so masking removes
 * the path and nothing else. `os.tmpdir()` is a call, not a path, and masks on its own.
 */
const TEMP_PATH_SPAN = /(?<![\w./-])(?:\/var\/tmp|\/tmp|%TEMP%|\$TMPDIR|os\.tmpdir\(\))(?:\/[^\s,;:)\]`'"|*<>]*)?/g;

/** What a masked path reads as, in the words-only text the classifier tests. */
const PATH_PLACEHOLDER = "<temp-path>";

/** The line with every system-temp path replaced by one placeholder — the text the vocabulary tests see. */
export function maskTempPaths(text) {
	return String(text).replace(TEMP_PATH_SPAN, PATH_PLACEHOLDER);
}

/**
 * Probe vocabulary: the line is describing space that is meant to be thrown away. Deliberately narrow —
 * "temporary" and "copy" are left out because they describe durable artifacts at least as often as they
 * describe scratch, and a word that swings both ways is not a classifier.
 */
const SCRATCH_WORDS = /\b(scratch|probes?|probing|throwaway|throw-away|experiments?|experimental)\b/i;

/** Refusal vocabulary: the line is describing a location the mechanism rejects. */
const REFUSAL_WORDS = /\b(refus\w*|never|forbidden|outlawed|banned|is an error|an error rather|not the root|no fallback|cannot be a root|does not survive|dies at reboot)\b/i;

/**
 * The category of one candidate line, read with the line before it. Two decisions, both load-bearing:
 *
 * 1. Scratch BEFORE refusal. "scratch repos in /tmp, real commands — never trust a claim" is a probe
 *    instruction that also says "never", and "probe in a /tmp scratch dir — never in the repo" refuses
 *    the REPOSITORY, not the temp path. Reading refusal first classified both as boundaries and hid every
 *    probe-scratch mention in the project-local corpus, which is why the ignore-side report named three
 *    files where there are seven.
 * 2. The probe/scratch word may be on the PREVIOUS line (sentences wrap: "reproduce them in a scratch" /
 *    "directory under /tmp"), but a REFUSAL must be on the line that names the path — and only when that
 *    line names no probe space. A refusal is a claim about the path made in the same breath; a "never"
 *    inherited from the line above is more often a neighbouring sentence about something else, and
 *    letting it through would exempt the very next instruction from the scan. The one corner this leaves
 *    open is a line carrying BOTH vocabularies ("a probe scratch dir in /tmp is refused"): it reads as
 *    probe space, which is the fail-open direction, and no line in the corpus is shaped that way.
 * 3. Both lines are masked first (#520): a path is not a word, so a vocabulary test never sees one.
 */
export function classify(previous, line) {
	// Mask BOTH sides before any word test — the previous line is tested for probe space, and a path there
	// would supply the word just as readily as a path on this line.
	const current = maskTempPaths(line);
	const before = maskTempPaths(previous);
	const refusal = REFUSAL_WORDS.test(current) && !SCRATCH_WORDS.test(current);
	if (refusal) return CATEGORIES.REFUSAL;
	if (SCRATCH_WORDS.test(`${before}\n${current}`)) return CATEGORIES.PROBE_SCRATCH;
	return CATEGORIES.ARTIFACT;
}

/** Every `.md` below `dir`, recursively, sorted — the corpus is stated, so its size is checkable. */
export function collectMarkdown(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...collectMarkdown(path));
		else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
	}
	return found.sort();
}

/** One file's candidates: `{ path, line, category, text }` per line naming a system-temp location. */
export function scanFile(path) {
	const lines = readFileSync(path, "utf8").split("\n");
	const hits = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (!TEMP_PATH.test(lines[index])) continue;
		hits.push({
			path,
			line: index + 1,
			category: classify(index === 0 ? "" : lines[index - 1], lines[index]),
			text: lines[index].trim(),
		});
	}
	return hits;
}

/** The corpus, its hits, and the non-hits — the last group is printed, never implied. */
export function auditCorpus(dir, { root = ROOT } = {}) {
	const absolute = resolve(root, dir);
	let files;
	try {
		files = collectMarkdown(absolute);
	} catch (error) {
		return { dir, files: [], hits: [], skipped: [], error: `${absolute}: cannot read the corpus (${describe(error)})` };
	}
	const all = files.flatMap((path) => scanFile(path));
	return {
		dir,
		files: files.map((path) => relative(root, path)),
		hits: all.filter((hit) => hit.category === CATEGORIES.ARTIFACT).map((hit) => ({ ...hit, path: relative(root, hit.path) })),
		skipped: all.filter((hit) => hit.category !== CATEGORIES.ARTIFACT).map((hit) => ({ ...hit, path: relative(root, hit.path) })),
		error: null,
	};
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The whole corpus: the three directories scanned and MERGED into one report (#514). A hit in any
 * directory is a hit, and there is no warn-only tier left to distinguish — every directory here is
 * tracked, so every hit is fixable from the repository.
 *
 * A directory that cannot be read, holds no `.md` at all, or is missing entirely is a USAGE fault rather
 * than a pass: it means the corpus the gate claims to cover is not the corpus on disk. That is the same
 * fail-closed rule the empty-corpus check had, applied per directory now that there are three — a wrong
 * path in one of them would otherwise scan two directories and report "clean".
 */
export function auditTracked({ root = ROOT } = {}) {
	const files = [];
	const hits = [];
	const skipped = [];
	const errors = [];
	for (const dir of TRACKED_CORPUS) {
		const report = auditCorpus(dir, { root });
		if (report.error !== null) {
			errors.push(report.error);
			continue;
		}
		if (report.files.length === 0) {
			errors.push(`${join(root, dir)}: no .md files — an empty corpus answers nothing, and a scan of nothing is not a pass`);
			continue;
		}
		files.push(...report.files);
		hits.push(...report.hits);
		skipped.push(...report.skipped);
	}
	return { files, hits, skipped, errors };
}

/** The rule table, printed with every run — the distinction is stated, so a reader can audit a verdict. */
export function rules() {
	return [
		`rule: a line naming a system-temp location is one of three things —`,
		`  ${CATEGORIES.ARTIFACT}      a durable artifact is placed there (bank, findings, report, record): a HIT`,
		`  ${CATEGORIES.REFUSAL}       the text says that location is refused (#512): not a hit`,
		`  ${CATEGORIES.PROBE_SCRATCH} real scratch for a probe, meant to be thrown away: not a hit`,
		"a path is not a word: the temp path itself is masked before the vocabulary is read, so a filename cannot",
		"supply 'probe' or 'scratch' — only the surrounding instruction can",
		"anything the classifier cannot read as a refusal or as probe space is an artifact — it fails closed",
	];
}

function hitLine(hit) {
	return `${hit.path}:${hit.line} · ${hit.category}`;
}

/** The rendered report: corpus, exclusions, rule table, hits, non-hits, verdict — one corpus, one verdict. */
export function renderReport({ report }) {
	const lines = [];
	lines.push(`corpus: ${TRACKED_CORPUS.map((dir) => `${dir}/**/*.md`).join(", ")} (${report.files.length} file(s))`);
	lines.push("  the tracked dispatch contract: the skills, and the project-local presets and templates");
	lines.push("  that take precedence over the shipped copies at dispatch time");
	for (const file of report.files) lines.push(`  ${file}`);
	lines.push(`not in the corpus, and why: ${EXCLUSIONS.map((entry) => `${entry.path} (${entry.why})`).join(" · ")}`);
	lines.push(...rules());
	if (report.hits.length === 0) lines.push("hits: none");
	else for (const hit of report.hits) lines.push(`hit: ${hitLine(hit)} — ${hit.text}`);
	for (const hit of report.skipped) lines.push(`ok:  ${hitLine(hit)} — ${hit.text}`);
	lines.push(
		`audit: ${report.hits.length} hit(s) in ${report.files.length} tracked file(s) — ` +
			(report.hits.length === 0 ? "clean" : "a durable artifact must not live in a system temp directory"),
	);
	return lines;
}

/** `{ ok: true, options }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	const options = { root: ROOT };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--tracked" || argument === "--overrides" || argument === "--strict") {
			return { ok: false, message: `${argument} was removed (#514): there is one corpus now — run the audit bare` };
		}
		if (argument === "--root") {
			const value = argv[index + 1];
			if (value === undefined || value === "") return { ok: false, message: "--root needs a path" };
			options.root = value;
			index += 1;
			continue;
		}
		return { ok: false, message: argument.startsWith("--") ? `unknown flag: ${argument}` : `unexpected argument: ${argument}` };
	}
	return { ok: true, options };
}

export const USAGE = `usage: audit-scratch-instructions.mjs [--root <dir>]

  Scans the tracked dispatch contract — ${TRACKED_CORPUS.join(", ")} —
  as ONE corpus. Any hit exits 1; there is no selector and no warn-only tier (#514).
  --root  the checkout to scan (default: this one)

exit 0 clean · 1 a hit in any corpus directory · 2 usage, or a corpus that is missing or empty`;

/** Run the audit. Returns the exit code; `io.out`/`io.err` are the only sinks. */
export function main(argv = process.argv.slice(2), io = {}) {
	const out = io.out ?? console.log;
	const err = io.err ?? console.error;
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		err(`${USAGE}\n${parsed.message}`);
		return EXIT.USAGE;
	}
	const report = auditTracked({ root: parsed.options.root });
	if (report.errors.length > 0) {
		for (const message of report.errors) err(`audit-scratch-instructions: ${message}`);
		return EXIT.USAGE;
	}
	for (const line of renderReport({ report })) out(line);
	return report.hits.length === 0 ? EXIT.OK : EXIT.HITS;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
