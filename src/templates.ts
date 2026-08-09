/**
 * brl-subagent — Task Templates
 *
 * Task templates are user-saved delegate_task configurations with ${param}
 * placeholder slots. They are FILE-BACKED: each template is a .md file with
 * YAML frontmatter (name, description, preset, thinkingLevel, outputFile,
 * timeout, tools, excludeTools, noBuiltinTools, inheritSystemPrompt) whose
 * body IS the task — multiline by construction. This mirrors the proven
 * custom-preset pattern (issue #66): the old TUI add flow used single-line
 * input, which is unusable for a task body.
 *
 * Built-in templates ship with the extension (templates/ dir) as thin
 * teaching examples — one companion per builtin preset, VERB-form names,
 * with ${param} slots shown in action. Custom templates override builtins
 * with the same name (PROJECT > USER > BUILTIN), mirroring the preset tier
 * added in issue #84.
 *
 * Usage:
 *   const resolved = resolveTemplate(template, { file: "src/main.ts" });
 *   if (!resolved.ok) { /* handle error *\/ }
 *   // resolved.value.task now has placeholders filled
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskTemplate, ThinkingLevel } from "./types";
import { TEMPLATE_PARAM_RE, THINKING_LEVELS } from "./types";
import type { Logger } from "./logging";
import { parseFrontmatter, sanitizeFileName } from "./presets";

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

// ---------------------------------------------------------------------------
// Template validation
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed template has the required name field and valid
 * option values. Returns validation errors, or empty array if valid.
 *
 * Mirrors validatePreset (src/presets.ts) plus template-specific fields:
 * timeout must be numeric, tools/excludeTools must be lists, preset must be
 * a string.
 */
export function validateTemplate(meta: Record<string, unknown>, fileName: string): string[] {
	const errors: string[] = [];

	if (!meta.name || typeof meta.name !== "string") {
		errors.push(`Template "${fileName}" is missing required "name" field.`);
		return errors;
	}

	if (meta.thinkingLevel !== undefined) {
		const level = meta.thinkingLevel as string;
		if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
			errors.push(
				`Template "${meta.name}" (${fileName}): invalid thinkingLevel "${level}". ` +
				`Must be one of: ${THINKING_LEVELS.join(", ")}.`,
			);
		}
	}

	if (meta.inheritSystemPrompt !== undefined) {
		const val = meta.inheritSystemPrompt;
		if (val !== "true" && val !== "false") {
			errors.push(
				`Template "${meta.name}" (${fileName}): inheritSystemPrompt must be "true" or "false", got "${val}".`,
			);
		}
	}

	if (meta.noBuiltinTools !== undefined) {
		const val = meta.noBuiltinTools;
		if (val !== "true" && val !== "false") {
			errors.push(
				`Template "${meta.name}" (${fileName}): noBuiltinTools must be "true" or "false", got "${val}".`,
			);
		}
	}

	if (meta.timeout !== undefined) {
		const val = Number(meta.timeout);
		if (Number.isNaN(val)) {
			errors.push(
				`Template "${meta.name}" (${fileName}): timeout must be numeric, got "${meta.timeout}".`,
			);
		}
	}

	if (meta.tools !== undefined && !Array.isArray(meta.tools)) {
		errors.push(`Template "${meta.name}" (${fileName}): tools must be a list.`);
	}

	if (meta.excludeTools !== undefined && !Array.isArray(meta.excludeTools)) {
		errors.push(`Template "${meta.name}" (${fileName}): excludeTools must be a list.`);
	}

	if (meta.preset !== undefined && typeof meta.preset !== "string") {
		errors.push(`Template "${meta.name}" (${fileName}): preset must be a string.`);
	}

	return errors;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load custom task templates from user directories. Templates are
 * file-backed, mirroring the custom-preset pattern (issue #66) — the TUI
 * add/remove flows were removed because single-line input cannot express a
 * task body.
 *
 * Precedence: PROJECT-LOCAL > USER-GLOBAL. The project dir is scanned first
 * and duplicates by name are skipped, so a project-local template always
 * wins over a user-global one with the same name. The custom > builtin
 * override happens in getAllTemplates/getTemplate, not here.
 *
 * Searches:
 *   1. .pi/brl-subagent/templates/ (project-local, highest priority)
 *   2. ~/.pi/agent/brl-subagent/templates/ (global)
 *
 * The markdown body IS the task (multiline by construction). Invalid files
 * (including empty/whitespace-only bodies) are skipped with log warnings;
 * missing directories are skipped silently.
 */
export function loadCustomTemplates(cwd: string, log?: Logger): TaskTemplate[] {
	const templates: TaskTemplate[] = [];
	const seenNames = new Set<string>();
	const homedir = process.env.HOME || process.env.USERPROFILE || "";

	const dirs = [
		path.join(cwd, ".pi", "brl-subagent", "templates"),
		path.join(homedir, ".pi", "agent", "brl-subagent", "templates"),
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

					const errors = validateTemplate(meta, file);
					if (errors.length > 0) {
						for (const err of errors) {
							log?.warn("Custom template validation failed", { file, error: err });
						}
						continue;
					}

					// Reject empty/whitespace-only bodies at load: shipping task: ""
					// would later trip mode-detection with the confusing "Provide
					// exactly one of: task/chain/..." error instead of a load-time
					// warn-and-skip (parseFrontmatter already trims the body).
					if (!body.trim()) {
						log?.warn("Custom template validation failed", {
							file,
							error: `Template "${meta.name}" has empty task body`,
						});
						continue;
					}

					const name = meta.name as string;
					// Dedup by name: the first occurrence (project-local, scanned
					// first) wins; user-global duplicates are skipped.
					if (seenNames.has(name)) continue;
					seenNames.add(name);
					templates.push({
						name,
						description: (meta.description as string) || undefined,
						task: body,
						preset: (meta.preset as string) || undefined,
						thinkingLevel: (meta.thinkingLevel as string) || undefined,
						outputFile: (meta.outputFile as string) || undefined,
						timeout: meta.timeout !== undefined ? Number(meta.timeout) : undefined,
						tools: Array.isArray(meta.tools) ? (meta.tools as string[]) : undefined,
						excludeTools: Array.isArray(meta.excludeTools) ? (meta.excludeTools as string[]) : undefined,
						noBuiltinTools: meta.noBuiltinTools === "true" ? true : undefined,
						inheritSystemPrompt: meta.inheritSystemPrompt === "false" ? false : undefined,
					});
				} catch (err) {
					log?.warn("Failed to load custom template file", { file, error: (err as Error).message });
				}
			}
		} catch {
			// Directory doesn't exist — that's fine, no custom templates
		}
	}

	return templates;
}

/**
 * Load built-in task templates from a directory of markdown files. Files
 * must have YAML frontmatter with at least a `name` field. Invalid files
 * (including empty/whitespace-only bodies, kept for consistency with
 * loadCustomTemplates) are skipped with log warnings. Mirrors
 * loadBuiltinPresets (src/presets.ts).
 */
export function loadBuiltinTemplates(templatesDir: string, log?: Logger): TaskTemplate[] {
	const templates: TaskTemplate[] = [];

	try {
		const files = fs.readdirSync(templatesDir);
		for (const file of files) {
			if (!file.endsWith(".md")) continue;

			try {
				const filePath = path.join(templatesDir, file);
				const content = fs.readFileSync(filePath, "utf-8");
				const { meta, body } = parseFrontmatter(content);

				const errors = validateTemplate(meta, file);
				if (errors.length > 0) {
					for (const err of errors) {
						log?.warn("Builtin template validation failed", { file, error: err });
					}
					continue;
				}

				// Same empty-body guard as loadCustomTemplates: shipped templates
				// are authored non-empty, but keep the check so a regressed copy
				// warns at load time instead of tripping mode-detection later.
				if (!body.trim()) {
					log?.warn("Builtin template validation failed", {
						file,
						error: `Template "${meta.name}" has empty task body`,
					});
					continue;
				}

				const name = meta.name as string;

				templates.push({
					name,
					description: (meta.description as string) || undefined,
					task: body,
					preset: (meta.preset as string) || undefined,
					thinkingLevel: (meta.thinkingLevel as string) || undefined,
					outputFile: (meta.outputFile as string) || undefined,
					timeout: meta.timeout !== undefined ? Number(meta.timeout) : undefined,
					tools: Array.isArray(meta.tools) ? (meta.tools as string[]) : undefined,
					excludeTools: Array.isArray(meta.excludeTools) ? (meta.excludeTools as string[]) : undefined,
					noBuiltinTools: meta.noBuiltinTools === "true" ? true : undefined,
					inheritSystemPrompt: meta.inheritSystemPrompt === "false" ? false : undefined,
				});
			} catch (err) {
				log?.warn("Failed to load builtin template file", { file, error: (err as Error).message });
			}
		}
	} catch {
		// Templates directory doesn't exist or can't be read — no built-in templates
		log?.info("No built-in templates directory found", { dir: templatesDir });
	}

	return templates;
}

// ---------------------------------------------------------------------------
// Template lookup
// ---------------------------------------------------------------------------

/**
 * Look up a template by name. Custom (user) templates take precedence over
 * built-ins, so users can override any built-in template with the same name.
 * Mirrors getPreset (src/presets.ts).
 */
export function getTemplate(
	name: string,
	builtinTemplates: TaskTemplate[],
	customTemplates: TaskTemplate[],
): TaskTemplate | undefined {
	return customTemplates.find((t) => t.name === name) || builtinTemplates.find((t) => t.name === name);
}

/**
 * Combine built-in and custom templates into a single array.
 * Custom (user) templates override built-ins with the same name.
 * Mirrors getAllPresets (src/presets.ts).
 */
export function getAllTemplates(
	builtinTemplates: TaskTemplate[],
	customTemplates: TaskTemplate[],
): TaskTemplate[] {
	const seen = new Set(customTemplates.map((t) => t.name));
	const filteredBuiltins = builtinTemplates.filter((t) => !seen.has(t.name));
	return [...customTemplates, ...filteredBuiltins];
}

/**
 * Load and merge the FULL template stack in one call: built-in templates
 * (shipped in the extension's templates/ dir) plus custom templates from the
 * project and user-global directories. Custom overrides builtin by name, so
 * precedence is PROJECT > USER > BUILTIN (issue #84 + builtin tier).
 *
 * This is the single entry point used by index.ts, tui.ts, and resetState so
 * every reload site stays in sync. `templatesDir` overrides the builtin
 * location (used by tests); it defaults to the shipped templates/ dir next to
 * the extension's presets/ dir.
 */
export function loadAllTemplates(cwd: string, log?: Logger, templatesDir?: string): TaskTemplate[] {
	const builtinDir = templatesDir ?? path.join(__dirname, "..", "templates");
	return getAllTemplates(loadBuiltinTemplates(builtinDir, log), loadCustomTemplates(cwd, log));
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Build just the YAML frontmatter string (without the "---" markers)
 * from a TaskTemplate object. Mirrors buildFrontmatter's key format
 * (src/presets.ts) exactly: scalars unquoted, description quoted,
 * boolean-only fields quoted, lists as indented "- item" lines.
 */
export function buildTemplateFrontmatter(template: TaskTemplate): string {
	const lines: string[] = [];
	lines.push(`name: ${template.name}`);
	if (template.description) lines.push(`description: "${template.description}"`);
	if (template.preset) lines.push(`preset: ${template.preset}`);
	if (template.thinkingLevel) lines.push(`thinkingLevel: ${template.thinkingLevel}`);
	if (template.outputFile) lines.push(`outputFile: ${template.outputFile}`);
	if (template.timeout !== undefined) lines.push(`timeout: ${template.timeout}`);
	if (template.noBuiltinTools) lines.push(`noBuiltinTools: "true"`);
	if (template.inheritSystemPrompt === false) lines.push(`inheritSystemPrompt: "false"`);
	if (template.tools?.length) {
		lines.push("tools:");
		for (const t of template.tools) lines.push(`  - ${t}`);
	}
	if (template.excludeTools?.length) {
		lines.push("excludeTools:");
		for (const t of template.excludeTools) lines.push(`  - ${t}`);
	}
	return lines.join("\n");
}

/**
 * Build a complete markdown string with YAML frontmatter from a TaskTemplate.
 * The body is the task, so multiline tasks are natural.
 */
export function buildTemplateMarkdown(template: TaskTemplate): string {
	const frontmatter = buildTemplateFrontmatter(template);
	return `---\n${frontmatter}\n---\n${template.task}\n`;
}

/**
 * Write a template to a .md file in the specified directory.
 * Creates the directory if it doesn't exist.
 * Returns the full path to the written file.
 */
export function writeTemplateFile(template: TaskTemplate, dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const fileName = sanitizeFileName(template.name) + ".md";
	const filePath = path.join(dir, fileName);
	const content = buildTemplateMarkdown(template);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}
