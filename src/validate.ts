/**
 * H1: Pre-task validation
 *
 * Deterministic checks that validate a subagent's tool configuration
 * and thinking level match the task description. Runs in code (not
 * LLM context), so it's consistent regardless of conductor state.
 */

import type { ThinkingLevel, SubagentToolOptions } from './types';
import { THINKING_LEVELS } from './types';

// ── Types ────────────────────────────────────────────────────────────

export interface ValidateConfig {
  task: string;
  toolOptions?: SubagentToolOptions;
  thinkingLevel?: ThinkingLevel;
  gitMode?: string;
}

export interface ValidateResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

// ── Keyword patterns ─────────────────────────────────────────────────

interface ToolRequirement {
  patterns: RegExp[];
  requiredTools: string[];
  description: string;
}

const TOOL_REQUIREMENTS: ToolRequirement[] = [
  {
    patterns: [/\b(write|create|generate|build|implement|add|insert|append)\b/i],
    requiredTools: ['write', 'edit'],
    description: 'task involves writing/creating files',
  },
  {
    patterns: [/\b(edit|modify|update|change|fix|patch|refactor|rename)\b/i],
    requiredTools: ['write', 'edit'],
    description: 'task involves editing files',
  },
  {
    patterns: [/\b(run|execute|test|benchmark|compile|install|deploy|npm|yarn|pnpm|cargo|pip|vitest)\b/i],
    requiredTools: ['bash'],
    description: 'task involves running commands',
  },
  {
    patterns: [/\b(delete|remove|clean|prune|uninstall|rm)\b/i],
    requiredTools: ['write', 'bash'],
    description: 'task involves deleting files',
  },
  {
    patterns: [/\b(commit|push|pull|merge|rebase|checkout|branch)\b/i],
    requiredTools: ['bash'],
    description: 'task involves git operations',
  },
  {
    patterns: [/\b(audit|review|analyze|examine|check|inspect|scan|read)\b/i],
    requiredTools: ['read'],
    description: 'task involves reading/analyzing files',
  },
];

interface ThinkingRequirement {
  patterns: RegExp[];
  minLevel: ThinkingLevel;
  description: string;
}

const THINKING_REQUIREMENTS: ThinkingRequirement[] = [
  {
    patterns: [/\b(security|vulnerability|exploit|injection|attack|penetration)\b/i],
    minLevel: 'high',
    description: 'security analysis',
  },
  {
    patterns: [/\b(debug|diagnose|root.cause|race.condition|deadlock|memory.leak)\b/i],
    minLevel: 'high',
    description: 'complex debugging',
  },
  {
    patterns: [/\b(architecture|design|refactor|migration|breaking.change)\b/i],
    minLevel: 'medium',
    description: 'architectural work',
  },
  {
    patterns: [/\b(implement|develop|build|feature)\b/i],
    minLevel: 'medium',
    description: 'implementation work',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

function thinkingLevelIndex(level: ThinkingLevel): number {
  return THINKING_LEVELS.indexOf(level);
}

function isToolAvailable(
  toolName: string,
  toolOptions?: SubagentToolOptions,
): boolean {
  if (toolOptions?.excludeTools?.includes(toolName)) return false;
  if (toolOptions?.tools && !toolOptions.tools.includes(toolName)) return false;
  return true;
}

// ── Main validation ──────────────────────────────────────────────────

export function validatePreTask(config: ValidateConfig): ValidateResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const taskText = config.task || '';

  // Skip validation for empty tasks (chain/parallel/graph don't always have task)
  if (!taskText.trim()) {
    return { valid: true, warnings: [], errors: [] };
  }

  // Check tool requirements
  for (const req of TOOL_REQUIREMENTS) {
    const matches = req.patterns.some(p => p.test(taskText));
    if (!matches) continue;

    for (const tool of req.requiredTools) {
      if (!isToolAvailable(tool, config.toolOptions)) {
        errors.push(
          `Task ${req.description} but '${tool}' is not available (tools=${config.toolOptions?.tools?.join(',') ?? 'all'}, excludeTools=${config.toolOptions?.excludeTools?.join(',') ?? 'none'})`,
        );
      }
    }
  }

  // Check git mode
  const gitPatterns = [/\b(commit|push|pull|merge|rebase|checkout|branch|pr|pull.request)\b/i];
  if (gitPatterns.some(p => p.test(taskText)) && config.gitMode === 'none') {
    warnings.push(
      `Task involves git operations but gitMode is 'none' — subagent cannot create commits or branches`,
    );
  }

  // Check thinking level recommendations
  for (const req of THINKING_REQUIREMENTS) {
    const matches = req.patterns.some(p => p.test(taskText));
    if (!matches) continue;

    const taskLevel = config.thinkingLevel ? thinkingLevelIndex(config.thinkingLevel) : -1;
    const minLevel = thinkingLevelIndex(req.minLevel);

    if (taskLevel >= 0 && taskLevel < minLevel) {
      warnings.push(
        `Task involves ${req.description} but thinkingLevel is '${config.thinkingLevel}' — consider '${req.minLevel}' or higher`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}
