/**
 * Full-output honesty lines (issue #261).
 *
 * The run-detail view always points at the run's transcript, and discloses the
 * cap when the stored output reached it. These tests pin the two-signal cap
 * detection (the exact `capOutput` truncation notice, plus the byte-length
 * fallback for uncapped records that already sit at/over the cap budget) and
 * the exact transcript path format.
 */
import { describe, expect, it } from "vitest";
import { buildOutputHonestyLines } from "../history";
import {
	capOutput,
	isOutputTruncated,
	OUTPUT_TRUNCATION_SUFFIX,
	LEGACY_OUTPUT_TRUNCATION_SUFFIX,
} from "../sanitize";
import { DEFAULT_OUTPUT_CAP_BYTES } from "../types";

const ID = "11111111-2222-3333-4444-555555555555";
const TRANSCRIPT = `Transcript: .pi/output/agent-${ID}.jsonl`;

function isCapLine(line: string): boolean {
	return line.includes("cap") && line.includes(`.pi/output/agent-${ID}.jsonl`);
}

describe("buildOutputHonestyLines (issue #261)", () => {
	it("always includes the exact transcript path", () => {
		expect(buildOutputHonestyLines({ id: ID }, 100)).toEqual([TRANSCRIPT]);
	});

	it("includes the transcript path even when output is present and under cap", () => {
		const lines = buildOutputHonestyLines({ id: ID, fullOutput: "small output" }, 100);
		expect(lines).toEqual([TRANSCRIPT]);
	});

	it("adds a truncation cap line when the stored output was capped", () => {
		const truncated = capOutput("x".repeat(200), 100);
		const lines = buildOutputHonestyLines({ id: ID, fullOutput: truncated }, 100);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(TRANSCRIPT);
		expect(lines[1]).toContain("truncated");
		expect(lines[1]).toContain("100 B cap");
		expect(lines[1]).toContain(`.pi/output/agent-${ID}.jsonl`);
	});

	it("adds an at/over cap line for an UNCAPPED record at the cap boundary", () => {
		// Exactly capBytes: capOutput leaves this untouched (it truncates only
		// strictly above the cap), so the length fallback — not the notice — fires.
		const exactlyAtCap = "y".repeat(100);
		const lines = buildOutputHonestyLines({ id: ID, fullOutput: exactlyAtCap }, 100);

		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("at or over");
		expect(lines[1]).toContain("100 B cap");
		expect(lines[1]).not.toContain("truncated");
		expect(lines[1]).toContain(`.pi/output/agent-${ID}.jsonl`);
	});

	it("adds a cap line for an uncapped record over the cap", () => {
		const lines = buildOutputHonestyLines({ id: ID, fullOutput: "z".repeat(500) }, 100);
		expect(lines).toHaveLength(2);
		expect(isCapLine(lines[1])).toBe(true);
	});

	it("does not add a cap line when the stored output is under the cap", () => {
		const lines = buildOutputHonestyLines({ id: ID, fullOutput: "y".repeat(99) }, 100);
		expect(lines).toEqual([TRANSCRIPT]);
	});

	it("does not add a cap line for empty/absent output", () => {
		expect(buildOutputHonestyLines({ id: ID, fullOutput: "" }, 0)).toEqual([TRANSCRIPT]);
		expect(buildOutputHonestyLines({ id: ID }, 0)).toEqual([TRANSCRIPT]);
	});

	it("defaults to the 100 KB cap and labels it", () => {
		const over = "x".repeat(DEFAULT_OUTPUT_CAP_BYTES);
		const lines = buildOutputHonestyLines({ id: ID, fullOutput: over });

		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("100 KB cap");
	});

	it("detects a genuinely capped 100 KB output via the truncation notice", () => {
		const capped = capOutput("x".repeat(DEFAULT_OUTPUT_CAP_BYTES + 1));
		const lines = buildOutputHonestyLines({ id: ID, fullOutput: capped });

		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("truncated");
		expect(lines[1]).toContain("100 KB cap");
	});

	it("adds the truncation line for a record capped with the LEGACY suffix (issue #275)", () => {
		// Session files written before the #275 reword persist the old marker.
		// Detection must keep matching it so the honesty line does not silently
		// regress. Asserting "truncated" (rather than "at or over") proves the
		// notice branch fired — the length fallback would also produce a cap line
		// for this long string, so the wording is the discriminator.
		const legacy =
			`${"x".repeat(100)}\n\n[Output truncated: 100B ${LEGACY_OUTPUT_TRUNCATION_SUFFIX}`;
		const lines = buildOutputHonestyLines({ id: ID, fullOutput: legacy }, 100);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(TRANSCRIPT);
		expect(lines[1]).toContain("truncated");
		expect(lines[1]).toContain("100 B cap");
		expect(lines[1]).toContain(`.pi/output/agent-${ID}.jsonl`);
	});

	it("detects a freshly capOutput-capped record as truncated (issue #275)", () => {
		const capped = capOutput("x".repeat(200), 100);

		// The writer emits the current suffix; detection agrees.
		expect(capped.endsWith(OUTPUT_TRUNCATION_SUFFIX)).toBe(true);
		expect(isOutputTruncated(capped)).toBe(true);

		const lines = buildOutputHonestyLines({ id: ID, fullOutput: capped }, 100);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("truncated");
		expect(lines[1]).toContain("100 B cap");
	});
});
