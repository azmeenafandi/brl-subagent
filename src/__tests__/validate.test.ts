import { describe, it, expect } from "vitest";
import { validatePreTask, diagnoseFailure, type ValidateConfig, type DiagnoseConfig } from "../validate";

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
