import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeSourceClimbHolds,
  deriveClimbHoldsFromFrames,
  resolveImportedClimbHolds,
} from './aurora-board-import-helpers.js';

void test('deriveClimbHoldsFromFrames maps aurora role codes', () => {
  const holds = deriveClimbHoldsFromFrames(
    {
      uuid: 'climb-1',
      frames: 'p101r1p102r2p103r3p104r4',
    },
    'grasshopper',
  );

  assert.deepEqual(holds, [
    { climbUuid: 'climb-1', holdId: 101, frameNumber: 0, holdState: 'STARTING' },
    { climbUuid: 'climb-1', holdId: 102, frameNumber: 0, holdState: 'HAND' },
    { climbUuid: 'climb-1', holdId: 103, frameNumber: 0, holdState: 'FINISH' },
    { climbUuid: 'climb-1', holdId: 104, frameNumber: 0, holdState: 'FOOT' },
  ]);
});

void test('deriveClimbHoldsFromFrames keeps the first valid accumulated row per hold', () => {
  const holds = deriveClimbHoldsFromFrames(
    {
      uuid: 'climb-2',
      frames: 'p200r4p201r2,p200r2p202x1,p203r3',
    },
    'decoy',
  );

  assert.deepEqual(holds, [
    { climbUuid: 'climb-2', holdId: 200, frameNumber: 0, holdState: 'FOOT' },
    { climbUuid: 'climb-2', holdId: 201, frameNumber: 0, holdState: 'HAND' },
    { climbUuid: 'climb-2', holdId: 203, frameNumber: 2, holdState: 'FINISH' },
  ]);
});

void test('deriveClimbHoldsFromFrames skips nonpositive and unknown roles until a later valid state', () => {
  const holds = deriveClimbHoldsFromFrames(
    {
      uuid: 'climb-4',
      frames: 'p0r2p401r999,"p401r2',
    },
    'decoy',
  );

  assert.deepEqual(holds, [{ climbUuid: 'climb-4', holdId: 401, frameNumber: 1, holdState: 'HAND' }]);
});

void test('dedupeSourceClimbHolds keeps the newest source hold row per climb and hold', () => {
  const holds = dedupeSourceClimbHolds([
    {
      climb_uuid: 'climb-3',
      hold_id: 301,
      frame_number: 0,
      hold_state: 'HAND',
      created_at: '2024-01-01T00:00:00Z',
    },
    {
      climb_uuid: 'climb-3',
      hold_id: 301,
      frame_number: 1,
      hold_state: 'FINISH',
      created_at: '2024-01-02T00:00:00Z',
    },
    {
      climb_uuid: 'climb-3',
      hold_id: 302,
      frame_number: 0,
      hold_state: 'STARTING',
      created_at: '2024-01-01T00:00:00Z',
    },
  ]);

  assert.deepEqual(holds, [
    { climbUuid: 'climb-3', holdId: 301, frameNumber: 1, holdState: 'FINISH' },
    { climbUuid: 'climb-3', holdId: 302, frameNumber: 0, holdState: 'STARTING' },
  ]);
});

void test('dedupeSourceClimbHolds drops invalid identities, frames, and non-lit states', () => {
  const holds = dedupeSourceClimbHolds([
    { climb_uuid: 'climb-6', hold_id: 0, frame_number: 0, hold_state: 'HAND' },
    { climb_uuid: 'climb-6', hold_id: -1, frame_number: 0, hold_state: 'HAND' },
    { climb_uuid: 'climb-6', hold_id: 601, frame_number: -1, hold_state: 'HAND' },
    { climb_uuid: 'climb-6', hold_id: 602, frame_number: 0, hold_state: 'OFF' },
    { climb_uuid: 'climb-6', hold_id: 603, frame_number: 0, hold_state: 'STARTING' },
  ]);

  assert.deepEqual(holds, [{ climbUuid: 'climb-6', holdId: 603, frameNumber: 0, holdState: 'STARTING' }]);
});

void test('resolveImportedClimbHolds prefers canonical frames and uses source rows only without frames', () => {
  const holds = resolveImportedClimbHolds(
    [
      { uuid: 'canonical-frames', frames: 'p701r1' },
      { uuid: 'source-fallback', frames: null },
    ],
    [
      {
        climb_uuid: 'canonical-frames',
        hold_id: 701,
        frame_number: 4,
        hold_state: 'FINISH',
      },
      {
        climb_uuid: 'source-fallback',
        hold_id: 702,
        frame_number: 0,
        hold_state: 'HAND',
      },
    ],
    'decoy',
  );

  assert.deepEqual(holds, [
    { climbUuid: 'canonical-frames', holdId: 701, frameNumber: 0, holdState: 'STARTING' },
    { climbUuid: 'source-fallback', holdId: 702, frameNumber: 0, holdState: 'HAND' },
  ]);
});
