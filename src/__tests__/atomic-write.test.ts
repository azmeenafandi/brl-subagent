/**
 * Issue #554 — the atomic agent-record writer and its temp-residue sweep.
 *
 * The deterministic crash points are the primary proof (E1): each case seeds a
 * VALID old record, injects one failure through the writer's `fs` seam, and
 * asserts the destination still parses byte-for-byte as before. The controls
 * make those assertions falsifiable — the same half write applied in place (no
 * temp, no rename) DOES corrupt the destination.
 *
 * Mutation tripwire (applied by hand, observed, reverted):
 *   M1 — write the destination before the rename → cases (a)/(b) fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	closeSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { writeFileAtomicSync, type AtomicFs } from '../atomic-write';
import { __setStorageDir, sweepAgentRecordTemps, AGENT_TEMP_MAX_AGE_MS } from '../session-manager';

const SEEDED = JSON.stringify(
	{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'running', task: 'seeded task', startedAt: 1 },
	null,
	2,
);

let dir = '';
let file = '';

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), 'brl-atomic-554-'));
	file = path.join(dir, 'record.json');
	writeFileSync(file, SEEDED, { mode: 0o600 });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** The real fs, with ONE behaviour replaced — the fault seam only. */
function seam(overrides: Partial<AtomicFs>): AtomicFs {
	return { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, ...overrides };
}

/** Every temp sibling this writer could have left behind. */
function temps(): string[] {
	return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

describe('issue #554 — writeFileAtomicSync', () => {
	it('(a) a partial write followed by a throw leaves the destination byte-identical and parsing, with no temp', () => {
		const injected = seam({
			writeFileSync: (fd, data) => {
				writeFileSync(fd, data.slice(0, Math.floor(data.length / 2)));
				throw new Error('injected: write failed mid-record');
			},
		});

		expect(() => writeFileAtomicSync(file, JSON.stringify({ status: 'failed' }), { fs: injected })).toThrow(
			'injected: write failed mid-record',
		);

		expect(readFileSync(file, 'utf8')).toBe(SEEDED);
		expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('running');
		expect(temps()).toEqual([]);
	});

	it('CONTROL (a): the same half write applied in place DOES corrupt the destination', () => {
		const next = JSON.stringify({ status: 'failed', task: 'next' });
		// The pre-#554 shape: truncate the destination, then write part of it.
		writeFileSync(file, next.slice(0, Math.floor(next.length / 2)));

		expect(() => JSON.parse(readFileSync(file, 'utf8'))).toThrow();
		expect(readFileSync(file, 'utf8')).not.toBe(SEEDED);
	});

	it('(b) a failing rename leaves the destination untouched (and cleans its temp up)', () => {
		const injected = seam({
			renameSync: () => {
				throw new Error('injected: rename failed');
			},
		});

		expect(() => writeFileAtomicSync(file, JSON.stringify({ status: 'failed' }), { fs: injected })).toThrow(
			'injected: rename failed',
		);

		expect(readFileSync(file, 'utf8')).toBe(SEEDED);
		expect(temps()).toEqual([]); // the contract's best-effort unlink ran
	});

	it('CONTROL (b): the no-rename shape — temp written, rename absent — leaves the destination untouched and the temp alive', () => {
		const next = JSON.stringify({ status: 'failed' });
		const tmp = `${file}.${process.pid}.control.tmp`;
		writeFileSync(tmp, next, { mode: 0o600 });
		// ...no rename: this is the atomicity mechanism, and what a SIGKILL leaves.

		expect(readFileSync(file, 'utf8')).toBe(SEEDED);
		expect(temps()).toEqual([path.basename(tmp)]);
	});

	it('(c) a missing temp during cleanup never masks the ORIGINAL error', () => {
		const injected = seam({
			writeFileSync: () => {
				throw new Error('injected: original failure');
			},
			unlinkSync: () => {
				const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				throw err;
			},
		});

		let caught: unknown;
		try {
			writeFileAtomicSync(file, '{}', { fs: injected });
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe('injected: original failure');
		expect((caught as NodeJS.ErrnoException).code).not.toBe('ENOENT');
		expect(readFileSync(file, 'utf8')).toBe(SEEDED);
	});

	it('(c2) a write fault AND a close fault keep the PRIMARY error — the destination stays byte-identical with no temp', () => {
		const injected = seam({
			writeFileSync: () => {
				throw new Error('PRIMARY');
			},
			closeSync: () => {
				throw new Error('SECOND');
			},
		});

		let caught: unknown;
		try {
			writeFileAtomicSync(file, '{}', { fs: injected });
		} catch (err) {
			caught = err;
		}

		expect((caught as Error).message).toBe('PRIMARY');
		expect(readFileSync(file, 'utf8')).toBe(SEEDED);
		expect(temps()).toEqual([]);
	});

	it('(c3) a close fault that is the ONLY failure does surface', () => {
		const injected = seam({
			closeSync: () => {
				throw new Error('SECOND');
			},
		});

		expect(() => writeFileAtomicSync(file, '{}', { fs: injected })).toThrow('SECOND');

		expect(readFileSync(file, 'utf8')).toBe(SEEDED);
		expect(temps()).toEqual([]);
	});

	it('(d) success replaces the bytes with a 0o600 record and leaves no temp', () => {
		const next = JSON.stringify({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'failed', completedAt: 2 }, null, 2);

		writeFileAtomicSync(file, next);

		expect(readFileSync(file, 'utf8')).toBe(next);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(temps()).toEqual([]);
	});

	it('(d2) a pre-existing record with a wider mode is replaced by a 0o600 destination', () => {
		writeFileSync(file, SEEDED, { mode: 0o644 });

		writeFileAtomicSync(file, JSON.stringify({ status: 'failed' }));

		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});

describe('issue #554 — the temp-residue sweep', () => {
	it('(e) an hour-old temp is removed, a fresh one (any pid) survives, and the count is reported', () => {
		__setStorageDir(dir);
		const oldTemp = path.join(dir, 'old.json.1234.deadbeef.tmp');
		const freshTemp = path.join(dir, 'fresh.json.9999.cafebabe.tmp');
		writeFileSync(oldTemp, 'partial');
		writeFileSync(freshTemp, 'partial');
		const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
		utimesSync(oldTemp, twoHoursAgo, twoHoursAgo);

		const swept = sweepAgentRecordTemps();

		expect(swept).toBe(1);
		expect(readdirSync(dir).sort()).toEqual([path.basename(file), path.basename(freshTemp)].sort());
	});

	it('(e2) the age floor is exactly the documented hour', () => {
		__setStorageDir(dir);
		const almostOld = path.join(dir, 'almost.json.1234.aaa.tmp');
		const justOld = path.join(dir, 'just.json.1234.bbb.tmp');
		writeFileSync(almostOld, 'partial');
		writeFileSync(justOld, 'partial');
		for (const [target, offset] of [
			[almostOld, AGENT_TEMP_MAX_AGE_MS - 60_000],
			[justOld, AGENT_TEMP_MAX_AGE_MS + 60_000],
		] as const) {
			const seconds = (Date.now() - offset) / 1000;
			utimesSync(target, seconds, seconds);
		}

		expect(sweepAgentRecordTemps()).toBe(1);
		expect(readdirSync(dir)).toContain(path.basename(almostOld));
		expect(readdirSync(dir)).not.toContain(path.basename(justOld));
	});

	it('(e3) a missing store is not an error', () => {
		__setStorageDir(path.join(dir, 'nope'));
		expect(sweepAgentRecordTemps()).toBe(0);
	});

	it('(e4) only *.tmp is touched — a record is never a candidate', () => {
		__setStorageDir(dir);
		const record = path.join(dir, 'keep.json');
		writeFileSync(record, SEEDED);
		const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
		utimesSync(record, twoHoursAgo, twoHoursAgo);

		expect(sweepAgentRecordTemps()).toBe(0);
		expect(readFileSync(record, 'utf8')).toBe(SEEDED);
	});
});

