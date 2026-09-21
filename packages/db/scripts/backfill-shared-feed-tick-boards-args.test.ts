import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs, parseSnapshot, writeSnapshot } from './backfill-shared-feed-tick-boards.js';

void test('forward and revert are dry-run by default', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.deepEqual(parseArgs(['--revert', 'snapshot.json']), {
    apply: false,
    help: false,
    revertPath: 'snapshot.json',
  });
  assert.equal(parseArgs(['--dry-run']).apply, false);
});

void test('only explicit apply enables forward or revert writes, including vp separators', () => {
  assert.equal(parseArgs(['--', '--apply']).apply, true);
  assert.equal(parseArgs(['--revert', 'snapshot.json', '--apply']).apply, true);
  assert.equal(parseArgs(['--out', 'plan.json']).outPath, 'plan.json');
  assert.equal(parseArgs(['--help']).help, true);
});

void test('rejects conflicting modes, unknown flags, and missing filenames', () => {
  for (const args of [
    ['--apply', '--dry-run'],
    ['--dry-run', '--apply'],
  ]) {
    assert.throws(() => parseArgs(args), /cannot be combined/);
  }
  assert.throws(() => parseArgs(['--aply']), /Unknown option/);
  for (const args of [['--revert'], ['--out'], ['--out', '--apply']]) {
    assert.throws(() => parseArgs(args), /requires a filename/);
  }
});

void test('snapshot writes never overwrite an existing recovery file', () => {
  const fixtureDirectory = mkdtempSync(join(process.cwd(), '.shared-feed-snapshot-test-'));
  try {
    const snapshotPath = join(fixtureDirectory, 'recovery.json');
    const original = 'existing recovery bytes\n';
    writeFileSync(snapshotPath, original);
    const snapshot = { writtenAt: '2026-09-21T00:00:00Z', entries: [] };
    assert.throws(() => writeSnapshot(snapshotPath, snapshot), /Choose a new --out path/);
    assert.equal(readFileSync(snapshotPath, 'utf8'), original);
    const freshPath = join(fixtureDirectory, 'fresh.json');
    writeSnapshot(freshPath, snapshot);
    assert.deepEqual(JSON.parse(readFileSync(freshPath, 'utf8')), snapshot);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

void test('snapshot parsing accepts generated recovery plans and empty plans', () => {
  const snapshot = {
    writtenAt: '2026-09-21T00:00:00.000Z',
    entries: [{ uuid: 'tick-uuid', oldBoardId: 123, newBoardId: 456 }],
  };
  assert.deepEqual(parseSnapshot(JSON.stringify(snapshot)), snapshot);
  assert.deepEqual(parseSnapshot(JSON.stringify({ ...snapshot, entries: [] })), { ...snapshot, entries: [] });
});

void test('snapshot parsing refuses corrupted files and malformed envelopes before revert', () => {
  assert.throws(() => parseSnapshot('{broken'), /Invalid snapshot: expected valid JSON/);
  for (const snapshot of [
    null,
    [],
    {},
    { writtenAt: 'not-a-date', entries: [] },
    { writtenAt: '2026-09-21T00:00:00Z', entries: {} },
  ]) {
    assert.throws(() => parseSnapshot(JSON.stringify(snapshot)), /expected writtenAt timestamp and entries array/);
  }
});

void test('snapshot parsing identifies malformed entries before a valid earlier row could be applied', () => {
  const validEntry = { uuid: 'valid-tick', oldBoardId: 123, newBoardId: 456 };
  for (const malformed of [
    null,
    {},
    { ...validEntry, uuid: ' ' },
    { ...validEntry, oldBoardId: '123' },
    { ...validEntry, newBoardId: 1.5 },
    { ...validEntry, oldBoardId: 0 },
    { ...validEntry, newBoardId: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () =>
        parseSnapshot(
          JSON.stringify({
            writtenAt: '2026-09-21T00:00:00Z',
            entries: [validEntry, malformed],
          }),
        ),
      /Invalid snapshot entry 2/,
    );
  }
});
