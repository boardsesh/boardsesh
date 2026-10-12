import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClimbOwnerBackfillArgs } from './backfill-climb-owners.js';

// Dry-run has to be what an operator gets by default and by mistake: the apply
// path assigns owners, and only the exact `--apply` flag may reach it.

void test('no args is a dry run over both kinds and every board', () => {
  assert.deepEqual(parseClimbOwnerBackfillArgs([]), {
    apply: false,
    kinds: ['drafts', 'unlisted'],
    boardType: undefined,
    batchSize: 500,
    includeMappingOnly: false,
  });
});

// A mapping row alone may have been written for an account that never signed
// in to the setter, so assigning those is a separate, explicit choice.
void test('--include-mapping-only is off unless named exactly', () => {
  assert.equal(parseClimbOwnerBackfillArgs(['--apply']).includeMappingOnly, false);
  assert.equal(parseClimbOwnerBackfillArgs(['--', '--apply', '--include-mapping-only']).includeMappingOnly, true);
  assert.throws(() => parseClimbOwnerBackfillArgs(['--include-mapping']), /Unknown argument: --include-mapping/);
});

void test('--apply opts into writes, with or without the `--` separator vp forwards', () => {
  assert.equal(parseClimbOwnerBackfillArgs(['--apply']).apply, true);
  assert.equal(parseClimbOwnerBackfillArgs(['--', '--apply']).apply, true);
  assert.equal(parseClimbOwnerBackfillArgs(['--']).apply, false);
});

void test('a mistyped flag is an error, never a silent dry run', () => {
  assert.throws(() => parseClimbOwnerBackfillArgs(['--aply']), /Unknown argument: --aply/);
  assert.throws(() => parseClimbOwnerBackfillArgs(['--dry-run']), /Unknown argument: --dry-run/);
});

void test('--only picks one kind and refuses anything else', () => {
  assert.deepEqual(parseClimbOwnerBackfillArgs(['--only', 'drafts']).kinds, ['drafts']);
  assert.deepEqual(parseClimbOwnerBackfillArgs(['--only', 'unlisted']).kinds, ['unlisted']);
  assert.throws(() => parseClimbOwnerBackfillArgs(['--only', 'both']), /must be one of: drafts, unlisted/);
  assert.throws(() => parseClimbOwnerBackfillArgs(['--only']), /must be one of/);
});

void test('--board takes one plain board type', () => {
  assert.equal(parseClimbOwnerBackfillArgs(['--board', 'tension']).boardType, 'tension');
  assert.throws(() => parseClimbOwnerBackfillArgs(['--board', "tension' OR 1=1"]), /must name a board type/);
  assert.throws(() => parseClimbOwnerBackfillArgs(['--board']), /must name a board type/);
});

void test('--batch-size takes a whole number in range and nothing else', () => {
  assert.equal(parseClimbOwnerBackfillArgs(['--batch-size', '50']).batchSize, 50);
  for (const invalidBatchSize of ['0', '-1', '2.5', 'many', '5001']) {
    assert.throws(() => parseClimbOwnerBackfillArgs(['--batch-size', invalidBatchSize]), /must be a whole number/);
  }
  assert.throws(() => parseClimbOwnerBackfillArgs(['--batch-size']), /must be a whole number/);
});
