import { randomUUID } from 'crypto';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import type { BackgroundAgent, AgentStatus, SubagentResult, ThinkingLevel } from './types';
import { EMPTY_USAGE } from './types';
import * as eventBus from './event-bus';
import * as transcript from './transcript';
import { createEvent } from './event-bus';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createAgentSession, SessionManager, getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';

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
  ensureStorageDir();
  const filePath = join(STORAGE_DIR, `${agent.id}.json`);
  writeFileSync(filePath, JSON.stringify(agent, null, 2), 'utf-8');
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
  const agentDir = getAgentDir();
  
  // Create session manager for this background agent
  const sessionManager = SessionManager.inMemory(effectiveCwd);
  const settingsManager = SettingsManager.create(effectiveCwd);
  
  // Create the session
  const { session } = await createAgentSession({
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRegistry: ctx.modelRegistry,
    tools: ['read', 'bash', 'grep', 'find', 'ls', 'write', 'edit'],
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
