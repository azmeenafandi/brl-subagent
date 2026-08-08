import { randomUUID } from 'crypto';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import type { BackgroundAgent, AgentStatus, GitMode, SubagentResult, ThinkingLevel, SubagentToolOptions } from './types';
import { EMPTY_USAGE } from './types';
import * as eventBus from './event-bus';
import * as transcript from './transcript';
import { createEvent } from './event-bus';
import { assertSafeAgentId, sanitizeErrorMessage } from './sanitize';
import { wrapTask } from './prompt';
import { createLogger } from './logging';
import { getCurrentBranch, createWorkBranch, captureDiff, switchToBranch, deleteBranch, hasUncommittedChanges, commitAll, captureWorkingDiff } from './git';

const log = createLogger('brl-subagent');
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// Serialize concurrent spawn attempts — pi's API modules aren't safe for
// concurrent access from extensions.
var spawnQueue: Promise<void> = Promise.resolve();

// C2: per-repo locks serializing the FULL gitMode=branch lifecycle (setup →
// settle → teardown). Keyed by cwd because different repos don't conflict.
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
    console.error(`[brl-subagent] Refusing to persist agent with invalid id: ${agent.id}`);
    return;
  }
  ensureStorageDir();
  const filePath = join(STORAGE_DIR, `${agent.id}.json`);
  // Strip live/non-serializable fields before stringify — `_sessionRef` holds the
  // ENTIRE live pi session graph (1.4MB+ for an empty session, and uninitialized
  // getters like Theme can make JSON.stringify throw).
  const { _sessionRef, ...persistable } = agent;
  try {
    // F6 (issue #29): records contain task, error, result.messages (full
    // conversation) and finalOutput — write owner-only (0o600) so other local
    // users cannot read subagent tasks/output. mode applies on file CREATE;
    // pre-existing files keep their old mode (not retroactive).
    writeFileSync(filePath, JSON.stringify(persistable, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // Log but never throw — persistence must not break execution
    console.error(`[brl-subagent] Failed to persist agent ${agent.id}:`, err);
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
 * Create a new background agent session
 * 
 * NOTE: In v2.0.3, this creates a record but does NOT actually spawn a pi session.
 * The actual session spawning will be implemented when pi's ExtensionAPI supports it.
 * For now, this is a placeholder that creates the agent record.
 */
export function createSession(params: {
  task: string;
  type?: string;
  description?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
}): BackgroundAgent {
  const id = generateUUID();
  const agent: BackgroundAgent = {
    id,
    sessionId: `session-${id}`,
    type: params.type || 'general-purpose',
    description: params.description || params.task.slice(0, 50),
    status: 'pending',
    startedAt: Date.now(),
    task: params.task,
    model: params.model || 'unknown',
    thinkingLevel: params.thinkingLevel || 'medium',
  };
  
  agents.set(id, agent);
  persistAgent(agent);

  // Start transcript for this agent
  transcript.startTranscript(agent.id, params.task);

  eventBus.emit(eventBus.createEvent('subagent:created', agent.id, {
    type: agent.type,
    description: agent.description,
    task: agent.task,
  }));

  return agent;
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
 * List all background agents
 */
export function listAgents(): BackgroundAgent[] {
  ensureStorageDir();
  const files = readdirSync(STORAGE_DIR).filter(f => f.endsWith('.json'));
  const result: BackgroundAgent[] = [];
  
  for (const file of files) {
    const id = file.replace('.json', '');
    const agent = agents.get(id) || loadAgent(id);
    if (agent) result.push(agent);
  }
  
  return result.sort((a, b) => b.startedAt - a.startedAt);
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
 * Set agent result
 */
export function setAgentResult(id: string, result: SubagentResult): BackgroundAgent | null {
  const agent = getAgent(id);
  if (!agent) return null;
  
  agent.result = result;
  agent.status = result.exitCode === 0 ? 'completed' : 'failed';
  agent.completedAt = Date.now();
  
  agents.set(id, agent);
  persistAgent(agent);
  return agent;
}

/**
 * Extract the final assistant text from a session's messages.
 * Falls back to the LAST assistant message with non-empty text content — the
 * final message is often a tool-call-only turn (agent stopped mid-turn, failed,
 * or hit the hard cap), and that turn carries no text of its own.
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
 * Steer a running agent by injecting a message
 * 
 * NOTE: In v2.0.3, this is a placeholder.
 * Actual message injection will be implemented when pi's ExtensionAPI supports it.
 */
export function steerAgent(id: string, message: string): BackgroundAgent | null {
  const agent = getAgent(id);
  if (!agent) return null;
  if (agent.status !== 'running') {
    throw new Error(`Cannot steer agent ${id}: status is ${agent.status}, not running`);
  }

  // Record steering in transcript
  transcript.appendEntry(id, 'user', `Steering: ${message}`);

  agent.status = 'steered';
  agents.set(id, agent);
  persistAgent(agent);

  eventBus.emit(eventBus.createEvent('subagent:steered', agent.id, { message }));

  return agent;
}

/**
 * Get transcript path for an agent
 */
export function getTranscriptPath(id: string): string {
  // F24: reachable with LLM-controlled ids (get_agent_result). Throw on invalid
  // ids — the tool caller surfaces it as an error. (Defense in depth: getAgent
  // already validated before this is reached with a live agent.)
  assertSafeAgentId(id);
  return join('.pi', 'output', `agent-${id}.jsonl`);
}

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
  
  // Create session manager for this background agent
  const sessionManager = SessionManager.inMemory(effectiveCwd);
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
    modelRegistry: ctx.modelRegistry,
    resourceLoader,
    model: resolvedModel,
    thinkingLevel: params.thinkingLevel,
    tools: bgTools ?? ['read', 'bash', 'grep', 'find', 'ls', 'write', 'edit'],
    ...(bgExcludeTools ? { excludeTools: bgExcludeTools } : {}),
    ...(params.toolOptions?.noBuiltinTools ? { noTools: 'builtin' as const } : {}),
  });
  
  // Set session name
  session.setSessionName(`background-${id.slice(0, 8)}`);
  
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
  };
  
  agents.set(id, agent);
  persistAgent(agent);
  
  // Start transcript for this agent
  transcript.startTranscript(agent.id, params.task);

  // Store session ref for live monitor polling
  agent._sessionRef = session;

  // W4 (issue #28): git isolation — create a work branch BEFORE the prompt so
  // the background agent's file writes land on the branch, never on the
  // working tree's base branch. There is no interactive approval in background
  // mode, so on completion the diff is captured and the branch is DISCARDED
  // (the diff is recorded on the agent for review); on failure/abort the
  // branch is discarded the same way. A branch that cannot be created is a
  // hard failure — never spawn an unisolated background agent that was asked
  // for isolation (fail-loud, same principle as foreground's fallback but
  // background cannot warn-and-continue safely).
  let originalBranch: string | undefined;
  let workBranchName: string | undefined;
  let releaseGitLock: (() => void) | undefined;
  const gitCwd = params.cwd ?? ctx.cwd;
  if (params.gitMode === 'branch') {
    // C2: serialize the FULL branch lifecycle per repo. The spawnQueue only
    // covers setup; without this lock, a second concurrent branch-mode spawn
    // would read the first's work branch as its base and both teardowns would
    // fight over the shared working tree (stranding the repo on an orphan
    // branch). The lock is released in cleanupWorkBranch (or on setup throw).
    const prev = gitBranchLocks.get(gitCwd) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const entry = prev.then(() => gate);
    gitBranchLocks.set(gitCwd, entry);
    await prev;
    releaseGitLock = () => {
      // Delete the map entry ONLY if we are still the head of the chain — a
      // queued spawn behind us replaced the entry with its own.
      if (gitBranchLocks.get(gitCwd) === entry) gitBranchLocks.delete(gitCwd);
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
      originalBranch = getCurrentBranch(gitCwd);
      const branchResult = createWorkBranch(gitCwd, originalBranch);
      if (branchResult.ok) {
        workBranchName = branchResult.branch;
        log.info('Created work branch for background agent', {
          branch: workBranchName,
          base: originalBranch,
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
    if (!workBranchName || !originalBranch) return {};
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
        const diffResult = captureDiff(gitCwd, originalBranch);
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
        switchToBranch(gitCwd, originalBranch);
      } catch (err) {
        log.warn(`switchToBranch failed for background agent ${id}`, { error: (err as Error).message });
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

  // Issue #53: the settle handlers (.then/.catch below) run in promise
  // callbacks — a throw from any step (fs failure, deleted transcript, emit
  // error) would escape as an uncaughtException and kill the whole pi
  // process. If a handler step throws, log it and best-effort flip the record
  // terminal so no zombie 'running' record survives; never rethrow.
  const markTerminalBestEffort = (fallback: AgentStatus): void => {
    try {
      if (agent.status !== 'completed' && agent.status !== 'failed' && agent.status !== 'stopped') {
        agent.status = fallback;
      }
      if (!agent.completedAt) agent.completedAt = Date.now();
      agents.set(id, agent);
      persistAgent(agent);
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
    throw err;
  }

  // W3 (issue #28): per-agent deadline — abort the session when exceeded.
  // Armed immediately after the prompt call so in-prompt preflight (auth
  // check, model resolution) counts toward the deadline; the abort lands in
  // the .then below as an aborted run (probe contract). We pre-set the status
  // so the .then keeps 'stopped' with the timeout reason recorded. The value
  // is normalized upstream (normalizeTimeout) but clamp again here — a raw
  // >=2^31 or Infinity would make Node fire the timer at ~1ms (instant kill).
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
    }, Math.min(params.timeout, 30 * 60 * 1000));
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
      const aborted = agent.status === 'stopped' || lastAssistant?.stopReason === 'aborted';
      if (aborted) {
        // Session was aborted — mark stopped. If stopAgent already flipped the
        // status (pre-set 'stopped' + completedAt + event + transcript), only
        // the transcript note is missing from this path.
        if (agent.status !== 'stopped') {
          updateAgentStatus(id, 'stopped');
          transcript.completeTranscript(id, 'stopped');
        }
        // W4/M1: capture whatever the branch produced before discarding it — an
        // aborted background agent's partial work is still worth reviewing, and
        // must be RECORDED, not just captured-and-deleted.
        const gitInfo = cleanupWorkBranch();
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
        // Issue #31: capture the final output while the session is still
        // live, then release the ref on the terminal path (memory retention;
        // the poller treats a nulled ref on a terminal agent as expected).
        setAgentFinalOutput(id, extractFinalOutput(session));
        agent._sessionRef = undefined;
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
          gitBranch: gitInfo.gitBranch,
          gitDiff: gitInfo.gitDiff,
        } as SubagentResult;
      }
      // Issue #31: capture the final output while the session is still live,
      // then release the ref before the branch's persist — the persisted
      // record is consistent and the live session graph is freed.
      setAgentFinalOutput(id, extractFinalOutput(session));
      agent._sessionRef = undefined;
      agents.set(id, agent);
      persistAgent(agent);
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
        // Issue #31: the stopped path is terminal too — release the ref.
        setAgentFinalOutput(id, extractFinalOutput(session));
        agent._sessionRef = undefined;
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
      if (gitInfo.gitBranch) {
        agent.result = {
          ...(agent.result ?? {}),
          exitCode: 1,
          messages: [],
          stderr: '',
          usage: agent.result?.usage ?? EMPTY_USAGE,
          errorMessage: sanitizedError,
          gitBranch: gitInfo.gitBranch,
          gitDiff: gitInfo.gitDiff,
        } as SubagentResult;
      }
      // Issue #31: capture the final output while the session is still live,
      // then release the ref before the branch's persist — the persisted
      // record is consistent and the live session graph is freed.
      setAgentFinalOutput(id, extractFinalOutput(session));
      agent._sessionRef = undefined;
      agents.set(id, agent);
      persistAgent(agent);
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
