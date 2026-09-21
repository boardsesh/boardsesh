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

void test('backfill preserves existing Woods and spray single-frame parsing', () => {
  assert.deepEqual(projectBackfillFrames('woods', 'p0r4p1r3'), [
    { holdId: 0, frameNumber: 0, holdState: 'STARTING' },
    { holdId: 1, frameNumber: 0, holdState: 'FINISH' },
  ]);
  assert.deepEqual(projectBackfillFrames('spray', 'p1r1p2r3p3r999'), [
    { holdId: 1, frameNumber: 0, holdState: 'STARTING' },
    { holdId: 2, frameNumber: 0, holdState: 'FINISH' },
  ]);
});

void test('backfill rejects unknown board types', () => {
  assert.deepEqual(projectBackfillFrames('unknown', 'p1r42'), []);
});
