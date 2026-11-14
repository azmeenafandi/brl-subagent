/**
 * Tests for the TypeScript AST adapter (ADRs 0013, 0014) — the single entry point every guard parses
 * through, so the unstable API stays contained in one file.
 *
 * Thin on purpose: five src guards already walk real programs through `parseTexts` and would fail if
 * the adapter broke (`architecture-rules`, `dispatch-line-enforcement`, `prose-duplication`,
 * `runtime-vocabulary`, `terminal-status-consistency`). What only this surface can pin is that the
 * adapter is importable from tooling and that its two containment promises hold: one parsed
 * `SourceFile` per entry, keyed by absolute path, and fresh text for a path reused across calls
 * (the long-lived client caches by path — a stale read here would make every guard lie).
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SyntaxKind, parseTexts } from "../ts-ast.mjs";

describe("parseTexts — one independent program per call", () => {
	it("keys each entry's SourceFile by its absolute path", () => {
		const parsed = parseTexts([
			{ path: "adapter-a.ts", text: "const a = 1;\n" },
			{ path: "adapter-b.ts", text: "function b(): void {}\n" },
		]);
		expect(parsed.size).toBe(2);
		const first = parsed.get(resolve("adapter-a.ts"));
		expect(first.statements).toHaveLength(1);
		expect(first.statements[0].kind).toBe(SyntaxKind.VariableStatement);
	});

	it("serves new text when a path is reused across calls", () => {
		const first = parseTexts([{ path: "adapter-reused.ts", text: "const a = 1;\n" }]);
		const second = parseTexts([{ path: "adapter-reused.ts", text: "const b = 2;\nlet c = 3;\n" }]);
		expect(first.get(resolve("adapter-reused.ts")).statements).toHaveLength(1);
		expect(second.get(resolve("adapter-reused.ts")).statements).toHaveLength(2);
	});
});
