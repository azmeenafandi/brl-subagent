import { join } from 'path';
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'fs';
import type { TranscriptEntry, TranscriptEntryType } from './types';

// Output directory
const OUTPUT_DIR = '.pi/output';

/**
 * Ensure output directory exists
 */
function ensureOutputDir(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Get transcript file path for an agent
 */
export function getTranscriptPath(agentId: string): string {
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
  
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
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
  
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
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

/**
 * Mark transcript as completed
 */
export function completeTranscript(agentId: string, status: string): void {
  appendEntry(agentId, 'system', `Transcript completed: ${status}`);
}
