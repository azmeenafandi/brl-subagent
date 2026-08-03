import { randomUUID } from 'crypto';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import type { BackgroundAgent, AgentStatus, SubagentResult, ThinkingLevel, SubagentToolOptions } from './types';
import { EMPTY_USAGE } from './types';
import * as eventBus from './event-bus';
import * as transcript from './transcript';
import { createEvent } from './event-bus';
import { assertSafeAgentId } from './sanitize';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// Serialize concurrent spawn attempts — pi's API modules aren't safe for
// concurrent access from extensions.
var spawnQueue: Promise<void> = Promise.resolve();

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

// Persistence directory
const STORAGE_DIR = '.pi/subagents';

/**
 * Ensure storage directory exists
 */
function ensureStorageDir(): void {
  mkdirSync(STORAGE_DIR, { recursive: true });
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
    writeFileSync(filePath, JSON.stringify(persistable, null, 2), 'utf-8');
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
 * Stop a running agent
 * 
 * NOTE: In v2.0.3, this just marks the agent as stopped.
 * Actual session termination will be implemented when pi's ExtensionAPI supports it.
 */
export function stopAgent(id: string): BackgroundAgent | null {
  const result = updateAgentStatus(id, 'stopped');
  if (result) {
    transcript.completeTranscript(id, 'stopped');
  }
  return result;
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

  // Emit created event
  eventBus.emit(eventBus.createEvent('subagent:created', id, {
    type: agent.type,
    description: agent.description,
    task: agent.task,
  }));
  
  // Start the session in the background (don't await)
  // The session will run independently
  session.prompt(params.task).then(() => {
    // Session completed
    agent.status = 'completed';
    agent.completedAt = Date.now();
    agents.set(id, agent);
    persistAgent(agent);
    transcript.completeTranscript(id, 'completed');
    eventBus.emit(eventBus.createEvent('subagent:completed', id, {}));
  }).catch((err: Error) => {
    // Session failed
    agent.status = 'failed';
    agent.completedAt = Date.now();
    agent.error = err.message;
    agents.set(id, agent);
    persistAgent(agent);
    transcript.completeTranscript(id, 'failed');
    eventBus.emit(eventBus.createEvent('subagent:failed', id, { error: err.message }));
  });
  
  return agent;
  } finally {
    resolveNext();
  }
}
