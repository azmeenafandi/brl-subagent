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
					model: (meta.model as string) || undefined,
					inheritSystemPrompt: meta.inheritSystemPrompt === "false" ? false : undefined,
					tools: Array.isArray(meta.tools) ? (meta.tools as string[]) : undefined,
					excludeTools: Array.isArray(meta.excludeTools) ? (meta.excludeTools as string[]) : undefined,
					noBuiltinTools: meta.noBuiltinTools === "true" ? true : undefined,
					promptGuideline: (meta.promptGuideline as string) || undefined,
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

/**
 * Load custom presets from user directories. User presets override built-ins
 * with the same name. Survives pi install updates since user directories
 * are never touched by the install process.
 *
 * Searches:
 *   1. ~/.pi/agent/brl-subagent/presets/ (global)
 *   2. .pi/brl-subagent/presets/ (project-local, highest priority)
 */
export function loadCustomPresets(cwd: string, log?: Logger): SubagentPreset[] {
	const presets: SubagentPreset[] = [];
	const homedir = process.env.HOME || process.env.USERPROFILE || "";

	const dirs = [
		path.join(homedir, ".pi", "agent", "brl-subagent", "presets"),
		path.join(cwd, ".pi", "brl-subagent", "presets"),
	];

	for (const dir of dirs) {
		try {
			const files = fs.readdirSync(dir);
			for (const file of files) {
				if (!file.endsWith(".md")) continue;
				try {
					const filePath = path.join(dir, file);
					const content = fs.readFileSync(filePath, "utf-8");
					const { meta, body } = parseFrontmatter(content);

					const errors = validatePreset(meta, file);
					if (errors.length > 0) {
						for (const err of errors) {
							log?.warn("Custom preset validation failed", { file, error: err });
						}
						continue;
					}

					const name = meta.name as string;
					presets.push({
						name,
						description: (meta.description as string) || undefined,
						systemPrompt: body || undefined,
						thinkingLevel: (meta.thinkingLevel as string) || undefined,
						model: (meta.model as string) || undefined,
						inheritSystemPrompt: meta.inheritSystemPrompt === "false" ? false : undefined,
						tools: Array.isArray(meta.tools) ? (meta.tools as string[]) : undefined,
						excludeTools: Array.isArray(meta.excludeTools) ? (meta.excludeTools as string[]) : undefined,
						noBuiltinTools: meta.noBuiltinTools === "true" ? true : undefined,
						promptGuideline: (meta.promptGuideline as string) || undefined,
					});
				} catch (err) {
					log?.warn("Failed to load custom preset file", { file, error: (err as Error).message });
				}
			}
		} catch {
			// Directory doesn't exist — that's fine, no custom presets
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
 * Look up a preset by name. Custom (user) presets take precedence over built-ins,
 * so users can override any built-in preset with the same name.
 */
export function getPreset(
	name: string,
	builtinPresets: SubagentPreset[],
	customPresets: SubagentPreset[],
): SubagentPreset | undefined {
	return customPresets.find((p) => p.name === name) || builtinPresets.find((p) => p.name === name);
}

/**
 * Combine built-in and custom presets into a single array.
 * Custom (user) presets override built-ins with the same name.
 */
export function getAllPresets(
	builtinPresets: SubagentPreset[],
	customPresets: SubagentPreset[],
): SubagentPreset[] {
	const seen = new Set(customPresets.map((p) => p.name));
	const filteredBuiltins = builtinPresets.filter((p) => !seen.has(p.name));
	return [...customPresets, ...filteredBuiltins];
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

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use as a filename.
 * Replaces characters that are problematic in file names with hyphens.
 */
export function sanitizeFileName(name: string): string {
	return name.replace(/[/\\:*?"<>|]/g, "-");
}

/**
 * Build just the YAML frontmatter string (without the "---" markers)
 * from a SubagentPreset object.
 */
export function buildFrontmatter(preset: SubagentPreset): string {
	const lines: string[] = [];
	lines.push(`name: ${preset.name}`);
	if (preset.description) lines.push(`description: "${preset.description}"`);
	if (preset.thinkingLevel) lines.push(`thinkingLevel: ${preset.thinkingLevel}`);
	if (preset.model) lines.push(`model: ${preset.model}`);
	if (preset.inheritSystemPrompt === false) lines.push(`inheritSystemPrompt: "false"`);
	if (preset.noBuiltinTools) lines.push(`noBuiltinTools: "true"`);
	if (preset.tools?.length) {
		lines.push("tools:");
		for (const t of preset.tools) lines.push(`  - ${t}`);
	}
	if (preset.excludeTools?.length) {
		lines.push("excludeTools:");
		for (const t of preset.excludeTools) lines.push(`  - ${t}`);
	}
	if (preset.promptGuideline) lines.push(`promptGuideline: "${preset.promptGuideline}"`);
	return lines.join("\n");
}

/**
 * Build a complete markdown string with YAML frontmatter from a SubagentPreset.
 * This produces the same format as the built-in preset .md files.
 */
export function buildPresetMarkdown(preset: SubagentPreset): string {
	const frontmatter = buildFrontmatter(preset);
	const body = preset.systemPrompt || "";
	return `---\n${frontmatter}\n---\n${body}\n`;
}

/**
 * Write a preset to a .md file in the specified directory.
 * Creates the directory if it doesn't exist.
 * Returns the full path to the written file.
 */
export function writePresetFile(preset: SubagentPreset, dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const fileName = sanitizeFileName(preset.name) + ".md";
	const filePath = path.join(dir, fileName);
	const content = buildPresetMarkdown(preset);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}
