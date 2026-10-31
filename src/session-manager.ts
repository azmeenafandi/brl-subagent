// Purpose: Background execution: SDK sessions (`createAgentSession`), agent records, timeouts, steering, and settle paths.
import { randomUUID } from 'crypto';
import { basename, dirname, join, resolve } from 'path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'fs';
import type { Dirent } from 'fs';
import type { BackgroundAgent, AgentStatus, GitMode, RecoveryMode, SubagentResult, SubagentRun, ThinkingLevel, SubagentToolOptions, UsageStats, ErrorCategory } from './types';
import { EMPTY_USAGE, classifyError, classifyTerminalOutcome, isProviderError, coherentFailureReason, SUBAGENT_ABORTED_MESSAGE } from './types';
import { accumulateUsage } from './runner';
import * as eventBus from './event-bus';
import * as transcript from './transcript';
import { createEvent } from './event-bus';
import { assertSafeAgentId, sanitizeErrorMessage } from './sanitize';
import { wrapTask } from './prompt';
import { createLogger } from './logging';
import { getCurrentBranch, getHeadState, restoreHead, createWorkBranch, captureDiff, deleteBranch, hasUncommittedChanges, getRepoRoot, commitAll, captureWorkingDiff } from './git';
import type { HeadState } from './git';
import { normalizeTimeout, DEFAULT_BACKGROUND_DEADLINE_MS } from './validate';
import { currentProcessOwner } from './recovery';
import { persistRunRecord, listInflightRuns, type InflightRun } from './run-registry';
import { isTransportRetryable } from './transport-retry';

const log = createLogger('brl-subagent');
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// Serialize concurrent spawn attempts — pi's API modules aren't safe for
// concurrent access from extensions.
var spawnQueue: Promise<void> = Promise.resolve();

// C2: per-repo locks serializing the FULL gitMode=branch lifecycle (setup →
// settle → teardown). Keyed by the resolved repository root, falling back to
// the cwd path for directories that are not inside a repository — different
// repos don't conflict, but different directories of one repo DO share a
// working tree and must serialize (issue #224).
const gitBranchLocks = new Map<string, Promise<void>>();

/**
 * TEST-ONLY: release every held git branch lock. The lock is normally held
 * for the agent's lifetime (released at settle), but tests that never settle
 * (hanging prompt mocks) would leak it into the next test.
 */
export function __testResetGitBranchLocks(): void {
  gitBranchLocks.clear();
}

// Robust UUID generation with fallback
function generateUUID(): string {
  try {
    return randomUUID();
  } catch {
    // Fallback for contexts where crypto is not available
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

// In-memory store of background agents
const agents = new Map<string, BackgroundAgent>();

// Persistence directory — overridable for tests (issue #52): unit tests must
// NOT write into the real repo .pi/ dir; the setter is test-only.
let STORAGE_DIR = '.pi/subagents';

/**
 * TEST-ONLY: point the agent-record storage at an alternate directory.
 * The tests call this in beforeEach to isolate from the real repo .pi/.
 */
export function __setStorageDir(dir: string): void {
  STORAGE_DIR = dir;
}

/**
 * Ensure storage directory exists
 */
function ensureStorageDir(): void {
  // F6 (issue #29): records hold the full task/result conversation — the dir
  // must be owner-only (0o700) so other local users cannot list the files.
  mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Option B U2 (D1/D2): file-backed background sessions + retention.
//
// Background runs are persisted by the SDK's SessionManager-created files, one
// per-run directory BESIDE the agent records (`.pi/subagents/sessions/<id>/`).
// The directory NAME is the run→file mapping — no new record field is needed,
// and no resume/re-drive/UI logic lives here (that is U3/U4). The per-run dir is
// removed when the run reaches a TERMINAL state; a run marked interrupted (U1's
// boot scan, D3) KEEPS its file until it is resolved by a later unit.
//
// Boundaries (stated once, referenced by the PR): no resume (U4); no UI/notice/
// abandon (U3); background is in-process only; a session file has a single
// writer (the settled run's own process).
//
// D5 measurement (one week of use):
//   du -sh .pi/subagents/sessions
//   find .pi/subagents/sessions -name '*.jsonl' | wc -l
// The expected steady state between runs is EMPTY, plus:
//   - one dir per currently-interrupted run (kept by design, D3), and
//   - up to RETAINED_MAX_DIRS transport-failed dirs bearing the retention
//     marker (issue #404 — bounded by the settle-time sweep, see the #404
//     block below).
// These two classes are the documented exceptions: a session dir whose name is
// NOT one of those is a prune-path regression. Judge by the marker file
// (`.transport-retained`), not by the raw count. There is no runtime metric.
// ---------------------------------------------------------------------------

/** Subdirectory of the agent-record store that holds per-run session dirs. */
const SESSIONS_SUBDIR = 'sessions';

/**
 * The per-run session directory for `id`: `<STORAGE_DIR>/sessions/<id>`.
 * The id is validated first — this path is fed to SessionManager.create() and
 * to rmSync(), so a traversal id must never reach either.
 */
export function backgroundSessionDir(id: string): string {
  assertSafeAgentId(id);
  return join(STORAGE_DIR, SESSIONS_SUBDIR, id);
}

/**
 * TRUE when `dir` is shaped exactly like `<...>/sessions/<id>` — the one
 * precondition every path that touches a session directory requires before it
 * can delete or brand it.
 */
function isSessionDirFor(id: string, dir: string): boolean {
  const target = resolve(dir);
  return basename(target) === id && basename(dirname(target)) === SESSIONS_SUBDIR;
}

/**
 * Remove ONE per-run session directory. Defensive by construction: the target
 * must look like `<...>/sessions/<id>` (basename === id, parent basename ===
 * 'sessions') before rmSync runs, so a caller can never delete a path outside
 * the sessions tree. Idempotent (force: true); best-effort (never throws).
 */
function pruneSessionDir(id: string, dir: string): void {
  try {
    assertSafeAgentId(id);
  } catch {
    log.error(`Refusing to prune session dir for invalid id: ${id}`);
    return;
  }
  if (!isSessionDirFor(id, dir)) {
    log.error(`Refusing to prune session dir outside ${SESSIONS_SUBDIR}/: ${resolve(dir)}`);
    return;
  }
  try {
    rmSync(resolve(dir), { recursive: true, force: true });
  } catch (err) {
    // Pruning is hygiene — it must never break execution or a settle path.
    log.warn(`Failed to prune session dir for ${id}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * U2 (D2): remove the persisted session for a finalized/abandoned background
 * run. Validated (throws on an unsafe id) and idempotent — a missing directory
 * is a success. Exposed for U3's abandon action to reuse; the internal settle
 * path prunes the CAPTURED directory instead so a mid-run STORAGE_DIR change
 * (tests swap it per case) can never mis-target.
 *
 * U3 (D5) documented boundary — abandon after a STORAGE_DIR change: this
 * PUBLIC helper recomputes the root from the CURRENT STORAGE_DIR, so if the
 * root moved between the spawn and the abandon it prunes the new root (a
 * no-op when nothing lives there) and leaves the old-root session dir behind
 * as debris. That is prod-safe today (only tests swap the root; production
 * uses one root per process), so U3 does NOT try to track the captured dir
 * across sessions — the run's `_sessionFile` is live-only process state and is
 * not persisted (D4). Debris, if any, is bounded and inspectable under the old
 * root.
 */
export function pruneBackgroundSession(id: string): void {
  pruneSessionDir(id, backgroundSessionDir(id));
}

// ---------------------------------------------------------------------------
// Issue #404: bounded retention of a transport-failed run's session.
//
// The #401 resume preamble named no artifact beyond the working tree and the
// bank, because the SDK session dir — the only place the conversation lives —
// was pruned on every terminal settle. A transport failure is the ONE class a
// retry re-dispatches automatically, so it is the one class whose session is
// worth keeping: the retry's child reads the tail of it to recover what attempt
// 1 had already worked out.
//
// Retention is an OPTIMIZATION; boundedness is the invariant. A retained dir is
// branded with RETAINED_MARKER, and the sweep at the same choke points enforces
// the caps below over MARKED dirs only — an interrupted run's dir (kept by
// design, unmarked) and the agent-record store are never candidates. Nothing in
// this block may throw into a settle path.
//
// Root-local, like the U3 D5 boundary above: the sweep walks the sessions root
// the settled run actually wrote to, so a dir retained under a previous
// STORAGE_DIR root is not reclaimed by a later settle under a new one.
// ---------------------------------------------------------------------------

/** Brand on a retained session dir — the sweep's only selection criterion. */
const RETAINED_MARKER = '.transport-retained';
/** Keep at most this many retained dirs (oldest marker mtime goes first). */
const RETAINED_MAX_DIRS = 5;
/** Keep the marked set under this total on-disk size. */
const RETAINED_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** Drop a retained dir once its marker is older than this. */
const RETAINED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Below this size there is nothing worth a retention slot: a run that died on a
 * connection error before its first assistant turn leaves a start-entry-only
 * file (the SDK writes the header at create()), and pointing a retry at a
 * contentless file is worse than not pointing at all.
 */
const RETAINED_MIN_BYTES = 2 * 1024;

/**
 * Recursive on-disk size of `dir`. Unreadable entries count as zero and
 * symlinks are never followed, so the walk cannot escape `dir`.
 */
function dirTotalBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // raced with a delete — size it as absent
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        try {
          total += statSync(child).size;
        } catch {
          // vanished mid-walk — ignore
        }
      }
    }
  }
  return total;
}

/**
 * Enforce the #404 caps over the marked session dirs beside `currentDir`.
 *
 * `currentDir` is EXEMPT for the settle that just marked it. Without that, a
 * single over-cap dir would be deleted at the instant it was retained — and the
 * largest, most salvageable runs are exactly the ones that would lose. So one
 * dir may overshoot by one; the NEXT settle reclaims it.
 *
 * Best-effort by construction: selection is guarded, and deletion goes through
 * the validated, never-throwing `pruneSessionDir`.
 */
function sweepRetainedSessions(currentDir: string): void {
  const current = resolve(currentDir);
  const root = dirname(current);
  if (basename(root) !== SESSIONS_SUBDIR) return; // never walk outside sessions/
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return; // root missing/unreadable — nothing to bound
  }
  const now = Date.now();
  const retained: Array<{ dir: string; size: number; markedAt: number }> = [];
  for (const name of names) {
    // Only ids our own spawn can mint are sweepable; a foreign name is left for
    // a human instead of being deleted on a guess.
    try {
      assertSafeAgentId(name);
    } catch {
      continue;
    }
    const dir = join(root, name);
    const marker = join(dir, RETAINED_MARKER);
    // UNMARKED ⇒ interrupted (D3), live, or foreign. Never a candidate.
    if (!existsSync(marker)) continue;
    try {
      retained.push({ dir, size: dirTotalBytes(dir), markedAt: statSync(marker).mtimeMs });
    } catch {
      // marker disappeared between the check and the stat — re-read as unmarked
    }
  }
  retained.sort((a, b) => a.markedAt - b.markedAt);
  let count = retained.length;
  let total = retained.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of retained) {
    if (entry.dir === current) continue; // this settle's own dir — see the doc comment
    // Ages ascend with the sort, so the oldest candidate's age speaks for the rest.
    const tooMany = count > RETAINED_MAX_DIRS;
    const tooBig = total > RETAINED_MAX_TOTAL_BYTES;
    const tooOld = now - entry.markedAt > RETAINED_MAX_AGE_MS;
    if (!tooMany && !tooBig && !tooOld) break;
    pruneSessionDir(basename(entry.dir), entry.dir);
    count -= 1;
    total -= entry.size;
  }
}

/**
 * Retain `dir` for the #401 resume preamble: brand it with the retention marker
 * (its mtime is the recency source) and enforce the caps.
 *
 * Returns TRUE when the dir is now retained — the caller then SKIPS the prune —
 * and FALSE when retention was skipped or failed, in which case the caller must
 * prune as before. Fail-closed on purpose: retention is an optimization, while
 * boundedness is the invariant, and a dir whose marker write failed would be
 * invisible to the sweep forever.
 */
function retainSessionDir(id: string, dir: string): boolean {
  try {
    if (!isSessionDirFor(id, dir) || !existsSync(dir)) return false;
    if (dirTotalBytes(dir) < RETAINED_MIN_BYTES) return false;
    writeFileSync(join(dir, RETAINED_MARKER), `${new Date().toISOString()}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch (err) {
    log.warn(`Not retaining session dir for ${id} (marker write failed)`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  try {
    sweepRetainedSessions(dir);
  } catch (err) {
    // The sweep guards its own steps; this is belt-and-braces so a settle can
    // never be broken by hygiene.
    log.warn(`Retained-session sweep failed for ${id}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

/**
 * Persist agent record to disk
 */
function persistAgent(agent: BackgroundAgent): void {
  // F24: agent.id may come from a disk-loaded record (loadAgent JSON.parse's
  // the id field unvalidated). A planted record with a traversal id would
  // make join() escape STORAGE_DIR — validate BEFORE building the write path.
  try {
    assertSafeAgentId(agent.id);
  } catch {
    log.error(`Refusing to persist agent with invalid id: ${agent.id}`);
    return;
  }
  ensureStorageDir();
  const filePath = join(STORAGE_DIR, `${agent.id}.json`);
  // Strip live/non-serializable fields before stringify — `_sessionRef` holds the
  // ENTIRE live pi session graph (1.4MB+ for an empty session, and uninitialized
  // getters like Theme can make JSON.stringify throw). `_sessionFile` (U2) is the
  // on-disk session path — live-only bookkeeping for precise pruning, never a
  // persisted record field (D4).
  const { _sessionRef, _sessionFile, ...persistable } = agent;
  try {
    // F6 (issue #29): records contain task, error, result.messages (full
    // conversation) and finalOutput — write owner-only (0o600) so other local
    // users cannot read subagent tasks/output. mode applies on file CREATE;
    // pre-existing files keep their old mode (not retroactive).
    writeFileSync(filePath, JSON.stringify(persistable, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // Log but never throw — persistence must not break execution
    log.error(`Failed to persist agent ${agent.id}`, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Load agent record from disk
 */
function loadAgent(id: string): BackgroundAgent | null {
  const filePath = join(STORAGE_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Get agent record by ID
 */
export function getAgent(id: string): BackgroundAgent | null {
  // F24: id may arrive from LLM tool params (get_agent_status, steer_subagent,
  // get_agent_result). Validate BEFORE any map/fs access — path.join does not
  // sanitize "../" or absolute segments, so a traversal id like "../../etc/foo"
  // would otherwise read arbitrary .json files via loadAgent(). Invalid ids
  // surface as "agent not found" to tool callers.
  try {
    assertSafeAgentId(id);
  } catch {
    return null;
  }
  return agents.get(id) || loadAgent(id);
}

/**
 * Option B U1: every agent record persisted on disk (cross-session — the
 * `.pi/subagents/` store survives a process death; the conductor's session run
 * entries do not). Boot recovery does NOT use this: it sources candidates from
 * the durable run registry and reads background records ONE at a time by id
 * (`recoverInflightRuns`'s `readAgentRecord`), precisely to avoid parsing the
 * whole store; production has no caller for this sweep. Unreadable/corrupt
 * files and unsafe ids are skipped, never thrown.
 */
export function listPersistedAgents(): BackgroundAgent[] {
  let files: string[];
  try {
    if (!existsSync(STORAGE_DIR)) return [];
    files = readdirSync(STORAGE_DIR);
  } catch {
    return [];
  }
  const records: BackgroundAgent[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    try {
      assertSafeAgentId(id);
    } catch {
      continue;
    }
    const record = loadAgent(id);
    if (record) records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Issue #396: retry lineage for `get_subagent_result`.
//
// A run id is not necessarily the id of the run that actually finished it: the
// background transport auto-retry (#365) re-dispatches the same logical task as
// `attempt: 2`, and a manual `retryRunId` can mint attempt 3 whose `resumeOf`
// points at attempt 2. The durable agent store therefore has to be consulted
// before "not found" or a terminal source status is reported as final.
//
// Two properties drive the implementation:
//
//   1. ID FORM — notices render the first 8 hex characters of a UUID, while
//      `resumeOf`/record ids are full UUIDs. Resolve a unique 8-hex prefix
//      before either the record read or the lineage match; an ambiguous prefix
//      is refused explicitly rather than guessed.
//   2. COST — the agent store is large and never pruned (measured 2026-10:
//      ~1160 records / ~116 MB on the live store; a full parse is ~0.5 s per
//      tool call, and a synthetic 100 KB-payload fixture of the same shape
//      measures ~225 MB). This reader
//      stats first, keeps only records inside a 7-day mtime window, caps the
//      number read at `RETRY_SCAN_CAP`, and extracts just the identity fields
//      with a top-level scanner instead of JSON-parsing result.messages.
//
// Deliberately NOT `listPersistedAgents()`: that sweep full-parses every
// record, and its "production has no caller" comment documents that decision.
// ---------------------------------------------------------------------------

/** How far back the lineage reader looks (mtime of the record file). */
export const RETRY_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Upper bound on records read for one lineage answer. */
const RETRY_SCAN_CAP = 200;

/** The scan window in whole days (the user-facing caveat derives from it). */
export const RETRY_SCAN_WINDOW_DAYS = RETRY_SCAN_WINDOW_MS / (24 * 60 * 60 * 1000);

/** The short form rendered by notices: the first 8 hex characters of a UUID. */
const SHORT_AGENT_ID_RE = /^[0-9a-f]{8}$/i;

const RETRY_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'id',
  'dispatchId',
  'resumeOf',
  'attempt',
  'status',
  'startedAt',
]);

const AGENT_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'steered',
  'completed',
  'failed',
  'stopped',
]);

/** One record's lineage-relevant fields — never its result/transcript. */
export interface RetryRecordIdentity {
  id: string;
  dispatchId?: string;
  resumeOf?: string;
  attempt: number;
  status: AgentStatus;
  /** Epoch milliseconds (agent records store ms; registry ISO is normalised). */
  startedAt: number;
}

export type AgentIdResolution =
  | { kind: 'resolved'; id: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'unresolved'; id: string };

export interface RetryLineage {
  id: string;
  /** Every known attempt of the logical dispatch, ordered by attempt/start. */
  family: RetryRecordIdentity[];
  /** The requested id's own record, when it exists. */
  found: RetryRecordIdentity | null;
  /** The newest attempt in the family. */
  latest: RetryRecordIdentity | null;
  /** Registry entries that name the id itself or a member of its family. */
  inflight: InflightRun[];
}

function isSafeAgentId(id: string): boolean {
  try {
    assertSafeAgentId(id);
    return true;
  } catch {
    return false;
  }
}

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && AGENT_STATUSES.has(value);
}

function normalizeStartedAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function safeListInflightRuns(): InflightRun[] {
  try {
    return listInflightRuns();
  } catch {
    return [];
  }
}

/**
 * Resolve the tool's id parameter before any record lookup. A full UUID passes
 * through; a unique 8-hex prefix resolves to its full id; multiple matches are
 * returned as `ambiguous` (fail closed); anything else stays unresolved and
 * follows today's not-found path.
 *
 * Candidates come from live records, the agent store's file names, and the
 * in-flight registry — every surface on which an id can currently exist.
 */
export function resolveAgentId(raw: string): AgentIdResolution {
  if (isSafeAgentId(raw)) return { kind: 'resolved', id: raw };
  if (!SHORT_AGENT_ID_RE.test(raw)) return { kind: 'unresolved', id: raw };

  const needle = raw.toLowerCase();
  const matches = new Set<string>();

  for (const id of agents.keys()) {
    if (id.toLowerCase().startsWith(needle)) matches.add(id);
  }

  try {
    if (existsSync(STORAGE_DIR)) {
      for (const file of readdirSync(STORAGE_DIR)) {
        if (!file.endsWith('.json')) continue;
        const id = file.slice(0, -'.json'.length);
        if (isSafeAgentId(id) && id.toLowerCase().startsWith(needle)) matches.add(id);
      }
    }
  } catch {
    // An unreadable store is not a prefix match — fall through to the registry.
  }

  for (const run of safeListInflightRuns()) {
    if (run.id.toLowerCase().startsWith(needle)) matches.add(run.id);
  }

  const ids = [...matches].sort();
  if (ids.length === 1) return { kind: 'resolved', id: ids[0] };
  if (ids.length > 1) return { kind: 'ambiguous', matches: ids };
  return { kind: 'unresolved', id: raw };
}

// ---------------------------------------------------------------------------
// Shallow JSON identity reader
// ---------------------------------------------------------------------------

type JsonScalar = string | number | boolean | null;

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/** Read one JSON string starting at `start` (which must be `"`). */
function readJsonStringAt(text: string, start: number): { value: string; end: number } {
  let i = start + 1;
  let escaped = false;
  while (i < text.length) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      i += 1;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      i += 1;
      continue;
    }
    if (char === '"') {
      const raw = text.slice(start, i + 1);
      i += 1;
      try {
        return { value: JSON.parse(raw) as string, end: i };
      } catch {
        return { value: raw.slice(1, -1), end: i };
      }
    }
    i += 1;
  }
  return { value: text.slice(start + 1), end: i };
}

/** Skip one JSON value (scalar, object, or array) without parsing it. */
function skipJsonValue(text: string, start: number): number {
  if (text[start] === '"') return readJsonStringAt(text, start).end;
  if (text[start] === '{' || text[start] === '[') {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return text.length;
  }
  let i = start;
  while (i < text.length && text[i] !== ',' && text[i] !== '}') i += 1;
  return i;
}

function parseJsonScalar(raw: string): JsonScalar {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

/**
 * Extract top-level scalar fields from a record's JSON text. Nested values
 * (notably `result.messages` and `finalOutput`) are skipped, not parsed — the
 * reader only ever touches the six identity keys.
 */
function scanTopLevelScalars(text: string, wanted: ReadonlySet<string>): Map<string, JsonScalar> {
  const out = new Map<string, JsonScalar>();
  let i = skipWhitespace(text, 0);
  if (text[i] !== '{') return out;
  i += 1;

  while (i < text.length) {
    i = skipWhitespace(text, i);
    if (i >= text.length) break;
    const char = text[i];
    if (char === '}') break;
    if (char === ',') {
      i += 1;
      continue;
    }
    if (char !== '"') {
      // Malformed object: make progress rather than looping forever.
      i += 1;
      continue;
    }

    const keyStart = i;
    const key = readJsonStringAt(text, i);
    i = skipWhitespace(text, key.end);
    if (text[i] !== ':') break;
    i = skipWhitespace(text, i + 1);
    if (i >= text.length) break;

    if (wanted.has(key.value)) {
      const valueStart = text[i];
      if (valueStart === '"') {
        const value = readJsonStringAt(text, i);
        out.set(key.value, value.value);
        i = value.end;
      } else if (valueStart === '{' || valueStart === '[') {
        i = skipJsonValue(text, i);
      } else {
        let end = i;
        while (end < text.length && text[end] !== ',' && text[end] !== '}') end += 1;
        out.set(key.value, parseJsonScalar(text.slice(i, end).trim()));
        i = end;
      }
    } else {
      i = skipJsonValue(text, i);
    }

    if (i <= keyStart) break;
  }

  return out;
}

/** Read one agent record's identity fields; null when malformed/incomplete. */
function readAgentIdentity(file: string): RetryRecordIdentity | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }

  const fields = scanTopLevelScalars(text, RETRY_IDENTITY_KEYS);
  const embeddedId = fields.get('id');
  const id = typeof embeddedId === 'string' ? embeddedId : basename(file, '.json');
  if (!isSafeAgentId(id)) return null;

  const status = fields.get('status');
  if (!isAgentStatus(status)) return null;

  const startedAt = normalizeStartedAt(fields.get('startedAt'));
  if (startedAt === null) return null;

  const attemptValue = fields.get('attempt');
  const attempt =
    typeof attemptValue === 'number' && Number.isFinite(attemptValue) && attemptValue > 0
      ? Math.floor(attemptValue)
      : 1;

  const dispatchId = fields.get('dispatchId');
  const resumeOf = fields.get('resumeOf');
  return {
    id,
    status,
    startedAt,
    attempt,
    ...(typeof dispatchId === 'string' ? { dispatchId } : {}),
    ...(typeof resumeOf === 'string' ? { resumeOf } : {}),
  };
}

/**
 * The bounded store read: stat every record (cheap), keep the ones inside the
 * mtime window, sort newest-first, cap at `RETRY_SCAN_CAP`, then read only the
 * surviving files' identity fields. Corrupt/unsafe records are skipped.
 */
function readRecentAgentIdentities(): RetryRecordIdentity[] {
  let files: string[];
  try {
    if (!existsSync(STORAGE_DIR)) return [];
    files = readdirSync(STORAGE_DIR);
  } catch {
    return [];
  }

  const cutoff = Date.now() - RETRY_SCAN_WINDOW_MS;
  const recent: Array<{ file: string; mtime: number }> = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    if (!isSafeAgentId(id)) continue;
    const fullPath = join(STORAGE_DIR, file);
    try {
      const stat = statSync(fullPath);
      if (stat.mtimeMs >= cutoff) recent.push({ file: fullPath, mtime: stat.mtimeMs });
    } catch {
      // Vanished between readdir and stat — not a lineage candidate.
    }
  }

  recent.sort((a, b) => b.mtime - a.mtime);
  const records: RetryRecordIdentity[] = [];
  for (const entry of recent.slice(0, RETRY_SCAN_CAP)) {
    const record = readAgentIdentity(entry.file);
    if (record) records.push(record);
  }
  return records;
}

function identityFromAgent(agent: BackgroundAgent): RetryRecordIdentity | null {
  const startedAt = normalizeStartedAt(agent.startedAt);
  if (startedAt === null) return null;
  return {
    id: agent.id,
    status: agent.status,
    startedAt,
    attempt: agent.attempt ?? 1,
    ...(agent.dispatchId ? { dispatchId: agent.dispatchId } : {}),
    ...(agent.resumeOf ? { resumeOf: agent.resumeOf } : {}),
  };
}

function identityFromRegistry(run: InflightRun): RetryRecordIdentity | null {
  const startedAt = normalizeStartedAt(run.startedAt);
  if (startedAt === null) return null;
  return {
    id: run.id,
    status: 'running',
    startedAt,
    attempt: run.attempt ?? 1,
    ...(run.dispatchId ? { dispatchId: run.dispatchId } : {}),
  };
}

/**
 * Find the logical dispatch family for `id`.
 *
 * Family membership is `dispatchId` (inherited by every attempt, including a
 * manual attempt 3 whose `resumeOf` names attempt 2). Records without a
 * `dispatchId` fall back to direct `resumeOf` matching. The registry is folded
 * in so an in-flight retry is visible without a store record.
 */
export function findRetryLineage(id: string, source?: BackgroundAgent | null): RetryLineage {
  const empty: RetryLineage = { id, family: [], found: null, latest: null, inflight: [] };
  if (!isSafeAgentId(id)) return empty;

  const byId = new Map<string, RetryRecordIdentity>();
  for (const record of readRecentAgentIdentities()) byId.set(record.id, record);

  const sourceIdentity = source && source.id === id ? identityFromAgent(source) : null;
  if (sourceIdentity) byId.set(id, sourceIdentity);

  const registry = safeListInflightRuns();
  for (const run of registry) {
    const identity = identityFromRegistry(run);
    // A persisted record is authoritative over the registry's "running" view.
    if (identity && !byId.has(identity.id)) byId.set(identity.id, identity);
  }

  const all = [...byId.values()];
  const found = byId.get(id) ?? sourceIdentity;
  // Newest-first so the dispatch chosen for an unknown id comes from its most
  // recent direct descendant, not from readdir order.
  const direct = all
    .filter((record) => record.resumeOf === id && record.id !== id)
    .sort((a, b) => b.attempt - a.attempt || b.startedAt - a.startedAt);
  const familyDispatch = found?.dispatchId ?? direct[0]?.dispatchId;

  const members = familyDispatch
    ? all.filter((record) => record.dispatchId === familyDispatch)
    : [...(found ? [found] : []), ...direct];

  const family = [...new Map(members.map((record) => [record.id, record])).values()];
  family.sort(
    (a, b) => a.attempt - b.attempt || a.startedAt - b.startedAt || a.id.localeCompare(b.id),
  );

  const latest = family.length > 0 ? family[family.length - 1] : null;
  const inflight = registry.filter(
    (run) => run.id === id || (familyDispatch !== undefined && run.dispatchId === familyDispatch),
  );

  return { id, family, found, latest, inflight };
}

/**
 * Option B U1 (D3): read-modify-write the interrupted mark onto a persisted
 * agent record. Idempotent: an already-marked record is returned unchanged.
 * Returns null when the record does not exist.
 */
export function markAgentInterrupted(id: string, interruptedAt: string): BackgroundAgent | null {
  const agent = getAgent(id);
  if (!agent) return null;
  if (!agent.interruptedAt) {
    agent.interruptedAt = interruptedAt;
    agents.set(id, agent);
    persistAgent(agent);
  }
  return agent;
}

/**
 * Update agent status
 */
export function updateAgentStatus(id: string, status: AgentStatus, error?: string): BackgroundAgent | null {
  const agent = getAgent(id);
  if (!agent) return null;
  
  agent.status = status;
  if (status === 'completed' || status === 'failed' || status === 'stopped') {
    agent.completedAt = Date.now();
  }
  if (error) agent.error = error;
  
  agents.set(id, agent);
  persistAgent(agent);

  if (status === 'running') {
    eventBus.emit(eventBus.createEvent('subagent:started', id, {}));
  } else if (status === 'completed') {
    eventBus.emit(eventBus.createEvent('subagent:completed', id, { error }));
  } else if (status === 'failed') {
    eventBus.emit(eventBus.createEvent('subagent:failed', id, { error }));
  } else if (status === 'stopped') {
    eventBus.emit(eventBus.createEvent('subagent:stopped', id, {}));
  } else if (status === 'steered') {
    eventBus.emit(eventBus.createEvent('subagent:steered', id, {}));
  }

  return agent;
}

/**
 * Issue #179 (D4): when a run ends in a failure, the prose extracted by
 * extractFinalOutput may come from an EARLIER turn — the failing turn carries
 * no text of its own. Prefixing the failure reason makes the output honest
 * instead of a plausible-looking success narrative.
 */
export function buildFailureHeadline(reason: string, output: string): string {
  const trimmed = output.trim();
  return trimmed ? `${reason}\n\n${trimmed}` : reason;
}

/**
 * Issue #179 (D3/D4): a run that ended without a terminal answer must still
 * record WHY. When the provider supplied no message, synthesize one from the
 * stopReason so the run entry never claims a failure with an empty reason.
 */
function defaultTerminalMessage(stopReason: string | undefined): string {
  switch (stopReason) {
    case 'error':
      return 'Run ended with a provider error (stopReason "error")';
    case 'length':
      return 'Run ended early: output length limit reached (stopReason "length")';
    case 'toolUse':
      return 'Run ended mid-turn without a final answer (stopReason "toolUse")';
    case 'deferred':
      return 'Run ended deferred without a final answer (stopReason "deferred")';
    case 'pending':
      return 'Run ended while still pending (stopReason "pending")';
    default:
      return 'Run ended without completing';
  }
}

/**
 * Extract the final assistant text from a session's messages.
 * Falls back to the LAST assistant message with non-empty text content — the
 * final message is often a tool-call-only turn (agent stopped mid-turn, failed,
 * or hit the deadline), and that turn carries no text of its own.
 */
export function extractFinalOutput(session: { messages: Array<{ role: string; content?: Array<{ type: string; text?: string }> | string | null }> }): string {
  const assistants = [...session.messages].reverse().filter(m => m.role === 'assistant');
  for (const msg of assistants) {
    const content = msg.content;
    let text = '';
    if (Array.isArray(content)) {
      text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
    } else if (typeof content === 'string') {
      text = content;
    }
    if (text.trim()) return text;
  }
  return '';
}

/**
 * Set the final assistant output captured from the agent's session
 */
export function setAgentFinalOutput(id: string, output: string): BackgroundAgent | null {
  const agent = getAgent(id);
  if (!agent) return null;
  
  agent.finalOutput = output;
  
  agents.set(id, agent);
  persistAgent(agent);
  return agent;
}

/**
 * Stop a running agent — REAL abort (PR #28 W1).
 *
 * Probe contract (sdk-abort-contract.test.ts): session.prompt() RESOLVES on
 * abort — the SDK's runWithLifecycle catches the AbortError and converts it
 * into a failure message with stopReason "aborted". So:
 *   1. set status 'stopped' FIRST (the .then in spawnBackgroundSession will
 *      fire after abort settles and must not overwrite it), then
 *   2. await session.abort() (waits for the agent to become idle), then
 *   3. complete the transcript.
 */
export async function stopAgent(id: string): Promise<BackgroundAgent | null> {
  const agent = getAgent(id);
  if (!agent) return null;
  // Nothing to stop — already terminal.
  if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'stopped') {
    return agent;
  }

  // Mark stopped BEFORE aborting so the spawnBackgroundSession .then handler
  // (which fires after the run settles) keeps the stopped state.
  updateAgentStatus(id, 'stopped');

  const session = agent._sessionRef;
  if (session) {
    try {
      await session.abort();
    } catch (err) {
      // Abort can throw if the session is mid-dispose; the status flip above
      // is already recorded, so this is non-fatal.
      log.warn(`stopAgent: abort failed for ${id}`, { error: (err as Error).message });
    }
  }

  transcript.completeTranscript(id, 'stopped');
  return agent;
}

/**
 * Steer a running agent by injecting a message into its live session.
 *
 * Issue #241: steering DELIVERS via the SDK's `AgentSession.steer()` — the
 * message is queued while the agent is running and delivered after the current
 * assistant turn finishes its tool calls, before the next model call.
 *
 * Steering is NOT a state transition: the agent stays 'running' (no status
 * flip, no persistAgent) so REPEAT steers keep working. Delivery failures
 * propagate to the caller — a false success would tell the conductor a steer
 * landed when the agent never saw it. The transcript line is an audit record
 * written AFTER successful delivery, best-effort: a landed steer must never be
 * reported as failed because the audit write failed.
 */
export async function steerAgent(id: string, message: string): Promise<BackgroundAgent | null> {
  const agent = getAgent(id);
  if (!agent) return null;
  if (agent.status !== 'running') {
    throw new Error(`Cannot steer agent ${id}: status is ${agent.status}, not running`);
  }

  const session = agent._sessionRef;
  if (!session) {
    throw new Error(`Cannot steer agent ${id}: no live session (the run may be settling)`);
  }
  if (typeof session.steer !== 'function') {
    throw new Error('installed pi SDK has no AgentSession.steer — steering unsupported');
  }

  // Deliver FIRST — a rejection here must surface as a real tool error, never
  // a recorded-but-undelivered steer.
  await session.steer(message);

  // Audit line — best-effort. The steer already landed; an append failure is
  // logged, not propagated.
  try {
    transcript.appendEntry(id, 'user', `Steering: ${message}`);
  } catch (err) {
    log.warn(`steerAgent: transcript append failed for ${id}`, { error: (err as Error).message });
  }

  eventBus.emit(eventBus.createEvent('subagent:steered', agent.id, { message }));

  return agent;
}

/**
 * Get transcript path for an agent.
 *
 * Issue #276: the format lives in `transcript-path.ts` (the single source).
 * This re-export preserves the historical `session-manager.getTranscriptPath`
 * surface for `index.ts`'s dynamic import and the existing tests.
 */
export { transcriptPath as getTranscriptPath } from './transcript-path';

/**
 * Spawn a background session using pi's session API
 * 
 * This creates a real pi session that runs independently.
 * The session can be polled later with getAgent() or steered with steerAgent().
 */
export async function spawnBackgroundSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: {
    task: string;
    type?: string;
    description?: string;
    model?: string;
    thinkingLevel?: ThinkingLevel;
    systemPrompt?: string;
    cwd?: string;
    toolOptions?: SubagentToolOptions;
    /** Per-agent deadline in ms — the session is aborted when exceeded (issue #28 W3). */
    timeout?: number;
    /** Git isolation for the background run — "branch" creates a work branch (issue #28 W4). */
    gitMode?: GitMode;
    /** Issue #98: snapshot of the caller's raw params — lets retryRunId restore
     *  the original model/thinkingLevel/preset for background runs (mirrors the
     *  foreground run-record creation in index.ts). */
    originalParams?: SubagentRun["originalParams"];
    /** Issue #114: per-unit priority — recorded on the run entry + agent record
     *  so the drill-in header and history carry it (absent → no segment). */
    priority?: string;
    /** Option B U1: durability identity. A retry inherits the original's
     *  dispatchId and records resumeOf/attempt; a fresh dispatch omits them. */
    dispatchId?: string;
    resumeOf?: string;
    attempt?: number;
    /** Option B U3 (D4): recovery posture at dispatch — snapshotted onto the
     *  agent record + run entry so the boot notice reads the posture the run
     *  was actually dispatched under. Absent reads as "offer". */
    recoveryPosture?: RecoveryMode;
  }
): Promise<BackgroundAgent> {
  // Serialize access to pi API to prevent concurrent import races
  const prev = spawnQueue;
  let resolveNext!: () => void;
  spawnQueue = new Promise<void>(r => { resolveNext = r; });
  await prev;
  
  try {
  const id = generateUUID();
  const effectiveCwd = params.cwd ?? ctx.cwd;
  // Dynamic import — static import fails under concurrent jiti loads
  const { getAgentDir, createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');
  const agentDir = getAgentDir();

  // Resolve the model STRING to a real Model object — createAgentSession expects
  // Model<any>, not "provider/id". Passing a string makes provider resolution
  // yield undefined ("No API key found for undefined") and clamps thinking to "off".
  // Falls back to undefined → SDK's findInitialModel picks the settings default.
  let resolvedModel;
  if (params.model) {
    const slashIdx = params.model.indexOf('/');
    if (slashIdx > 0) {
      const provider = params.model.slice(0, slashIdx);
      const modelId = params.model.slice(slashIdx + 1);
      resolvedModel = ctx.modelRegistry.find(provider, modelId);
    }
  }
  
  // Create the session manager for this background agent. U2 (D1): an explicit
  // per-run sessionDir is REQUIRED — `inMemory` persists nothing (no post-hoc
  // inspection, no U4 resume) and the SDK default (`~/.pi/agent/sessions/<cwd-key>/`,
  // passed as `undefined`) would scatter our runs into the global store. The
  // directory lives beside the agent record: `.pi/subagents/sessions/<id>/`.
  const sessionManager = SessionManager.create(effectiveCwd, backgroundSessionDir(id));
  // Capture the exact path the SDK will write. The settle path derives the
  // prune target from THIS (not from a freshly-computed STORAGE_DIR path) so a
  // change of STORAGE_DIR between spawn and settle cannot mis-target the delete.
  const sessionFile: string | undefined = sessionManager.getSessionFile();
  const settingsManager = SettingsManager.create(effectiveCwd);

  // E20: Inject the subagent prompt into the session's system prompt.
  // The SDK has no systemPrompt option on createAgentSession — the sanctioned
  // injection point is the resource loader's appendSystemPrompt (the same
  // mechanism pi uses for --append-system-prompt).
  //
  // F26: resolvePromptInput (resource-loader.js:16) checks existsSync(input)
  // and readFileSync's the string if it matches a real path — a raw prompt
  // value like ".env" or "package.json" would be silently REPLACED by that
  // file's contents (arbitrary-file-read-into-prompt).
  //
  // The defense is NOT "newlines are invalid in filenames" (false on POSIX —
  // filenames can contain \n). The actual mechanism:
  //   1. The "/" in "</system-prompt>" forces a multi-component RELATIVE path
  //      (never absolute — leading \n guarantees no "/" prefix), so the
  //      wrapped value can never equal a single-component name like ".env".
  //   2. buildSubagentPrompt ALWAYS appends SUBAGENT_INSTRUCTIONS (measured
  //      1644 bytes, no "/"), so one contiguous path component exceeds
  //      NAME_MAX=255 on mainstream filesystems → the path can never be
  //      created → existsSync is always false.
  //   3. Windows: \n, <, > are illegal in filenames — impossible outright.
  //
  // Residual (theoretical): a filesystem with component limit > ~1663 bytes,
  // cwd write access, AND byte-exact prediction of the full prompt could
  // plant a newline-named dir + symlink leaf. Not exploitable realistically;
  // do not "simplify" the frame (e.g. dropping the "/" marker) without
  // re-verifying this property.
  const literalPrompt = params.systemPrompt?.trim()
    ? `\n<system-prompt>\n${params.systemPrompt}\n</system-prompt>\n`
    : undefined;
  //
  // F25: ALWAYS build our own loader (even without a systemPrompt). If
  // resourceLoader is undefined, createAgentSession constructs its own
  // DefaultResourceLoader({ cwd, agentDir, settingsManager }) and reload()s it
  // — importing extension/skill code from the LLM-controlled target cwd into
  // THIS process (RCE; background mode has no trust prompt).
  //
  // noExtensions + noSkills are BLANKET (they also disable user-global
  // extensions/skills from agentDir, e.g. ~/.pi/agent/skills). This is a
  // deliberate security choice: background sessions have no trust prompt, so
  // nothing is imported from anywhere — the prompt is fully specified by the
  // caller. Users needing skills/extensions should use foreground delegation.
  const loader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir,
    settingsManager,
    ...(literalPrompt ? { appendSystemPrompt: [literalPrompt] } : {}),
    noExtensions: true,
    noSkills: true,
  });
  await loader.reload();
  const resourceLoader: InstanceType<typeof DefaultResourceLoader> = loader;
  
  // Create the session — honor the resolved tool restrictions so the
  // background agent's ACTUAL toolset matches what the prompt tells it
  // (and what H1 validation checked). Pre-PR this was a hardcoded full
  // toolset, so an agent told "read-only" by the prompt still had write.
  const bgTools = params.toolOptions?.tools;
  const bgExcludeTools = params.toolOptions?.excludeTools;
  const { session } = await createAgentSession({
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    // NOTE: modelRegistry is NOT part of CreateAgentSessionOptions (pi 0.84
    // SDK surface) and the runtime never reads it — the model is passed
    // explicitly via `model: resolvedModel` above, so this option was dead.
    resourceLoader,
    model: resolvedModel,
    thinkingLevel: params.thinkingLevel,
    tools: bgTools ?? ['read', 'bash', 'grep', 'find', 'ls', 'write', 'edit'],
    ...(bgExcludeTools ? { excludeTools: bgExcludeTools } : {}),
    ...(params.toolOptions?.noBuiltinTools ? { noTools: 'builtin' as const } : {}),
  });
  
  // Set session name
  session.setSessionName(`background-${id.slice(0, 8)}`);
  
  // Option B U1: durability identity. Background runs have no child process
  // (the session is in-process), so there is no childMarker — only the owner
  // identity that a boot scan uses to tell a live conductor from a dead one.
  const dispatchId = params.dispatchId ?? generateUUID();
  const attempt = params.attempt ?? 1;
  const owner = currentProcessOwner();

  // Create agent record
  const agent: BackgroundAgent = {
    id,
    sessionId: session.sessionId ?? id,
    type: params.type || 'general-purpose',
    description: params.description || params.task.slice(0, 50),
    status: 'running',
    startedAt: Date.now(),
    task: params.task,
    model: params.model || 'unknown',
    thinkingLevel: params.thinkingLevel || 'medium',
    priority: params.priority,
    dispatchId,
    resumeOf: params.resumeOf,
    attempt,
    owner,
    // Option B U3 (D4): per-run recovery posture snapshot. Additive — absent
    // reads as "offer" via `runRecoveryPosture`/the notice collector.
    recoveryPosture: params.recoveryPosture,
    // U2: live-only pointer to this run's session file (stripped before persist).
    _sessionFile: sessionFile,
  };
  
  agents.set(id, agent);
  persistAgent(agent);
  
  // Issue #98: background runs must be retry-able — persist a session run
  // entry at spawn (id == agent id, so retryRunId: <agent-id> resolves via
  // state.findSpawnRunById → getRunEntries). The entry lives in the same session
  // custom-entry store the foreground path writes to (state.persistRun); the
  // background path previously never wrote there, so retries silently no-oped.
  const startedAtMs = agent.startedAt; // reuse the agent record's start clock
  const run: SubagentRun = {
    id, // SAME as agent.id — the caller holds this id
    task: params.task,
    description: params.description,
    // Issue #98 (review F3): history/reports consumers read run.label —
    // the background label (params.description) must land there too, not
    // only in description.
    label: params.description,
    status: "running",
    model: params.model || "unknown",
    thinkingLevel: params.thinkingLevel || "medium",
    priority: params.priority,
    startedAt: new Date().toISOString(),
    originalParams: params.originalParams,
    dispatchId,
    resumeOf: params.resumeOf,
    attempt,
    owner,
    recoveryPosture: params.recoveryPosture,
  };
  persistRunRecord(pi, run, "background");

  // Issue #98: keep the session run entry in lockstep with the agent record —
  // every terminal branch that flips agent.status also finalizes the run entry
  // ("done"/"failed"). The guard keeps the entry single-finalized even when a
  // settle handler throws after finalizing (markTerminalBestEffort catch-all).
  //
  // U2 (D2) retention: this is the SINGLE terminal choke point for a background
  // run — git-setup refusal, a synchronous prompt throw, the .then completed /
  // provider-failed / aborted branches, the .catch stopped / failed branches and
  // the markTerminalBestEffort catch-all ALL land here exactly once (the
  // runFinalized guard). The session-dir decision below therefore covers every
  // settle path. The index.ts poller crash notices are NOT settlements (they flip
  // only the live UI state and leave the run/agent record to this settle); an
  // interrupted run (U1 boot-scan mark) never reaches this function and KEEPS its
  // file (D3).
  let runFinalized = false;
  const finalizeRunEntry = (
    status: "done" | "failed",
    error?: string,
    terminal?: { stopReason?: string; errorCategory?: ErrorCategory },
  ): void => {
    if (runFinalized) return;
    runFinalized = true;
    const usage = agent.result?.usage ?? EMPTY_USAGE;
    const finalOutput = agent.finalOutput ?? "";
    // Issue #179 (D1/D2): the classifier's explicit category wins (it knows the
    // terminal stopReason); otherwise fall back to the legacy message-based
    // classification (refused spawns, sync throws, preflight rejections, the
    // catch-all) so no failure is ever left uncategorized.
    //
    // Issue #404: HOISTED above the session-dir decision below — the retention
    // gate must read the same category/value the run record is about to get, and
    // that decision has to happen before the record write (see the invariant
    // note there). `classifyError` is pure and total, so hoisting costs nothing.
    const errorCategory =
      status === "failed"
        ? terminal?.errorCategory ??
          (error
            ? classifyError({
                messages: [],
                usage: { ...EMPTY_USAGE },
                exitCode: 1,
                stderr: "",
                errorMessage: error,
              })
            : undefined)
        : undefined;
    // U2 (D2) prune + #404 retention. THE INVARIANT: the prune/mark decision
    // precedes the run-record write, and everything above it is pure — so no
    // throw between the decision and the write can leave a terminal run's session
    // dir behind. Interrupted runs keep theirs (D3) and are never marked.
    //
    // The retention gate is the auto-retry predicate itself (#365/#401): only a
    // run that will be re-dispatched has a reader for the retained session, and
    // it is built from the values this record is about to carry, so the reader
    // and the retainer can never disagree.
    if (!agent.interruptedAt) {
      // The CAPTURED dir — tests swap STORAGE_DIR per case, and a mid-run change
      // of root must never mis-target the delete or the marker.
      const sessionDir = agent._sessionFile ? dirname(agent._sessionFile) : backgroundSessionDir(id);
      const retained = isTransportRetryable({
        status,
        errorCategory,
        errorMessage: error,
        attempt: run.attempt,
        originalParams: run.originalParams,
      });
      // Marker write failure => prune: retention is an optimization, boundedness
      // is the invariant (an unmarked retained dir would escape the sweep).
      if (!retained || !retainSessionDir(id, sessionDir)) {
        pruneSessionDir(id, sessionDir);
      }
    }
    // Issue #187: capture the RAW terminal reason BEFORE coercion. `finalTurnError`
    // means "the final turn was a PROVIDER error" (isProviderError); deriving it
    // from the COERCED reason would turn a missing/success reason into 'error' and
    // mislabel a non-provider failure (hard-cap timeout, spawn throw) as one.
    const rawStopReason = terminal?.stopReason ?? agent.result?.stopReason;
    const stopReason =
      status === "failed"
        ? coherentFailureReason(rawStopReason, errorCategory)
        : rawStopReason;
    const entry: SubagentRun = {
      ...run,
      status,
      // Issue #179 (D2): the run entry carries the CLASSIFIED reason, not just
      // an opaque error string.
      stopReason,
      errorCategory,
      // Issue #179 (D3): work volume + terminal-error signal. `turns`/`tokensOut`
      // are already in the usage data; recording them here makes "did nothing"
      // (turns 0) explicit versus "did work then died" (turns > 0, error).
      turns: usage.turns,
      finalTurnError: isProviderError(rawStopReason),
      errorMessage: error,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      // Issue #122: audit fields — usage and final output are already
      // captured on the agent record before the terminal finalize runs.
      cost: usage.cost,
      tokensIn: usage.input,
      tokensOut: usage.output,
      outputSummary: finalOutput.slice(0, 200),
      fullOutput: finalOutput || undefined,
      originalParams:
        errorCategory
          ? { ...(run.originalParams ?? {}), errorCategory }
          : run.originalParams,
    };
    persistRunRecord(pi, entry);
    // Issue #179 (D6): the explicit settle line — the log's job is to record the
    // CLASSIFIED OUTCOME, which cwd alone can never convey.
    log.info("Background run settled", {
      agentId: id,
      status,
      stopReason,
      turns: usage.turns,
      tokensOut: usage.output,
      errorCategory,
      error: error ?? null,
    });
  };

  // Start transcript for this agent
  transcript.startTranscript(agent.id, params.task);

  // Store session ref for live monitor polling
  agent._sessionRef = session;

  // Issue #31 (PR #76 review, DRY): every terminal branch must capture the
  // final output while the session is still live, THEN release the ref — the
  // capture must always precede the release or the output dies with the
  // session graph. Single helper for all four settlement paths.
  //
  // Issue #179 (D4): an optional failureHeadline is prepended when the run did
  // NOT complete — the extracted prose may come from an earlier turn, so it
  // must not be presented as the run's output unqualified.
  const captureAndReleaseSession = (failureHeadline?: string): void => {
    const output = extractFinalOutput(session);
    setAgentFinalOutput(
      id,
      failureHeadline ? buildFailureHeadline(failureHeadline, output) : output,
    );
    agent._sessionRef = undefined;
  };

  // Issue #122: the session's REAL usage lives on the assistant messages in
  // session.messages — each turn carries the same usage shape accumulateUsage
  // folds (the runner's single source of truth for usage semantics: turns++,
  // sum input/output/cache, cost.total, contextTokens from totalTokens). Fold
  // the session's assistant turns into a fresh stats object and MERGE it onto
  // the agent's result record — never replace: the git-diff branches may have
  // already set exitCode/messages/stderr/gitBranch/gitDiff, and the aborted/
  // failed branches previously OVERWROTE usage with the empty fallback. Runs
  // on every terminal path right before the finalize; must never throw
  // (best-effort, same discipline as markTerminalBestEffort).
  const recordSessionUsage = (): void => {
    try {
      const usage: UsageStats = { ...EMPTY_USAGE };
      for (const msg of session.messages ?? []) {
        if (msg.role === 'assistant') {
          accumulateUsage(usage, msg.usage as Parameters<typeof accumulateUsage>[1]);
        }
      }
      agent.result = {
        // Issue #122: seed the FULL required SubagentResult shape (messages /
        // exitCode / stderr) BEFORE the existing record is spread — the seed
        // only fills fields the record doesn't already have, so real values
        // from the git-diff branches (exitCode 1 on aborted/failed, 0 on
        // completed, plus messages/stderr) always win. A seed AFTER the spread
        // would clobber a real exitCode: 1 back to 0. usage is folded below
        // and merged last so the REAL session usage replaces the branches'
        // EMPTY_USAGE placeholder.
        messages: [],
        exitCode: 0,
        stderr: '',
        ...(agent.result ?? {}),
        usage,
      } as SubagentResult;
    } catch {
      // Usage extraction is best-effort — it must never block the terminal
      // flip, the finalize, or the ref release.
    }
  };

  // W4 (issue #28): git isolation — create a work branch BEFORE the prompt so
  // the background agent's file writes land on the branch, never on the
  // working tree's base branch. There is no interactive approval in background
  // mode, so on completion the diff is captured and the branch is DISCARDED
  // (the diff is recorded on the agent for review); on failure/abort the
  // branch is discarded the same way. A branch that cannot be created is a
  // hard failure — never spawn an unisolated background agent that was asked
  // for isolation (fail-loud, same principle as foreground's fallback but
  // background cannot warn-and-continue safely).
  let headState: HeadState | undefined;
  let workBranchName: string | undefined;
  let releaseGitLock: (() => void) | undefined;
  // Idempotency guard for cleanupWorkBranch: it must be safe to call from both
  // the normal settle path and the catch-all that runs when a settle step
  // throws FIRST (before its own cleanup call). Without this the second call
  // would re-restore/re-delete and log spurious warnings.
  let gitCleanupDone = false;
  const gitCwd = params.cwd ?? ctx.cwd;
  if (params.gitMode === 'branch') {
    // C2: serialize the FULL branch lifecycle per repo. The spawnQueue only
    // covers setup; without this lock, a second concurrent branch-mode spawn
    // would read the first's work branch as its base and both teardowns would
    // fight over the shared working tree (stranding the repo on an orphan
    // branch). The lock is released in cleanupWorkBranch (or on setup throw).
    // Key: resolved repository root, cwd fallback for non-repo paths (#224).
    const lockKey = getRepoRoot(gitCwd) ?? gitCwd;
    const prev = gitBranchLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const entry = prev.then(() => gate);
    gitBranchLocks.set(lockKey, entry);
    await prev;
    releaseGitLock = () => {
      // Delete the map entry ONLY if we are still the head of the chain — a
      // queued spawn behind us replaced the entry with its own.
      if (gitBranchLocks.get(lockKey) === entry) gitBranchLocks.delete(lockKey);
      release();
    };

    try {
      // C1: isolation is only real when the base tree is clean. A dirty tree
      // would ride onto the work branch, get clobbered by the agent's writes,
      // and leak back into the base working tree on switch — refuse loudly.
      if (hasUncommittedChanges(gitCwd)) {
        throw new Error(
          'working tree has uncommitted changes; commit or stash before ' +
          'requesting background gitMode=branch isolation'
        );
      }
      headState = getHeadState(gitCwd);
      const branchResult = createWorkBranch(gitCwd, headState.sha);
      if (branchResult.ok) {
        workBranchName = branchResult.branch;
        log.info('Created work branch for background agent', {
          branch: workBranchName,
          base: headState.branch,
          agentId: id,
        });
      } else {
        throw new Error(`createWorkBranch failed: ${branchResult.error}`);
      }
    } catch (err) {
      // The agent record was already persisted as 'running' above — flip it
      // to 'failed' so no zombie 'running' record survives the refused spawn
      // (get_subagent_result would otherwise report 'running' forever).
      releaseGitLock?.();
      releaseGitLock = undefined;
      // Sanitize ONCE and reuse for the status update and the thrown error.
      const sanitizedError = sanitizeErrorMessage((err as Error).message, effectiveCwd);
      try {
        updateAgentStatus(id, 'failed',
          `gitMode 'branch' requested but work branch setup failed: ${sanitizedError}`);
        // Issue #98: the refused spawn is a failure — finalize the run entry so
        // no zombie 'running' entry survives (lockstep with the record flip).
        finalizeRunEntry('failed',
          `gitMode 'branch' requested but work branch setup failed: ${sanitizedError}`);
        transcript.completeTranscript(id, 'failed');
      } catch { /* ignore */ }
      throw new Error(
        `gitMode 'branch' requested but work branch setup failed: ${sanitizedError}. ` +
        `Refusing to spawn the background agent unisolated.`,
        { cause: err }
      );
    }
  }

  // Branch teardown — commit the agent's work (so the diff is real), capture
  // the diff, switch back to the original branch, delete the work branch, and
  // release the per-repo git lock. Runs on EVERY settle path. C1: agents
  // rarely commit, so captureDiff(base...HEAD) alone would be empty and the
  // uncommitted edits would leak into the base working tree on switch —
  // commitAll first makes the diff real and the switch clean.
  const cleanupWorkBranch = (): { gitBranch?: string; gitDiff?: string } => {
    if (gitCleanupDone || !workBranchName || !headState) return {};
    gitCleanupDone = true;
    const info: { gitBranch?: string; gitDiff?: string } = { gitBranch: workBranchName };
    // The lock MUST be released on every exit path — early returns included.
    try {
      try {
        const stillOnOurBranch = getCurrentBranch(gitCwd) === workBranchName;
        if (!stillOnOurBranch) {
          log.warn(`cleanupWorkBranch: tree moved off ${workBranchName} — skipping switch/delete`, {
            agentId: id,
          });
          return info;
        }
      } catch (err) {
        log.warn(`getCurrentBranch failed during cleanup for background agent ${id}`, {
          error: (err as Error).message,
        });
        return info;
      }
      try {
        // C1: commit the agent's work so captureDiff sees it. If no identity is
        // configured, fall back to capturing the working-tree diff directly.
        const dirty = hasUncommittedChanges(gitCwd);
        if (dirty) {
          const commitResult = commitAll(gitCwd, `brl-subagent ${id}: background work`);
          if (commitResult.ok) {
            log.info('Committed background agent work on work branch', {
              sha: commitResult.sha,
              branch: workBranchName,
              agentId: id,
            });
          } else {
            log.warn(`commitAll failed for background agent ${id} — capturing working diff`, {
              error: commitResult.error,
            });
            const workingDiff = captureWorkingDiff(gitCwd);
            if (workingDiff) info.gitDiff = workingDiff;
          }
        }
        const diffResult = captureDiff(gitCwd, headState.sha);
        if (diffResult.ok && diffResult.diff.trim()) {
          // Merge committed + working diffs — either can exist alone.
          info.gitDiff = info.gitDiff
            ? `${info.gitDiff}\n${diffResult.diff}`
            : diffResult.diff;
        }
      } catch (err) {
        log.warn(`captureDiff failed for background agent ${id}`, { error: (err as Error).message });
      }
      try {
        const restoreResult = restoreHead(gitCwd, headState);
        if (!restoreResult.ok) {
          log.warn(`restoreHead failed for background agent ${id}`, { error: restoreResult.error });
        }
      } catch (err) {
        log.warn(`restoreHead failed for background agent ${id}`, { error: (err as Error).message });
      }
      try {
        deleteBranch(gitCwd, workBranchName);
      } catch (err) {
        log.warn(`deleteBranch failed for background agent ${id}`, { error: (err as Error).message });
      }
    } finally {
      releaseGitLock?.();
      releaseGitLock = undefined;
    }
    return info;
  };

  // Issue #376 (audit D8): the aborted settle path is reached from BOTH
  // handlers — the .then (probe contract: an abort RESOLVES the prompt) and the
  // .catch (the prompt rejects while the agent is already 'stopped'). Both must
  // record the same partial-work result and the same retryable failure, so they
  // share one helper.
  //   - `gitInfo` is caller-captured: cleanupWorkBranch is once-per-run
  //     (idempotent), and the .catch failed path reuses that same capture.
  //   - `stopReason` is caller-supplied: the .then can narrow it from the last
  //     assistant message; the .catch has no message to read.
  const finalizeAbortedRun = (
    gitInfo: { gitBranch?: string; gitDiff?: string },
    stopReason: string,
  ): void => {
    // W4/M1: capture whatever the branch produced before discarding it — an
    // aborted background agent's partial work is still worth reviewing, and
    // must be RECORDED, not just captured-and-deleted.
    if (gitInfo.gitBranch) {
      agent.result = {
        ...(agent.result ?? {}),
        exitCode: 1,
        messages: [],
        stderr: '',
        usage: agent.result?.usage ?? EMPTY_USAGE,
        stopReason: 'aborted',
        gitBranch: gitInfo.gitBranch,
        gitDiff: gitInfo.gitDiff,
      } as SubagentResult;
      agents.set(id, agent);
      persistAgent(agent);
    }
    // Issue #98: aborts/timeouts are retryable failures (retry schema:
    // timeout/abort counts as failure) — finalize the run entry.
    // Issue #122: a timed-out run burned tokens — record the real usage
    // (the git-diff block above must not leave the empty fallback).
    recordSessionUsage();
    // Issue #120 (Track 1): agent.error carries the reason when the stop was a
    // deadline timeout ('Timed out after Xms' → 'timeout'); a user cancel
    // (stop_subagent) sets no error, so fall back to the honest user-abort
    // stamp (→ 'aborted') instead of the old ambiguous 'Aborted or timed out'.
    finalizeRunEntry('failed', agent.error ?? SUBAGENT_ABORTED_MESSAGE, { stopReason });
    // Issue #31: capture the final output while the session is still live,
    // then release the ref on the terminal path (memory retention; the poller
    // treats a nulled ref on a terminal agent as expected).
    captureAndReleaseSession();
  };

  // Issue #53: the settle handlers (.then/.catch below) run in promise
  // callbacks — a throw from any step (fs failure, deleted transcript, emit
  // error) would escape as an uncaughtException and kill the whole pi
  // process. If a handler step throws, log it and best-effort flip the record
  // terminal so no zombie 'running' record survives; never rethrow.
  const markTerminalBestEffort = (fallback: AgentStatus): void => {
    try {
      // Issue #53 / review C: this catch-all fires when a settle handler step
      // threw — possibly BEFORE the branch's own cleanupWorkBranch() call. Run
      // it here too (idempotent) so a throw can never bypass branch teardown
      // and strand the work branch in the repo working tree.
      cleanupWorkBranch();
      // Issue #31 (PR #76 review): this catch-all fires when a settle handler
      // threw — either BEFORE the branch's own capture (ref still live: capture
      // now, it is the last chance to record the session's output) or AFTER it
      // (finalOutput already recorded: never clobber it with a re-capture of a
      // released ref, which would yield ''). Guard on finalOutput to cover both.
      if (agent.finalOutput === undefined) {
        try {
          setAgentFinalOutput(id, extractFinalOutput(agent._sessionRef ?? { messages: [] }));
        } catch {
          // Output capture is best-effort — it must never block the terminal
          // flip or the ref release below.
        }
      }
      if (agent.status !== 'completed' && agent.status !== 'failed' && agent.status !== 'stopped') {
        agent.status = fallback;
      }
      if (!agent.completedAt) agent.completedAt = Date.now();
      // Issue #122: merge the session's real usage even on the catch-all — it
      // fires when a settle handler threw BEFORE the branch's own extraction,
      // so this is the last chance to record the tokens the run burned.
      recordSessionUsage();
      agents.set(id, agent);
      persistAgent(agent);
      // Issue #98 (review F2): derive the run-entry status from the agent
      // record's terminal state — the catch-all fires on ANY settle-handler
      // throw, so hardcoding 'failed' would mislabel a run whose completion
      // branch already flipped the agent to 'completed'.
      // Issue #120 (Review round): the catch-all fires when a settle handler
      // threw — possibly BEFORE the branch's own stamp. A user-cancel whose
      // abort branch never reached its stamped finalize would otherwise record
      // an EMPTY errorMessage and NO errorCategory. Mirror the stamped paths
      // with the honest user-abort fallback so no path is left without a
      // category.
      finalizeRunEntry(
        agent.status === 'completed' ? 'done' : 'failed',
        agent.error ?? SUBAGENT_ABORTED_MESSAGE,
      );
      // Issue #31: the live session ref must not survive terminal paths —
      // including this catch-all, which fires when a settle handler throws.
      agent._sessionRef = undefined;
    } catch {
      // The record may be beyond saving — the process must survive.
    }
  };

  // Emit created event
  eventBus.emit(eventBus.createEvent('subagent:created', id, {
    type: agent.type,
    description: agent.description,
    task: agent.task,
  }));
  
  // Start the session in the background (don't await)
  // The session will run independently
  // F27: wrap in the task-as-data fence — the user message is DATA, not
  // instructions (see SUBAGENT_INSTRUCTIONS Task Boundary).
  // NOTE: if prompt() throws SYNCHRONOUSLY, the .then/.catch below never
  // attach and cleanupWorkBranch would never run — catch here so the work
  // branch is not orphaned (it is a real filesystem branch).
  let runPromise: Promise<unknown>;
  try {
    runPromise = session.prompt(wrapTask(params.task));
  } catch (err) {
    cleanupWorkBranch();
    // Issue #98 (review F1): a synchronous prompt() throw never reaches the
    // settle handlers — finalize the run entry so no zombie 'running' entry
    // survives (findSpawnRunById would otherwise resolve and retry a run that
    // never started).
    finalizeRunEntry('failed', sanitizeErrorMessage((err as Error).message, effectiveCwd));
    throw err;
  }

  // W3 (issue #28): per-agent deadline — abort the session when exceeded.
  // Armed immediately after the prompt call so in-prompt preflight (auth
  // check, model resolution) counts toward the deadline; the abort lands in
  // the .then below as an aborted run (probe contract). We pre-set the status
  // so the .then keeps 'stopped' with the timeout reason recorded. The raw
  // value is normalized here (issue #240): a raw >=2^31 or Infinity would make
  // Node fire the timer at ~1ms (instant kill), so normalizeTimeout maps it to
  // undefined. An explicit timeout is HONORED verbatim (no ceiling); only the
  // no-timeout fallback uses the 30m background default. The `params.timeout`
  // guard below keeps this timer unarmed on the no-timeout path, where the
  // index.ts deadline timer owns the no-timeout default (no redundant timer).
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (params.timeout && params.timeout > 0) {
    timeoutHandle = setTimeout(() => {
      try {
        if (agent.completedAt) return; // already settled — nothing to abort
        updateAgentStatus(id, 'stopped', `Timed out after ${params.timeout}ms`);
        transcript.completeTranscript(id, 'stopped');
        session.abort().catch(() => {
          // Abort can reject if the session is mid-dispose; the status flip
          // above is already recorded, so this is non-fatal.
        });
      } catch (err) {
        // Timer callbacks must never throw uncaught — that crashes the host
        // process. updateAgentStatus/completeTranscript can throw (persist
        // fs failure, transcript deleted); the abort is best-effort.
        log.warn(`spawnBackgroundSession: timeout handler error for ${id}`, {
          error: (err as Error).message,
        });
      }
    }, normalizeTimeout(params.timeout) ?? DEFAULT_BACKGROUND_DEADLINE_MS);
  }

  runPromise.then(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try {
      // Probe contract (sdk-abort-contract.test.ts): prompt() RESOLVES on abort
      // — the SDK's runWithLifecycle catches the AbortError and converts it into
      // a failure message with stopReason "aborted". So an aborted run lands
      // HERE, not in .catch. Two signals distinguish stop from completion:
      //   1. stopAgent pre-set status to 'stopped' before calling abort();
      //   2. the last assistant message carries stopReason "aborted".
      const lastAssistant = [...(session.messages ?? [])].reverse().find(m => m.role === 'assistant');
      const terminalStopReason = lastAssistant?.stopReason;
      const aborted = agent.status === 'stopped' || terminalStopReason === 'aborted';
      if (aborted) {
        // Session was aborted — mark stopped. If stopAgent already flipped the
        // status (pre-set 'stopped' + completedAt + event + transcript), only
        // the transcript note is missing from this path.
        if (agent.status !== 'stopped') {
          updateAgentStatus(id, 'stopped');
          transcript.completeTranscript(id, 'stopped');
        }
        // W4/M1 + #98/#122/#120/#31: the same aborted settle as the .catch
        // stopped branch (issue #376/D8 — one helper, no second copy).
        finalizeAbortedRun(
          cleanupWorkBranch(),
          terminalStopReason && terminalStopReason !== 'stop'
            ? terminalStopReason
            : 'aborted',
        );
        return;
      }
      // Issue #179 (D1/D2): prompt() RESOLVED — but a resolved prompt is NOT
      // proof of success. The SDK's runWithLifecycle catches a mid-run provider
      // death internally and resolves with an assistant message carrying
      // stopReason "error"; the completion branch below would record it as a
      // false success (exitCode 0, no category). Classify the terminal outcome
      // from the last assistant message + the session error, reusing
      // classifyError for the provider-error case.
      const providerErrorMessage =
        lastAssistant?.errorMessage ?? session.state?.errorMessage;
      const outcome = classifyTerminalOutcome(terminalStopReason, providerErrorMessage);

      if (outcome.status === 'failed') {
        // Mid-run provider death / truncation / incomplete turn.
        agent.status = 'failed';
        agent.completedAt = Date.now();
        const sanitizedError = sanitizeErrorMessage(
          providerErrorMessage ?? defaultTerminalMessage(terminalStopReason),
          effectiveCwd,
        );
        agent.error = sanitizedError;
        const gitInfo = cleanupWorkBranch();
        agent.result = {
          ...(agent.result ?? {}),
          exitCode: 1,
          messages: agent.result?.messages ?? [],
          stderr: agent.result?.stderr ?? '',
          usage: agent.result?.usage ?? EMPTY_USAGE,
          stopReason: terminalStopReason,
          errorMessage: sanitizedError,
          errorCategory: outcome.errorCategory,
          ...(gitInfo.gitBranch
            ? { gitBranch: gitInfo.gitBranch, gitDiff: gitInfo.gitDiff }
            : {}),
        } as SubagentResult;
        // Issue #31: capture the final output while the session is still live.
        // Issue #179 (D4): surface the failure as the HEADLINE — the extracted
        // prose may come from an earlier turn, so it must not be presented as an
        // unqualified success narrative.
        captureAndReleaseSession(sanitizedError);
        // Issue #122: fold the real usage (turns/tokens) the run burned.
        recordSessionUsage();
        agents.set(id, agent);
        persistAgent(agent);
        finalizeRunEntry('failed', sanitizedError, {
          stopReason: terminalStopReason,
          errorCategory: outcome.errorCategory,
        });
        transcript.completeTranscript(id, 'failed');
        eventBus.emit(eventBus.createEvent('subagent:failed', id, { error: sanitizedError }));
        return;
      }

      // Session completed
      agent.status = 'completed';
      agent.completedAt = Date.now();
      // W4: capture diff + discard the work branch; record branch info on the
      // agent so the caller can review what the background agent changed.
      const gitInfo = cleanupWorkBranch();
      if (gitInfo.gitBranch) {
        agent.result = {
          ...(agent.result ?? {}),
          exitCode: 0,
          messages: [],
          stderr: '',
          usage: agent.result?.usage ?? EMPTY_USAGE,
          stopReason: terminalStopReason ?? 'stop',
          gitBranch: gitInfo.gitBranch,
          gitDiff: gitInfo.gitDiff,
        } as SubagentResult;
      }
      // Issue #31: capture the final output while the session is still live,
      // then release the ref before the branch's persist — the persisted
      // record is consistent and the live session graph is freed.
      captureAndReleaseSession();
      // Issue #122: merge the session's summed usage onto the result record
      // before the persist + finalize — the entry's cost/tokens are real.
      recordSessionUsage();
      agents.set(id, agent);
      persistAgent(agent);
      // Issue #98: mirror the agent-record flip in the session run entry.
      finalizeRunEntry('done', undefined, { stopReason: terminalStopReason ?? 'stop' });
      transcript.completeTranscript(id, 'completed');
      eventBus.emit(eventBus.createEvent('subagent:completed', id, {}));
    } catch (err) {
      // Issue #53: any throw in this handler would escape as an
      // uncaughtException and kill pi. Log and mark the record terminal —
      // never rethrow.
      log.error(`spawnBackgroundSession: completion handler failed for ${id}`, {
        error: (err as Error).message,
      });
      markTerminalBestEffort('completed');
    }
  }).catch((err: Error) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try {
      // W4: capture partial work + discard the work branch on failure — a failed
      // background agent may still have produced reviewable changes.
      const gitInfo = cleanupWorkBranch();
      // Session failed — genuine preflight/rejection errors only (auth failure,
      // model resolution, invalid task). Abort never rejects (probe contract).
      if (agent.status === 'stopped') {
        // M1: record the partial work even on the stopped path.
        // Issue #376 (D8): identical to the .then aborted branch — the work-branch
        // capture above is reused (cleanupWorkBranch is once-per-run) and there is
        // no last assistant message here to narrow the reason from.
        finalizeAbortedRun(gitInfo, 'aborted');
        // Issue #31: the stopped path is terminal too — its transcript note.
        transcript.completeTranscript(id, 'stopped');
        return;
      }
      agent.status = 'failed';
      agent.completedAt = Date.now();
      // F7 (issue #30): err.message may contain absolute paths (CWD prefixes,
      // spawn commands) — sanitize ONCE here and reuse it for the record, the
      // result errorMessage, and the subagent:failed event (DRY, PR #63 review).
      const sanitizedError = sanitizeErrorMessage(err.message, effectiveCwd);
      agent.error = sanitizedError;
      // Issue #179: record the failure on the result UNCONDITIONALLY (not only
      // on the git-diff path) so a failed run never persists exitCode 0.
      agent.result = {
        ...(agent.result ?? {}),
        exitCode: 1,
        messages: agent.result?.messages ?? [],
        stderr: agent.result?.stderr ?? '',
        usage: agent.result?.usage ?? EMPTY_USAGE,
        // Issue #179 (C1 fix): a genuine preflight/run failure always carries
        // the failure reason — never leave the result with an undefined
        // stopReason that downstream display/aggregate paths read as success.
        stopReason: 'error',
        errorMessage: sanitizedError,
        ...(gitInfo.gitBranch
          ? { gitBranch: gitInfo.gitBranch, gitDiff: gitInfo.gitDiff }
          : {}),
      } as SubagentResult;
      // Issue #31: capture the final output while the session is still live,
      // then release the ref before the branch's persist — the persisted
      // record is consistent and the live session graph is freed.
      // Issue #179 (D4): lead with the failure reason (the prose may be from an
      // earlier turn).
      captureAndReleaseSession(sanitizedError);
      // Issue #122: fold any assistant turns the preflight/run did produce —
      // usually none (auth/model rejection) → honest zeros, never a crash.
      recordSessionUsage();
      agents.set(id, agent);
      persistAgent(agent);
      // Issue #98: mirror the agent-record flip in the session run entry.
      finalizeRunEntry('failed', sanitizedError, { stopReason: 'error' });
      transcript.completeTranscript(id, 'failed');
      eventBus.emit(eventBus.createEvent('subagent:failed', id, { error: sanitizedError }));
    } catch (err) {
      // Issue #53: any throw in this handler would escape as an
      // uncaughtException and kill pi. Log and mark the record terminal —
      // never rethrow.
      log.error(`spawnBackgroundSession: completion handler failed for ${id}`, {
        error: (err as Error).message,
      });
      markTerminalBestEffort('failed');
    }
  });
  
  return agent;
  } finally {
    resolveNext();
  }
}
