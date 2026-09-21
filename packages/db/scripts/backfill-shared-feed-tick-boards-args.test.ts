import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs, writeSnapshot } from './backfill-shared-feed-tick-boards.js';

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
