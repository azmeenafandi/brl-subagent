/**
 * Tests for the two generated-docs guards (issues #249, #253) — the pure halves.
 *
 * `docs-arch.mjs` and `docs-decisions.mjs` are a pure function of a tree plus a marker splice:
 * `collect*` reads the records, `render*` builds the block, `replace*` swaps it between the markers.
 * Drift (source edited, block not regenerated) is already caught against the real documents by
 * `src/__tests__/architecture-doc.test.ts` and `src/__tests__/decisions-index.test.ts`, which spawn
 * the CLIs; this file pins the seam those tests cannot reach — that the splice replaces the block
 * and nothing else, and that a document with missing or inverted markers is refused rather than
 * silently rewritten. Deep corpus assertions are deliberately not duplicated here.
 */
import { describe, expect, it } from "vitest";
import {
	BEGIN_MARKER as ARCH_BEGIN,
	END_MARKER as ARCH_END,
	collectModules,
	renderModuleMap,
	replaceModuleMap,
} from "../docs-arch.mjs";
import {
	BEGIN_MARKER as ADR_BEGIN,
	END_MARKER as ADR_END,
	collectDecisions,
	renderAdrIndex,
	replaceAdrIndex,
} from "../docs-decisions.mjs";

describe("collectModules — every shipped module names its purpose", () => {
	it("reads the real tree, sorted, with a non-empty purpose per module", () => {
		const modules = collectModules();
		// Guard the guard: a path change that makes the scan match nothing must not pass.
		expect(modules.length).toBeGreaterThan(30);
		expect(modules.map((module: { file: string }) => module.file)).toEqual(
			[...modules.map((module: { file: string }) => module.file)].sort(),
		);
		expect(modules.filter((module: { purpose: string }) => module.purpose.trim().length === 0)).toEqual([]);
	});
});

describe("renderModuleMap — one row per module between the markers", () => {
	it("renders the block, its count line and both markers", () => {
		const block = renderModuleMap([
			{ file: "a.ts", purpose: "Does A." },
			{ file: "b.ts", purpose: "Does B." },
		]);
		expect(block.startsWith(ARCH_BEGIN)).toBe(true);
		expect(block.endsWith(ARCH_END)).toBe(true);
		expect(block).toContain("| `a.ts` | Does A. |");
		expect(block).toContain("**2 modules** — every one is listed");
	});
});

describe("replaceModuleMap — a splice, never a rewrite", () => {
	it("replaces only the marked block and keeps the prose around it", () => {
		const doc = `# Arch\n\n${ARCH_BEGIN}\nold\n${ARCH_END}\n\nTail prose.\n`;
		const next = replaceModuleMap(doc, `${ARCH_BEGIN}\nnew\n${ARCH_END}`);
		expect(next).toBe(`# Arch\n\n${ARCH_BEGIN}\nnew\n${ARCH_END}\n\nTail prose.\n`);
	});

	it("refuses a document with missing or inverted markers", () => {
		expect(() => replaceModuleMap("# Arch\n", ARCH_BEGIN)).toThrow(/module-map markers not found/);
		expect(() => replaceModuleMap(`${ARCH_END}\n${ARCH_BEGIN}`, "x")).toThrow(/module-map markers not found/);
	});
});

describe("collectDecisions — every record states its metadata", () => {
	it("reads the real decision directory with a number, a title and metadata", () => {
		const decisions = collectDecisions();
		expect(decisions.length).toBeGreaterThan(20);
		expect(decisions.filter((record: { number: string; title: string; status: string; date: string }) =>
			[record.number, record.title, record.status, record.date].some((value) => value.trim().length === 0),
		)).toEqual([]);
	});
});

describe("renderAdrIndex / replaceAdrIndex", () => {
	it("orders the rows by decision number, not by file order", () => {
		const block = renderAdrIndex([
			{ file: "0002-b.md", number: "0002", title: "B", status: "Accepted", date: "2026-01-02" },
			{ file: "0001-a.md", number: "0001", title: "A", status: "Accepted", date: "2026-01-01" },
		]);
		expect(block.indexOf("| 0001 |")).toBeLessThan(block.indexOf("| 0002 |"));
		expect(block).toContain("| 0001 | [A](./0001-a.md) | Accepted | 2026-01-01 |");
		expect(block).toContain("**2 decisions** — every one is listed");
	});

	it("splices between the markers and refuses a document without them", () => {
		const doc = `# Decisions\n\n${ADR_BEGIN}\nold\n${ADR_END}\n`;
		expect(replaceAdrIndex(doc, `${ADR_BEGIN}\nnew\n${ADR_END}`)).toBe(`# Decisions\n\n${ADR_BEGIN}\nnew\n${ADR_END}\n`);
		expect(() => replaceAdrIndex("# Decisions\n", "x")).toThrow(/adr-index markers not found/);
	});
});
