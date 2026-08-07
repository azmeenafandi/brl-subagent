import { join } from 'path';
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'fs';
import type { TranscriptEntry, TranscriptEntryType } from './types';
import { assertSafeAgentId } from './sanitize';

// Output directory — overridable for tests (issue #52): unit tests must NOT
// write into the real repo .pi/ dir; the setter is test-only.
let OUTPUT_DIR = '.pi/output';

/**
 * TEST-ONLY: point the transcript output at an alternate directory.
 * The tests call this in beforeEach to isolate from the real repo .pi/.
 */
export function __setOutputDir(dir: string): void {
  OUTPUT_DIR = dir;
}

/**
 * Ensure output directory exists
 */
function ensureOutputDir(): void {
  // F6 (issue #29): transcripts contain the full subagent conversation — the
  // dir must be owner-only (0o700) so other local users cannot list the files.
  mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Get transcript file path for an agent
 */
export function getTranscriptPath(agentId: string): string {
  // F24: single chokepoint for every transcript file path. All internal callers
  // (startTranscript/appendEntry/getTranscript/completeTranscript) pass
  // generateUUID() ids, but get_agent_result feeds LLM-controlled ids in via
  // getTranscript. path.join does not sanitize "../" or absolute segments, so
  // throw on anything that is not a UUID before it reaches the filesystem.
  assertSafeAgentId(agentId);
  return join(OUTPUT_DIR, `agent-${agentId}.jsonl`);
}

/**
 * Start a new transcript for an agent
 * Creates the file and writes a system entry
 */
export function startTranscript(agentId: string, task: string): string {
  ensureOutputDir();
  const path = getTranscriptPath(agentId);
  
  const entry: TranscriptEntry = {
    type: 'system',
    timestamp: Date.now(),
    content: `Transcript started for agent ${agentId}`,
    metadata: { task },
  };
  
  // F6 (issue #29): transcripts hold the full conversation — append
  // owner-only (0o600) on file CREATE (mode is not retroactive).
  appendFileSync(path, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
  return path;
}

/**
 * Append an entry to an agent's transcript
 */
export function appendEntry(
  agentId: string,
  type: TranscriptEntryType,
  content: string,
  metadata?: Record<string, unknown>
): void {
  const path = getTranscriptPath(agentId);
  if (!existsSync(path)) {
    throw new Error(`Transcript not found for agent ${agentId}`);
  }
  
  const entry: TranscriptEntry = {
    type,
    timestamp: Date.now(),
    content,
    metadata,
  };
  
  // F6 (issue #29): transcripts hold the full conversation — append
  // owner-only (0o600) on file CREATE (mode is not retroactive).
  appendFileSync(path, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Read a transcript for an agent
 */
export function getTranscript(agentId: string): TranscriptEntry[] {
  const path = getTranscriptPath(agentId);
  if (!existsSync(path)) return [];
  
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  return lines.map(line => {
    try {
      return JSON.parse(line) as TranscriptEntry;
    } catch {
      return null;
    }
  }).filter((entry): entry is TranscriptEntry => entry !== null);
}

export function completeTranscript(agentId: string, status: string): void {
  // Issue #53: completeTranscript is settle-path bookkeeping (called from
  // promise callbacks in session-manager/index) and must NEVER throw. The
  // transcript file can legitimately be missing — a spawn that died before
  // startTranscript ran, or a file deleted during cleanup. A throw here
  // escapes the promise callback and becomes an uncaughtException that kills
  // the whole pi process. appendEntry KEEPS its throwing behavior for
  // startTranscript/appendEntry callers (F24: the file must exist before
  // appending — that invariant is load-bearing for caller validation).
  const path = getTranscriptPath(agentId);
  if (!existsSync(path)) {
    console.warn(`[brl-subagent] completeTranscript: transcript missing for agent ${agentId} — skipping completion entry`);
    return;
  }
  appendEntry(agentId, 'system', `Transcript completed: ${status}`);
}
