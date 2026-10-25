/**
 * Direct unit tests for the shared markdown-tier loader (src/loader.ts),
 * extracted in issue #380 (D6 in the smell audit): the preset and template
 * tiers each had their own copy of dir list → readdir → `.md` filter →
 * frontmatter → validate → normalise.
 *
 * These pin the walk's contract in isolation, including the branch no family
 * test reaches — a `.md` dirent that is a directory (read failure → warn and
 * keep scanning) — and the two behaviours the family loaders rely on but do
 * not own anymore: per-error warn-and-skip, and first-occurrence-wins dedupe
 * across dirs (PROJECT > USER precedence).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMarkdownRecords, parseFrontmatter } from "../loader";
import { parseFrontmatter as parseFrontmatterFromPresets } from "../presets";
import type { Logger } from "../logging";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-subagent-loader-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeLog() {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function writeFile(dir: string, fileName: string, content: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, fileName), content, "utf-8");
}

const FM = (lines: string[], body: string): string => ["---", ...lines, "---", body].join("\n");

/** Minimal record shape: the loader is generic, so tests use a throwaway type. */
interface Rec {
	name: string;
	body?: string;
	extra?: string;
}

function rec(meta: Record<string, unknown>, body: string, name: string): Rec {
	return { name, body: body || undefined, extra: (meta.extra as string) || undefined };
}

const MESSAGES = { invalid: "validation failed", readFailed: "read failed" };

function requireName(meta: Record<string, unknown>, fileName: string): string[] {
	return meta.name ? [] : [`"${fileName}" is missing required "name"`];
}

describe("loadMarkdownRecords", () => {
	it("maps every valid .md file and ignores other extensions", () => {
		const dir = makeTempDir();
		writeFile(dir, "a.md", FM(["name: a", "extra: one"], "body a"));
		writeFile(dir, "b.md", FM(["name: b"], "body b"));
		writeFile(dir, "notes.txt", "not markdown");
		writeFile(dir, "README", "not markdown");

		const records = loadMarkdownRecords<Rec>({
			dirs: [dir],
			validate: requireName,
			map: rec,
			messages: MESSAGES,
		});

		expect(records).toEqual([
			{ name: "a", body: "body a", extra: "one" },
			{ name: "b", body: "body b", extra: undefined },
		]);
	});

	it("warns once per validation error and skips the file", () => {
		const dir = makeTempDir();
		writeFile(dir, "ok.md", FM(["name: ok"], "body"));
		writeFile(dir, "bad.md", FM(["extra: no name"], "body"));
		const log = makeLog();

		const records = loadMarkdownRecords<Rec>({
			dirs: [dir],
			validate: requireName,
			map: rec,
			messages: MESSAGES,
			log,
		});

		expect(records.map((r) => r.name)).toEqual(["ok"]);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(MESSAGES.invalid, {
			file: "bad.md",
			error: '"bad.md" is missing required "name"',
		});
	});

	it("warns and skips when the body guard rejects a validated file", () => {
		const dir = makeTempDir();
		writeFile(dir, "empty.md", FM(["name: empty"], "   "));
		writeFile(dir, "filled.md", FM(["name: filled"], "task"));
		const log = makeLog();

		const records = loadMarkdownRecords<Rec>({
			dirs: [dir],
			validate: requireName,
			map: rec,
			messages: MESSAGES,
			log,
			bodyError: (meta, body) => (body.trim() ? null : `${String(meta.name)} has empty body`),
		});

		expect(records.map((r) => r.name)).toEqual(["filled"]);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(MESSAGES.invalid, {
			file: "empty.md",
			error: "empty has empty body",
		});
	});

	it("warns and keeps scanning when a .md dirent cannot be read", () => {
		const dir = makeTempDir();
		writeFile(dir, "ok.md", FM(["name: ok"], "body"));
		// A directory named `*.md` passes the extension filter, then EISDIRs on read.
		fs.mkdirSync(path.join(dir, "adir.md"), { recursive: true });
		const log = makeLog();

		const records = loadMarkdownRecords<Rec>({
			dirs: [dir],
			validate: requireName,
			map: rec,
			messages: MESSAGES,
			log,
		});

		expect(records.map((r) => r.name)).toEqual(["ok"]);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(MESSAGES.readFailed, {
			file: "adir.md",
			error: expect.stringContaining("EISDIR"),
		});
	});

	it("warns and keeps scanning when the mapper throws", () => {
		const dir = makeTempDir();
		writeFile(dir, "boom.md", FM(["name: boom"], "body"));
		const log = makeLog();

		const records = loadMarkdownRecords<Rec>({
			dirs: [dir],
			validate: requireName,
			map: () => {
				throw new Error("mapper exploded");
			},
			messages: MESSAGES,
			log,
		});

		expect(records).toEqual([]);
		expect(log.warn).toHaveBeenCalledWith(MESSAGES.readFailed, {
			file: "boom.md",
			error: "mapper exploded",
		});
	});

	it("skips a name already seen when dedupeByName is set (first dir wins)", () => {
		const first = makeTempDir();
		const second = makeTempDir();
		writeFile(first, "dup.md", FM(["name: dup"], "project body"));
		writeFile(first, "only-first.md", FM(["name: only-first"], "body"));
		writeFile(second, "dup.md", FM(["name: dup"], "global body"));
		writeFile(second, "only-second.md", FM(["name: only-second"], "body"));

		const records = loadMarkdownRecords<Rec>({
			dirs: [first, second],
			validate: requireName,
			map: rec,
			messages: MESSAGES,
			dedupeByName: true,
		});

		expect(records).toEqual([
			{ name: "dup", body: "project body", extra: undefined },
			{ name: "only-first", body: "body", extra: undefined },
			{ name: "only-second", body: "body", extra: undefined },
		]);
	});

	it("keeps name collisions when dedupeByName is not set (builtin tiers)", () => {
		const dir = makeTempDir();
		writeFile(dir, "dup.md", FM(["name: dup"], "body"));
		writeFile(dir, "dup-copy.md", FM(["name: dup"], "body"));

		const records = loadMarkdownRecords<Rec>({
			dirs: [dir],
			validate: requireName,
			map: rec,
			messages: MESSAGES,
		});

		expect(records.map((r) => r.name)).toEqual(["dup", "dup"]);
	});

	it("reports a missing directory and still scans the remaining dirs", () => {
		const dir = makeTempDir();
		writeFile(dir, "ok.md", FM(["name: ok"], "body"));
		const missing = path.join(makeTempDir(), "nope");
		const onMissingDir = vi.fn();

		const records = loadMarkdownRecords<Rec>({
			dirs: [missing, dir],
			validate: requireName,
			map: rec,
			messages: MESSAGES,
			onMissingDir,
		});

		expect(records.map((r) => r.name)).toEqual(["ok"]);
		expect(onMissingDir).toHaveBeenCalledTimes(1);
		expect(onMissingDir).toHaveBeenCalledWith(missing);
	});

	it("stays silent and never throws without a logger", () => {
		const dir = makeTempDir();
		writeFile(dir, "bad.md", FM(["extra: no name"], "body"));
		const missing = path.join(makeTempDir(), "nope");

		expect(
			loadMarkdownRecords<Rec>({ dirs: [missing, dir], validate: requireName, map: rec, messages: MESSAGES }),
		).toEqual([]);
	});
});

describe("parseFrontmatter re-export (issue #380)", () => {
	it("presets.ts still exports the one parser from loader.ts", () => {
		expect(parseFrontmatterFromPresets).toBe(parseFrontmatter);
	});

	it("splits frontmatter from the trimmed body", () => {
		expect(parseFrontmatter(FM(["name: x", "tools:", "  - read"], "\n  Body text.  \n"))).toEqual({
			meta: { name: "x", tools: ["read"] },
			body: "Body text.",
		});
	});
});
