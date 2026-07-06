/**
 * brl-subagent — Task Templates
 *
 * Task templates are user-saved delegate_task configurations with ${param}
 * placeholder slots. They are stored in session state and are personal
 * to the user.
 *
 * Usage:
 *   const resolved = resolveTemplate(template, { file: "src/main.ts" });
 *   if (!resolved.ok) { /* handle error *\/ }
 *   // resolved.value.task now has placeholders filled
 */

import type { TaskTemplate } from "./types";
import { TEMPLATE_PARAM_RE } from "./types";

// ---------------------------------------------------------------------------
// Param extraction
// ---------------------------------------------------------------------------

/**
 * Extract all unique ${paramName} names from a text string.
 * Used for validation and TUI hints.
 *
 * @param text - The text to scan for ${param} placeholders
 * @returns A sorted array of unique param names
 */
export function extractParamNames(text: string): string[] {
	const names = new Set<string>();
	let match: RegExpExecArray | null;
	const re = new RegExp(TEMPLATE_PARAM_RE.source, "g");
	while ((match = re.exec(text)) !== null) {
		names.add(match[1]);
	}
	return [...names].sort();
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a TaskTemplate by replacing all ${param} placeholders with
 * the provided parameter values.
 *
 * Before substitution, checks that all required params are provided.
 * Extra params (in the object but not in the template) are silently ignored.
 *
 * @param template - The template with ${param} placeholders
 * @param params - Key-value map of parameter names to substitution strings
 * @returns Ok with resolved template, or Err with a descriptive error message
 */
export function resolveTemplate(
	template: TaskTemplate,
	params: Record<string, string>,
): { ok: true; value: TaskTemplate } | { ok: false; error: string } {
	// Collect all unique param names used in task and outputFile
	const namesInTask = extractParamNames(template.task);
	const namesInOutput = template.outputFile ? extractParamNames(template.outputFile) : [];
	const allNames = [...new Set([...namesInTask, ...namesInOutput])];

	// Check for missing params
	const missing = allNames.filter((name) => !(name in params));
	if (missing.length > 0) {
		return {
			ok: false,
			error: `Missing params: ${missing.join(", ")}`,
		};
	}

	// Build a replacer function that replaces all ${param} occurrences
	const replaceAll = (text: string): string => {
		return text.replace(TEMPLATE_PARAM_RE, (_match, name: string) => {
			// All params are guaranteed to exist at this point
			return name in params ? params[name] : _match;
		});
	};

	const resolved: TaskTemplate = {
		...template,
		task: replaceAll(template.task),
		outputFile: template.outputFile ? replaceAll(template.outputFile) : undefined,
	};

	return { ok: true, value: resolved };
}
