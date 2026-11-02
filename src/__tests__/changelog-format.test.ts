// Purpose: Pin the CHANGELOG's version headings to the shape pi parses for extension-update notices.
/**
 * pi 1.5.0 shows a package's changelog after an update ("Extension Updates", docs/packages.md
 * #show-a-changelog). Its parser (`dist/utils/changelog.js` in pi-coding-agent 1.5.0) reads only
 * `## ` lines and matches `##\s+\[?(\d+)\.(\d+)\.(\d+)\]?`; a `### vX.Y.Z` heading parses as
 * nothing, and a non-version `## ` line resets the collector. Our history used `### vX` — the
 * feature showed nothing (verified against the real parser: 0 entries).
 *
 * This is a docs-pinning test in the #166 class: the format is load-bearing for a user-facing
 * feature but invisible to every other gate, so it gets a ratchet.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const changelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

/** pi's parser regex, quoted from `parseChangelog` (pi-coding-agent 1.5.0). */
const VERSION_HEADING = /^##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/;

const lines = changelog.split("\n");
const h2s = lines.filter((line) => line.startsWith("## "));
const versions = h2s
	.map((line) => VERSION_HEADING.exec(line))
	.filter((match): match is RegExpExecArray => match !== null)
	.map((match) => `${match[1]}.${match[2]}.${match[3]}`);

describe("CHANGELOG.md version headings (pi extension-update notices)", () => {
	it("uses pi-parsable h2 version headings, not the legacy `### vX` form", () => {
		expect(versions.length).toBeGreaterThan(0);
		const legacy = lines.filter((line) => /^### v\d+\.\d+\.\d+/.test(line));
		expect(legacy, "legacy `### vX.Y.Z` headings parse as nothing").toEqual([]);
	});

	it("the newest version heading is the package version", () => {
		expect(versions[0]).toBe(version);
	});

	it("keeps an Unreleased section (inert to pi's parser, but our working area)", () => {
		expect(h2s.some((line) => line.trim() === "## Unreleased")).toBe(true);
	});
});
