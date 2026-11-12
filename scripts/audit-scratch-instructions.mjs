#!/usr/bin/env node
// Purpose: find instructions that send a durable artifact to a system temp directory — in the tracked
// skills, and (separately) in the gitignored project-local overrides (issue #513, decision 2.2).
//
// THE DEFECT. #512 established the private root (`~/.cache/brl-subagent`): 0700, owned by us, refused
// `tmpfs`. The instruction surfaces were not migrated with it, so a conductor reading
// `.pi/skills/worktree/SKILL.md` still told every implementation brief to bank its state in
// `/tmp/brl-<label>-bank.md` — a file that dies at reboot, that a second uid can pre-create, and that
// nobody can attribute. The bank exists precisely so a dropped run can be resumed; a bank on a tmpfs is
// the artifact this migration is about losing.
//
// TWO CORPORA, TWO ANSWERS, because they are two different situations:
//   --tracked    `.pi/skills/**/*.md` — TRACKED, so a hit here is ours to fix now. Any hit exits 1, which
//                is what makes this gateable in CI once the corpus is clean.
//   --overrides  `.pi/brl-subagent/{templates,presets}` — GITIGNORED, local, and it takes PRECEDENCE over
//                the shipped text at dispatch time (`src/templates.ts`, `src/presets.ts`). Editing these
//                on someone's machine is not enforcement and this tool never writes them; it NAMES them.
//                Warn by default (exit 0) and `--strict` to gate (exit 1), because a warn-on-every-run
//                check that nobody can fix from the repo is noise, not a gate.
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
// Exit: 0 clean (or warn-only overrides) · 1 hits in a gated corpus · 2 usage, or a missing corpus.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — every path below is relative to it, never absolute. */
export const ROOT = join(HERE, "..");

export const EXIT = Object.freeze({ OK: 0, HITS: 1, USAGE: 2 });

/** The tracked corpus: the instruction surface that ships to contributors. */
export const TRACKED_CORPUS = join(".pi", "skills");

/** The ignored override corpus — two directories, highest priority at dispatch time. */
export const OVERRIDE_CORPUS = [join(".pi", "brl-subagent", "templates"), join(".pi", "brl-subagent", "presets")];

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
 * Probe vocabulary: the line is describing space that is meant to be thrown away. Deliberately narrow —
 * "temporary" and "copy" are left out because they describe durable artifacts at least as often as they
 * describe scratch, and a word that swings both ways is not a classifier.
 */
const SCRATCH_WORDS = /\b(scratch|probes?|probing|throwaway|throw-away|experiments?|experimental)\b/i;

/** Refusal vocabulary: the line is describing a location the mechanism rejects. */
const REFUSAL_WORDS = /\b(refus\w*|never|forbidden|outlawed|banned|is an error|an error rather|not the root|no fallback|cannot be a root|does not survive|dies at reboot)\b/i;

/** Which corpus a run covers. One table so a flag and its report cannot disagree. */
export const MODES = Object.freeze({ TRACKED: "tracked", OVERRIDES: "overrides" });

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The category of one candidate line, read with the line before it. Two decisions, both load-bearing:
 *
 * 1. Scratch BEFORE refusal. "scratch repos in /tmp, real commands — never trust a claim" is a probe
 *    instruction that also says "never", and "probe in a /tmp scratch dir — never in the repo" refuses
 *    the REPOSITORY, not the temp path. Reading refusal first classified both as boundaries and hid every
 *    probe-scratch mention in the ignored corpus, which is why the ignore-side report named three files
 *    where there are seven.
 * 2. The probe/scratch word may be on the PREVIOUS line (sentences wrap: "reproduce them in a scratch" /
 *    "directory under /tmp"), but a REFUSAL must be on the line that names the path — and only when that
 *    line names no probe space. A refusal is a claim about the path made in the same breath; a "never"
 *    inherited from the line above is more often a neighbouring sentence about something else, and
 *    letting it through would exempt the very next instruction from the scan. The one corner this leaves
 *    open is a line carrying BOTH vocabularies ("a probe scratch dir in /tmp is refused"): it reads as
 *    probe space, which is the fail-open direction, and no line in either corpus is shaped that way.
 */
export function classify(previous, line) {
	const refusal = REFUSAL_WORDS.test(line) && !SCRATCH_WORDS.test(line);
	if (refusal) return CATEGORIES.REFUSAL;
	if (SCRATCH_WORDS.test(`${previous}\n${line}`)) return CATEGORIES.PROBE_SCRATCH;
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

/**
 * The override corpus: the same scan over two directories, reported as one corpus — and EVERY mention is
 * named, whatever its category. That is the difference between the two modes and it is deliberate: the
 * tracked corpus distinguishes "an artifact must not live there" from "probe space may", because those are
 * instructions we own and fix. An ignored override is somebody's local dispatch text, every line of it
 * live at dispatch time, and a probe path named there is still a path the run will write to — so the
 * report names all of them and the fix belongs to whoever owns the machine.
 */
export function auditOverrides({ root = ROOT } = {}) {
	const files = [];
	const hits = [];
	const notes = [];
	for (const dir of OVERRIDE_CORPUS) {
		const report = auditCorpus(dir, { root });
		if (report.error !== null) {
			// A missing override directory is normal (most checkouts have none) — said, not failed.
			notes.push({ path: dir, line: 0, category: "absent", text: report.error });
			continue;
		}
		files.push(...report.files);
		hits.push(...report.hits, ...report.skipped);
	}
	const names = [...new Set(hits.map((hit) => hit.path))].sort();
	return { files, hits: hits.sort((left, right) => (left.path === right.path ? left.line - right.line : left.path < right.path ? -1 : 1)), notes, names, error: null };
}

/** The rule table, printed with every run — the distinction is stated, so a reader can audit a verdict. */
export function rules() {
	return [
		`rule: a line naming a system-temp location is one of three things —`,
		`  ${CATEGORIES.ARTIFACT}      a durable artifact is placed there (bank, findings, report, record): a HIT`,
		`  ${CATEGORIES.REFUSAL}       the text says that location is refused (#512): not a hit`,
		`  ${CATEGORIES.PROBE_SCRATCH} real scratch for a probe, meant to be thrown away: not a hit`,
		"anything the classifier cannot read as a refusal or as probe space is an artifact — it fails closed",
	];
}

function hitLine(hit) {
	return `${hit.path}:${hit.line} · ${hit.category}`;
}

/** The rendered report for one mode: corpus, exclusions, rule table, hits, non-hits, verdict. */
export function renderReport({ mode, report, strict = false }) {
	const tracked = mode === MODES.TRACKED;
	const lines = [];
	const corpusPath = tracked ? `${TRACKED_CORPUS}/**/*.md` : OVERRIDE_CORPUS.join(", ");
	const corpusWhy = tracked ? "the tracked instruction surface" : "gitignored local overrides, highest priority at dispatch time";
	lines.push(`corpus: ${corpusPath} (${report.files.length} file(s)) — ${corpusWhy}`);
	for (const file of report.files) lines.push(`  ${file}`);
	lines.push(`not in the corpus, and why: ${EXCLUSIONS.map((entry) => `${entry.path} (${entry.why})`).join(" · ")}`);
	lines.push(...rules());
	for (const note of report.notes ?? []) lines.push(`note: ${note.text}`);
	if (tracked) {
		if (report.hits.length === 0) lines.push("hits: none");
		else for (const hit of report.hits) lines.push(`hit: ${hitLine(hit)} — ${hit.text}`);
		for (const hit of report.skipped) lines.push(`ok:  ${hitLine(hit)} — ${hit.text}`);
		lines.push(
			`audit: ${report.hits.length} hit(s) in ${report.files.length} tracked file(s) — ` +
				(report.hits.length === 0 ? "clean" : "a durable artifact must not live in a system temp directory"),
		);
		return lines;
	}
	for (const hit of report.hits) lines.push(`hit: ${hitLine(hit)} — ${hit.text}`);
	const gated = strict;
	lines.push(
		`audit: ${report.names.length} file(s) carry a system-temp location, named above and NOT modified — ` +
			`editing a local override is not enforcement (${gated ? "--strict: gated" : "warn only; pass --strict to gate"})`,
	);
	return lines;
}

/** `{ ok: true, options }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	const options = { modes: [], strict: false, root: ROOT };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--tracked" || argument === "--overrides") {
			const mode = argument.slice(2);
			if (!options.modes.includes(mode)) options.modes.push(mode);
			continue;
		}
		if (argument === "--strict") {
			options.strict = true;
			continue;
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
	if (options.modes.length === 0) options.modes.push(MODES.TRACKED);
	if (options.strict && !options.modes.includes(MODES.OVERRIDES)) return { ok: false, message: "--strict is --overrides only: the tracked corpus always exits 1 on a hit" };
	return { ok: true, options };
}

export const USAGE = `usage: audit-scratch-instructions.mjs [--tracked] [--overrides [--strict]] [--root <dir>]

  --tracked     scan .pi/skills/**/*.md (default); any hit exits 1
  --overrides   scan .pi/brl-subagent/{templates,presets}; warns (exit 0) unless --strict
  --root        the checkout to scan (default: this one)

exit 0 clean (or warn-only) · 1 hits in a gated corpus · 2 usage, or a missing corpus`;

/** Run the audit. Returns the exit code; `io.out`/`io.err` are the only sinks. */
export function main(argv = process.argv.slice(2), io = {}) {
	const out = io.out ?? console.log;
	const err = io.err ?? console.error;
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		err(`${USAGE}\n${parsed.message}`);
		return EXIT.USAGE;
	}
	const { modes, strict, root } = parsed.options;
	let gatedHits = 0;
	for (const mode of modes) {
		const report = mode === MODES.TRACKED ? auditCorpus(TRACKED_CORPUS, { root }) : auditOverrides({ root });
		if (report.error !== null && report.error !== undefined) {
			err(`audit-scratch-instructions: ${report.error}`);
			return EXIT.USAGE;
		}
		if (report.files.length === 0) {
			err(`audit-scratch-instructions: ${mode}: the corpus is empty — a scan of nothing is not a pass`);
			return EXIT.USAGE;
		}
		for (const line of renderReport({ mode, report, strict })) out(line);
		if (mode === MODES.TRACKED) gatedHits += report.hits.length;
		else if (strict) gatedHits += report.names.length;
	}
	return gatedHits === 0 ? EXIT.OK : EXIT.HITS;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());
