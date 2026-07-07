/**
 * brl-subagent — Compliance Reports Tests (E5)
 *
 * Tests for buildFileAccessReport, buildSecretsExposureReport, and generateComplianceSummary.
 */

import { describe, it, expect } from "vitest";
import {
	buildFileAccessReport,
	buildSecretsExposureReport,
	generateComplianceSummary,
} from "../reports";
import type { SubagentRun } from "../types";

// ---------------------------------------------------------------------------
// Helper: create a minimal SubagentRun
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: "run-1",
		task: "Test task",
		status: "done",
		model: "test-model",
		thinkingLevel: "low",
		startedAt: "2024-01-15T10:00:00Z",
		finishedAt: "2024-01-15T10:01:00Z",
		durationMs: 60000,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildFileAccessReport tests
// ---------------------------------------------------------------------------

describe("buildFileAccessReport", () => {
	it("should correctly extract file paths from gitDiff in fullOutput", () => {
		const runs = [
			makeRun({
				id: "run-1",
				fullOutput: `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,6 @@
+import { Foo } from './foo';
 import { Bar } from './bar';
diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,4 @@
+export function helper() {}
 export function main() {}`,
			}),
		];

		const report = buildFileAccessReport(runs);

		expect(report.files).toHaveProperty("src/index.ts");
		expect(report.files).toHaveProperty("src/utils.ts");
		expect(report.files["src/index.ts"]).toContain("run-1");
		expect(report.files["src/utils.ts"]).toContain("run-1");
	});

	it("should return empty report when runs have no gitDiff", () => {
		const runs = [
			makeRun({
				id: "run-1",
				fullOutput: "No diff content here",
				outputSummary: "Just some output text",
			}),
		];

		const report = buildFileAccessReport(runs);

		expect(Object.keys(report.files)).toHaveLength(0);
	});

	it("should list all run IDs for files touched by multiple runs", () => {
		const gitDiff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1,2 @@
+import { Foo } from './foo';`;

		const runs = [
			makeRun({ id: "run-1", fullOutput: gitDiff }),
			makeRun({ id: "run-2", fullOutput: gitDiff }),
			makeRun({ id: "run-3", fullOutput: gitDiff }),
		];

		const report = buildFileAccessReport(runs);

		expect(report.files["src/index.ts"]).toHaveLength(3);
		expect(report.files["src/index.ts"]).toContain("run-1");
		expect(report.files["src/index.ts"]).toContain("run-2");
		expect(report.files["src/index.ts"]).toContain("run-3");
	});

	it("should return empty report for empty runs array", () => {
		const report = buildFileAccessReport([]);

		expect(Object.keys(report.files)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// buildSecretsExposureReport tests
// ---------------------------------------------------------------------------

describe("buildSecretsExposureReport", () => {
	it("should flag run that accessed .env file as high severity", () => {
		const runs = [
			makeRun({
				id: "run-1",
				task: "Read configuration",
				outputSummary: "Successfully read .env file",
			}),
		];

		const report = buildSecretsExposureReport(runs);

		expect(report.exposures.length).toBeGreaterThan(0);
		const envExposure = report.exposures.find(
			(e) => e.file.includes(".env") && e.severity === "high"
		);
		expect(envExposure).toBeDefined();
		expect(envExposure?.runId).toBe("run-1");
	});

	it("should flag run with task containing 'password' as medium", () => {
		const runs = [
			makeRun({
				id: "run-1",
				task: "Change the admin password to something secure",
			}),
		];

		const report = buildSecretsExposureReport(runs);

		expect(report.exposures.length).toBeGreaterThan(0);
		const passwordExposure = report.exposures.find(
			(e) => e.file.includes("password") && e.severity === "medium"
		);
		expect(passwordExposure).toBeDefined();
		expect(passwordExposure?.runId).toBe("run-1");
	});

	it("should flag run with task containing 'api key' as medium", () => {
		const runs = [
			makeRun({
				id: "run-1",
				task: "Generate a new API key for the service",
			}),
		];

		const report = buildSecretsExposureReport(runs);

		expect(report.exposures.length).toBeGreaterThan(0);
		const apiKeyExposure = report.exposures.find(
			(e) => e.file.includes("api key") && e.severity === "medium"
		);
		expect(apiKeyExposure).toBeDefined();
		expect(apiKeyExposure?.runId).toBe("run-1");
	});

	it("should return empty exposures for clean run with no sensitive access", () => {
		const runs = [
			makeRun({
				id: "run-1",
				task: "Fix the typo in README.md",
				outputSummary: "Fixed typo in README.md",
			}),
		];

		const report = buildSecretsExposureReport(runs);

		expect(report.exposures).toHaveLength(0);
	});

	it("should flag run that accessed .pem file as high severity", () => {
		const runs = [
			makeRun({
				id: "run-1",
				task: "Read certificate",
				outputSummary: "Successfully read certificate.pem file",
			}),
		];

		const report = buildSecretsExposureReport(runs);

		expect(report.exposures.length).toBeGreaterThan(0);
		const pemExposure = report.exposures.find(
			(e) => e.file.includes(".pem") && e.severity === "high"
		);
		expect(pemExposure).toBeDefined();
		expect(pemExposure?.runId).toBe("run-1");
	});
});

// ---------------------------------------------------------------------------
// generateComplianceSummary tests
// ---------------------------------------------------------------------------

describe("generateComplianceSummary", () => {
	it("should correctly aggregate metrics for multiple runs", () => {
		const runs = [
			makeRun({
				id: "run-1",
				startedAt: "2024-01-15T10:00:00Z",
				status: "done",
				durationMs: 50000,
				cost: 0.01,
			}),
			makeRun({
				id: "run-2",
				startedAt: "2024-01-15T11:00:00Z",
				status: "failed",
				durationMs: 30000,
				cost: 0.02,
			}),
		];

		const summary = generateComplianceSummary(runs);

		expect(summary.totalRuns).toBe(2);
		expect(summary.dateRange.earliest).toBe("2024-01-15T10:00:00.000Z");
		expect(summary.dateRange.latest).toBe("2024-01-15T11:00:00.000Z");
		expect(summary.metrics.totalRuns).toBe(2);
		expect(summary.metrics.successRate).toBe(0.5);
		expect(summary.metrics.failureRate).toBe(0.5);
	});

	it("should handle empty runs gracefully", () => {
		const summary = generateComplianceSummary([]);

		expect(summary.totalRuns).toBe(0);
		expect(summary.dateRange.earliest).toBe("");
		expect(summary.dateRange.latest).toBe("");
		expect(summary.filesAccessed).toBe(0);
		expect(summary.sensitiveFilesTouched).toBe(0);
		expect(summary.highSeverityFindings).toBe(0);
	});

	it("should correctly count mixed severity findings", () => {
		const runs = [
			makeRun({
				id: "run-1",
				task: "Read the password file",
				outputSummary: "Read .env file successfully",
			}),
			makeRun({
				id: "run-2",
				task: "Access credentials.json",
				outputSummary: "Read auth.json",
			}),
		];

		const summary = generateComplianceSummary(runs);

		expect(summary.totalRuns).toBe(2);
		expect(summary.sensitiveFilesTouched).toBeGreaterThan(0);
		expect(summary.highSeverityFindings).toBeGreaterThan(0);
	});
});
