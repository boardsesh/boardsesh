import assert from 'node:assert/strict';
import test from 'node:test';
import { projectBackfillFrames } from './backfill-board-climb-holds-helpers.js';

void test('backfill keeps one first-valid row per positive hold', () => {
  assert.deepEqual(projectBackfillFrames('tension', 'p0r2p1r1p1r2,"p2r2'), [
    { holdId: 1, frameNumber: 0, holdState: 'HAND' },
    { holdId: 2, frameNumber: 1, holdState: 'HAND' },
  ]);
});

void test('backfill skips unknown roles until the same hold has a valid state', () => {
  assert.deepEqual(projectBackfillFrames('tension', 'p1r999,"p1r2'), [
    { holdId: 1, frameNumber: 1, holdState: 'HAND' },
  ]);
});

void test('backfill rejects non-Aurora board types', () => {
  assert.deepEqual(projectBackfillFrames('moonboard', 'p1r42'), []);
});
