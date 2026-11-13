/**
 * Tests for `scripts/audit-scratch-instructions.mjs` (issue #513) — the instruction migration's check.
 *
 * Why an audit and not a grep: a system-temp path in prose is one of three different things, and only one
 * of them is a defect. A bank in `/tmp` is a durable artifact in a filesystem that dies at reboot; a
 * `/tmp` probe repo is exactly where a scratch repo belongs; and "/tmp is refused `ancestor-writable`" is
 * the #512 predicate doing its job. A grep cannot tell them apart, so the tool classifies, prints the rule
 * it applied, and fails closed on anything it cannot read — every case below pins one of those three.
 *
 * The corpora are real directories with real files (a planted bank, a planted probe mention, the seven
 * override paths the ignored corpus carries), and the mode's exit code is asserted through `main`, because
 * the exit code IS the contract: `--tracked` gates, `--overrides` warns unless `--strict`.
 *
 * COVERAGE — what these probes do NOT cover, stated rather than implied:
 *  - a path containing whitespace: the mask stops at a space, so the tail of such a path is read as prose.
 *    The failure direction is the safe one (a leftover word is either harmless or a hit) and no corpus
 *    carries one, but it is a bound of the mask rather than a property of it (#520);
 *  - the ignored override corpus as it exists on THIS machine. The seven files live in the cockpit
 *    checkout and are gitignored, so they are not in a worktree; the probe plants the same seven paths
 *    with the same shapes, and the real run is quoted in the PR body rather than asserted here;
 *  - prose that names a temp location with vocabulary outside the classifier's lists (the classifier
 *    fails closed, so the outcome is a hit, but it cannot be enumerated for a corpus that does not exist
 *    yet);
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
	OVERRIDE_CORPUS,
	ROOT,
	TEMP_PATH,
	TRACKED_CORPUS,
	auditCorpus,
	auditOverrides,
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

/** A checkout-shaped temp root: the tracked corpus and the two override directories, empty. */
function checkout(files: Record<string, string> = {}): string {
	const root = join(WORK, `root-${(counter += 1)}`);
	mkdirSync(root, { recursive: true });
	const defaults = { [`${TRACKED_CORPUS}/SKILL.md`]: "# A skill\n\nNo paths here.\n" };
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
		// The regression this pins: refusal-first classified every one of the ignored overrides' probe
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
		const root = checkout({ [`${TRACKED_CORPUS}/bank.md`]: "# Bank\n\nok\n\nbank in /tmp/x.md\n" });
		const hits = scanFile(join(root, TRACKED_CORPUS, "bank.md"));
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ line: 5, category: CATEGORIES.ARTIFACT, text: "bank in /tmp/x.md" });
	});
});

describe("audit — the tracked corpus gates", () => {
	it("exits 0 on a clean corpus and prints the corpus it read", () => {
		const root = checkout({ [`${TRACKED_CORPUS}/worktree/SKILL.md`]: "# Worktree\n\nbank at `<root>/bank/<label>.md`\n" });
		const result = run(root);
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain("corpus: .pi/skills/**/*.md (2 file(s))");
		expect(result.out).toContain(join(TRACKED_CORPUS, "worktree", "SKILL.md"));
		expect(result.out).toContain("hits: none");
	});

	it("exits 1 on a planted /tmp bank, naming path:line and the category", () => {
		const root = checkout({ [`${TRACKED_CORPUS}/impl.md`]: "# Impl\n\nAppend your state to `/tmp/brl-x-bank.md`.\n" });
		const result = run(root);
		expect(result.code).toBe(EXIT.HITS);
		expect(result.out).toContain(`hit: ${TRACKED_CORPUS}/impl.md:3 · artifact`);
		expect(result.out).toContain("1 hit(s) in 2 tracked file(s)");
	});

	it("prints the probe-space and refusal mentions it did NOT count, so the distinction is not implied", () => {
		const body = "# Skill\n\n1. probe in a scratch dir under /tmp\n2. `/tmp` is never the root\n3. bank at /tmp/x.md\n";
		const root = checkout({ [`${TRACKED_CORPUS}/mixed.md`]: body });
		const result = run(root);
		expect(result.code).toBe(EXIT.HITS);
		expect(result.out).toContain(`ok:  ${TRACKED_CORPUS}/mixed.md:3 · probe-scratch`);
		expect(result.out).toContain(`ok:  ${TRACKED_CORPUS}/mixed.md:4 · refusal`);
		expect(result.out).toContain(`hit: ${TRACKED_CORPUS}/mixed.md:5 · artifact`);
		expect(result.out).toContain("1 hit(s)");
	});

	it("gates the retired convention's own bank path, probe in the filename and all (#520)", () => {
		// The probe's literal reproduction, through the CLI the gate runs: the same two lines the issue filed
		// as exits 0, now hits — a durable bank instruction is not throwaway space because of its name.
		const body = "bank: /tmp/brl-probe-bank.md\n\nAppend your working state to /tmp/brl-probe-bank.md as you work.\n";
		const root = checkout({ [`${TRACKED_CORPUS}/bank.md`]: body });
		const result = run(root);
		expect(result.code).toBe(EXIT.HITS);
		expect(result.out).toContain(`hit: ${TRACKED_CORPUS}/bank.md:1 · artifact`);
		expect(result.out).toContain(`hit: ${TRACKED_CORPUS}/bank.md:3 · artifact`);
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

	it("finds the repository's own tracked corpus clean — the migration this audit shipped with", () => {
		// The one case that is about THIS checkout rather than a planted one: #513 migrated every durable
		// artifact path in `.pi/skills/**` to the private root, and this is the assertion that keeps it so.
		const out: string[] = [];
		const code = main(["--tracked", "--root", ROOT], { out: (line: string) => void out.push(line), err: () => undefined });
		const hits = out.filter((line) => line.startsWith("hit:"));
		expect(hits).toEqual([]);
		expect(code).toBe(EXIT.OK);
		expect(out.join("\n")).toContain("audit: 0 hit(s)");
		// The probe-space and refusal mentions that legitimately stay in `/tmp` are printed, not dropped.
		const printed = out.join("\n");
		expect(printed).toContain("ok:  .pi/skills/worktree/references/engineering-bar.md");
		expect(printed).toContain("probe-scratch");
		expect(printed).toContain("refusal");
	});

	it("refuses an empty corpus — a scan of nothing is not a pass", () => {
		const root = join(WORK, `empty-${(counter += 1)}`);
		mkdirSync(join(root, TRACKED_CORPUS), { recursive: true });
		const result = run(root);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("the corpus is empty");
	});

	it("refuses a missing corpus as exit 2, never as a clean run", () => {
		const result = run(join(WORK, "no-such-checkout"));
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("cannot read the corpus");
	});
});

describe("audit — the ignored overrides are named, warned, and never edited", () => {
	/** The seven paths the ignored corpus carries today, with the shapes it carries them in. */
	const SEVEN: Record<string, string> = {
		[`${OVERRIDE_CORPUS[0]}/adversarial-review.md`]: "Gate A: scratch repos in /tmp, real commands.\n",
		[`${OVERRIDE_CORPUS[0]}/focused-review.md`]: "the conductor names a scratch path — a `/tmp` path.\n",
		[`${OVERRIDE_CORPUS[0]}/plan-critique.md`]: "Append your working state to `/tmp/brl-<label>-bank.md`.\n",
		[`${OVERRIDE_CORPUS[0]}/design-proposal.md`]: "probe for real in a `/tmp` scratch dir or throwaway copy.\n",
		[`${OVERRIDE_CORPUS[1]}/project-reviewer.md`]: "`/tmp/REVIEW_<n>.md` only when the dispatch says `/tmp`.\n",
		[`${OVERRIDE_CORPUS[1]}/project-proposer.md`]: "Scratch experiments live in `/tmp`.\n",
		[`${OVERRIDE_CORPUS[1]}/project-plan-critic.md`]: "scratch experiments in `/tmp`.\n",
	};

	it("names all seven paths, warns, and exits 0", () => {
		const root = checkout(SEVEN);
		const result = run(root, ["--overrides"]);
		expect(result.code).toBe(EXIT.OK);
		for (const path of Object.keys(SEVEN)) expect(result.out).toContain(path);
		expect(result.out).toContain("7 file(s) carry a system-temp location");
		expect(result.out).toContain("NOT modified");
		expect(result.out).toContain("editing a local override is not enforcement");
		expect(result.out).toContain("warn only; pass --strict to gate");
	});

	it("gates under --strict, naming the same paths", () => {
		const root = checkout(SEVEN);
		const result = run(root, ["--overrides", "--strict"]);
		expect(result.code).toBe(EXIT.HITS);
		expect(result.out).toContain("--strict: gated");
		expect(result.out).toContain(OVERRIDE_CORPUS[0]);
	});

	it("does not modify the files it reports", () => {
		const root = checkout(SEVEN);
		const before = Object.entries(SEVEN).map(([path]) => [path, scanFile(join(root, path)).length]);
		run(root, ["--overrides", "--strict"]);
		const after = Object.entries(SEVEN).map(([path]) => [path, scanFile(join(root, path)).length]);
		expect(after).toEqual(before);
	});

	it("says when an override directory is absent instead of failing or inventing hits", () => {
		const root = checkout();
		const report = auditOverrides({ root });
		expect(report.files).toEqual([]);
		expect(report.names).toEqual([]);
		expect(report.notes.map((note) => note.path)).toEqual([...OVERRIDE_CORPUS]);
		const result = run(root, ["--overrides"]);
		// An empty corpus is a usage fault: "--overrides" on a checkout with no overrides cannot be a pass.
		expect(result.code).toBe(EXIT.USAGE);
	});

	it("counts a tracked corpus and an override corpus in one run", () => {
		const root = checkout({ ...SEVEN, [`${TRACKED_CORPUS}/bad.md`]: "bank in /tmp/x.md\n" });
		const result = run(root, ["--tracked", "--overrides"]);
		expect(result.code).toBe(EXIT.HITS); // the tracked hit gates even though overrides warn
		expect(result.out).toContain(`hit: ${TRACKED_CORPUS}/bad.md:1 · artifact`);
		expect(result.out).toContain("7 file(s) carry a system-temp location");
	});
});

describe("audit — the CLI", () => {
	it("defaults to --tracked and parses the documented flags", () => {
		expect(parseArgs([]).options).toMatchObject({ modes: ["tracked"], strict: false });
		expect(parseArgs(["--overrides"]).options).toMatchObject({ modes: ["overrides"] });
		expect(parseArgs(["--tracked", "--overrides", "--strict"]).options).toMatchObject({ modes: ["tracked", "overrides"], strict: true });
	});

	it("refuses a usage fault as exit 2", () => {
		expect(parseArgs(["--wat"]).ok).toBe(false);
		expect(parseArgs(["--strict"]).ok).toBe(false);
		expect(parseArgs(["--root"]).ok).toBe(false);
		expect(parseArgs(["positional"]).ok).toBe(false);
		expect(main(["--strict"], { out: () => undefined, err: () => undefined })).toBe(EXIT.USAGE);
	});

	it("prints the corpus as paths relative to the root it scanned, not absolute ones", () => {
		const root = checkout();
		const report = auditCorpus(TRACKED_CORPUS, { root });
		expect(report.files).toEqual([join(TRACKED_CORPUS, "SKILL.md")]);
		expect(collectMarkdown(join(root, TRACKED_CORPUS))).toEqual([join(root, TRACKED_CORPUS, "SKILL.md")]);
		expect(renderReport({ mode: "tracked", report }).join("\n")).not.toContain(root);
	});
});
