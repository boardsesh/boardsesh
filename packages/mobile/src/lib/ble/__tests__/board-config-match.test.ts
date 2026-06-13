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
    id: 1,
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
