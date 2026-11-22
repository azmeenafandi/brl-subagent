/**
 * The shipped friction-candidate fixture stays shippable (issue #574, §2.5, T13).
 *
 * The corpus under `fixtures/friction-candidates/` is REAL log data frozen from this machine, so the
 * risk is not that it drifts — it is that it silently carries something a log line contained and the
 * derivation never needed: a `task` prompt, a run's `fullOutput`, an `originalParams` blob, a scratch
 * directory. Those are the classified contents this repository's receipts must not publish.
 *
 * The guard is STRUCTURAL, not a keyword search over prose, because a keyword search cannot pass: the
 * tool name `delegate_task` contains "task". Three properties, checked at every depth of every shipped
 * JSON row:
 *
 * 1. no forbidden KEY (`task`, `originalParams`, `fullOutput`, `result`, `outputSummary`, `scratchDir`,
 *    `owner`, `label`, `description`);
 * 2. no string VALUE that starts with `/` — an absolute path names a machine, not an event;
 * 3. no string VALUE longer than 60 characters — the retained fields are ids, enums, model names and
 *    timestamps, and free text is what exceeds that.
 *
 * The sentinel matrix proves property 1–3 can FAIL: every string position in the shipped rows is
 * visited, a sentinel is planted in a scratch copy, and the guard is asserted to name that position.
 * A guard nothing can trip is not a guard. `README.md` is prose, not a row, and is excluded by name.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "friction-candidates");

/** The row files: `README.md` is prose about the corpus, not a row the derivation reads. */
const ROW_FILES = ["session.jsonl", "spawn.log", "expected-candidates.json"];

/** Keys that carry classified content — prohibited at ANY depth, in any file. */
const FORBIDDEN_KEYS = ["task", "originalParams", "fullOutput", "result", "outputSummary", "scratchDir", "owner", "label", "description"];

/** The longest retained value in the corpus is a URN-ish run id; free text would blow past this. */
const MAX_STRING_LENGTH = 60;

interface Slot {
	path: string;
	container: Record<string, unknown> | unknown[];
	key: string | number;
}

function readSlot(slot: Slot): unknown {
	return Array.isArray(slot.container) ? slot.container[slot.key as number] : slot.container[slot.key as string];
}

function writeSlot(slot: Slot, value: unknown): void {
	if (Array.isArray(slot.container)) slot.container[slot.key as number] = value;
	else slot.container[slot.key as string] = value;
}

/** Every key/value position in a parsed row, parents before children. */
function visitEntries(value: unknown, path: string, visit: (slot: Slot) => void): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			visit({ path: `${path}[${index}]`, container: value, key: index });
			visitEntries(item, `${path}[${index}]`, visit);
		}
		return;
	}
	if (value === null || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	for (const [key, item] of Object.entries(record)) {
		visit({ path: `${path}.${key}`, container: record, key });
		visitEntries(item, `${path}.${key}`, visit);
	}
}

/** The leak guard: every violation it finds, with the position that raised it. */
function leaks(value: unknown, path: string): string[] {
	const found: string[] = [];
	visitEntries(value, path, (slot) => {
		const key = String(slot.key);
		if (!Array.isArray(slot.container) && FORBIDDEN_KEYS.includes(key)) found.push(`${slot.path}: forbidden key`);
		const item = readSlot(slot);
		if (typeof item !== "string") return;
		if (item.startsWith("/")) found.push(`${slot.path}: absolute path "${item}"`);
		if (item.length > MAX_STRING_LENGTH) found.push(`${slot.path}: ${item.length}-character string`);
	});
	return found;
}

/** The rows of one fixture file, parsed — `expected-candidates.json` is one document, the logs are JSONL. */
function rowsOf(name: string): unknown[] {
	const text = readFileSync(join(FIXTURE_DIR, name), "utf8");
	if (name.endsWith(".jsonl") || name.endsWith(".log")) {
		return text
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as unknown);
	}
	return [JSON.parse(text) as unknown];
}

/** The guard over a whole file, as the shipped bytes would be read. */
function fileLeaks(name: string): string[] {
	return rowsOf(name).flatMap((row, index) => leaks(row, `${name}:row ${index + 1}`));
}

describe("friction-candidates fixture — the leak guard", () => {
	it("ships no forbidden key, no absolute path and no string over 60 characters", () => {
		for (const name of ROW_FILES) {
			expect({ file: name, leaks: fileLeaks(name) }).toEqual({ file: name, leaks: [] });
		}
	});

	it("the guard is not vacuous: it catches the keys the corpus was scrubbed of", () => {
		// The control the shipped bytes cannot give (they are clean by construction): an injected
		// `task` three levels down must be named, at any depth.
		const row = { type: "custom", data: { id: "run-1", nested: { deeper: [{ task: "a prompt" }] } } };
		expect(leaks(row, "planted")).toEqual(["planted.data.nested.deeper[0].task: forbidden key"]);
	});

	it("the guard catches an absolute path and an oversized string", () => {
		expect(leaks({ data: { scratch: "/home/someone/.cache/x" } }, "planted")).toEqual(['planted.data.scratch: absolute path "/home/someone/.cache/x"']);
		expect(leaks({ data: { note: "x".repeat(MAX_STRING_LENGTH + 1) } }, "planted")).toEqual([`planted.data.note: ${MAX_STRING_LENGTH + 1}-character string`]);
	});
});

/**
 * The sentinel matrix: a scratch copy of each row file, every retained string position replaced in
 * turn by a sentinel, and the guard asserted to fail on THAT position. The scratch copy is what gets
 * mutated — the tracked fixture is only read, so a red matrix can never edit its own corpus.
 */
describe("friction-candidates fixture — the value sentinel in every retained position", () => {
	const scratch = mkdtempSync(join(tmpdir(), "fc-sentinel-"));

	afterAll(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	/** Two sentinels, one per property: an absolute path and a string over the length budget. */
	const SENTINELS = ["/sentinel/absolute/path", "s".repeat(MAX_STRING_LENGTH + 1)];

	/** The string slots of ONE parsed row, under the position root the guard names. */
	function rowSlots(row: unknown, root: string): Slot[] {
		const slots: Slot[] = [];
		visitEntries(row, root, (slot) => {
			if (typeof readSlot(slot) === "string") slots.push(slot);
		});
		return slots;
	}

	it("the scratch copy is the only thing mutated", () => {
		const copy = join(scratch, "session.jsonl");
		writeFileSync(copy, readFileSync(join(FIXTURE_DIR, "session.jsonl")));
		expect(readFileSync(copy, "utf8")).toBe(readFileSync(join(FIXTURE_DIR, "session.jsonl"), "utf8"));
	});

	for (const name of ROW_FILES) {
		it(`every retained string position in ${name} trips the guard on a sentinel`, () => {
			const rows = rowsOf(name);
			expect(rows.flatMap((row, index) => rowSlots(row, `${name}:row ${index + 1}`)).length).toBeGreaterThan(0);

			for (const sentinel of SENTINELS) {
				const planted = JSON.parse(JSON.stringify(rows)) as unknown[];
				for (const [index, row] of planted.entries()) {
					const root = `${name}:row ${index + 1}`;
					for (const slot of rowSlots(row, root)) {
						const original = readSlot(slot);
						writeSlot(slot, sentinel);
						const found = leaks(row, root);
						writeSlot(slot, original);
						expect({ position: slot.path, flagged: found.some((violation) => violation.startsWith(`${slot.path}:`)) }).toEqual({
							position: slot.path,
							flagged: true,
						});
					}
				}
			}
		});
	}
});
