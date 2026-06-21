import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import type { ResolvedBoardEntry } from '../resolve-serials';
import {
  configFromResolvedEntry,
  decideBlePickerSelection,
  classifyClimbBoardCompatibility,
  findNextCompatibleQueueItem,
  type BleBoardConfig,
} from '../board-config-match';

function makeCurrentConfig(overrides: Partial<BleBoardConfig> = {}): BleBoardConfig {
  return {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    ...overrides,
  };
}

function makeBoard(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'board-1',
    slug: 'board-1',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '20,1',
    name: 'Garage Kilter',
    isPublic: false,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    serialNumber: 'SN-1',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<BoardSerialConfig> = {}): BoardSerialConfig {
  return {
    serialNumber: 'SN-2',
    boardName: 'tension',
    layoutId: 1,
    sizeId: 10,
    setIds: '1',
    apiLevel: 2,
    updatedAt: '2026-01-02T00:00:00.000Z',
    boardUuid: null,
    boardSlug: null,
    ...overrides,
  };
}

describe('configFromResolvedEntry', () => {
  it('normalises saved boards and carries the board slug', () => {
    const entry: ResolvedBoardEntry = { kind: 'saved', board: makeBoard({ slug: 'garage-kilter' }) };

    expect(configFromResolvedEntry(entry)).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '20,1',
      boardSlug: 'garage-kilter',
    });
  });

  it('returns undefined for unknown board names', () => {
    const entry: ResolvedBoardEntry = { kind: 'recorded', config: makeConfig({ boardName: 'not-a-board' }) };

    expect(configFromResolvedEntry(entry)).toBeUndefined();
  });
});

describe('decideBlePickerSelection', () => {
  it('forwards unresolved devices', () => {
    const decision = decideBlePickerSelection({
      deviceId: 'device-1',
      devices: [{ deviceId: 'device-1', name: 'Kilter Board#SN-1@3', rssi: -40 }],
      resolvedBoards: new Map(),
      currentBoardConfig: makeCurrentConfig(),
    });

    expect(decision).toEqual({ kind: 'forward' });
  });

  it('forwards resolved devices when the config matches after set normalisation', () => {
    const resolvedBoards = new Map<string, ResolvedBoardEntry>([
      ['SN-1', { kind: 'saved', board: makeBoard({ setIds: '20,1' }) }],
    ]);

    const decision = decideBlePickerSelection({
      deviceId: 'device-1',
      devices: [{ deviceId: 'device-1', name: 'Kilter Board#SN-1@3', rssi: -40 }],
      resolvedBoards,
      currentBoardConfig: makeCurrentConfig({ setIds: '1,20' }),
    });

    expect(decision).toEqual({ kind: 'forward' });
  });

  it('returns mismatch when the resolved serial belongs to another config', () => {
    const recordedEntry: ResolvedBoardEntry = {
      kind: 'recorded',
      config: makeConfig({ boardName: 'tension', setIds: '1' }),
    };
    const resolvedBoards = new Map<string, ResolvedBoardEntry>([['SN-2', recordedEntry]]);

    const decision = decideBlePickerSelection({
      deviceId: 'device-2',
      devices: [{ deviceId: 'device-2', name: 'Tension Board#SN-2@2', rssi: -50 }],
      resolvedBoards,
      currentBoardConfig: makeCurrentConfig(),
    });

    expect(decision).toEqual({
      kind: 'mismatch',
      serial: 'SN-2',
      config: {
        boardName: 'tension',
        layoutId: 1,
        sizeId: 10,
        setIds: '1',
        boardSlug: null,
      },
      entry: recordedEntry,
    });
  });

  it('carries the recorded entry boardUuid in the mismatch decision', () => {
    const recordedEntry: ResolvedBoardEntry = {
      kind: 'recorded',
      config: makeConfig({ boardName: 'tension', setIds: '1', boardUuid: 'recorded-board-uuid' }),
    };
    const resolvedBoards = new Map<string, ResolvedBoardEntry>([['SN-2', recordedEntry]]);

    const decision = decideBlePickerSelection({
      deviceId: 'device-2',
      devices: [{ deviceId: 'device-2', name: 'Tension Board#SN-2@2', rssi: -50 }],
      resolvedBoards,
      currentBoardConfig: makeCurrentConfig(),
    });

    expect(decision.kind).toBe('mismatch');
    if (decision.kind !== 'mismatch') throw new Error('expected mismatch decision');
    expect(decision.entry.kind).toBe('recorded');
    if (decision.entry.kind !== 'recorded') throw new Error('expected recorded entry');
    expect(decision.entry.config.boardUuid).toBe('recorded-board-uuid');
  });
});

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    name: 'Climb',
    frames: 'p1r12',
    setter_username: 'setter',
    angle: 40,
    ascensionist_count: 0,
    difficulty: 'V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.3',
    benchmark_difficulty: null,
    ...overrides,
  };
}

function makeItem(uuid: string, climb: Partial<Climb> = {}): ClimbQueueItem {
  return { uuid, climb: makeClimb({ uuid: `c-${uuid}`, ...climb }) };
}

const KILTER_L1: BleBoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };

describe('classifyClimbBoardCompatibility', () => {
  it('returns unknown when the active config is missing', () => {
    expect(classifyClimbBoardCompatibility(undefined, makeClimb({ boardType: 'kilter', layoutId: 1 }))).toBe('unknown');
  });

  it('returns unknown when the climb carries no board metadata', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, makeClimb({ boardType: undefined, layoutId: undefined }))).toBe(
      'unknown',
    );
  });

  it('returns compatible when known boardType and layoutId match', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, makeClimb({ boardType: 'kilter', layoutId: 1 }))).toBe(
      'compatible',
    );
  });

  it('returns incompatible on a different boardType', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, makeClimb({ boardType: 'tension', layoutId: 1 }))).toBe(
      'incompatible',
    );
  });

  it('returns incompatible on a different layoutId', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, makeClimb({ boardType: 'kilter', layoutId: 8 }))).toBe(
      'incompatible',
    );
  });

  it('falls through to the layout check when boardType is unrecognised', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, makeClimb({ boardType: 'mystery', layoutId: 1 }))).toBe(
      'compatible',
    );
    expect(classifyClimbBoardCompatibility(KILTER_L1, makeClimb({ boardType: 'mystery', layoutId: 8 }))).toBe(
      'incompatible',
    );
  });

  it('judges on layout alone when only layoutId is known', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, makeClimb({ boardType: undefined, layoutId: 1 }))).toBe(
      'compatible',
    );
    expect(classifyClimbBoardCompatibility(KILTER_L1, makeClimb({ boardType: undefined, layoutId: 8 }))).toBe(
      'incompatible',
    );
  });
});

describe('findNextCompatibleQueueItem', () => {
  it('skips a run of spill climbs and returns the next compatible one with the count', () => {
    const queue = [
      makeItem('q0', { boardType: 'kilter', layoutId: 1 }), // current, incompatible? no — compatible
      makeItem('q1', { boardType: 'tension', layoutId: 1 }), // spill
      makeItem('q2', { boardType: 'kilter', layoutId: 8 }), // spill (layout)
      makeItem('q3', { boardType: 'kilter', layoutId: 1 }), // compatible
    ];
    // Start at the spill at q1.
    const result = findNextCompatibleQueueItem(queue, 'q1', KILTER_L1);
    expect(result.item?.uuid).toBe('q3');
    expect(result.skippedCount).toBe(2);
  });

  it('returns the current item with skippedCount 0 when it is already compatible', () => {
    const queue = [
      makeItem('q0', { boardType: 'kilter', layoutId: 1 }),
      makeItem('q1', { boardType: 'kilter', layoutId: 1 }),
    ];
    const result = findNextCompatibleQueueItem(queue, 'q0', KILTER_L1);
    expect(result.item?.uuid).toBe('q0');
    expect(result.skippedCount).toBe(0);
  });

  it('returns null when every remaining climb is incompatible', () => {
    const queue = [
      makeItem('q0', { boardType: 'tension', layoutId: 1 }),
      makeItem('q1', { boardType: 'kilter', layoutId: 8 }),
    ];
    const result = findNextCompatibleQueueItem(queue, 'q0', KILTER_L1);
    expect(result.item).toBeNull();
    expect(result.skippedCount).toBe(2);
  });

  it('treats unknown-metadata climbs as sendable (not skipped)', () => {
    const queue = [
      makeItem('q0', { boardType: 'tension', layoutId: 1 }), // spill
      makeItem('q1', { boardType: undefined, layoutId: undefined }), // unknown → stop here
    ];
    const result = findNextCompatibleQueueItem(queue, 'q0', KILTER_L1);
    expect(result.item?.uuid).toBe('q1');
    expect(result.skippedCount).toBe(1);
  });
});
