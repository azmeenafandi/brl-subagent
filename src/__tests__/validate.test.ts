import { describe, it, expect } from "vitest";
import { validatePreTask, diagnoseFailure, normalizeTimeout, type ValidateConfig, type DiagnoseConfig } from "../validate";

describe("validatePreTask", () => {
  it("returns valid for empty task", () => {
    const result = validatePreTask({ task: "" });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns valid when no conflicts exist", () => {
    const result = validatePreTask({
      task: "Read the file and summarize its contents",
      toolOptions: { tools: ["read", "bash", "grep", "find", "ls", "glob"] },
    });
    expect(result.valid).toBe(true);
  });

  // ── Tool validation ──────────────────────────────────────────────

  it("warns when write tool is missing for write task", () => {
    const result = validatePreTask({
      task: "Create a new file with the API endpoint",
      toolOptions: { tools: ["read", "bash", "grep"], excludeTools: ["write", "edit"] },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => /write|edit/.test(w))).toBe(true);
  });

  it("warns when bash is excluded for run task", () => {
    const result = validatePreTask({
      task: "Run the test suite with vitest",
      toolOptions: { tools: ["read", "write", "edit"], excludeTools: ["bash"] },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => /bash/.test(w))).toBe(true);
  });

  it("warns when edit is missing for refactor task", () => {
    const result = validatePreTask({
      task: "Refactor the authentication module",
      toolOptions: { tools: ["read", "bash", "grep"], excludeTools: ["write", "edit"] },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => /write|edit/.test(w))).toBe(true);
  });

  it("warns when read is excluded for audit task", () => {
    const result = validatePreTask({
      task: "Audit the security of the authentication flow",
      toolOptions: { excludeTools: ["read"] },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => /read/.test(w))).toBe(true);
  });

  it("passes when tools are unrestricted (no toolOptions)", () => {
    const result = validatePreTask({
      task: "Create and write to a new file",
    });
    expect(result.valid).toBe(true);
  });

  it("passes when tools are in the allowlist", () => {
    const result = validatePreTask({
      task: "Edit the config file",
      toolOptions: { tools: ["read", "write", "edit", "bash"] },
    });
    expect(result.valid).toBe(true);
  });

  // ── Git mode warnings ────────────────────────────────────────────

  it("warns when git mode is none but task involves git", () => {
    const result = validatePreTask({
      task: "Commit the changes to the repository",
      gitMode: "none",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/gitMode.*none/);
  });

  it("no warning when git mode is branch", () => {
    const result = validatePreTask({
      task: "Commit the changes",
      gitMode: "branch",
    });
    expect(result.warnings).toHaveLength(0);
  });

  // ── Thinking level warnings ──────────────────────────────────────

  it("warns when thinking level is too low for security task", () => {
    const result = validatePreTask({
      task: "Audit the security vulnerabilities in the auth flow",
      thinkingLevel: "off",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes("thinkingLevel"))).toBe(true);
  });

  it("no warning when thinking level is sufficient", () => {
    const result = validatePreTask({
      task: "Audit the security vulnerabilities in the auth flow",
      thinkingLevel: "high",
    });
    expect(result.warnings.filter(w => w.includes("thinkingLevel"))).toHaveLength(0);
  });

  it("warns when thinking is low for implementation work", () => {
    const result = validatePreTask({
      task: "Implement the new payment processing feature",
      thinkingLevel: "off",
    });
    expect(result.warnings.some(w => w.includes("thinkingLevel"))).toBe(true);
  });

  // ── Determinism ──────────────────────────────────────────────────

  it("is deterministic — same input always gives same output", () => {
    const config: ValidateConfig = {
      task: "Run the security audit and commit the results",
      toolOptions: { tools: ["read", "bash", "grep"], excludeTools: ["write", "edit"] },
      thinkingLevel: "off",
      gitMode: "none",
    };
    const r1 = validatePreTask(config);
    const r2 = validatePreTask(config);
    expect(r1).toEqual(r2);
  });

  // ── Edge cases ───────────────────────────────────────────────────

  it("handles task with only whitespace", () => {
    const result = validatePreTask({ task: "   " });
    expect(result.valid).toBe(true);
  });

  it("warns on multiple keyword matches", () => {
    const result = validatePreTask({
      task: "Create and commit the new feature",
      toolOptions: { excludeTools: ["write", "edit", "bash"] },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  // ── Hard conflicts: outputFile vs write tool (issue #32, part C) ─────

  it("is invalid when outputFile is set but write is excluded", () => {
    const result = validatePreTask({
      task: "Audit the codebase security",
      toolOptions: { excludeTools: ["write", "edit", "bash"] },
      outputFile: "reports/audit.md",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/outputFile/);
    expect(result.errors[0]).toMatch(/write/);
  });

  it("is invalid when outputFile is set but write is missing from the tools allowlist", () => {
    const result = validatePreTask({
      task: "Review the authentication flow",
      toolOptions: { tools: ["read", "grep", "find", "ls"] },
      outputFile: "review.md",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/outputFile/);
  });

  it("is valid when outputFile is set and write is available", () => {
    const result = validatePreTask({
      task: "Audit the codebase security",
      toolOptions: { tools: ["read", "grep", "find", "ls", "write", "edit"] },
      outputFile: "reports/audit.md",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("no outputFile → existing behavior unchanged (valid:true, no errors)", () => {
    const result = validatePreTask({
      task: "Create a new file with the API endpoint",
      toolOptions: { excludeTools: ["write", "edit"] },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("is invalid when outputFile is set but noBuiltinTools disables write", () => {
    // noBuiltinTools maps to pi's --no-builtin-tools: write is a built-in
    // tool, so it is unavailable — the same silent-failure class as #32.
    const result = validatePreTask({
      task: "Audit the codebase security",
      toolOptions: { noBuiltinTools: true },
      outputFile: "reports/audit.md",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/outputFile/);
  });

  it("is valid when noBuiltinTools is set but no outputFile is used", () => {
    // No hard conflict — noBuiltinTools alone is a legitimate config.
    const result = validatePreTask({
      task: "Review the authentication flow",
      toolOptions: { noBuiltinTools: true },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // ── Empty top-level task (chain/parallel/graph mode entry, issue #34) ────
  // Chain/parallel/graph top-level tasks are empty (modeCount forbids
  // task+chain/tasks/graph). The hard outputFile-vs-write check (C) must still
  // run for those — the empty-task skip only suppresses keyword warnings, not
  // the hard conflict. Keyword patterns cannot match empty text, so no
  // warnings can false-fire from this path.

  it("is invalid when outputFile is set with an empty task and write is excluded", () => {
    const result = validatePreTask({
      task: "",
      toolOptions: { excludeTools: ["write", "edit", "bash"] },
      outputFile: "reports/audit.md",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/outputFile/);
    expect(result.errors[0]).toMatch(/write/);
  });

  it("is invalid when outputFile is set with an empty task and write is missing from the allowlist", () => {
    const result = validatePreTask({
      task: "  ",
      toolOptions: { tools: ["read", "grep", "find", "ls"] },
      outputFile: "review.md",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/outputFile/);
  });

  it("is valid when outputFile is set with an empty task and write IS available", () => {
    const result = validatePreTask({
      task: "",
      toolOptions: { tools: ["read", "grep", "find", "ls", "write", "edit"] },
      outputFile: "reports/audit.md",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("empty task without outputFile still skips all checks (no false warnings)", () => {
    const result = validatePreTask({
      task: "",
      toolOptions: { excludeTools: ["write", "edit", "bash"] },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ── H3: Post-mortem diagnostics ─────────────────────────────────────

describe("diagnoseFailure", () => {
  it("returns suggestions when git mode is none but task needs git", () => {
    const suggestions = diagnoseFailure({
      task: "Commit the changes to the repository",
      gitMode: "none",
    });
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]).toContain("gitMode");
  });

  it("returns no suggestion when git mode is branch", () => {
    const suggestions = diagnoseFailure({
      task: "Commit the changes to the repository",
      gitMode: "branch",
    });
    expect(suggestions).toHaveLength(0);
  });

  it("returns suggestion when thinking level is too low for security", () => {
    const suggestions = diagnoseFailure({
      task: "Audit the security vulnerabilities in the auth flow",
      thinkingLevel: "off",
    });
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]).toContain("thinkingLevel");
    expect(suggestions[0]).toContain("security");
  });

  it("returns no suggestion when thinking level is high for security", () => {
    const suggestions = diagnoseFailure({
      task: "Audit the security vulnerabilities in the auth flow",
      thinkingLevel: "high",
    });
    expect(suggestions).toHaveLength(0);
  });

  it("returns suggestion when thinking level is too low for debugging", () => {
    const suggestions = diagnoseFailure({
      task: "Debug the root cause of the memory leak",
      thinkingLevel: "low",
    });
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]).toContain("thinkingLevel");
    expect(suggestions[0]).toContain("debugging");
  });

  it("returns no suggestion when thinking level is high for debugging", () => {
    const suggestions = diagnoseFailure({
      task: "Debug the root cause of the memory leak",
      thinkingLevel: "high",
    });
    expect(suggestions).toHaveLength(0);
  });

  it("returns suggestion when write/edit tools are excluded but task needs them", () => {
    const suggestions = diagnoseFailure({
      task: "Create a new file with the API endpoint",
      toolOptions: { excludeTools: ["write", "edit"] },
    });
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]).toContain("excludeTools");
    expect(suggestions[0]).toContain("write");
  });

  it("returns no suggestion when write/edit tools are available", () => {
    const suggestions = diagnoseFailure({
      task: "Create a new file with the API endpoint",
      toolOptions: {},
    });
    expect(suggestions).toHaveLength(0);
  });

  it("returns suggestion when bash is excluded but task needs command execution", () => {
    const suggestions = diagnoseFailure({
      task: "Run the test suite with vitest",
      toolOptions: { excludeTools: ["bash"] },
    });
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]).toContain("bash");
    expect(suggestions[0]).toContain("excludeTools");
  });

  it("returns no suggestion when bash is available for run task", () => {
    const suggestions = diagnoseFailure({
      task: "Run the test suite with vitest",
      toolOptions: {},
    });
    expect(suggestions).toHaveLength(0);
  });

  it("returns suggestion when timeout with xhigh thinking", () => {
    const suggestions = diagnoseFailure({
      task: "Analyze the codebase",
      thinkingLevel: "xhigh",
      errorMessage: "Subagent timed out after 60000ms",
    });
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]).toContain("xhigh");
  });

  it("returns no timeout suggestion when thinking is not xhigh", () => {
    const suggestions = diagnoseFailure({
      task: "Analyze the codebase",
      thinkingLevel: "high",
      errorMessage: "Subagent timed out after 60000ms",
    });
    expect(suggestions).toHaveLength(0);
  });

  it("returns suggestion when timeout is very low", () => {
    const suggestions = diagnoseFailure({
      task: "Analyze the codebase",
      errorMessage: "Subagent timed out",
      timeout: 15000,
    });
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]).toContain("timeout");
  });

  it("returns no suggestion when timeout is adequate", () => {
    const suggestions = diagnoseFailure({
      task: "Analyze the codebase",
      errorMessage: "Subagent timed out",
      timeout: 60000,
    });
    expect(suggestions).toHaveLength(0);
  });

  it("returns multiple suggestions for compound failures", () => {
    const suggestions = diagnoseFailure({
      task: "Commit the changes and audit the security",
      gitMode: "none",
      thinkingLevel: "off",
      errorMessage: "Subagent timed out",
      timeout: 10000,
    });
    expect(suggestions.length).toBeGreaterThanOrEqual(3);
  });

  it("returns empty array when no issues are diagnosable", () => {
    const suggestions = diagnoseFailure({
      task: "Read the file",
      thinkingLevel: "off",
    });
    expect(suggestions).toHaveLength(0);
  });

  it("is deterministic — same input always gives same output", () => {
    const config: DiagnoseConfig = {
      task: "Commit the changes and audit the security",
      gitMode: "none",
      thinkingLevel: "off",
      errorMessage: "Subagent timed out",
      timeout: 10000,
    };
    const r1 = diagnoseFailure(config);
    const r2 = diagnoseFailure(config);
    expect(r1).toEqual(r2);
  });
});

describe("normalizeTimeout (issue #28 PR #49 review M1/m1)", () => {
	it("returns undefined for no timeout", () => {
		expect(normalizeTimeout(undefined)).toBeUndefined();
	});

	it("neutralizes instant-kill values: 0, negative, NaN", () => {
		expect(normalizeTimeout(0)).toBeUndefined();
		expect(normalizeTimeout(-5)).toBeUndefined();
		expect(normalizeTimeout(-1)).toBeUndefined();
		expect(normalizeTimeout(NaN)).toBeUndefined();
	});

	it("neutralizes Node setTimeout overflow values: Infinity, >=2^31-1", () => {
		// Node fires setTimeout(fn, Infinity) and setTimeout(fn, 2^31) at ~1ms
		// (TimeoutOverflowWarning) — an instant kill, not a generous deadline.
		expect(normalizeTimeout(Infinity)).toBeUndefined();
		expect(normalizeTimeout(2 ** 31 - 1)).toBeUndefined();
		expect(normalizeTimeout(2 ** 31)).toBeUndefined();
	});

	it("passes through valid deadlines unchanged (foreground may exceed 30min)", () => {
		expect(normalizeTimeout(5000)).toBe(5000);
		expect(normalizeTimeout(30 * 60 * 1000)).toBe(30 * 60 * 1000);
		// Foreground legitimately supports >30min timeouts (runner kill); the
		// background hard cap applies its own 30min Math.min.
		expect(normalizeTimeout(45 * 60 * 1000)).toBe(45 * 60 * 1000);
	});
});
