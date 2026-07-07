/**
 * brl-subagent — Compliance Reports (E5)
 *
 * Generates compliance reports showing which subagents touched which files
 * and what secrets may have been accessed.
 */

import type {
	SubagentRun,
	FileAccessReport,
	SecretsExposureEntry,
	SecretsExposureReport,
	ComplianceSummary,
} from "./types";
import { computeSLAMetrics } from "./metrics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sensitive file patterns that should be flagged in compliance reports */
const SENSITIVE_FILE_PATTERNS = [
	/\.env\b/,
	/\.env\./,
	/credentials\.json/,
	/auth\.json/,
	/\.pem\b/,
	/\.key\b/,
	/id_rsa/,
	/\.secrets\b/,
	/secrets\.yml/,
	/config\/credentials/,
	/private\//,
];

/** Sensitive keywords in task descriptions that should be flagged */
const SENSITIVE_TASK_KEYWORDS = [
	"password",
	"secret",
	"token",
	"api key",
	"credential",
];

/** Severity mapping for sensitive file patterns */
const FILE_SEVERITY_MAP: Record<string, "high" | "medium" | "low"> = {
	".env": "high",
	".env.*": "high",
	"credentials.json": "high",
	"auth.json": "high",
	".pem": "high",
	".key": "high",
	"id_rsa*": "high",
	".secrets": "high",
	"secrets.yml": "high",
	"config/credentials": "high",
	"private/": "medium",
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Extract file paths from a git diff string.
 * Parses diff headers to find file paths.
 */
function extractFilesFromGitDiff(gitDiff: string): string[] {
	const files: string[] = [];
	const lines = gitDiff.split("\n");

	for (const line of lines) {
		// Match diff --git a/path b/path
		const diffMatch = line.match(/^diff --git a\/(.+?) b\//);
		if (diffMatch) {
			files.push(diffMatch[1]);
			continue;
		}

		// Match --- a/path or +++ b/path
		const fileMatch = line.match(/^(?:---|\+\+\+) [ab]\/(.+?)$/);
		if (fileMatch) {
			files.push(fileMatch[1]);
		}
	}

	// Deduplicate
	return [...new Set(files)];
}

/**
 * Extract file paths from output summary using heuristics.
 * Looks for patterns like "src/..." or "Modified: file1.ts".
 */
function extractFilesFromOutputSummary(outputSummary: string): string[] {
	const files: string[] = [];

	// Pattern 1: "Modified: filename" or "Created: filename" or "Deleted: filename"
	const actionPatterns = outputSummary.match(/(?:Modified|Created|Deleted|Changed|Updated):\s*([^\n,]+)/gi);
	if (actionPatterns) {
		for (const pattern of actionPatterns) {
			const fileMatch = pattern.match(/(?:Modified|Created|Deleted|Changed|Updated):\s*(.+)/i);
			if (fileMatch) {
				files.push(fileMatch[1].trim());
			}
		}
	}

	// Pattern 2: File paths with common extensions
	const pathPattern = /(?:src|lib|test|tests|spec|specs|config|docs|examples|scripts|utils|helpers|components|services|models|views|controllers|routes|types)\/[\w\-\/]+\.(?:ts|js|tsx|jsx|json|md|yml|yaml)/g;
	const pathMatches = outputSummary.match(pathPattern);
	if (pathMatches) {
		files.push(...pathMatches);
	}

	// Pattern 3: Files ending with common extensions
	const filePattern = /(?:^|\s)([\w\-\/]+\.(?:ts|js|tsx|jsx|json|md|yml|yaml))(?:\s|$)/g;
	let match;
	while ((match = filePattern.exec(outputSummary)) !== null) {
		if (match[1] && !files.includes(match[1])) {
			files.push(match[1]);
		}
	}

	// Deduplicate
	return [...new Set(files)];
}

/**
 * Check if a file path matches any sensitive file pattern.
 */
function isSensitiveFile(filePath: string): { match: boolean; pattern?: string; severity?: "high" | "medium" | "low" } {
	const normalizedPath = filePath.toLowerCase();

	for (const pattern of SENSITIVE_FILE_PATTERNS) {
		if (pattern.test(normalizedPath)) {
			// Find the severity
			const patternStr = pattern.toString();
			for (const [key, severity] of Object.entries(FILE_SEVERITY_MAP)) {
				if (patternStr.includes(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) {
					return { match: true, pattern: key, severity };
				}
			}
			// Default to high if no specific severity found
			return { match: true, pattern: patternStr, severity: "high" };
		}
	}

	return { match: false };
}

/**
 * Check if a task description contains sensitive keywords.
 */
function hasSensitiveTaskKeywords(task: string): { match: boolean; keyword?: string } {
	const lowerTask = task.toLowerCase();

	for (const keyword of SENSITIVE_TASK_KEYWORDS) {
		if (lowerTask.includes(keyword)) {
			return { match: true, keyword };
		}
	}

	return { match: false };
}

// ---------------------------------------------------------------------------
// Report generators
// ---------------------------------------------------------------------------

/**
 * Generates a report mapping files to subagent runs that touched them.
 *
 * Parses gitDiff from each run's result (if available) to extract file paths.
 * If gitDiff is not available, uses outputSummary to heuristically find file paths.
 *
 * @param runs - Array of SubagentRun records
 * @returns FileAccessReport mapping file path to array of run IDs that touched it
 */
export function buildFileAccessReport(runs: SubagentRun[]): FileAccessReport {
	const files: Record<string, string[]> = {};

	for (const run of runs) {
		const runFiles: string[] = [];

		// Try to extract from gitDiff first (stored in fullOutput for completed runs)
		if (run.fullOutput) {
			// Check if fullOutput contains git diff content
			if (run.fullOutput.includes("diff --git")) {
				runFiles.push(...extractFilesFromGitDiff(run.fullOutput));
			}
		}

		// Fall back to outputSummary heuristics
		if (runFiles.length === 0 && run.outputSummary) {
			runFiles.push(...extractFilesFromOutputSummary(run.outputSummary));
		}

		// Add run ID to each file's list
		for (const file of runFiles) {
			if (!files[file]) {
				files[file] = [];
			}
			if (!files[file].includes(run.id)) {
				files[file].push(run.id);
			}
		}
	}

	return { files };
}

/**
 * Checks if any subagent runs accessed sensitive files.
 *
 * Checks run task descriptions for suspicious patterns and run outputs
 * for sensitive file access.
 *
 * @param runs - Array of SubagentRun records
 * @returns SecretsExposureReport with any findings
 */
export function buildSecretsExposureReport(runs: SubagentRun[]): SecretsExposureReport {
	const exposures: SecretsExposureEntry[] = [];

	for (const run of runs) {
		// Check task description for sensitive keywords
		const taskCheck = hasSensitiveTaskKeywords(run.task);
		if (taskCheck.match && taskCheck.keyword) {
			exposures.push({
				file: `task:${taskCheck.keyword}`,
				runId: run.id,
				runLabel: run.label,
				severity: "medium",
			});
		}

		// Check output for sensitive file access
		const outputToCheck = [
			run.outputSummary,
			run.fullOutput,
		].filter(Boolean).join("\n");

		if (outputToCheck) {
			// Check for direct file access mentions
			for (const pattern of SENSITIVE_FILE_PATTERNS) {
				const patternStr = pattern.toString();
				if (pattern.test(outputToCheck)) {
					// Determine severity based on the pattern
					let severity: "high" | "medium" | "low" = "medium";
					for (const [key, sev] of Object.entries(FILE_SEVERITY_MAP)) {
						if (patternStr.includes(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) {
							severity = sev;
							break;
						}
					}

					exposures.push({
						file: patternStr,
						runId: run.id,
						runLabel: run.label,
						severity,
					});
				}
			}
		}
	}

	return { exposures };
}

/**
 * Combines metrics, file access, and secrets exposure into a single summary.
 *
 * @param runs - Array of SubagentRun records
 * @returns ComplianceSummary with aggregated data
 */
export function generateComplianceSummary(runs: SubagentRun[]): ComplianceSummary {
	if (runs.length === 0) {
		return {
			totalRuns: 0,
			dateRange: {
				earliest: "",
				latest: "",
			},
			metrics: computeSLAMetrics([]),
			filesAccessed: 0,
			sensitiveFilesTouched: 0,
			highSeverityFindings: 0,
		};
	}

	// Calculate date range
	const dates = runs
		.map((r) => new Date(r.startedAt).getTime())
		.filter((d) => !isNaN(d));

	const earliest = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : "";
	const latest = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : "";

	// Compute SLA metrics
	const metrics = computeSLAMetrics(runs);

	// Get file access report
	const fileReport = buildFileAccessReport(runs);
	const filesAccessed = Object.keys(fileReport.files).length;

	// Get secrets exposure report
	const secretsReport = buildSecretsExposureReport(runs);
	const sensitiveFilesTouched = secretsReport.exposures.length;
	const highSeverityFindings = secretsReport.exposures.filter(
		(e) => e.severity === "high"
	).length;

	return {
		totalRuns: runs.length,
		dateRange: {
			earliest,
			latest,
		},
		metrics,
		filesAccessed,
		sensitiveFilesTouched,
		highSeverityFindings,
	};
}
