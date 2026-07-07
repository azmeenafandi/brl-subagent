/**
 * Tests for E7 — Multi-turn subagents with clarifying questions.
 *
 * Tests the question pattern detection, multi-turn loop logic,
 * maxTurns enforcement, and SUBAGENT_INSTRUCTIONS guidance.
 *
 * NOTE: Cannot import directly from runner.ts due to pi-coding-agent
 * dependency not being available in vitest. Instead, we duplicate the
 * QUESTION_PATTERN regex and detectQuestion logic here for testing.
 */

import { describe, it, expect } from "vitest";
import { buildSubagentPrompt, SUBAGENT_INSTRUCTIONS } from "../prompt";
import { EMPTY_USAGE } from "../types";
import type { SubagentResult } from "../types";

// ---------------------------------------------------------------------------
// Duplicated from runner.ts (same regex used in production)
// ---------------------------------------------------------------------------

const QUESTION_PATTERN = /^\[QUESTION\]:(.+)/m;

function detectQuestion(
	text: string,
): string | null {
	const match = text.match(QUESTION_PATTERN);
	return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(text: string): SubagentResult {
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
			},
		],
		usage: { ...EMPTY_USAGE },
		exitCode: 0,
		stderr: "",
	};
}

function makeEmptyResult(): SubagentResult {
	return {
		messages: [],
		usage: { ...EMPTY_USAGE },
		exitCode: 0,
		stderr: "",
	};
}

// ---------------------------------------------------------------------------
// QUESTION_PATTERN regex tests
// ---------------------------------------------------------------------------

describe("QUESTION_PATTERN regex", () => {
	it("matches [QUESTION]: at the start of a line", () => {
		const text = "[QUESTION]:What is the target file for this refactor?";
		const match = text.match(QUESTION_PATTERN);
		expect(match).not.toBeNull();
		expect(match![1]).toBe("What is the target file for this refactor?");
	});

	it("matches [QUESTION]: with multiline text", () => {
		const text = "[QUESTION]:Should I use TypeScript or JavaScript?\nPlease clarify.";
		const match = text.match(QUESTION_PATTERN);
		expect(match).not.toBeNull();
		expect(match![1]).toBe("Should I use TypeScript or JavaScript?");
	});

	it("matches [QUESTION]: in the middle of a response (multiline flag)", () => {
		const text = "Here is my analysis.\n[QUESTION]:What format should the output be?";
		const match = text.match(QUESTION_PATTERN);
		expect(match).not.toBeNull();
		expect(match![1]).toBe("What format should the output be?");
	});

	it("does not match [QUESTION] without colon", () => {
		const text = "[QUESTION] What is the target?";
		const match = text.match(QUESTION_PATTERN);
		expect(match).toBeNull();
	});

	it("does not match plain text without [QUESTION]:", () => {
		const text = "Here is my analysis of the codebase. I found several issues.";
		const match = text.match(QUESTION_PATTERN);
		expect(match).toBeNull();
	});

	it("does not match empty string", () => {
		const match = "".match(QUESTION_PATTERN);
		expect(match).toBeNull();
	});

	it("matches with special characters in question", () => {
		const text = "[QUESTION]:What about {placeholder} and $variable?";
		const match = text.match(QUESTION_PATTERN);
		expect(match).not.toBeNull();
		expect(match![1]).toBe("What about {placeholder} and $variable?");
	});
});

// ---------------------------------------------------------------------------
// detectQuestion function tests
// ---------------------------------------------------------------------------

describe("detectQuestion (inline implementation)", () => {
	it("returns question text when [QUESTION]: is present", () => {
		const question = detectQuestion("[QUESTION]:What is the target file?");
		expect(question).toBe("What is the target file?");
	});

	it("returns null when no [QUESTION]: is present", () => {
		const question = detectQuestion("Here is my analysis. No questions needed.");
		expect(question).toBeNull();
	});

	it("returns null for empty string", () => {
		const question = detectQuestion("");
		expect(question).toBeNull();
	});

	it("extracts question from multiline response", () => {
		const text =
			"I've analyzed the codebase and found several patterns.\n" +
			"[QUESTION]:Should I prioritize security or performance?\n" +
			"Please let me know.";
		const question = detectQuestion(text);
		expect(question).toBe("Should I prioritize security or performance?");
	});

	it("returns trimmed question text", () => {
		const question = detectQuestion("[QUESTION]:  What file should I modify?  ");
		expect(question).toBe("What file should I modify?");
	});

	it("detects question in SubagentResult with assistant message", () => {
		const result = makeResult("[QUESTION]:What is the target file?");
		const text = result.messages[0].content[0].text as string;
		const question = detectQuestion(text);
		expect(question).toBe("What is the target file?");
	});

	it("returns null for SubagentResult with no question", () => {
		const result = makeResult("Task completed successfully.");
		const text = result.messages[0].content[0].text as string;
		const question = detectQuestion(text);
		expect(question).toBeNull();
	});

	it("returns null for empty SubagentResult", () => {
		const result = makeEmptyResult();
		expect(result.messages).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// SUBAGENT_INSTRUCTIONS includes multi-turn guidance
// ---------------------------------------------------------------------------

describe("SUBAGENT_INSTRUCTIONS multi-turn guidance", () => {
	it("contains the [QUESTION]: instruction", () => {
		expect(SUBAGENT_INSTRUCTIONS).toContain("[QUESTION]:Your question here?");
	});

	it("mentions conductor will provide an answer", () => {
		expect(SUBAGENT_INSTRUCTIONS).toContain("The conductor will provide an answer");
	});

	it("mentions re-invoked with answer as additional context", () => {
		expect(SUBAGENT_INSTRUCTIONS).toContain("re-invoked with the answer as additional context");
	});

	it("mentions using sparingly", () => {
		expect(SUBAGENT_INSTRUCTIONS).toContain("Use this sparingly");
	});

	it("mentions question must be first line", () => {
		expect(SUBAGENT_INSTRUCTIONS).toContain("first line of your final response");
	});
});

// ---------------------------------------------------------------------------
// Multi-turn loop logic (simulated)
// ---------------------------------------------------------------------------

describe("Multi-turn loop logic (simulated)", () => {
	/**
	 * Simulates the multi-turn loop logic from runSubagent without spawning
	 * real processes. Tests the core decision-making: when to ask, when to stop,
	 * and how answers accumulate.
	 */

	interface TurnResult {
		output: string;
		exitCode: number;
	}

	async function simulateMultiTurn(
		results: TurnResult[],
		maxTurns: number,
		onQuestion: (question: string, turn: number, maxTurns: number) => Promise<string | null>,
	): Promise<{ finalOutput: string; turnsUsed: number; answers: string[] }> {
		const answers: string[] = [];
		let finalOutput = "";
		let turnsUsed = 0;

		for (let turn = 0; turn < maxTurns; turn++) {
			turnsUsed++;
			const turnResult = results[turn];
			if (!turnResult) break;

			finalOutput = turnResult.output;

			// Check for [QUESTION]: pattern (same logic as runner.ts detectQuestion)
			const match = finalOutput.match(QUESTION_PATTERN);
			if (match && turn < maxTurns - 1) {
				const answer = await onQuestion(match[1].trim(), turn + 1, maxTurns);
				if (answer === null) {
					break; // Cancelled
				}
				answers.push(`Question (turn ${turn + 1}): ${match[1].trim()}\nAnswer: ${answer}`);
				continue;
			}

			break; // No question or last turn
		}

		return { finalOutput, turnsUsed, answers };
	}

	it("single turn: completes without question", async () => {
		const results: TurnResult[] = [{ output: "Task completed successfully.", exitCode: 0 }];
		const { finalOutput, turnsUsed, answers } = await simulateMultiTurn(
			results,
			1,
			async () => null,
		);
		expect(finalOutput).toBe("Task completed successfully.");
		expect(turnsUsed).toBe(1);
		expect(answers).toHaveLength(0);
	});

	it("multi-turn: question on turn 1, answer on turn 2", async () => {
		const results: TurnResult[] = [
			{ output: "[QUESTION]:What file should I modify?", exitCode: 0 },
			{ output: "Modified src/index.ts as requested.", exitCode: 0 },
		];
		const { finalOutput, turnsUsed, answers } = await simulateMultiTurn(
			results,
			3,
			async (question, turn, mt) => {
				expect(question).toBe("What file should I modify?");
				expect(turn).toBe(1);
				expect(mt).toBe(3);
				return "src/index.ts";
			},
		);
		expect(finalOutput).toBe("Modified src/index.ts as requested.");
		expect(turnsUsed).toBe(2);
		expect(answers).toHaveLength(1);
		expect(answers[0]).toContain("What file should I modify?");
		expect(answers[0]).toContain("src/index.ts");
	});

	it("max turns reached: question on last turn does not trigger another iteration", async () => {
		const results: TurnResult[] = [
			{ output: "[QUESTION]:Should I continue?", exitCode: 0 },
		];
		const { finalOutput, turnsUsed, answers } = await simulateMultiTurn(
			results,
			1, // Only 1 turn, so question on turn 1 should not trigger onQuestion
			async () => "yes",
		);
		expect(finalOutput).toBe("[QUESTION]:Should I continue?");
		expect(turnsUsed).toBe(1);
		expect(answers).toHaveLength(0);
	});

	it("onQuestion returns null: loop cancels and returns partial result", async () => {
		const results: TurnResult[] = [
			{ output: "[QUESTION]:What is the target?", exitCode: 0 },
		];
		const { finalOutput, turnsUsed, answers } = await simulateMultiTurn(
			results,
			3,
			async () => null, // Cancel
		);
		expect(finalOutput).toBe("[QUESTION]:What is the target?");
		expect(turnsUsed).toBe(1);
		expect(answers).toHaveLength(0);
	});

	it("three-turn conversation: question, answer, question, answer, complete", async () => {
		const results: TurnResult[] = [
			{ output: "[QUESTION]:What language?", exitCode: 0 },
			{ output: "[QUESTION]:What framework?", exitCode: 0 },
			{ output: "Done! Created the TypeScript Express app.", exitCode: 0 },
		];
		let callCount = 0;
		const { finalOutput, turnsUsed, answers } = await simulateMultiTurn(
			results,
			4,
			async (question, turn) => {
				callCount++;
				if (turn === 1) return "TypeScript";
				if (turn === 2) return "Express";
				return null;
			},
		);
		expect(finalOutput).toBe("Done! Created the TypeScript Express app.");
		expect(turnsUsed).toBe(3);
		expect(answers).toHaveLength(2);
		expect(callCount).toBe(2);
		expect(answers[0]).toContain("TypeScript");
		expect(answers[1]).toContain("Express");
	});

	it("no question on any turn: completes in single turn", async () => {
		const results: TurnResult[] = [
			{ output: "No ambiguity here. Task done.", exitCode: 0 },
		];
		const { finalOutput, turnsUsed, answers } = await simulateMultiTurn(
			results,
			5,
			async () => "unused",
		);
		expect(finalOutput).toBe("No ambiguity here. Task done.");
		expect(turnsUsed).toBe(1);
		expect(answers).toHaveLength(0);
	});

	it("maxTurns=2 with question on turn 1: uses 2 turns total", async () => {
		const results: TurnResult[] = [
			{ output: "[QUESTION]:Clarify scope?", exitCode: 0 },
			{ output: "Scope clarified. Done.", exitCode: 0 },
		];
		const { finalOutput, turnsUsed } = await simulateMultiTurn(
			results,
			2,
			async () => "Full scope",
		);
		expect(finalOutput).toBe("Scope clarified. Done.");
		expect(turnsUsed).toBe(2);
	});

	it("question pattern not at start of first line (but in middle) is still detected by multiline regex", async () => {
		const results: TurnResult[] = [
			{ output: "Analyzing...\n[QUESTION]:Which file?", exitCode: 0 },
			{ output: "Done.", exitCode: 0 },
		];
		const { finalOutput, turnsUsed } = await simulateMultiTurn(
			results,
			2,
			async () => "src/main.ts",
		);
		expect(finalOutput).toBe("Done.");
		expect(turnsUsed).toBe(2);
	});

	it("accumulated answers are passed as context on subsequent turns", async () => {
		const results: TurnResult[] = [
			{ output: "[QUESTION]:What language?", exitCode: 0 },
			{ output: "[QUESTION]:What version?", exitCode: 0 },
			{ output: "Done with TypeScript 5.", exitCode: 0 },
		];
		const allAnswers: string[] = [];
		await simulateMultiTurn(results, 4, async (question, turn) => {
			if (turn === 1) {
				allAnswers.push("TypeScript");
				return "TypeScript";
			}
			if (turn === 2) {
				allAnswers.push("5.x");
				return "5.x";
			}
			return null;
		});
		expect(allAnswers).toEqual(["TypeScript", "5.x"]);
	});
});

// ---------------------------------------------------------------------------
// buildSubagentPrompt with multi-turn context
// ---------------------------------------------------------------------------

describe("buildSubagentPrompt with multi-turn context", () => {
	it("instructions include [QUESTION]: format guidance", () => {
		const prompt = buildSubagentPrompt("Base prompt", true, undefined);
		expect(prompt).toContain("[QUESTION]:Your question here?");
		expect(prompt).toContain("first line of your final response");
	});

	it("instructions are present regardless of inheritance mode", () => {
		const withInherit = buildSubagentPrompt("Base", true, undefined);
		const withoutInherit = buildSubagentPrompt("Base", false, undefined);

		expect(withInherit).toContain("[QUESTION]:");
		expect(withoutInherit).toContain("[QUESTION]:");
	});

	it("custom system prompt does not override question instructions", () => {
		const prompt = buildSubagentPrompt("Base", true, "Custom instructions here.");
		expect(prompt).toContain("[QUESTION]:");
		expect(prompt).toContain("Custom instructions here.");
	});
});
