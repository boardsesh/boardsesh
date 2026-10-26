import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import type { ResolvedBoardEntry } from '../resolve-serials';
import { configFromResolvedEntry, decideBlePickerSelection, type BleBoardConfig } from '../board-config-match';

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
    canEdit: false,
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
      boardUuid: 'board-1',
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
      currentBoardConfig: makeCurrentConfig({ setIds: '1,20', boardUuid: 'board-1' }),
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
        boardUuid: null,
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

  it.each(['saved', 'recorded'] as const)('rejects an identically configured sibling resolved from %s', (kind) => {
    const entry: ResolvedBoardEntry =
      kind === 'saved'
        ? { kind: 'saved', board: makeBoard({ uuid: 'wall-a' }) }
        : { kind: 'recorded', config: makeConfig({ boardName: 'kilter', setIds: '20,1', boardUuid: 'wall-a' }) };
    const decision = decideBlePickerSelection({
      deviceId: 'device-1',
      devices: [{ deviceId: 'device-1', name: 'Kilter Board#SN-1@3', rssi: -40 }],
      resolvedBoards: new Map([['SN-1', entry]]),
      currentBoardConfig: makeCurrentConfig({ boardUuid: 'wall-b' }),
    });

    expect(decision).toMatchObject({ kind: 'mismatch', config: { boardUuid: 'wall-a' }, entry });
  });

  it.each([
    { resolvedUuid: undefined, currentUuid: 'wall-b' },
    { resolvedUuid: null, currentUuid: 'wall-b' },
    { resolvedUuid: '', currentUuid: 'wall-b' },
    { resolvedUuid: 'wall-a', currentUuid: undefined },
    { resolvedUuid: 'wall-a', currentUuid: null },
    { resolvedUuid: 'wall-a', currentUuid: '' },
  ])(
    'keeps legacy compatibility when one identity is unknown: $resolvedUuid / $currentUuid',
    ({ resolvedUuid, currentUuid }) => {
      const entry: ResolvedBoardEntry = {
        kind: 'recorded',
        config: makeConfig({ boardName: 'kilter', setIds: '20,1', boardUuid: resolvedUuid }),
      };
      const decision = decideBlePickerSelection({
        deviceId: 'device-1',
        devices: [{ deviceId: 'device-1', name: 'Kilter Board#SN-1@3', rssi: -40 }],
        resolvedBoards: new Map([['SN-1', entry]]),
        currentBoardConfig: makeCurrentConfig({ boardUuid: currentUuid }),
      });

      expect(decision).toEqual({ kind: 'forward' });
    },
  );

  it('treats an anonymous saved-board UUID as unknown', () => {
    const decision = decideBlePickerSelection({
      deviceId: 'device-1',
      devices: [{ deviceId: 'device-1', name: 'Kilter Board#SN-1@3', rssi: -40 }],
      resolvedBoards: new Map([['SN-1', { kind: 'saved', board: makeBoard({ uuid: '' }) }]]),
      currentBoardConfig: makeCurrentConfig({ boardUuid: 'wall-b' }),
    });
    expect(decision).toEqual({ kind: 'forward' });
  });

  it('still rejects different geometry when the saved UUID matches', () => {
    const decision = decideBlePickerSelection({
      deviceId: 'device-1',
      devices: [{ deviceId: 'device-1', name: 'Kilter Board#SN-1@3', rssi: -40 }],
      resolvedBoards: new Map([['SN-1', { kind: 'saved', board: makeBoard({ uuid: 'wall-a', layoutId: 2 }) }]]),
      currentBoardConfig: makeCurrentConfig({ boardUuid: 'wall-a' }),
    });
    expect(decision.kind).toBe('mismatch');
  });
});

// classifyClimbBoardCompatibility / findNextCompatibleQueueItem moved to
// @boardsesh/board-config — see packages/shared/board-config/src/__tests__/board-compatibility.test.ts.
