import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './dedupe-beta-links.js';

// `vp run db:dedupe-beta-links -- --apply` forwards the `--` separator to the
// script verbatim (it is not stripped by vp), so the parser must skip it rather
// than reject it as an unknown argument. Both invocation styles must work.

test('a leading `--` separator is skipped, not treated as an unknown argument', () => {
  const parsed = parseArgs(['--', '--apply']);
  assert.equal(parsed.apply, true);
});

test('flags resolve the same with or without the `--` separator', () => {
  const withSeparator = parseArgs(['--', '--board', 'kilter', '--limit', '20']);
  const withoutSeparator = parseArgs(['--board', 'kilter', '--limit', '20']);
  assert.deepEqual(withSeparator, withoutSeparator);
  assert.equal(withSeparator.board, 'kilter');
  assert.equal(withSeparator.limit, 20);
});

test('no args is a dry-run (apply stays false)', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.board, null);
  assert.equal(parsed.limit, null);
});
