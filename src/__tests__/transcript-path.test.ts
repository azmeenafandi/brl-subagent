/**
 * Transcript path single source (issue #276).
 *
 * `transcript-path.ts` is the one declaration of the `.pi/output/agent-<id>.jsonl`
 * format. These tests pin both halves of that contract: the filesystem form
 * (`transcriptPath`, which must validate the id) and the render-safe display
 * form (`transcriptDisplayPath`, which must never throw).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_DIR, transcriptPath, transcriptDisplayPath } from "../transcript-path";

// Valid-format UUID — assertSafeAgentId only accepts UUIDs.
const UUID = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("transcriptPath (filesystem form)", () => {
	it("returns join('.pi/output', 'agent-<uuid>.jsonl') with the default dir", () => {
		expect(TRANSCRIPT_DIR).toBe(".pi/output");
		expect(transcriptPath(UUID)).toBe(join(".pi/output", `agent-${UUID}.jsonl`));
	});

	it("honours a custom dir override", () => {
		const dir = join("tmp", "custom-output");
		expect(transcriptPath(UUID, dir)).toBe(join(dir, `agent-${UUID}.jsonl`));
	});

	it("throws for a traversal id", () => {
		expect(() => transcriptPath("../../etc/passwd")).toThrow();
	});

	it("throws for an absolute path", () => {
		expect(() => transcriptPath("/tmp/foo")).toThrow();
	});

	it("does not throw for a valid UUID", () => {
		expect(() => transcriptPath(UUID)).not.toThrow();
	});
});

describe("transcriptDisplayPath (render-safe display form)", () => {
	it("returns the POSIX literal with forward slashes", () => {
		expect(transcriptDisplayPath(UUID)).toBe(`.pi/output/agent-${UUID}.jsonl`);
	});

	it("never calls assertSafeAgentId — arbitrary input does not throw", () => {
		// Format-only: the id comes from a stored run record during TUI render,
		// where a throw would break the panel.
		expect(() => transcriptDisplayPath("../../etc/passwd")).not.toThrow();
		expect(() => transcriptDisplayPath("not-a-uuid")).not.toThrow();
		expect(transcriptDisplayPath("not-a-uuid")).toBe(".pi/output/agent-not-a-uuid.jsonl");
	});
});
