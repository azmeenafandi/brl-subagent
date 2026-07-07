/**
 * brl-subagent — Skill-based Routing
 *
 * Auto-classify a task description to the best preset personality
 * using keyword matching.
 */

import type { SubagentPreset } from "./types";

// ---------------------------------------------------------------------------
// Classification rules — ordered by priority
// ---------------------------------------------------------------------------

interface ClassificationRule {
	preset: string;
	keywords: string[];
}

const CLASSIFICATION_RULES: ClassificationRule[] = [
	{
		preset: "security-auditor",
		keywords: [
			"audit", "security", "vulnerability", "owasp", "cve",
			"exploit", "threat", "penetration", "injection", "xss",
			"csrf", "auth bypass",
		],
	},
	{
		preset: "code-reviewer",
		keywords: [
			"review", "code review", "pr", "pull request", "quality",
			"best practice", "anti-pattern",
		],
	},
	{
		preset: "test-engineer",
		keywords: [
			"test", "unit test", "integration test", "coverage", "mock",
			"assertion", "spec", "tdd", "bdd",
		],
	},
	{
		preset: "tech-writer",
		keywords: [
			"document", "readme", "api doc", "manual", "guide",
			"tutorial", "write docs",
		],
	},
	{
		preset: "debugger",
		keywords: [
			"debug", "bug", "fix", "crash", "error", "trace",
			"diagnose", "root cause", "reproduce",
		],
	},
	{
		preset: "refactorer",
		keywords: [
			"refactor", "restructure", "clean up", "dry", "extract",
			"simplify", "rename", "reorganize",
		],
	},
	{
		preset: "data-analyst",
		keywords: [
			"analyze", "data", "metrics", "statistics", "chart",
			"visualize", "report", "query", "aggregate",
		],
	},
	{
		preset: "rapid-prototyper",
		keywords: [
			"prototype", "quick", "fast", "hack", "poc", "spike",
			"experiment",
		],
	},
	{
		preset: "dev-agent",
		keywords: [
			"implement", "build", "develop", "code", "write", "create",
			"add", "change", "modify", "edit",
		],
	},
];

/**
 * Check if a keyword matches within a task string.
 * Uses word-boundary matching for short keywords (<=3 chars) to avoid
 * false positives (e.g., "pr" matching inside "prototype").
 */
function keywordMatches(lower: string, keyword: string): boolean {
	if (keyword.length <= 3) {
		const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`);
		return re.test(lower);
	}
	return lower.includes(keyword);
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Auto-classify a task description to the best preset personality.
 * Uses case-insensitive keyword matching, checked in priority order.
 * Returns the first matching preset name, or undefined if no match.
 */
export function autoRoutePreset(
	task: string,
	presets: SubagentPreset[],
): string | undefined {
	if (!task || task.trim().length === 0) return undefined;

	const lower = task.toLowerCase();

	for (const rule of CLASSIFICATION_RULES) {
		// Only match if the preset actually exists in the available presets
		if (!presets.some((p) => p.name === rule.preset)) continue;

		for (const keyword of rule.keywords) {
			if (keywordMatches(lower, keyword)) {
				return rule.preset;
			}
		}
	}

	return undefined;
}
