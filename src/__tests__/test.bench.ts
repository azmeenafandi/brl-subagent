/**
 * brl-subagent — Performance Benchmarks (R8)
 *
 * Measures throughput (ops/sec) and average time for key operations.
 * Uses Vitest bench API: bench(name, fn) and describe(name, fn).
 *
 * Run: npx vitest bench run
 */

import { bench, describe } from "vitest";
import { buildSubagentPrompt } from "../prompt";
import { parseFrontmatter } from "../presets";
import { classifyError, formatUsageStats, EMPTY_USAGE } from "../types";
import { cleanupRuns, resolveRetryParams } from "../history";
import { sanitizeTask, getSafeEnv } from "../sanitize";
import type { SubagentRun, UsageStats } from "../types";

// ===========================================================================
// 1. buildSubagentPrompt — all 4 inheritance modes
// ===========================================================================

const BASE_PROMPT =
	"You are an expert coding assistant operating inside pi, a coding agent harness. " +
	"You help users by reading files, executing commands, editing code, and writing new files.\n\n" +
	"Available tools:\n- read: Read file contents\n- grep: Search file contents for patterns\n" +
	"- find: Find files by glob pattern\n- write: Create or overwrite files\n\n" +
	"Guidelines:\n- Use read to examine files instead of cat or sed.\n" +
	"- Use write only for new files or complete rewrites.\n- Be concise in your responses\n" +
	"- Show file paths clearly when working with files";

const CUSTOM_PROMPT =
	"You are **Security Auditor**, a specialist in application security and vulnerability assessment.\n\n" +
	"## Audit Focus Areas\n1. **Injection** — SQL, command, LDAP, XSS\n" +
	"2. **Authentication** — Broken auth, session management, credential storage\n" +
	"3. **Authorization** — IDOR, privilege escalation, missing access controls\n" +
	"4. **Data Exposure** — Sensitive data in logs, responses, error messages\n" +
	"5. **Input Validation** — Missing sanitization, type coercion, boundary checks\n" +
	"6. **Dependencies** — Known CVEs, outdated packages";

const OUTPUT_FILE = "/home/user/project/reports/audit.md";

describe("buildSubagentPrompt", () => {
	bench("inherit=true, custom=unset", () => {
		buildSubagentPrompt(BASE_PROMPT, true, undefined);
	});

	bench("inherit=true, custom=set", () => {
		buildSubagentPrompt(BASE_PROMPT, true, CUSTOM_PROMPT);
	});

	bench("inherit=true, custom=set, outputFile", () => {
		buildSubagentPrompt(BASE_PROMPT, true, CUSTOM_PROMPT, OUTPUT_FILE);
	});

	bench("inherit=false, custom=set", () => {
		buildSubagentPrompt(BASE_PROMPT, false, CUSTOM_PROMPT);
	});

	bench("inherit=false, custom=unset (bare minimum)", () => {
		buildSubagentPrompt(BASE_PROMPT, false, undefined);
	});
});

// ===========================================================================
// 2. parseFrontmatter — with realistic preset content
// ===========================================================================

const SECURITY_AUDITOR_CONTENT = `---
name: security-auditor
description: Security-focused audit with OWASP and vulnerability patterns
thinkingLevel: high
tools:
  - read
  - grep
  - find
  - ls
excludeTools:
  - write
  - edit
  - bash
noBuiltinTools: false
---

# Security Auditor

You are **Security Auditor**, a specialist in application security and vulnerability assessment.

## Audit Focus Areas

1. **Injection** — SQL, command, LDAP, XSS
2. **Authentication** — Broken auth, session management, credential storage
3. **Authorization** — IDOR, privilege escalation, missing access controls
4. **Data Exposure** — Sensitive data in logs, responses, error messages
5. **Input Validation** — Missing sanitization, type coercion, boundary checks
6. **Dependencies** — Known CVEs, outdated packages

## Output Format

For each finding:

- **Severity**: Critical / High / Medium / Low / Informational
- **Location**: file:line
- **Description**: What and why it's a problem
- **Impact**: What an attacker could do
- **Remediation**: Specific fix with code example
`;

// Content without frontmatter (fallback path)
const PLAIN_MD_CONTENT = `# Plain Document

This is a markdown document without any YAML frontmatter.
The parser should return empty meta and the full body.`;

// Content with extensive frontmatter (worst-case parse)
const LARGE_FRONTMATTER_CONTENT = `---
name: code-reviewer
description: A very detailed code review preset with lots of metadata
thinkingLevel: very high
inheritSystemPrompt: true
tools:
  - read
  - grep
  - find
  - ls
  - write
  - edit
  - bash
  - delegate_task
  - vcc_recall
  - intercom
excludeTools:
  - bash
  - vcc_recall
noBuiltinTools: false
timeout: 300000
outputFile: /tmp/review.md
tags:
  - code-quality
  - review
  - best-practices
  - typescript
  - testing
---

# Code Reviewer

You are **Code Reviewer**, a specialist in code quality and best practices.
`;

describe("parseFrontmatter", () => {
	bench("security-auditor preset (with arrays)", () => {
		parseFrontmatter(SECURITY_AUDITOR_CONTENT);
	});

	bench("plain markdown (no frontmatter)", () => {
		parseFrontmatter(PLAIN_MD_CONTENT);
	});

	bench("large frontmatter (many keys + arrays)", () => {
		parseFrontmatter(LARGE_FRONTMATTER_CONTENT);
	});
});

// ===========================================================================
// 3. classifyError — all 9 categories
// ===========================================================================

function makeResult(overrides: Partial<{
	exitCode: number;
	stopReason: string;
	errorMessage: string;
	stderr: string;
}> = {}) {
	return {
		messages: [],
		usage: { ...EMPTY_USAGE },
		exitCode: 0,
		stderr: "",
		...overrides,
	} as Parameters<typeof classifyError>[0];
}

// Build one result per error category for realistic benchmarking
const ERROR_CASES: Array<{ name: string; result: ReturnType<typeof makeResult> }> = [
	{ name: "aborted", result: makeResult({ stopReason: "aborted" }) },
	{ name: "timeout", result: makeResult({ errorMessage: "Subagent timed out after 30000ms" }) },
	{
		name: "model_unavailable",
		result: makeResult({ errorMessage: "model not found: gpt-5 does not exist" }),
	},
	{
		name: "permission_denied",
		result: makeResult({ stderr: "EACCES: permission denied, open '/etc/shadow'" }),
	},
	{
		name: "parse_error",
		result: makeResult({ stderr: "parse error: unexpected token at line 42" }),
	},
	{
		name: "crash",
		result: makeResult({ stderr: "panic: runtime error: invalid memory address or nil pointer" }),
	},
	{
		name: "tool_error",
		result: makeResult({ errorMessage: "spawn pi ENOENT" }),
	},
	{
		name: "exit_error",
		result: makeResult({ exitCode: 1, stderr: "FATAL: something went wrong" }),
	},
	{
		name: "unknown",
		result: makeResult({ exitCode: 0 }),
	},
];

describe("classifyError", () => {
	for (const { name, result } of ERROR_CASES) {
		bench(name, () => {
			classifyError(result);
		});
	}
});

// ===========================================================================
// 4. cleanupRuns — 1000 and 10000 entries
// ===========================================================================

function makeRun(id: string, startedAt: string): SubagentRun {
	return {
		id,
		task: `task-${id}${"x".repeat(80)}`,
		status: "done",
		model: "anthropic/claude-sonnet-4-20250514",
		thinkingLevel: "high",
		startedAt,
		cost: 0.0234,
		tokensIn: 1500,
		tokensOut: 450,
		durationMs: 12345,
		finishedAt: new Date(new Date(startedAt).getTime() + 12345).toISOString(),
	};
}

// Pre-build run arrays so time-to-construct doesn't pollute the benchmark
function buildRuns(count: number): SubagentRun[] {
	const base = new Date("2025-01-01T00:00:00Z").getTime();
	return Array.from({ length: count }, (_, i) =>
		makeRun(String(i), new Date(base - i * 60_000).toISOString()),
	);
}

const RUNS_1K = buildRuns(1000);
const RUNS_10K = buildRuns(10000);
const RUNS_501 = buildRuns(501); // just over typical default (500)

describe("cleanupRuns", () => {
	bench("1000 entries → keep 500 (default)", () => {
		cleanupRuns(RUNS_1K, 500);
	});

	bench("10000 entries → keep 500", () => {
		cleanupRuns(RUNS_10K, 500);
	});

	bench("501 entries → keep 500 (boundary)", () => {
		cleanupRuns(RUNS_501, 500);
	});

	bench("1000 entries → unlimited (maxEntries=0)", () => {
		cleanupRuns(RUNS_1K, 0);
	});

	bench("empty array", () => {
		cleanupRuns([], 500);
	});
});

// ===========================================================================
// 5. formatUsageStats — with full UsageStats object
// ===========================================================================

const FULL_USAGE: UsageStats = {
	input: 4523,
	output: 1287,
	cacheRead: 980,
	cacheWrite: 340,
	cost: 0.0532,
	contextTokens: 5800,
	turns: 3,
};

const MINIMAL_USAGE: UsageStats = { ...EMPTY_USAGE };

const LARGE_USAGE: UsageStats = {
	input: 485_000,
	output: 95_000,
	cacheRead: 120_000,
	cacheWrite: 45_000,
	cost: 2.4578,
	contextTokens: 605_000,
	turns: 12,
};

describe("formatUsageStats", () => {
	bench("full usage object", () => {
		formatUsageStats(FULL_USAGE, "anthropic/claude-sonnet-4-20250514");
	});

	bench("empty/minimal usage", () => {
		formatUsageStats(MINIMAL_USAGE);
	});

	bench("large token counts (hundreds of thousands)", () => {
		formatUsageStats(LARGE_USAGE, "openai/gpt-4o");
	});
});

// ===========================================================================
// 6. sanitizeTask — normal-length tasks
// ===========================================================================

const SHORT_TASK = "Review the src/ directory for TypeScript errors.";
const MEDIUM_TASK =
	"Audit the authentication module for security vulnerabilities. " +
	"Check for SQL injection, XSS, CSRF, and broken access controls. " +
	"Report all findings with severity levels and file locations.";
const LONG_TASK =
	"Conduct a comprehensive security audit of the entire codebase. " +
	"Focus on:\n" +
	"1. Injection vulnerabilities (SQL, NoSQL, command, LDAP)\n" +
	"2. Broken authentication and session management\n" +
	"3. Sensitive data exposure in logs, error messages, and API responses\n" +
	"4. XML External Entities (XXE) processing\n" +
	"5. Broken access control and privilege escalation\n" +
	"6. Security misconfiguration in deployment and CI/CD\n" +
	"7. Cross-Site Scripting (XSS) in user-facing components\n" +
	"8. Insecure deserialization\n" +
	"9. Using components with known vulnerabilities\n" +
	"10. Insufficient logging and monitoring\n\n" +
	"For each finding, provide: severity, file:line location, description, impact, and remediation.\n" +
	"Use the OWASP Top 10 classification system.";

describe("sanitizeTask", () => {
	bench("short task (50 chars)", () => {
		sanitizeTask(SHORT_TASK);
	});

	bench("medium task (200 chars)", () => {
		sanitizeTask(MEDIUM_TASK);
	});

	bench("long task (~1000 chars)", () => {
		sanitizeTask(LONG_TASK);
	});
});

// ===========================================================================
// 7. resolveRetryParams — parameter merging with various combinations
// ===========================================================================

const BASE_PARAMS = {
	task: "Audit the entire codebase for security issues",
	systemPrompt: "You are a security expert.",
	inheritSystemPrompt: true,
	thinkingLevel: "high" as const,
	outputFile: "/tmp/audit.md",
	timeout: 300_000,
	cwd: "/home/user/project",
	tools: ["read", "grep", "find", "ls"] as string[],
	excludeTools: ["write", "edit", "bash"] as string[],
	noBuiltinTools: false,
	retryOnTimeout: true,
};

const PARTIAL_PARAMS = {
	task: "New audit task",
	// All other fields intentionally undefined — should fall back to original
};

const OVERRIDE_PARAMS = {
	task: "Different task entirely",
	inheritSystemPrompt: false,
	thinkingLevel: "off" as const,
	timeout: 60_000,
};

const BASE_RUN: SubagentRun = {
	id: "run-abc-123",
	task: BASE_PARAMS.task,
	status: "failed",
	model: "anthropic/claude-sonnet-4-20250514",
	thinkingLevel: "high",
	startedAt: "2025-06-01T12:00:00Z",
	finishedAt: "2025-06-01T12:00:30Z",
	durationMs: 30000,
	cost: 0.05,
	tokensIn: 2000,
	tokensOut: 800,
	errorMessage: "Subagent timed out after 30000ms",
	outputSummary: "Audit started but timed out",
	originalParams: {
		systemPrompt: BASE_PARAMS.systemPrompt,
		inheritSystemPrompt: BASE_PARAMS.inheritSystemPrompt,
		thinkingLevel: BASE_PARAMS.thinkingLevel,
		outputFile: BASE_PARAMS.outputFile,
		timeout: BASE_PARAMS.timeout,
		cwd: BASE_PARAMS.cwd,
		tools: BASE_PARAMS.tools,
		excludeTools: BASE_PARAMS.excludeTools,
		noBuiltinTools: BASE_PARAMS.noBuiltinTools,
	},
};

describe("resolveRetryParams", () => {
	bench("full params → merge with full original", () => {
		resolveRetryParams(BASE_PARAMS, BASE_RUN);
	});

	bench("partial params (merge mostly from original)", () => {
		resolveRetryParams(PARTIAL_PARAMS, BASE_RUN);
	});

	bench("override params (replace most fields)", () => {
		resolveRetryParams(OVERRIDE_PARAMS, BASE_RUN);
	});
});

// ===========================================================================
// 8. getSafeEnv — environment filtering
// ===========================================================================

describe("getSafeEnv", () => {
	bench("no overrides (filter process.env)", () => {
		getSafeEnv();
	});

	bench("with depth override", () => {
		getSafeEnv({ BRL_SUBAGENT_DEPTH: "3" });
	});

	bench("with multiple overrides", () => {
		getSafeEnv({
			BRL_SUBAGENT_DEPTH: "1",
			CUSTOM_VAR: "test-value",
			ANOTHER_OVERRIDE: "hello-world",
			PATH_OVERRIDE: "/custom/bin:/usr/bin",
		});
	});
});
