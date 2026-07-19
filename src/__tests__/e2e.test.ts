import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "path";

/**
 * Tier 1: Jiti integration tests
 *
 * These tests verify that all source files load correctly via jiti
 * (pi's runtime). Vitest bundles all modules together, auto-resolving
 * cross-module imports. Jiti compiles files individually. This means
 * a missing import passes vitest but crashes in production.
 *
 * These tests load the extension the same way pi does.
 */

// jiti is not in this project's dependencies — load from pnpm global store
const JITI_PACKAGE = "/home/azmeen/.local/share/pnpm/global/5/.pnpm/jiti@2.7.0/node_modules/jiti";
const jitiFactory = require(JITI_PACKAGE);
const SRC_DIR = resolve(__dirname, "..");

// Files that can be loaded in isolation (no pi/typebox dependencies)
const ISOLATED_FILES = [
  "concurrency",
  "diff",
  "git",
  "history",
  "logging",
  "messaging",
  "metrics",
  "presets",
  "prompt",
  "reports",
  "router",
  "sanitize",
  "scheduler",
  "schedule",
  "state",
  "templates",
  "update",
  "validate",
];

// Files that require pi/typebox — can't load in isolation
const PI_DEPENDENT_FILES = [
  "index",
  "pool",
  "preflight",
  "runner",
  "tui",
];

describe("Tier 1: Jiti integration tests", () => {
  let jiti: (id: string) => any;

  beforeAll(() => {
    // Create jiti instance — returns a require function
    jiti = jitiFactory(SRC_DIR, {
      interopDefault: true,
      moduleCache: false, // Don't cache — we want fresh requires
    });
  });

  // ── Import verification ──────────────────────────────────────────

  describe("Import verification", () => {
    for (const file of ISOLATED_FILES) {
      it(`loads ${file}.ts via jiti`, () => {
        try {
          jiti(`./${file}`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to load ${file}.ts: ${message}`);
        }
      });
    }

    for (const file of PI_DEPENDENT_FILES) {
      it(`loads ${file}.ts via jiti (pi-dependent — expected to fail)`, () => {
        // These files import @earendil-works/pi-coding-agent or typebox
        // which are only available when pi loads the extension.
        // We test them here to document the dependency, not to verify loading.
        try {
          jiti(`./${file}`);
          // If it loads, that's fine too (pi might be in the path)
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          // Expected failure — these files need pi's runtime
          expect(message).toMatch(/Cannot find module|typebox|pi-coding-agent/);
        }
      });
    }
  });

  // ── Pure function integration ────────────────────────────────────

  describe("Pure function integration via jiti", () => {
    it("validatePreTask detects missing write tool", () => {
      const { validatePreTask } = jiti("./validate");
      const result = validatePreTask({
        task: "Create a new file with the API endpoint",
        toolOptions: { tools: ["read", "bash", "grep"], excludeTools: ["write", "edit"] },
      });
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w: string) => /write|edit/.test(w))).toBe(true);
    });

    it("validatePreTask passes when tools are available", () => {
      const { validatePreTask } = jiti("./validate");
      const result = validatePreTask({
        task: "Read the file and summarize its contents",
        toolOptions: { tools: ["read", "bash", "grep", "find", "ls", "glob"] },
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("resolveTemplate substitutes ${param} placeholders", () => {
      const { resolveTemplate } = jiti("./templates");
      const result = resolveTemplate(
        { name: "test", task: "Hello ${name}, you are ${age}" },
        { name: "World", age: "42" },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task).toBe("Hello World, you are 42");
      }
    });

    it("resolveTemplate reports missing params", () => {
      const { resolveTemplate } = jiti("./templates");
      const result = resolveTemplate(
        { name: "test", task: "Hello ${name} ${missing}" },
        { name: "World" },
      );
      expect(result.ok).toBe(false);
    });

    it("extractParamNames finds ${param} placeholders", () => {
      const { extractParamNames } = jiti("./templates");
      const params = extractParamNames("Hello ${name} ${age} ${city}");
      expect(params).toContain("name");
      expect(params).toContain("age");
      expect(params).toContain("city");
      expect(params).toHaveLength(3);
    });

    it("validateGraph accepts valid graph", () => {
      const { validateGraph } = jiti("./scheduler");
      const errors = validateGraph([
        { id: "a", task: "Task A", dependsOn: [] },
        { id: "b", task: "Task B", dependsOn: ["a"] },
      ]);
      expect(errors).toHaveLength(0);
    });

    it("validateGraph detects missing dependency", () => {
      const { validateGraph } = jiti("./scheduler");
      const errors = validateGraph([
        { id: "a", task: "Task A", dependsOn: [] },
        { id: "b", task: "Task B", dependsOn: ["c"] }, // c doesn't exist
      ]);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("topologicalSort returns correct waves", () => {
      const { topologicalSort } = jiti("./scheduler");
      const result = topologicalSort([
        { id: "a", task: "Task A", dependsOn: [] },
        { id: "b", task: "Task B", dependsOn: ["a"] },
        { id: "c", task: "Task C", dependsOn: ["b"] },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Three sequential waves: [a], [b], [c]
        expect(result.waves).toHaveLength(3);
        expect(result.waves[0][0].id).toBe("a");
        expect(result.waves[1][0].id).toBe("b");
        expect(result.waves[2][0].id).toBe("c");
      }
    });

    it("topologicalSort parallelizes independent tasks", () => {
      const { topologicalSort } = jiti("./scheduler");
      const result = topologicalSort([
        { id: "a", task: "Task A", dependsOn: [] },
        { id: "b", task: "Task B", dependsOn: [] },
        { id: "c", task: "Task C", dependsOn: ["a", "b"] },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Two waves: [a, b] (parallel), [c]
        expect(result.waves).toHaveLength(2);
        expect(result.waves[0]).toHaveLength(2);
        expect(result.waves[1][0].id).toBe("c");
      }
    });
  });
});
