import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './dedupe-gym-locations.js';

// `vp run db:dedupe-gyms -- --apply` forwards the `--` separator to the script
// verbatim (it is not stripped by vp), so the parser must skip it rather than
// reject it as an unknown argument. Both invocation styles must work.

test('a leading `--` separator is skipped, not treated as an unknown argument', () => {
  const parsed = parseArgs(['--', '--apply']);
  assert.equal(parsed.apply, true);
});

test('flags resolve the same with or without the `--` separator', () => {
  const withSeparator = parseArgs(['--', '--only-name', 'Sandbox Bouldering', '--limit', '10']);
  const withoutSeparator = parseArgs(['--only-name', 'Sandbox Bouldering', '--limit', '10']);
  assert.deepEqual(withSeparator, withoutSeparator);
  assert.equal(withSeparator.onlyName, 'Sandbox Bouldering');
  assert.equal(withSeparator.limit, 10);
});

test('no args is a dry-run (apply stays false)', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.limit, null);
  assert.equal(parsed.onlyName, null);
  assert.equal(parsed.backfillPointers, false);
});

test('--backfill-pointers selects the pointer-backfill mode (dry-run by default)', () => {
  const parsed = parseArgs(['--backfill-pointers']);
  assert.equal(parsed.backfillPointers, true);
  assert.equal(parsed.apply, false);
});

test('--backfill-pointers --apply enables the backfill write path', () => {
  const parsed = parseArgs(['--backfill-pointers', '--apply']);
  assert.equal(parsed.backfillPointers, true);
  assert.equal(parsed.apply, true);
});

test('backfill defaults to SYSTEM-owned twins unless --include-non-system-twins is passed', () => {
  assert.equal(parseArgs(['--backfill-pointers']).includeNonSystemTwins, false);
  assert.equal(parseArgs(['--backfill-pointers', '--include-non-system-twins']).includeNonSystemTwins, true);
});
