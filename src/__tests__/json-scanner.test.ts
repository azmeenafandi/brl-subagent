/**
 * Issue #428 — the shallow JSON identity reader, pinned.
 *
 * The reader is hand-written (`session-manager.ts`), it parses persisted
 * transcript records for retry lineage, and its regression mode is silent: a
 * scanner bug mis-parses a record and the record disappears from the family
 * instead of raising. This file is the unit pin, block-for-block, of the plan
 * critique `.development/investigations/test-plan-428-2026-11-06.md` (A-G). The
 * expectations are that doc's MEASURED values, not re-derived from `JSON.parse`:
 * `JSON.parse` throws or disagrees on 18 of the 45 skip cases (every
 * unterminated case, every mismatched bracket, and all five non-JSON whitespace
 * characters), so each `hand` row here is hand-written on purpose.
 *
 * Decisions pinned (D1-D5, the issue's table):
 *   D1  unterminated string/container     -> end === text.length, never throws
 *   D2  whitespace alphabet               -> /\s/, wider than JSON's four chars
 *   D3  depth counting                    -> bracket-TYPE-agnostic
 *   D4  scalar terminator                 -> first ',' or '}' or EOF; NOT ']'
 *   D5  invalid-escape fallback           -> raw value, correct end
 *
 * Mutation map (each mutant measured; the case named here is its killer):
 *   M1  delete `escaped = false`   -> A4 on `value` (no end-only assertion can)
 *   M8  fallback `raw.slice(1,-1)` -> A12 on `value`
 *   M3  container `\` unarmed      -> B8 (17 -> 9)
 *   M17 caller `i += 1`            -> E2, E3, E5, E6, E7
 *   M7  scalar loop stops at ']'   -> C2, C3, C4
 *
 * Boundaries — what this file does NOT prove:
 *   - `skipWhitespace` is not exported (the seam is three functions), so D is
 *     observed THROUGH `scanTopLevelScalars`: a whitespace character at the
 *     brace, around a key and around the `:` either is or is not skipped, which
 *     is the only externally visible effect. The doc's direct-offset rows
 *     (`'\u00a0{}'` -> 1, `'x  '` -> 0) have no observable through the three
 *     exports and are stated exclusions, not silence.
 *   - `readAgentIdentity`'s consequences are pinned at scan level (E4: a
 *     container value leaves the key absent) and through `findRetryLineage`
 *     (F1/F2); `assertSafeAgentId`/`isAgentStatus` themselves are other tests'.
 *   - the caller's `if (i <= keyStart) break` guard (:759) is defensive: it
 *     survived every measured mutant. E9 pins that the scanner terminates.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
	RETRY_IDENTITY_KEYS,
	findRetryLineage,
	readJsonStringAt,
	scanTopLevelScalars,
	skipJsonValue,
} from "../session-manager";
import { createTempEnv } from "./fixtures/temp-lifecycle";

interface StringCase {
	/** Doubles as the test name; the A-ID comes from the plan critique. */
	id: string;
	text: string;
	start?: number;
	value: string;
	end: number;
	/** Unterminated input (D1) — excluded from the minimality check (G3). */
	open?: boolean;
}

interface SkipCase {
	id: string;
	text: string;
	start?: number;
	end: number;
	/** Unterminated input (D1) — excluded from the minimality check (G3). */
	open?: boolean;
}

interface ScanCase {
	id: string;
	text: string;
	entries: Array<[string, string | number | boolean | null]>;
}

// ---------------------------------------------------------------------------
// A. readJsonStringAt — the {value,end} PAIR, not just the end (B2)
// ---------------------------------------------------------------------------

const STRING_CASES: StringCase[] = [
	{ id: "A1 empty string", text: '""', value: "", end: 2 },
	{ id: "A2 single char", text: '"a"', value: "a", end: 3 },
	{ id: "A3 escaped quote is content, not a terminator", text: '"a\\"b"', value: 'a"b', end: 6 },
	// kills M1 on `value`: the `\\` eats the second backslash, so the `"` after
	// it closes the string. Deleting `escaped = false` makes the value swallow
	// the closing quote — the END does not move, which is why `end`-only
	// assertions cannot kill this mutant.
	{ id: "A4 escaped backslash before the closing quote", text: '"a\\\\"', value: "a\\", end: 5 },
	// Contrast, NOT a killer: `end` is 6 in the base AND under M1, because the
	// closing quote is not immediately after the escape run.
	{ id: "A5 escaped backslash mid-string", text: '"a\\\\b"', value: "a\\b", end: 6 },
	{ id: "A6 escaped solidus", text: '"a\\/b"', value: "a/b", end: 6 },
	{ id: "A7 the four short escapes", text: '"\\b\\f\\n\\r\\t"', value: "\b\f\n\r\t", end: 12 },
	{ id: "A8 unicode escape", text: '"\\u0041"', value: "A", end: 8 },
	// The escape decodes to `"` but the SOURCE `"` is what closes the string.
	{ id: "A9 unicode-escaped quote does not terminate", text: '"a\\u0022b"', value: 'a"b', end: 10 },
	// Pins the offset UNIT: 5 code points, 6 UTF-16 code units — which is what
	// makes `text.slice(0, end)` correct.
	{ id: "A10 astral pair counts two code units", text: '"a😀b"', value: "a😀b", end: 6 },
	{ id: "A11 surrogate-pair escapes", text: '"\\ud83d\\ude00"', value: "😀", end: 14 },
	// kills M8 on `value`: JSON.parse rejects `\q`, so the fallback runs. The
	// fallback must strip the quotes and keep the backslash, not return `raw`.
	{ id: "A12 invalid escape falls back to the raw value", text: '"a\\qb"', value: "a\\qb", end: 6 },
	{ id: "A13 unterminated string ends at text.length", text: '"abc', value: "abc", end: 4, open: true },
	{
		id: "A14 unterminated after an escaped quote",
		text: '"a\\"',
		value: 'a\\"',
		end: 4,
		open: true,
	},
	{ id: "A15 JSON punctuation inside a string", text: '"{}[],:"', value: "{}[],:", end: 8 },
	{ id: "A16 trailing content after the closing quote is ignored", text: '"a"xyz', value: "a", end: 3 },
	{ id: "A17 start offset is honoured", text: 'xx"ab"', start: 2, value: "ab", end: 6 },
];

describe("readJsonStringAt — the {value,end} pair (#428 A, kills M1/M8/M12)", () => {
	it.each(STRING_CASES)("$id", ({ text, start, value, end }) => {
		expect(readJsonStringAt(text, start ?? 0)).toEqual({ value, end });
	});
});

// ---------------------------------------------------------------------------
// B. skipJsonValue — containers
// ---------------------------------------------------------------------------

const CONTAINER_CASES: SkipCase[] = [
	{ id: "B1a empty object", text: "{}", end: 2 },
	{ id: "B1b empty array", text: "[]", end: 2 },
	{ id: "B2 flat array", text: "[1,2]", end: 5 },
	{ id: "B3 mixed nesting", text: '{"a":{"b":[1,{"c":2}]}}', end: 23 },
	{ id: "B4 empty containers as values", text: '{"a":{},"b":[]}', end: 15 },
	// kills M14: `"` must arm inString, or the `}` inside the string closes early.
	{ id: "B5 braces and commas inside a string", text: '{"a":"} , {" }', end: 14 },
	{ id: "B6 brackets inside a string value of an array", text: '[{"a":"]"}]', end: 11 },
	{ id: "B7 escaped quote at the end of a value", text: '{"a":"\\""}', end: 10 },
	// kills M3: without arming `escaped` in the container loop, the `"` after the
	// backslash closes the string and the `}` right after it ends the value at 9.
	{ id: "B8 escaped quote followed by a brace", text: '{"a":"\\"}","b":2}', end: 17 },
	{ id: "B9 escaped backslash at the end of a value", text: '{"a":"x\\\\"}', end: 11 },
	// kills M4: `escaped` must CLEAR on the next char. These two need trailing
	// content — without it the stale flag is invisible.
	{ id: "B10 escape then trailing content", text: '{"a":"\\n"} xyz', end: 10 },
	{ id: "B11 escaped backslash then trailing content", text: '{"a":"\\\\"} tail', end: 10 },
	{ id: "B12 escapes and a brace inside an array", text: '["a\\\\","\\"","}"]', end: 16 },
	{ id: "B13a trailing space after a container", text: "[1,2] ", end: 5 },
	{ id: "B13b trailing garbage after a container", text: '{"a":1} xyz', end: 7 },
	{ id: "B14a unterminated array", text: "[1,2", end: 4, open: true },
	{ id: "B14b unterminated nested array", text: '{"a": [1,2', end: 10, open: true },
	{ id: "B14c lone open bracket", text: "[", end: 1, open: true },
	{ id: "B15 unterminated string inside a container", text: '{"a":"abc', end: 9, open: true },
	// D3: the depth counter is bracket-type-agnostic — closing the wrong bracket
	// still counts down. Strictness is JSON.parse's job.
	{ id: "B16a mismatched closer", text: "[1}", end: 3 },
	{ id: "B16b mismatched closer inside an object", text: '{"a":1]', end: 7 },
	{ id: "B16c mismatched nesting", text: '{"a":[1}]}', end: 9 },
	{ id: "B17 extra closer is ignored", text: "[]]", end: 2 },
	// D2: NBSP is whitespace to this reader and NOT to JSON.parse.
	{ id: "B18 NBSP inside the object", text: '{\u00a0"a":1}', end: 8 },
	{ id: "B19 CRLF inside the object", text: '{\r\n"a":1\r\n}', end: 11 },
	{ id: "B21 start offset is honoured", text: 'xx{"a":1}', start: 2, end: 9 },
];

describe("skipJsonValue — containers (#428 B, kills M3/M4/M6/M9/M14)", () => {
	it.each(CONTAINER_CASES)("$id", ({ text, start, end }) => {
		expect(skipJsonValue(text, start ?? 0)).toBe(end);
	});

	it("B20 a 10 000-deep container completes iteratively (no recursion)", () => {
		const depth = 10_000;
		const text = "[".repeat(depth) + "]".repeat(depth);
		// A recursive rewrite of the loop would raise RangeError here.
		expect(skipJsonValue(text, 0)).toBe(text.length);
	});
});

// ---------------------------------------------------------------------------
// C. skipJsonValue — the scalar branch (D4: the terminator rule)
// ---------------------------------------------------------------------------

const SCALAR_CASES: SkipCase[] = [
	{ id: "C1a comma terminates a scalar", text: "1,", end: 1 },
	{ id: "C1b close brace terminates a scalar", text: "1}", end: 1 },
	// D4: `]` is NOT a terminator. This is the contract, not an oversight — the
	// fix (M7) is a separate behaviour issue, if ever wanted.
	{ id: "C2 close bracket does not terminate", text: "1]", end: 2 },
	{ id: "C3 lone close bracket is scanned to the end", text: "]", end: 1 },
	{ id: "C4 bracket inside a bare scalar run", text: "abc]def,", end: 7 },
	// Zero progress, never a throw — the caller's termination depends on it.
	{ id: "C5a lone close brace makes zero progress", text: "}", end: 0 },
	{ id: "C5b lone comma makes zero progress", text: ",", end: 0 },
	{ id: "C5c empty text returns start", text: "", end: 0 },
	{ id: "C6 out-of-contract start is clamped to start", text: '{"a":1}', start: 99, end: 99 },
	// No oracle exists for these: they are not JSON values, and the scanner
	// absorbs them as bare text and lets parseJsonScalar decide.
	{ id: "C7a bare word", text: "true xyz", end: 8 },
	{ id: "C7b truncated literal", text: "nul", end: 3 },
	{ id: "C7c NaN is not a JSON value", text: "NaN", end: 3 },
	{ id: "C8a boolean literal", text: "true,", end: 4 },
	{ id: "C8b null literal", text: "null,", end: 4 },
	{ id: "C8c signed exponent number", text: "-0.5e+3}", end: 7 },
	// The JSON.parse minimality oracle is INVALID here: `JSON.parse('1')`
	// succeeds, so `end` comes from the terminator rule alone.
	{ id: "C9 two-digit number", text: "12,", end: 2 },
	{ id: "C10 overflowing exponent", text: "1e999", end: 5 },
	{ id: "C11a inner offset dispatches to the container branch", text: "[1,2]", start: 1, end: 2 },
	{ id: "C11b inner offset after a key", text: '{"a":1}', start: 1, end: 4 },
];

describe("skipJsonValue — the scalar terminator contract (#428 C, kills M7/M10)", () => {
	it.each(SCALAR_CASES)("$id", ({ text, start, end }) => {
		expect(skipJsonValue(text, start ?? 0)).toBe(end);
	});
});

// ---------------------------------------------------------------------------
// D. The whitespace alphabet is /\s/, deliberately wider than JSON's four (D2)
//
// Observed through `scanTopLevelScalars`: `skipWhitespace` is not part of the
// three-function seam. Each row either yields the field (the character WAS
// skipped) or nothing (it was not) — never asserted against `JSON.parse`, which
// throws on four of these five characters.
// ---------------------------------------------------------------------------

const WHITESPACE_CASES: ScanCase[] = [
	{ id: "D1 NBSP before the object", text: '\u00a0{"id":"x"}', entries: [["id", "x"]] },
	{ id: "D2 BOM before the object", text: '\ufeff{"id":"x"}', entries: [["id", "x"]] },
	{ id: "D3a U+2028 line separator", text: '\u2028{"id":"x"}', entries: [["id", "x"]] },
	{ id: "D3b vertical tab", text: '\u000b{"id":"x"}', entries: [["id", "x"]] },
	{ id: "D3c ideographic space", text: '\u3000{"id":"x"}', entries: [["id", "x"]] },
	{ id: "D4 the four JSON whitespace characters", text: '\r\n\t {"id":"x"}', entries: [["id", "x"]] },
	{ id: "D6a NBSP around the colon", text: '{"id"\u00a0:\u00a0"x"}', entries: [["id", "x"]] },
	{ id: "D6b BOM after the brace and U+2028 after the colon", text: '{\ufeff"id":\u2028"x"}', entries: [["id", "x"]] },
	// The loop stops at the first NON-whitespace character: it skips one NBSP,
	// sees `x`, and refuses the record — the skip is bounded, not greedy.
	{ id: "D6c a non-whitespace byte after the skip is not consumed", text: '\u00a0x{"id":"x"}', entries: [] },
];

describe("scanTopLevelScalars — the whitespace alphabet is /\\s/ (#428 D, kills M11)", () => {
	it.each(WHITESPACE_CASES)("$id", ({ text, entries }) => {
		expect([...scanTopLevelScalars(text, RETRY_IDENTITY_KEYS)]).toEqual(entries);
	});
});

// ---------------------------------------------------------------------------
// E. scanTopLevelScalars — nested payloads are skipped, never read (M4)
// ---------------------------------------------------------------------------

const NESTED_SOURCE_ID = "99f4e815-9968-4554-a7b0-0cf646aa9e26";
const NESTED_DISPATCH_ID = "1662ba9e-1111-4222-8333-944455556666";

/**
 * A realistic record: the six identity fields, plus a `result` whose
 * `result.messages[].content[].text` and `finalOutput` carry every byte the
 * scanner treats specially (`\"`, `}`, `{`, `,`, `\\`).
 */
const REALISTIC_RECORD = JSON.stringify({
	id: NESTED_SOURCE_ID,
	sessionId: "sess-99f4e815",
	type: "general-purpose",
	description: 'agent says "hi"',
	status: "completed",
	startedAt: 1762345678901,
	task: "do } { the thing",
	model: "test/model",
	thinkingLevel: "medium",
	result: {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: 'he said "hi", }{ \\ ok' }] },
		],
		finalOutput: 'done } "quoted" , ok',
	},
	attempt: 2,
	dispatchId: NESTED_DISPATCH_ID,
	resumeOf: "0f1e2d3c-4b5a-4968-8776-655443322110",
});

const SCAN_CASES: ScanCase[] = [
	{
		id: "E1 realistic record with adversarial nested payload",
		text: REALISTIC_RECORD,
		entries: [
			["id", NESTED_SOURCE_ID],
			["status", "completed"],
			["startedAt", 1762345678901],
			["attempt", 2],
			["dispatchId", NESTED_DISPATCH_ID],
			["resumeOf", "0f1e2d3c-4b5a-4968-8776-655443322110"],
		],
	},
	// kills M17: the decoy `"status":"failed"` sits INSIDE the nested payload,
	// after the real one. A caller that steps `i += 1` instead of skipping the
	// value re-reads the payload as top level and reports `failed`.
	{
		id: "E2 a nested decoy status is never read",
		text: '{"id":"a","status":"completed","result":{"messages":[{"status":"failed"}]}}',
		entries: [
			["id", "a"],
			["status", "completed"],
		],
	},
	{
		id: "E3 a nested decoy attempt is never read",
		text: '{"attempt":2,"result":{"messages":[{"attempt":99}]},"id":"a"}',
		entries: [
			["attempt", 2],
			["id", "a"],
		],
	},
	// kills M18: a wanted key holding a CONTAINER is skipped, not read. In
	// `readAgentIdentity` the absent `id` falls back to the file's basename.
	{
		id: "E4 a wanted key holding a container stays absent",
		text: '{"id":{"a":1},"status":"completed"}',
		entries: [["status", "completed"]],
	},
	// kills M17: an unterminated string inside the nested payload must not leak
	// the payload's fields, hang, or throw.
	{
		id: "E5 unterminated nested string does not leak or hang",
		text: '{"id":"a","result":{"m":"abc,"status":"completed"}',
		entries: [["id", "a"]],
	},
	// kills M17 alongside M14: a `}` INSIDE a string inside an array value.
	{
		id: "E6 braces inside a nested array value",
		text: '{"id":"a","tags":["x}","y"],"status":"completed"}',
		entries: [
			["id", "a"],
			["status", "completed"],
		],
	},
	// kills M4 and M17: CRLF plus `\u0022`-escaped quotes inside the payload.
	{
		id: "E7 escaped quotes and CRLF inside the payload",
		text: '{"id":"a",\r\n"result":{"m":"he said \\u0022hi\\u0022, } {"},\r\n"status":"completed"}',
		entries: [
			["id", "a"],
			["status", "completed"],
		],
	},
	// kills M11: a BOM-prefixed record must not vanish from lineage.
	{
		id: "E8 BOM-prefixed record is still read",
		text: '\ufeff{"id":"agt_3","status":"completed","startedAt":1}',
		entries: [
			["id", "agt_3"],
			["status", "completed"],
			["startedAt", 1],
		],
	},
	{ id: "E9a malformed value terminates", text: '{"id":"x","a":,}', entries: [["id", "x"]] },
	{ id: "E9b truncated after the colon terminates", text: '{"id":"x","b":', entries: [["id", "x"]] },
	{ id: "E10a an array is not a record", text: "[]", entries: [] },
	{ id: "E10b an empty object has no fields", text: "{}", entries: [] },
	{ id: "E10c a stray closer after the object is ignored", text: '{"id":"x"}}', entries: [["id", "x"]] },
	{ id: "E10d a duplicate key keeps the last value", text: '{"id":"a","id":"b"}', entries: [["id", "b"]] },
	// `startedAt` stays a string here; `normalizeStartedAt` is what converts it.
	{
		id: "E11 an ISO startedAt stays a string at scan level",
		text: '{"id":"a","status":"completed","startedAt":"2026-11-06T00:00:00.000Z"}',
		entries: [
			["id", "a"],
			["status", "completed"],
			["startedAt", "2026-11-06T00:00:00.000Z"],
		],
	},
];

describe("scanTopLevelScalars — nested payloads are skipped, never read (#428 E, kills M4/M11/M17/M18)", () => {
	it.each(SCAN_CASES)("$id", ({ text, entries }) => {
		expect([...scanTopLevelScalars(text, RETRY_IDENTITY_KEYS)]).toEqual(entries);
	});

	it("E12 a ~200 KB record still yields only the identity fields", () => {
		const messages = Array.from({ length: 2000 }, (_, i) => ({
			role: "assistant",
			content: [{ type: "text", text: `line ${i} with } { , "quotes" and \\ backslash` }],
		}));
		const record = JSON.stringify({
			id: NESTED_SOURCE_ID,
			status: "completed",
			startedAt: 1762345678901,
			result: { messages, finalOutput: "done" },
		});
		expect(record.length).toBeGreaterThan(200_000);
		expect([...scanTopLevelScalars(record, RETRY_IDENTITY_KEYS)]).toEqual([
			["id", NESTED_SOURCE_ID],
			["status", "completed"],
			["startedAt", 1762345678901],
		]);
	});
});

// ---------------------------------------------------------------------------
// G. Invariants
// ---------------------------------------------------------------------------

describe("invariants (#428 G)", () => {
	it("G1 every end is a number inside [start, text.length] and nothing throws", () => {
		// The upper bound is `max(start, text.length)`: C6's out-of-contract start
		// (`start > text.length`) returns `start` rather than clamping — measured,
		// and the contract is "never throws", so the bound is widened for it.
		for (const { text, start, end } of STRING_CASES) {
			const from = start ?? 0;
			const result = readJsonStringAt(text, from);
			expect(Number.isInteger(result.end), `end for ${JSON.stringify(text)}`).toBe(true);
			expect(result.end).toBeGreaterThanOrEqual(from);
			expect(result.end).toBeLessThanOrEqual(Math.max(from, text.length));
			expect(result.end).toBe(end);
		}
		for (const { text, start, end } of [...CONTAINER_CASES, ...SCALAR_CASES]) {
			const from = start ?? 0;
			const result = skipJsonValue(text, from);
			expect(Number.isInteger(result), `end for ${JSON.stringify(text)}`).toBe(true);
			expect(result).toBeGreaterThanOrEqual(from);
			expect(result).toBeLessThanOrEqual(Math.max(from, text.length));
			expect(result).toBe(end);
		}
	});

	it("G2 seeded round-trip over 200 generated values", () => {
		const rand = mulberry32(428);
		const generated: unknown[] = [];
		for (let i = 0; i < 200; i += 1) generated.push(randomValue(rand, 0));

		for (const value of generated) {
			const text = JSON.stringify(value);
			const end = skipJsonValue(text, 0);
			// Self-delimiting: the reader consumes the value exactly.
			expect(end, `end for ${text}`).toBe(text.length);
			expect(JSON.parse(text.slice(0, end)), `value for ${text}`).toEqual(value);
		}
	});

	it("G3 minimality — one byte short of `end` is not the same value", () => {
		const closed = [
			...STRING_CASES.filter((c) => !c.open),
			...CONTAINER_CASES.filter((c) => !c.open),
		];
		for (const { text, start, end } of closed) {
			const from = start ?? 0;
			// A self-delimiting value whose last byte can be dropped and still
			// parse means `end` overshot (the scalar branch is exempt by C9).
			expect(
				() => JSON.parse(text.slice(from, end - 1)),
				`prefix of ${JSON.stringify(text)} parsed`,
			).toThrow();
		}
	});
});

/** Deterministic PRNG (mulberry32) — a fixed seed, so G2 cannot flake. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Bytes the scanner must survive inside a string (JSON.stringify escapes them). */
const ALPHABET = ['"', "\\", "{", "}", "[", "]", ",", ":", " ", "\n", "\t", "😀", "é", "\u0000", "a", "日本語"];

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)];
}

function randomString(rand: () => number): string {
	const length = Math.floor(rand() * 6);
	let out = "";
	for (let i = 0; i < length; i += 1) out += pick(rand, ALPHABET);
	return out;
}

/**
 * Strings/containers/booleans/null/integers only — no non-finite and no `-0`,
 * whose `JSON.stringify` output (`null`, `0`) would make G2 assert nonsense.
 */
function randomValue(rand: () => number, depth: number): unknown {
	const kind = depth >= 3 ? Math.floor(rand() * 3) : Math.floor(rand() * 6);
	switch (kind) {
		case 0:
			return randomString(rand);
		case 1:
			return rand() < 0.5;
		case 2:
			return rand() < 0.5 ? null : Math.floor(rand() * 2000) - 1000;
		case 3:
			return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
		default: {
			const obj: Record<string, unknown> = {};
			const size = Math.floor(rand() * 4);
			for (let i = 0; i < size; i += 1) obj[randomString(rand)] = randomValue(rand, depth + 1);
			return obj;
		}
	}
}

// ---------------------------------------------------------------------------
// F. findRetryLineage over a store with adversarial nesting — the level where
// the regression actually lands (M4)
// ---------------------------------------------------------------------------

const env = createTempEnv("brl-428-scanner");

const SOURCE_ID = "99f4e815-9968-4554-a7b0-0cf646aa9e26";
const RETRY_ID = "f36f8413-0bb4-4752-918f-93ed19c31014";
const DISPATCH_ID = "1662ba9e-1111-4222-8333-944455556666";

/**
 * Written as RAW text, not via `JSON.stringify`: the point of the F block is
 * bytes inside a nested payload (`\"`, `}`, `,`, `\\`) that a serializer would
 * normalise away, plus (F2) an invalid escape no serializer can produce.
 */
const SOURCE_RECORD = `{"id":"${SOURCE_ID}","sessionId":"sess-99f4e815","type":"general-purpose","description":"agent 99f4e815","status":"failed","startedAt":1762345678901,"task":"do } { the thing, \\"quoted\\"","result":{"messages":[{"role":"assistant","content":[{"type":"text","text":"{\\"status\\":\\"completed\\",\\"attempt\\":99} and } { , \\\\"}]}],"finalOutput":"done \\"quoted\\" , }"},"attempt":1,"dispatchId":"${DISPATCH_ID}"}`;

const RETRY_RECORD = `{"id":"${RETRY_ID}","status":"completed","startedAt":1762345799000,"attempt":2,"dispatchId":"${DISPATCH_ID}","resumeOf":"${SOURCE_ID}","result":{"messages":[]}}`;

/** F2: the same record, but its `id` carries an invalid escape (`\q`). */
const ESCAPED_ID_RECORD = SOURCE_RECORD.replace(
	`"id":"${SOURCE_ID}"`,
	`"id":"${SOURCE_ID.slice(0, -2)}\\q"`,
);

function writeRecord(id: string, text: string): void {
	mkdirSync(env.storageDir, { recursive: true });
	writeFileSync(path.join(env.storageDir, `${id}.json`), text);
}

describe("findRetryLineage over a store with adversarial nesting (#428 F, kills M17)", () => {
	beforeEach(() => env.setUp());
	afterAll(async () => await env.tearDown());

	it("F1 a nested decoy status never surfaces; the family is intact", () => {
		// The record is valid JSON — so the decoy is real payload, not damage.
		expect(() => JSON.parse(SOURCE_RECORD)).not.toThrow();
		writeRecord(SOURCE_ID, SOURCE_RECORD);
		writeRecord(RETRY_ID, RETRY_RECORD);

		const lineage = findRetryLineage(SOURCE_ID);

		expect(lineage.family.map((record) => record.id)).toEqual([SOURCE_ID, RETRY_ID]);
		// The `"status":"completed"` and `"attempt":99` inside result.messages are
		// payload. Reading them would rewrite the source record's identity.
		expect(lineage.found?.status).toBe("failed");
		expect(lineage.found?.attempt).toBe(1);
		expect(lineage.latest?.id).toBe(RETRY_ID);
	});

	it("F2 an invalid escape in `id` drops that record, never throws (D5)", () => {
		expect(() => JSON.parse(ESCAPED_ID_RECORD)).toThrow();
		writeRecord(SOURCE_ID, ESCAPED_ID_RECORD);
		writeRecord(RETRY_ID, RETRY_RECORD);

		const lineage = findRetryLineage(SOURCE_ID);

		// The scan succeeds; `assertSafeAgentId` rejects the raw value, so the
		// record leaves the family and the answer still comes from the retry.
		expect(lineage.found).toBeNull();
		expect(lineage.family.map((record) => record.id)).toEqual([RETRY_ID]);
	});
});
