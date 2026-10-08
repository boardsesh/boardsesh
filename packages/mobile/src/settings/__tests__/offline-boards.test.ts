import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const mockStorage = new Map<string, string>();
const setSpy = vi.fn();

vi.mock('react-native-mmkv', () => {
  const createMockInstance = () => ({
    getString(key: string) {
      return mockStorage.get(key);
    },
    set(key: string, value: string) {
      setSpy(key, value);
      mockStorage.set(key, value);
    },
    remove(key: string) {
      mockStorage.delete(key);
    },
    clearAll() {
      mockStorage.clear();
    },
  });
  return { createMMKV: vi.fn(() => createMockInstance()) };
});

import {
  getOfflineBoards,
  rememberOfflineBoards,
  forgetOfflineBoard,
  forgetOfflineBoardScope,
  pruneOfflineBoards,
  clearOfflineBoards,
  clearSprayWallArchives,
  forgetSprayWallArchive,
  getRememberedSprayWallArchive,
  rememberSprayWallArchive,
  clearOwnedSprayWallPins,
  forgetOwnedSprayWallPin,
  getOwnedSprayWallPins,
  setOwnedSprayWallPins,
} from '../offline-boards';
import { resetAllSettings } from '../hooks';

const board = (overrides: Partial<UserBoard> & { uuid: string; name: string }): UserBoard =>
  ({
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '20,21',
    angle: 40,
    ...overrides,
  }) as unknown as UserBoard;

describe('offline board snapshots', () => {
  beforeEach(() => {
    mockStorage.clear();
    resetAllSettings();
    setSpy.mockClear();
  });

  it('starts empty', () => {
    expect(getOfflineBoards()).toEqual([]);
  });

  it('upserts by uuid, most-recent-first, without duplicating a re-enabled board', () => {
    rememberOfflineBoards([board({ uuid: 'a', name: 'Garage' })]);
    rememberOfflineBoards([board({ uuid: 'b', name: 'Gym' })]);
    rememberOfflineBoards([board({ uuid: 'a', name: 'Garage renamed' })]);

    expect(getOfflineBoards().map((card) => [card.uuid, card.name])).toEqual([
      ['a', 'Garage renamed'],
      ['b', 'Gym'],
    ]);
  });

  it('does not write when the remembered list is unchanged', () => {
    const boards = [board({ uuid: 'a', name: 'Garage' }), board({ uuid: 'b', name: 'Gym' })];
    rememberOfflineBoards(boards);
    setSpy.mockClear();

    // Every settings write calls emitChange(), which re-renders every useSetting
    // consumer app-wide. The online refresh hook runs on each myBoards success, so a
    // no-op refresh must not touch storage.
    rememberOfflineBoards(boards);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('caps the remembered list at 20 boards, keeping the most recent', () => {
    for (let index = 0; index < 25; index += 1) {
      rememberOfflineBoards([board({ uuid: `b${index}`, name: `Board ${index}` })]);
    }
    const cards = getOfflineBoards();
    expect(cards).toHaveLength(20);
    expect(cards[0]?.uuid).toBe('b24');
    expect(cards.at(-1)?.uuid).toBe('b5');
  });

  it('ignores boards that fail the shape guard', () => {
    rememberOfflineBoards([
      board({ uuid: 'ok', name: 'Fine' }),
      { uuid: 'bad', name: 'No layout', boardType: 'kilter', setIds: '20', angle: 40 } as unknown as UserBoard,
    ]);
    expect(getOfflineBoards().map((card) => card.uuid)).toEqual(['ok']);
  });

  it('forgets BOTH boards that share the scope being turned off', () => {
    // The download is per scope, so disabling one of two same-layout boards removes
    // the data behind both — leaving the sibling would offer a board with no climbs.
    rememberOfflineBoards([
      board({ uuid: 'garage', name: 'Garage' }),
      board({ uuid: 'gym', name: 'Gym' }),
      board({ uuid: 'tension', name: 'Tension', boardType: 'tension', layoutId: 12, sizeId: 3 }),
    ]);

    forgetOfflineBoardScope({ boardType: 'kilter', layoutId: 8, sizeId: 17 });

    expect(getOfflineBoards().map((card) => card.uuid)).toEqual(['tension']);
  });

  it('does not write when the scope being forgotten has no cards', () => {
    rememberOfflineBoards([board({ uuid: 'garage', name: 'Garage' })]);
    setSpy.mockClear();

    forgetOfflineBoardScope({ boardType: 'tension', layoutId: 12, sizeId: 3 });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('forgets one board by uuid, leaving its scope sibling alone', () => {
    // Delete / unfollow is per board, not per scope: "Marco's garage" and "Gym wall"
    // can share one Kilter Original 12x12 download, and unfollowing one must not take
    // the other off the offline picker.
    rememberOfflineBoards([board({ uuid: 'garage', name: 'Garage' }), board({ uuid: 'gym', name: 'Gym' })]);

    forgetOfflineBoard('gym');

    expect(getOfflineBoards().map((card) => card.uuid)).toEqual(['garage']);
  });

  it('does not write when the uuid being forgotten has no card', () => {
    rememberOfflineBoards([board({ uuid: 'garage', name: 'Garage' })]);
    setSpy.mockClear();

    forgetOfflineBoard('never-stored');
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('prunes cards absent from a complete server list', () => {
    // The board was deleted or unfollowed on another device, so no local call ever
    // fires for it — without this it would sit in the picker forever and hand a dead
    // uuid to setActiveBoard.
    rememberOfflineBoards([
      board({ uuid: 'garage', name: 'Garage' }),
      board({ uuid: 'gone', name: 'Unfollowed elsewhere' }),
    ]);

    pruneOfflineBoards(['garage', 'some-board-with-no-card']);

    expect(getOfflineBoards().map((card) => card.uuid)).toEqual(['garage']);
  });

  it('spares cards of the type the caller cannot vouch for', () => {
    rememberOfflineBoards([
      board({ uuid: 'garage', name: 'Garage' }),
      board({ uuid: 'old-wall', name: 'Archived wall', boardType: 'spray', layoutId: 77, sizeId: 77 }),
      board({ uuid: 'gone', name: 'Unfollowed elsewhere' }),
    ]);

    pruneOfflineBoards(['garage'], { keepBoardType: 'spray' });

    expect(getOfflineBoards().map((card) => card.uuid)).toEqual(['garage', 'old-wall']);
  });

  it('does not write when every card is still on the server list', () => {
    rememberOfflineBoards([board({ uuid: 'garage', name: 'Garage' })]);
    setSpy.mockClear();

    pruneOfflineBoards(['garage', 'gym']);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('clears every card', () => {
    rememberOfflineBoards([board({ uuid: 'a', name: 'A' }), board({ uuid: 'b', name: 'B' })]);
    clearOfflineBoards();
    expect(getOfflineBoards()).toEqual([]);
  });

  it('clears a corrupt stored value even though it reads as empty', () => {
    // The early-out must read the raw bytes, not the shape-guarded view: a card that
    // fails the guard still carries the previous account's board name on disk.
    mockStorage.set('offlineBoardsV1', '[{"uuid":"a","name":"Someone else\'s wall"}]');
    setSpy.mockClear();

    clearOfflineBoards();

    expect(setSpy).toHaveBeenCalled();
    expect(mockStorage.get('offlineBoardsV1')).toBe('[]');
  });

  it('does not write when there is nothing to clear', () => {
    clearOfflineBoards();
    setSpy.mockClear();

    clearOfflineBoards();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('reads a corrupt or non-array stored value as empty rather than throwing', () => {
    mockStorage.set('offlineBoardsV1', '{"not":"an array"}');
    expect(getOfflineBoards()).toEqual([]);

    mockStorage.set('offlineBoardsV1', 'not json at all');
    expect(getOfflineBoards()).toEqual([]);
  });
});

describe('remembered spray wall archive state', () => {
  beforeEach(() => {
    mockStorage.clear();
    setSpy.mockClear();
    resetAllSettings();
    setSpy.mockClear();
  });

  const archived = { archivedAt: '2026-10-01T09:00:00.000Z', replacedByWallUuid: 'new-wall' };

  it('keeps archived walls only', () => {
    rememberSprayWallArchive('old-wall', archived);
    rememberSprayWallArchive('live-wall', { archivedAt: null, replacedByWallUuid: null });
    expect(getRememberedSprayWallArchive('old-wall')).toEqual(archived);
    expect(getRememberedSprayWallArchive('live-wall')).toBeNull();
  });

  // Every ten-minute revalidation calls this; a write wakes every settings reader.
  it('writes only on a change', () => {
    rememberSprayWallArchive('old-wall', archived);
    setSpy.mockClear();
    rememberSprayWallArchive('old-wall', { ...archived });
    rememberSprayWallArchive('live-wall', { archivedAt: null, replacedByWallUuid: null });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('forgets a wall the server says is not archived, or that was deleted', () => {
    rememberSprayWallArchive('old-wall', archived);
    rememberSprayWallArchive('old-wall', { archivedAt: null, replacedByWallUuid: null });
    expect(getRememberedSprayWallArchive('old-wall')).toBeNull();
    rememberSprayWallArchive('deleted-wall', archived);
    forgetSprayWallArchive('deleted-wall');
    expect(getRememberedSprayWallArchive('deleted-wall')).toBeNull();
  });

  it('drops an entry written in a shape this build does not know', () => {
    mockStorage.set(
      'offlineSprayWallArchiveV1',
      JSON.stringify({
        broken: { archivedAt: 4 },
        live: { archivedAt: null, replacedByWallUuid: null },
        'old-wall': archived,
      }),
    );
    expect(getRememberedSprayWallArchive('broken')).toBeNull();
    expect(getRememberedSprayWallArchive('live')).toBeNull();
    expect(getRememberedSprayWallArchive('old-wall')).toEqual(archived);
  });

  it('stays bounded, dropping the least recently written wall first', () => {
    for (let index = 0; index < 70; index += 1) {
      rememberSprayWallArchive(`wall-${index}`, { ...archived, replacedByWallUuid: `next-${index}` });
    }
    expect(getRememberedSprayWallArchive('wall-0')).toBeNull();
    expect(getRememberedSprayWallArchive('wall-69')).not.toBeNull();
    const stored = JSON.parse(mockStorage.get('offlineSprayWallArchiveV1') ?? '{}') as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(64);
  });

  // The offline loader can only ever draw a downloaded wall: its entry is the
  // one worth keeping when the cap bites.
  it('keeps a downloaded wall over an older entry for a wall that is not downloaded', () => {
    rememberOfflineBoards([board({ uuid: 'wall-0', name: 'Old garage' })]);
    for (let index = 0; index < 70; index += 1) {
      rememberSprayWallArchive(`wall-${index}`, { ...archived, replacedByWallUuid: `next-${index}` });
    }
    expect(getRememberedSprayWallArchive('wall-0')).not.toBeNull();
    expect(getRememberedSprayWallArchive('wall-1')).toBeNull();
  });

  it('clears everything at the account boundary', () => {
    rememberSprayWallArchive('old-wall', archived);
    clearSprayWallArchives();
    expect(getRememberedSprayWallArchive('old-wall')).toBeNull();
  });
});

describe('owned spray wall pins', () => {
  beforeEach(() => {
    mockStorage.clear();
    resetAllSettings();
  });

  it('round-trips the ledger with its account', () => {
    expect(getOwnedSprayWallPins()).toBeNull();
    setOwnedSprayWallPins({ userId: 'user-1', wallUuids: ['wall-a', 'wall-b'] });
    expect(getOwnedSprayWallPins()).toEqual({ userId: 'user-1', wallUuids: ['wall-a', 'wall-b'] });
  });

  it('forgets a deleted wall and nothing else', () => {
    setOwnedSprayWallPins({ userId: 'user-1', wallUuids: ['wall-a', 'wall-b'] });
    forgetOwnedSprayWallPin('wall-a');
    expect(getOwnedSprayWallPins()).toEqual({ userId: 'user-1', wallUuids: ['wall-b'] });
  });

  // The next account on a shared phone pins its own walls.
  it('clears at the account boundary', () => {
    setOwnedSprayWallPins({ userId: 'user-1', wallUuids: ['wall-a'] });
    clearOwnedSprayWallPins();
    expect(getOwnedSprayWallPins()).toBeNull();
  });

  it('reads a malformed ledger as none', () => {
    mockStorage.set('offlineOwnedSprayWallsV1', JSON.stringify({ userId: 7, wallUuids: 'wall-a' }));
    expect(getOwnedSprayWallPins()).toBeNull();
  });
});
