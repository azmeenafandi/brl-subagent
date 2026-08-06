import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { unlinkSync } from "fs";
import { startTranscript, completeTranscript, appendEntry, getTranscript } from "../transcript";

describe("transcript completeTranscript (issue #53)", () => {
	// Valid-format UUID constants — assertSafeAgentId only accepts UUIDs.
	const UUID_MISSING = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
	const UUID_PRESENT = "b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

	const transcriptPath = (id: string) =>
		join(process.cwd(), ".pi", "output", `agent-${id}.jsonl`);

	const cleanup = () => {
		for (const id of [UUID_MISSING, UUID_PRESENT]) {
			try { unlinkSync(transcriptPath(id)); } catch { /* ok */ }
		}
	};

	beforeEach(cleanup);
	afterEach(cleanup);

	it("does NOT throw on a never-started agent (regression for #53)", () => {
		// Pre-fix, completeTranscript → appendEntry → existsSync throw became an
		// uncaughtException in the settle-path promise callback (killed pi).
		expect(() => completeTranscript(UUID_MISSING, "completed")).not.toThrow();
	});

	it("still appends the completion entry when the transcript exists", () => {
		startTranscript(UUID_PRESENT, "test task");
		completeTranscript(UUID_PRESENT, "completed");
		const entries = getTranscript(UUID_PRESENT);
		const last = entries[entries.length - 1];
		expect(last.type).toBe("system");
		expect(last.content).toContain("Transcript completed: completed");
	});

	it("still throws for an invalid non-UUID id (F24 preserved)", () => {
		// F24: getTranscriptPath → assertSafeAgentId still rejects traversal ids
		// BEFORE any filesystem access — completeTranscript must not skip it.
		expect(() => completeTranscript("../../etc/passwd", "completed")).toThrow();
	});

	it("appendEntry still throws 'Transcript not found' when the file does not exist (F24 preserved)", () => {
		// Only completeTranscript relaxes the missing-file invariant; appendEntry
		// callers (steer/start) must keep the loud failure.
		expect(() => appendEntry(UUID_PRESENT, "system", "hello")).toThrow("Transcript not found");
	});
});
