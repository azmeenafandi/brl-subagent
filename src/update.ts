/**
 * brl-subagent — Version Update Notifier
 *
 * Checks GitHub releases for newer versions of brl-subagent.
 * Runs non-blocking with a 5-second timeout on session start.
 */

import type { Logger } from "./logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
	available: boolean;
	version?: string;
	url?: string;
}

// ---------------------------------------------------------------------------
// Semver comparison
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings (e.g., "2.1.0" vs "2.0.1").
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);
	const len = Math.max(aParts.length, bParts.length);

	for (let i = 0; i < len; i++) {
		const aVal = aParts[i] ?? 0;
		const bVal = bParts[i] ?? 0;
		if (aVal > bVal) return 1;
		if (aVal < bVal) return -1;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Check GitHub for a newer release of brl-subagent.
 *
 * @param currentVersion - The current version string (e.g., "2.0.1")
 * @param log - Optional logger for debug output
 * @returns Update check result, or null on any error (never throws)
 */
export async function checkForUpdates(
	currentVersion: string,
	log?: Logger,
): Promise<UpdateCheckResult | null> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5_000);

		const response = await fetch(
			"https://api.github.com/repos/azmeenafandi/brl-subagent/releases/latest",
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "brl-subagent",
				},
				signal: controller.signal,
			},
		);

		clearTimeout(timeoutId);

		if (!response.ok) {
			log?.debug("Update check: non-OK response", { status: response.status });
			return null;
		}

		const data = (await response.json()) as {
			tag_name?: string;
			html_url?: string;
		};

		if (!data.tag_name || !data.html_url) {
			log?.debug("Update check: missing tag_name or html_url in response");
			return null;
		}

		// Strip "v" prefix from tag_name (e.g., "v2.1.0" → "2.1.0")
		const latestVersion = data.tag_name.replace(/^v/, "");

		const cmp = compareSemver(latestVersion, currentVersion);

		if (cmp > 0) {
			return {
				available: true,
				version: latestVersion,
				url: data.html_url,
			};
		}

		return { available: false };
	} catch (err) {
		log?.debug("Update check failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
