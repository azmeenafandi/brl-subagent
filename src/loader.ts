// Purpose: Shared markdown-tier loader — scan dirs for `.md`, parse frontmatter, validate, map to a typed record.
/**
 * brl-subagent — Markdown tier loader
 *
 * Presets and task templates are both FILE-BACKED tiers: a directory of `.md`
 * files with YAML frontmatter is listed, filtered to `.md`, read, parsed,
 * validated, and normalised into a family-specific record. Before issue #380
 * that pipeline was written four times (builtin presets, custom presets,
 * custom templates, builtin templates) with only the record shape, the
 * validator, and the log wording differing (D6 in the smell audit).
 *
 * This module owns the common steps once. The two families keep their own
 * record types and mappers — `loadMarkdownRecords` is generic over the record
 * and takes the family-specific mapping as `spec.map`, so presets stay presets
 * and templates stay templates while the walk is single-source.
 *
 * Behaviour preserved from the four copies:
 *   - non-`.md` entries are ignored; a directory named `*.md` surfaces as a
 *     read failure (warn) instead of aborting the scan;
 *   - an unreadable directory is skipped (`onMissingDir` lets the builtin tiers
 *     log the info line, custom tiers stay silent);
 *   - a validation error warns once per error and skips the file;
 *   - a per-file read/parse/map throw warns and continues;
 *   - dedupe by name is opt-in (`dedupeByName`) and first-occurrence-wins,
 *     which is how PROJECT > USER precedence is enforced.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
// Tier loading
// ---------------------------------------------------------------------------

/** Log wording for one tier — the only part of the walk that is family-specific. */
export interface LoaderMessages {
	/** Warn message for a file skipped by `validate` or `bodyError`. */
	invalid: string;
	/** Warn message for a file that threw while being read, parsed, or mapped. */
	readFailed: string;
}

/** Everything one tier needs: where to scan, how to validate, how to build the record. */
export interface MarkdownTierSpec<T> {
	/** Directories to scan, in precedence order (first occurrence of a name wins). */
	dirs: readonly string[];
	/** Frontmatter validator; a non-empty result skips the file (one warn per error). */
	validate: (meta: Record<string, unknown>, fileName: string) => string[];
	/** Family-specific record construction from validated frontmatter, body, and name. */
	map: (meta: Record<string, unknown>, body: string, name: string) => T;
	/** Log wording for this tier. */
	messages: LoaderMessages;
	/** Logger for the warn/info lines; omitted → silent. */
	log?: Logger;
	/** Skip a second occurrence of an already-seen name (PROJECT > USER precedence). */
	dedupeByName?: boolean;
	/** Extra skip check after `validate`; a returned error string warns and skips. */
	bodyError?: (meta: Record<string, unknown>, body: string) => string | null;
	/** Called when a directory cannot be read (missing dir). Custom tiers stay silent. */
	onMissingDir?: (dir: string) => void;
}

/**
 * Load every record of one markdown tier: walk `spec.dirs` in order, and for
 * each `.md` file parse frontmatter, validate, check the optional body guard,
 * dedupe by name when asked, then map into the family-specific record.
 *
 * Never throws for a bad file or a missing directory — those are warnings (or
 * silence), matching the four hand-written loaders this replaces.
 */
export function loadMarkdownRecords<T>(spec: MarkdownTierSpec<T>): T[] {
	const records: T[] = [];
	const seenNames = new Set<string>();

	for (const dir of spec.dirs) {
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			// Directory doesn't exist or can't be read — no records from this tier.
			spec.onMissingDir?.(dir);
			continue;
		}

		for (const file of files) {
			if (!file.endsWith(".md")) continue;

			try {
				const content = fs.readFileSync(path.join(dir, file), "utf-8");
				const { meta, body } = parseFrontmatter(content);

				const errors = spec.validate(meta, file);
				if (errors.length > 0) {
					for (const err of errors) {
						spec.log?.warn(spec.messages.invalid, { file, error: err });
					}
					continue;
				}

				const bodyError = spec.bodyError?.(meta, body) ?? null;
				if (bodyError !== null) {
					spec.log?.warn(spec.messages.invalid, { file, error: bodyError });
					continue;
				}

				// Both validators reject a missing/non-string name, so it is a string here.
				const name = meta.name as string;
				if (spec.dedupeByName) {
					// First occurrence (highest-precedence dir) wins; later ones are skipped.
					if (seenNames.has(name)) continue;
					seenNames.add(name);
				}

				records.push(spec.map(meta, body, name));
			} catch (err) {
				spec.log?.warn(spec.messages.readFailed, { file, error: (err as Error).message });
			}
		}
	}

	return records;
}
