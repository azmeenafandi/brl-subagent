/**
 * Tests for `scripts/audit-scratch-instructions.mjs` (issues #513, #514) — the instruction migration's check.
 *
 * Why an audit and not a grep: a system-temp path in prose is one of three different things, and only one
 * of them is a defect. A bank in `/tmp` is a durable artifact in a filesystem that dies at reboot; a
 * `/tmp` probe repo is exactly where a scratch repo belongs; and "/tmp is refused `ancestor-writable`" is
 * the #512 predicate doing its job. A grep cannot tell them apart, so the tool classifies, prints the rule
 * it applied, and fails closed on anything it cannot read — every case below pins one of those three.
 *
 * ONE CORPUS, THREE DIRECTORIES (#514). The old split — `.pi/skills` gated, the gitignored
 * `.pi/brl-subagent` overrides warn-only — is gone: those presets and templates are tracked now, so a hit
 * there is a fix we own. The cases below are the merged-corpus contract: a hit in ANY of the three
 * directories exits 1, and a directory that is missing or empty is a usage fault (exit 2) rather than a
 * silent "clean" over two thirds of the corpus. The corpus is real directories with real files, and the
 * exit code is asserted through `main`, because the exit code IS the contract.
 *
 * COVERAGE — what these probes do NOT cover, stated rather than implied:
 *  - a path containing whitespace: the mask stops at a space, so the tail of such a path is read as prose.
 *    The failure direction is the safe one (a leftover word is either harmless or a hit) and no corpus
 *    carries one, but it is a bound of the mask rather than a property of it (#520);
 *  - prose that names a temp location with vocabulary outside the classifier's lists (the classifier
 *    fails closed, so the outcome is a hit, but it cannot be enumerated for a corpus that does not exist
 *    yet);
 *  - a line that carries BOTH vocabularies ("a probe scratch dir in /tmp is refused") reads as probe
 *    space, the fail-open direction: the fixtures pin the shapes the corpus carries, not that corner;
 *  - non-Linux paths: `%TEMP%` and `os.tmpdir()` are recognised as spellings, not exercised on a host
 *    that resolves them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	CATEGORIES,
	EXCLUSIONS,
	EXIT,
	ROOT,
	TEMP_PATH,
	TRACKED_CORPUS,
	auditCorpus,
	auditTracked,
	classify,
	collectMarkdown,
	main,
	maskTempPaths,
	parseArgs,
	renderReport,
	scanFile,
} from "../audit-scratch-instructions.mjs";

const BASE = join(ROOT, ".tmp");
mkdirSync(BASE, { recursive: true });
const WORK = mkdtempSync(join(BASE, "audit-scratch-"));
let counter = 0;

afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
});

/** The three corpus directories, by the role each plays in the two cases below. */
const [SKILLS, PRESETS, TEMPLATES] = TRACKED_CORPUS;

/** A checkout-shaped temp root: the three corpus directories, each with one clean file. */
function checkout(files: Record<string, string> = {}, { dirs = TRACKED_CORPUS }: { dirs?: readonly string[] } = {}): string {
	const root = join(WORK, `root-${(counter += 1)}`);
	mkdirSync(root, { recursive: true });
	const defaults: Record<string, string> = {};
	const seeds: Record<string, string> = {
		[SKILLS]: "SKILL.md",
		[PRESETS]: "a-preset.md",
		[TEMPLATES]: "a-template.md",
	};
	for (const dir of dirs) defaults[`${dir}/${seeds[dir]}`] = "# Clean\n\nNo paths here.\n";
	for (const [path, body] of Object.entries({ ...defaults, ...files })) {
		const target = join(root, path);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, body);
	}
	return root;
}

function run(root: string, argv: string[] = []) {
	const out: string[] = [];
	const err: string[] = [];
	const code = main([...argv, "--root", root], { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) });
	return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("audit — the classification is three-way, and printed", () => {
	it("calls a durable artifact a hit, and a probe location or a refusal not a hit", () => {
		expect(classify("", "Bank your state to `/tmp/brl-x-bank.md` before each step.")).toBe(CATEGORIES.ARTIFACT);
		expect(classify("", "Gate A: check stateful claims in scratch repos in /tmp, with real commands.")).toBe(CATEGORIES.PROBE_SCRATCH);
		expect(classify("", "`/tmp` is refused `ancestor-writable` and the message names the default.")).toBe(CATEGORIES.REFUSAL);
	});

	it("reads the previous line too, because a sentence wraps", () => {
		// "scratch" is on the line above; on its own the second line has no probe vocabulary at all.
		expect(classify("  reproduce them in a scratch", "  directory under `/tmp` with real commands.")).toBe(CATEGORIES.PROBE_SCRATCH);
	});

	it("does not inherit a refusal from the line above — the next instruction is still scanned", () => {
		// A refusal is a claim about the path it names, in the same breath. A "never" from the previous
		// sentence must not exempt the line below it, which is how a migrated-then-re-added /tmp bank would
		// otherwise walk through this audit.
		expect(classify("`/tmp` is never the root — too shallow.", "3. bank at /tmp/x.md")).toBe(CATEGORIES.ARTIFACT);
		expect(classify("", "`/tmp` is never the root — too shallow.")).toBe(CATEGORIES.REFUSAL);
		// A refusal keeps its own line even when the line above is a probe: the two are different sentences.
		expect(classify("1. probe in a scratch dir under /tmp", "2. `/tmp` is never the root")).toBe(CATEGORIES.REFUSAL);
	});

	it("prefers probe-scratch over refusal, so 'never' cannot hide a scratch instruction", () => {
		// The regression this pins: refusal-first classified every one of the project-local corpus' probe
		// lines as a boundary, and the audit then named 3 files instead of 7.
		expect(classify("", "scratch repos in `/tmp` — never trust a claim you have not checked")).toBe(CATEGORIES.PROBE_SCRATCH);
	});

	/**
	 * #520 — A PATH IS NOT A WORD. The classifier tests vocabulary, and a filename is not vocabulary; before
	 * the mask, `/tmp/brl-probe-bank.md` made every line that named it read as throwaway space, so the
	 * audit's own fail-closed claim was defeated by a directory name. Each case below is the exact shape the
	 * probe filed, plus the two that must NOT change: a genuine probe-scratch sentence keeps its category
	 * when the word is outside the path.
	 */
	it("does not read a path as a vocabulary hint (#520)", () => {
		// The retired convention's own bank path — durable, and a `probe` in the filename is not a statement.
		expect(classify("", "bank: /tmp/brl-probe-bank.md")).toBe(CATEGORIES.ARTIFACT);
		expect(classify("", "Append your working state to /tmp/brl-probe-bank.md as you work.")).toBe(CATEGORIES.ARTIFACT);
		// The same sentences with the vocabulary OUTSIDE the path keep their categories.
		expect(classify("", "scratch repos in /tmp, real commands")).toBe(CATEGORIES.PROBE_SCRATCH);
		expect(classify("", "Scratch files go under /tmp/probe-519/")).toBe(CATEGORIES.PROBE_SCRATCH);
		// ... and a wrapped sentence still reads across the break, path or no path.
		expect(classify("reproduce them in a scratch", "directory under /tmp")).toBe(CATEGORIES.PROBE_SCRATCH);
	});

	it("masks the path span, not the words around it (#520)", () => {
		expect(maskTempPaths("bank: /tmp/brl-probe-bank.md")).toBe("bank: <temp-path>");
		expect(maskTempPaths("see (/tmp/x/y.md).")).toBe("see (<temp-path>).");
		expect(maskTempPaths("join(os.tmpdir(), 'x')")).toBe("join(<temp-path>, 'x')");
		expect(maskTempPaths("scratch repos in /tmp, real commands")).toBe("scratch repos in <temp-path>, real commands");
	});

	it("recognises the spellings of the same location, and no false positive", () => {
		expect(TEMP_PATH.test("a file in /var/tmp/x.md")).toBe(true);
		expect(TEMP_PATH.test("a file in $TMPDIR/x.md")).toBe(true);
		expect(TEMP_PATH.test("path.join(os.tmpdir(), 'x')")).toBe(true);
		expect(TEMP_PATH.test("`/tmp/brl-bank.md`")).toBe(true);
		// Not a temp path: a longer name that merely starts with the letters, a relative segment, tmpfs.
		expect(TEMP_PATH.test("/tmpdir/notes.md")).toBe(false);
		expect(TEMP_PATH.test("the tmpfs mount check")).toBe(false);
		expect(TEMP_PATH.test("scripts/tmp/x")).toBe(false);
	});

	it("reports a line number, path and text for each mention", () => {
		const root = checkout({ [`${SKILLS}/bank.md`]: "# Bank\n\nok\n\nbank in /tmp/x.md\n" });
		const hits = scanFile(join(root, SKILLS, "bank.md"));
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ line: 5, category: CATEGORIES.ARTIFACT, text: "bank in /tmp/x.md" });
	});
});

describe("audit — the merged corpus gates", () => {
	it("exits 0 on a clean corpus and prints all three directories it read", () => {
		const root = checkout({ [`${SKILLS}/worktree/SKILL.md`]: "# Worktree\n\nbank at `<root>/bank/<label>.md`\n" });
		const result = run(root);
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain("corpus: .pi/skills/**/*.md, .pi/brl-subagent/presets/**/*.md, .pi/brl-subagent/templates/**/*.md (4 file(s))");
		expect(result.out).toContain(join(SKILLS, "worktree", "SKILL.md"));
		expect(result.out).toContain("hits: none");
		expect(result.out).toContain("audit: 0 hit(s) in 4 tracked file(s) — clean");
	});

	it("exits 1 on a hit in EACH directory, naming the file and the category", () => {
		// The merge is the point of #514: none of the three directories is warn-only any more, so a hit in
		// any one of them — including the presets the dispatch reads first — gates the run.
		const root = checkout({
			[`${SKILLS}/impl.md`]: "# Impl\n\nAppend your state to `/tmp/brl-x-bank.md`.\n",
			[`${PRESETS}/project-reviewer.md`]: "# Reviewer\n\nThe record goes to `/tmp/REVIEW_<n>.md`.\n",
			[`${TEMPLATES}/plan-critique.md`]: "# Critique\n\nBank to `/tmp/brl-<label>-bank.md`.\n",
		});
		const result = run(root);
		expect(result.code).toBe(EXIT.HITS);
		expect(result.out).toContain(`hit: ${SKILLS}/impl.md:3 · artifact`);
		expect(result.out).toContain(`hit: ${PRESETS}/project-reviewer.md:3 · artifact`);
		expect(result.out).toContain(`hit: ${TEMPLATES}/plan-critique.md:3 · artifact`);
		expect(result.out).toContain("3 hit(s) in 6 tracked file(s)");
	});

	it("gates a hit in the presets alone — the directory that used to be warn-only", () => {
		const root = checkout({ [`${PRESETS}/project-proposer.md`]: "# Proposer\n\nSave the proposal to /tmp/proposal.md\n" });
		const result = run(root);
		expect(result.code).toBe(EXIT.HITS);
		expect(result.out).toContain(`hit: ${PRESETS}/project-proposer.md:3 · artifact`);
		expect(result.out).toContain("1 hit(s) in 4 tracked file(s)");
	});

	it("prints the probe-space and refusal mentions it did NOT count, so the distinction is not implied", () => {
		const body = "# Skill\n\n1. probe in a scratch dir under /tmp\n2. `/tmp` is never the root\n3. bank at /tmp/x.md\n";
		const root = checkout({ [`${SKILLS}/mixed.md`]: body });
		const result = run(root);
		expect(result.code).toBe(EXIT.HITS);
		expect(result.out).toContain(`ok:  ${SKILLS}/mixed.md:3 · probe-scratch`);
		expect(result.out).toContain(`ok:  ${SKILLS}/mixed.md:4 · refusal`);
		expect(result.out).toContain(`hit: ${SKILLS}/mixed.md:5 · artifact`);
		expect(result.out).toContain("1 hit(s)");
	});

	it("gates the retired convention's own bank path, probe in the filename and all (#520)", () => {
		// The probe's literal reproduction, through the CLI the gate runs: the same two lines the issue filed
		// as exits 0, now hits — a durable bank instruction is not throwaway space because of its name.
		const body = "bank: /tmp/brl-probe-bank.md\n\nAppend your working state to /tmp/brl-probe-bank.md as you work.\n";
		const root = checkout({ [`${TEMPLATES}/bank.md`]: body });
		const result = run(root);
		expect(result.code).toBe(EXIT.HITS);
		expect(result.out).toContain(`hit: ${TEMPLATES}/bank.md:1 · artifact`);
		expect(result.out).toContain(`hit: ${TEMPLATES}/bank.md:3 · artifact`);
		expect(result.out).toContain("2 hit(s)");
	});

	it("prints the exclusions and the rule table with every run", () => {
		const result = run(checkout());
		for (const exclusion of EXCLUSIONS) expect(result.out).toContain(exclusion.path);
		expect(result.out).toContain("history — handoffs, transcripts and investigations quote old paths");
		expect(result.out).toContain("planted strings");
		expect(result.out).toContain("artifact      a durable artifact is placed there");
		expect(result.out).toContain("fails closed");
	});

	it("finds the repository's own corpus clean — the dispatch contract this audit gates", () => {
		// The one case that is about THIS checkout rather than a planted one: #513 migrated every durable
		// artifact path in `.pi/skills/**`, #514 did the same in the tracked project-local contract, and this
		// is the assertion that keeps both so.
		const out: string[] = [];
		const code = main(["--root", ROOT], { out: (line: string) => void out.push(line), err: () => undefined });
		const hits = out.filter((line) => line.startsWith("hit:"));
		expect(hits).toEqual([]);
		expect(code).toBe(EXIT.OK);
		expect(out.join("\n")).toContain("audit: 0 hit(s)");
		// The tracked project-local contract is IN the corpus, not beside it (#514).
		expect(out.join("\n")).toContain(join(PRESETS, "project-reviewer.md"));
		expect(out.join("\n")).toContain(join(TEMPLATES, "plan-critique.md"));
		// The probe-space and refusal mentions that legitimately stay in `/tmp` are printed, not dropped.
		const printed = out.join("\n");
		expect(printed).toContain("ok:  .pi/skills/worktree/references/engineering-bar.md");
		expect(printed).toContain("probe-scratch");
		expect(printed).toContain("refusal");
	});

	it("refuses a missing corpus directory as exit 2, naming the directory", () => {
		// One absent directory is the worktree-of-a-project-without-presets shape: the other two would scan
		// clean and the run would report a corpus it never read.
		const root = checkout({}, { dirs: [SKILLS, TEMPLATES] });
		const result = run(root);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("cannot read the corpus");
		expect(result.err).toContain(PRESETS);
	});

	it("refuses a directory with no .md files — a scan of nothing is not a pass", () => {
		const root = checkout({}, { dirs: [SKILLS] });
		mkdirSync(join(root, PRESETS), { recursive: true });
		mkdirSync(join(root, TEMPLATES), { recursive: true });
		const result = run(root);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("no .md files");
		expect(result.err).toContain(PRESETS);
		expect(result.err).toContain(TEMPLATES);
	});

	it("refuses a root that is not a checkout at all", () => {
		const result = run(join(WORK, "no-such-checkout"));
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("cannot read the corpus");
	});
});

describe("audit — the CLI", () => {
	it("parses the one flag it still has", () => {
		expect(parseArgs([]).options).toMatchObject({ root: ROOT });
		expect(parseArgs(["--root", "/tmp/x"]).options).toMatchObject({ root: "/tmp/x" });
	});

	it("names the removed selectors as a usage error, never as a silent no-op", () => {
		// #514 retired the two-corpus mode: `--overrides` labelled those files "gitignored local overrides",
		// which stopped being true the moment they were tracked. An invocation that still passes it must fail
		// loudly — accepting it and scanning everything anyway would make a stale call look meaningful.
		const root = checkout();
		for (const flag of ["--tracked", "--overrides", "--strict"]) {
			expect(parseArgs([flag]), flag).toMatchObject({ ok: false });
			expect(run(root, [flag]).code, flag).toBe(EXIT.USAGE);
			expect(run(root, [flag]).err, flag).toContain("was removed");
		}
		expect(parseArgs(["--overrides"])).toMatchObject({ ok: false, message: expect.stringContaining("was removed") });
	});

	it("refuses a usage fault as exit 2", () => {
		expect(parseArgs(["--wat"]).ok).toBe(false);
		expect(parseArgs(["--root"]).ok).toBe(false);
		expect(parseArgs(["positional"]).ok).toBe(false);
		expect(main(["--wat"], { out: () => undefined, err: () => undefined })).toBe(EXIT.USAGE);
	});

	it("prints the corpus as paths relative to the root it scanned, not absolute ones", () => {
		const root = checkout();
		const report = auditCorpus(SKILLS, { root });
		expect(report.files).toEqual([join(SKILLS, "SKILL.md")]);
		expect(collectMarkdown(join(root, SKILLS))).toEqual([join(root, SKILLS, "SKILL.md")]);
		const merged = auditTracked({ root });
		expect(merged.files).toHaveLength(3);
		expect(renderReport({ report: merged }).join("\n")).not.toContain(root);
	});
});
