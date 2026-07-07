/**
 * brl-subagent — Presets
 *
 * Load, parse, validate, and manage subagent personality presets.
 * Built-in presets are loaded from markdown files with YAML frontmatter.
 * Custom presets are stored in session state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentPreset, ThinkingLevel } from "./types";
import { THINKING_LEVELS } from "./types";
import type { Logger } from "./logging";

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns metadata key-value pairs and the body content.
 */
export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { meta: {}, body: content };

	const meta: Record<string, unknown> = {};
	const lines = match[1].split("\n");
	let currentKey = "";
	let currentArray: string[] | null = null;

	for (const line of lines) {
		// Array item: starts with "- "
		if (line.match(/^\s+-\s+/)) {
			if (currentArray !== null) {
				currentArray.push(line.replace(/^\s+-\s+/, "").trim());
			}
			continue;
		}

		// End of array if we were in one
		if (currentArray !== null) {
			meta[currentKey] = currentArray;
			currentArray = null;
		}

		// Key-value pair
		const kvMatch = line.match(/^(\w+):\s*(.*)$/);
		if (kvMatch) {
			const key = kvMatch[1];
			const value = kvMatch[2].trim();
			// Check if next line starts an array
			if (value === "") {
				currentKey = key;
				currentArray = [];
			} else {
				// Strip quotes if present
				meta[key] = value.replace(/^["']|["']$/g, "");
			}
		}
	}
	// Close any pending array
	if (currentArray !== null) {
		meta[currentKey] = currentArray;
	}

	return { meta, body: match[2].trim() };
}

// ---------------------------------------------------------------------------
// Preset validation
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed preset has the required name field
 * and its thinkingLevel (if set) is a valid value.
 * Returns validation errors, or empty array if valid.
 */
export function validatePreset(meta: Record<string, unknown>, fileName: string): string[] {
	const errors: string[] = [];

	if (!meta.name || typeof meta.name !== "string") {
		errors.push(`Preset "${fileName}" is missing required "name" field.`);
		return errors;
	}

	if (meta.thinkingLevel !== undefined) {
		const level = meta.thinkingLevel as string;
		if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
			errors.push(
				`Preset "${meta.name}" (${fileName}): invalid thinkingLevel "${level}". ` +
				`Must be one of: ${THINKING_LEVELS.join(", ")}.`,
			);
		}
	}

	if (meta.inheritSystemPrompt !== undefined) {
		const val = meta.inheritSystemPrompt;
		if (val !== "true" && val !== "false") {
			errors.push(
				`Preset "${meta.name}" (${fileName}): inheritSystemPrompt must be "true" or "false", got "${val}".`,
			);
		}
	}

	if (meta.noBuiltinTools !== undefined) {
		const val = meta.noBuiltinTools;
		if (val !== "true" && val !== "false") {
			errors.push(
				`Preset "${meta.name}" (${fileName}): noBuiltinTools must be "true" or "false", got "${val}".`,
			);
		}
	}

	return errors;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load built-in presets from a directory of markdown files.
 * Files must have YAML frontmatter with at least a `name` field.
 * Invalid files are skipped with log warnings.
 */
export function loadBuiltinPresets(presetsDir: string, log?: Logger): SubagentPreset[] {
	const presets: SubagentPreset[] = [];

	try {
		const files = fs.readdirSync(presetsDir);
		for (const file of files) {
			if (!file.endsWith(".md")) continue;

			try {
				const filePath = path.join(presetsDir, file);
				const content = fs.readFileSync(filePath, "utf-8");
				const { meta, body } = parseFrontmatter(content);

				const errors = validatePreset(meta, file);
				if (errors.length > 0) {
					for (const err of errors) {
						log?.warn("Preset validation failed", { file, error: err });
					}
					continue;
				}

				const name = meta.name as string;

				presets.push({
					name,
					description: (meta.description as string) || undefined,
					systemPrompt: body || undefined,
					thinkingLevel: (meta.thinkingLevel as string) || undefined,
					inheritSystemPrompt: meta.inheritSystemPrompt === "false" ? false : undefined,
					tools: Array.isArray(meta.tools) ? (meta.tools as string[]) : undefined,
					excludeTools: Array.isArray(meta.excludeTools) ? (meta.excludeTools as string[]) : undefined,
					noBuiltinTools: meta.noBuiltinTools === "true" ? true : undefined,
				});
			} catch (err) {
				log?.warn("Failed to load preset file", { file, error: (err as Error).message });
			}
		}
	} catch {
		// Presets directory doesn't exist or can't be read — no built-in presets
		log?.info("No built-in presets directory found", { dir: presetsDir });
	}

	// Validate all loaded presets
	const validationErrors = validateAllPresets(presets);
	if (validationErrors.length > 0) {
		for (const err of validationErrors) {
			log?.warn("Preset validation on load failed", { error: err });
		}
	}

	return presets;
}

// ---------------------------------------------------------------------------
// Preset validation of parsed objects
// ---------------------------------------------------------------------------

/**
 * Validate an array of already-parsed SubagentPreset objects.
 * Checks: name must be defined and non-empty, thinkingLevel (if set) must be
 * a valid ThinkingLevel, and tools (if set) must be an array.
 * Returns an array of error messages (empty = valid).
 */
export function validateAllPresets(presets: SubagentPreset[]): string[] {
	const errors: string[] = [];

	for (const preset of presets) {
		if (!preset.name || (typeof preset.name === "string" && preset.name.trim() === "")) {
			errors.push("Preset has empty or missing name.");
			continue;
		}

		if (preset.thinkingLevel !== undefined) {
			if (!THINKING_LEVELS.includes(preset.thinkingLevel as ThinkingLevel)) {
				errors.push(
					`Preset "${preset.name}": invalid thinkingLevel "${preset.thinkingLevel}". ` +
					`Must be one of: ${THINKING_LEVELS.join(", ")}.`,
				);
			}
		}

		if (preset.tools !== undefined && !Array.isArray(preset.tools)) {
			errors.push(`Preset "${preset.name}": tools must be an array.`);
		}
	}

	return errors;
}

// ---------------------------------------------------------------------------
// Preset lookup
// ---------------------------------------------------------------------------

/**
 * Look up a preset by name. Built-in presets take precedence over custom ones.
 */
export function getPreset(
	name: string,
	builtinPresets: SubagentPreset[],
	customPresets: SubagentPreset[],
): SubagentPreset | undefined {
	return builtinPresets.find((p) => p.name === name) || customPresets.find((p) => p.name === name);
}

/**
 * Combine built-in and custom presets into a single array.
 * Built-in presets come first.
 */
export function getAllPresets(
	builtinPresets: SubagentPreset[],
	customPresets: SubagentPreset[],
): SubagentPreset[] {
	return [...builtinPresets, ...customPresets];
}

/**
 * Format a one-line summary of a preset's configuration.
 */
export function formatPresetSummary(p: SubagentPreset): string {
	const parts: string[] = [];
	if (p.thinkingLevel) parts.push(p.thinkingLevel);
	if (p.tools?.length) parts.push(`tools:${p.tools.join(",")}`);
	if (p.excludeTools?.length) parts.push(`-${p.excludeTools.join(",")}`);
	if (p.noBuiltinTools) parts.push("no-builtins");
	return parts.join(" · ") || "default";
}
