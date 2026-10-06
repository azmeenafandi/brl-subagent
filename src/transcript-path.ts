// Purpose: The single declaration of the transcript path format — filesystem (`join`) and display (POSIX) forms.
import { join } from "node:path";
import { assertSafeAgentId } from "./sanitize";

/**
 * The transcript directory, relative to the project root. This is the ONE
 * declaration of the format; every other module derives its path from here
 * rather than re-inlining `.pi/output` in a template string (issue #276).
 */
export const TRANSCRIPT_DIR = ".pi/output";

/**
 * Filesystem path to an agent's transcript: `<dir>/agent-<id>.jsonl`.
 *
 * SECURITY (F24): the id is validated through `assertSafeAgentId` BEFORE it
 * reaches `path.join` — join does NOT sanitize `../` or absolute segments, so
 * a traversal id would otherwise escape `dir`. Keep this chokepoint for every
 * filesystem caller (`transcript.ts`, the `get_agent_result` re-export).
 *
 * `dir` is a parameter so `transcript.ts` can forward its mutable test-only
 * `OUTPUT_DIR`; production callers take the `TRANSCRIPT_DIR` default.
 */
export function transcriptPath(agentId: string, dir: string = TRANSCRIPT_DIR): string {
  assertSafeAgentId(agentId);
  return join(dir, `agent-${agentId}.jsonl`);
}

/**
 * Display form of the transcript path: `<TRANSCRIPT_DIR>/agent-<id>.jsonl`,
 * always with forward slashes so the rendered panel is identical on every
 * platform.
 *
 * This is deliberately format-only: it does NOT call `assertSafeAgentId` and
 * must never throw. It is called during TUI rendering (`tui.ts` →
 * `buildOutputHonestyLines`) from a stored run record, where a throw would
 * break the panel. Display text is POSIX while filesystem access uses `join` —
 * the two forms intentionally differ (settled in issue #276).
 */
export function transcriptDisplayPath(agentId: string): string {
  return `${TRANSCRIPT_DIR}/agent-${agentId}.jsonl`;
}
