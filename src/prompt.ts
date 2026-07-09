/**
 * brl-subagent — Prompt Builder
 *
 * Constructs the subagent's system prompt based on inheritance mode,
 * custom instructions, and output file directives.
 */

// ---------------------------------------------------------------------------
// Subagent instructions (appended to every subagent prompt)
// ---------------------------------------------------------------------------

export const SUBAGENT_INSTRUCTIONS =
	"You are now acting as a subagent. Your task has been delegated to you by the main agent.\n\n" +
	"Complete the assigned task thoroughly. When finished, provide a clear summary covering:\n" +
	"1. What you did\n" +
	"2. Key findings or results\n" +
	"3. Any issues or limitations encountered\n" +
	"4. Files modified (if any)\n\n" +
	"When you encounter a blocker during the task, report it clearly using this format in your final response: ## Completion Status with [DONE/UNVERIFIED/BLOCKED] for each requirement, then ## Blockers section listing the issue, what you tried, and what you need. If you cannot run tests or execute commands because your toolset lacks bash/exec access, state this explicitly under Blockers. Do NOT claim tests pass if you could not run them." +
	"\n\n" +
	"If your task is complex and can be broken into independent sub-tasks, you may use delegate_task to spawn sub-subagents. Follow these rules: delegate only truly independent work, set labels for each sub-subagent, use appropriate thinking levels for simplicity, and collect all results before reporting. Do NOT create chains of more than 2 levels deep without explicit user approval. If you delegate, mention it in your summary." +
	"\n\n" +
	"If you are running alongside other subagents and need to share findings, you can send messages using the format: [TO:subagent-id]:your message. Use [TO:*]:message to broadcast to all subagents. Messages are delivered after you complete and before the recipient starts. Use subagent labels (from the task description) as IDs. Keep messages concise and actionable.";

// ---------------------------------------------------------------------------
// Output file instruction block
// ---------------------------------------------------------------------------

function buildOutputBlock(outputFile: string): string {
	return (
		`## Output Instructions\n\n` +
		`Write your complete findings to the file at: ${outputFile}\n` +
		`Use the write tool to create this file.\n\n` +
		`Then, in your final response, provide ONLY a structured summary:\n` +
		`1. A 2-3 sentence overview of what you found\n` +
		`2. A compact index with: severity counts, key keywords, files examined, and section references\n` +
		`3. Do NOT include the full findings in your response — they are in the file.\n\n` +
		`When finished, your final response should look like:\n\n` +
		`## Summary\n[2-3 sentences]\n\n` +
		`## Index\n- Critical: N (see §X)\n- High: N (see §Y)\n- Medium: N (see §Z)\n` +
		`- Keywords: word1, word2, word3\n- Files examined: file1.ts, file2.ts`
	);
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the subagent's system prompt based on inheritance and customization options.
 *
 * Modes:
 * - inherit=true,  custom=set   → basePrompt + customPrompt + instructions
 * - inherit=true,  custom=unset → basePrompt + instructions
 * - inherit=false, custom=set   → customPrompt + instructions
 * - inherit=false, custom=unset → instructions only (bare minimum, saves tokens)
 */
export function buildSubagentPrompt(
	basePrompt: string,
	inheritSystemPrompt: boolean,
	customSystemPrompt: string | undefined,
	outputFile?: string,
): string {
	const parts: string[] = [];

	if (inheritSystemPrompt) {
		parts.push(basePrompt);
	}

	if (customSystemPrompt) {
		parts.push(customSystemPrompt);
	}

	if (outputFile) {
		parts.push(buildOutputBlock(outputFile));
	}

	parts.push(SUBAGENT_INSTRUCTIONS);

	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompt mode description (for UI display)
// ---------------------------------------------------------------------------

export function describePromptMode(inheritSP: boolean, hasCustomSP: boolean): string {
	if (inheritSP && hasCustomSP) return "inherit + custom instructions";
	if (inheritSP) return "inherit";
	if (hasCustomSP) return "custom prompt";
	return "default (no inheritance)";
}
