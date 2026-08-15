/**
 * Unit tests for src/params.ts helpers (issue #99).
 *
 * findUnknownParams backs the delegate_task unknown-param warn: TypeBox's
 * Type.Object allows additional properties by default and pi's
 * validateToolArguments passes unknown keys through unchanged, so without
 * this check a typo like `thinkinglevel` is silently ignored by execute.
 * The warn is warn-not-reject: it must never break a delegation.
 */

import { describe, it, expect } from "vitest";
import { findUnknownParams, KNOWN_DELEGATE_KEYS, snapshotOriginalParams } from "../params";

describe("findUnknownParams (issue #99)", () => {
	it("returns [] when all received keys are known", () => {
		const received = {
			task: "do the thing",
			label: "audit",
			thinkingLevel: "high",
			priority: "critical",
		};
		expect(findUnknownParams(received, KNOWN_DELEGATE_KEYS)).toEqual([]);
	});

	it("returns the unknown key when a single key is unknown", () => {
		const received = { task: "do the thing", thinkinglevel: "high" };
		expect(findUnknownParams(received, KNOWN_DELEGATE_KEYS)).toEqual(["thinkinglevel"]);
	});

	it("returns all unknown keys when multiple are unknown", () => {
		const received = {
			task: "do the thing",
			priority: "high",
			thinkinglevel: "high",
			inheritSystemprompt: false,
		};
		expect(findUnknownParams(received, KNOWN_DELEGATE_KEYS).sort()).toEqual([
			"inheritSystemprompt",
			"thinkinglevel",
		]);
	});

	it("returns [] for an empty received object", () => {
		expect(findUnknownParams({}, KNOWN_DELEGATE_KEYS)).toEqual([]);
	});

	it("priority is a known key (issue #99 live victim — schema now declares it)", () => {
		// Regresses the bug: before the schema fix, priority was not in the
		// known set and would be flagged (silently ignored by execute).
		expect(KNOWN_DELEGATE_KEYS.has("priority")).toBe(true);
		expect(findUnknownParams({ priority: "high" }, KNOWN_DELEGATE_KEYS)).toEqual([]);
	});

	it("warn-not-reject: unknown keys are reported, never thrown", () => {
		// findUnknownParams is pure — the caller decides to warn. No throw,
		// and the known keys are still recognized alongside unknown ones.
		const received = { task: "x", bogusParam: 1 };
		const unknown = findUnknownParams(received, KNOWN_DELEGATE_KEYS);
		expect(unknown).toEqual(["bogusParam"]);
		expect(() => findUnknownParams(received, KNOWN_DELEGATE_KEYS)).not.toThrow();
	});

	it("respects an explicit known-keys set (contract: pass the set explicitly)", () => {
		const minimal = new Set(["task"]);
		expect(findUnknownParams({ task: "x" }, minimal)).toEqual([]);
		expect(findUnknownParams({ task: "x", label: "y" }, minimal)).toEqual(["label"]);
	});
});

describe("snapshotOriginalParams (issue #108)", () => {
	it("copies exactly the 11 retry-override fields with values preserved", () => {
		const snap = snapshotOriginalParams({
			systemPrompt: "custom sys",
			inheritSystemPrompt: false,
			model: "openai/gpt-4o",
			thinkingLevel: "high",
			outputFile: "report.md",
			timeout: 120_000,
			cwd: "/tmp/proj",
			tools: ["read", "grep"],
			excludeTools: ["bash"],
			noBuiltinTools: true,
			preset: "security-auditor",
		});
		expect(snap).toEqual({
			systemPrompt: "custom sys",
			inheritSystemPrompt: false,
			model: "openai/gpt-4o",
			thinkingLevel: "high",
			outputFile: "report.md",
			timeout: 120_000,
			cwd: "/tmp/proj",
			tools: ["read", "grep"],
			excludeTools: ["bash"],
			noBuiltinTools: true,
			preset: "security-auditor",
		});
	});

	it("leaves unprovided fields undefined (no defaults, no garbage values)", () => {
		expect(snapshotOriginalParams({})).toEqual({});
		const snap = snapshotOriginalParams({ timeout: 5_000 });
		expect(snap).toEqual({ timeout: 5_000 });
		// undefined for missing fields — only the provided field carries a defined value
		expect(Object.entries(snap).filter(([, v]) => v !== undefined)).toEqual([["timeout", 5_000]]);
	});

	it("never copies non-override keys (params/task/label/background are not retry overrides)", () => {
		// The typed signature already excludes them, but ratchet the contract:
		// a schema-drifted extra key must not leak into the retry snapshot.
		const input = {
			systemPrompt: "x",
			timeout: 1,
			params: { slot: "v" },
			task: "do it",
			label: "lbl",
			background: true,
		} as unknown as Parameters<typeof snapshotOriginalParams>[0];
		expect(snapshotOriginalParams(input)).toEqual({ systemPrompt: "x", timeout: 1 });
	});
});
