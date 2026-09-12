import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pkgPath } from "../paths";

// ---------------------------------------------------------------------------
// Issue #158: pin the published-package packaging contract for AGENT.md.
//
// The `delegate_task` tool points the conductor at the extension's AGENT.md.
// For that reference to be resolvable on the documented primary install channel
// (`pi install npm:brl-subagent`), AGENT.md must both exist at the package root
// and be included in package.json's `files` allowlist. Before this fix it was
// omitted from `files` entirely, so it never shipped in the published tarball.
//
// These assertions are manifest/doc pinning, not behavioural tests — they fail
// loudly if the entry is dropped or the file is moved/renamed.
// ---------------------------------------------------------------------------

const repoRoot = join(__dirname, "..", "..");

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
	files?: string[];
	version: string;
};

describe("package manifest ships AGENT.md (issue #158)", () => {
	it("package.json `files` array includes AGENT.md", () => {
		expect(Array.isArray(packageJson.files), "package.json must declare a `files` array").toBe(true);
		expect(packageJson.files, "AGENT.md must be listed in package.json `files` so it ships in the tarball").toContain(
			"AGENT.md",
		);
	});

	it("AGENT.md exists at the package root", () => {
		expect(existsSync(join(repoRoot, "AGENT.md")), "AGENT.md must exist at the package root").toBe(true);
	});

	it("pkgPath resolves bundled root assets from the extension's own module dir", () => {
		// Exercise the SAME helper index.ts uses. A wrong path depth would make
		// these resolve inside src/ and fail, instead of passing the suite.
		expect(existsSync(pkgPath("AGENT.md")), "pkgPath(\"AGENT.md\") must resolve the shipped AGENT.md").toBe(true);
		expect(existsSync(pkgPath("package.json")), "pkgPath(\"package.json\") must resolve the package manifest").toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// Issue #166: pin the shipped docs' version strings to package.json.
//
// The v2.3.5 release shipped three stale version strings because nothing
// pinned them. These assertions make the release ritual's version-inventory
// step mechanical: the README's version line and git-install example tag must
// track package.json, and AGENT.md's H1 must stay version-free so it cannot
// drift again.
// ---------------------------------------------------------------------------

const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const agentMd = readFileSync(join(repoRoot, "AGENT.md"), "utf8");

describe("shipped docs track the manifest version (issue #166)", () => {
	it("README `**Version:**` line contains package.json's version", () => {
		const versionLine = readme.split("\n").find((line) => line.startsWith("**Version:**"));
		expect(versionLine, "README must contain a `**Version:**` line").toBeDefined();
		expect(versionLine).toContain(`**Version:** ${packageJson.version}`);
	});

	it("README git-install example tag equals `v` + package.json's version", () => {
		const match = readme.match(/pi install git:github\.com\/azmeenafandi\/brl-subagent@(v\d+\.\d+\.\d+)/);
		expect(match, "README must contain the pinned git-install example").not.toBeNull();
		expect(match?.[1]).toBe(`v${packageJson.version}`);
	});

	it("AGENT.md H1 carries no version stamp", () => {
		const firstLine = agentMd.split("\n")[0];
		expect(firstLine, "AGENT.md must have an H1 on its first line").toMatch(/^# /);
		expect(firstLine).not.toMatch(/\d+\.\d+\.\d+/);
	});
});
