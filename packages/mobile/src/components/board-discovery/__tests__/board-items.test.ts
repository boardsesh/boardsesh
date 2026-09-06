import { describe, it, expect } from 'vitest';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import { userBoardToItem, userBoardsToItems, popularConfigToItem, findOwnedBoardForConfig } from '../board-items';

const board = {
  uuid: 'b-1',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: '3,4',
  name: 'My Kilter',
  sizeName: '12x12',
  angle: 40,
  distanceMeters: 250,
} as unknown as UserBoard;

const config = {
  boardType: 'tension',
  layoutId: 9,
  sizeId: 8,
  setIds: [7, 6],
  setNames: ['A', 'B'],
  layoutName: 'TB2',
  sizeName: '8x10',
  displayName: 'Tension 8x10',
  climbCount: 100,
  totalAscents: 50,
  boardCount: 3,
} as unknown as PopularBoardConfig;

describe('userBoardToItem', () => {
  it('maps a UserBoard onto a discovery item', () => {
    const item = userBoardToItem(board);
    expect(item).toMatchObject({
      key: 'b-1',
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 2,
      setIds: '3,4',
      title: 'My Kilter',
      subtitle: 'Original',
      distanceMeters: 250,
    });
  });

  it('flags the active board', () => {
    expect(userBoardToItem(board, 'b-1')?.isActive).toBe(true);
    expect(userBoardToItem(board, 'other')?.isActive).toBe(false);
  });

  it('drops a board whose type is not a supported BoardName', () => {
    const bad = { ...board, boardType: 'not-a-board' } as unknown as UserBoard;
    expect(userBoardToItem(bad)).toBeNull();
  });

  // Ownership is resolved here, once per list build, so the card's action slot
  // never scans back into myBoards from inside a virtualized row.
  it('stamps ownership against the signed-in user', () => {
    const owned = { ...board, ownerId: 'me' } as unknown as UserBoard;
    const followed = { ...board, ownerId: 'someone-else' } as unknown as UserBoard;
    expect(userBoardToItem(owned, null, undefined, 'me')?.isViewerOwner).toBe(true);
    expect(userBoardToItem(followed, null, undefined, 'me')?.isViewerOwner).toBe(false);
  });

  // "We don't know" is its own answer: the card renders no ownership badge
  // rather than offering to unfollow the user's own wall.
  it('leaves ownership undefined when no user id is passed', () => {
    const owned = { ...board, ownerId: 'me' } as unknown as UserBoard;
    expect(userBoardToItem(owned)?.isViewerOwner).toBeUndefined();
  });
});

describe('userBoardsToItems', () => {
  const bergen = {
    uuid: 'bergen-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    setIds: '1,20',
    name: 'Bergen Klatresenter Danmarksplass',
    gymName: 'Bergen Klatresenter',
    angle: 40,
  } as unknown as UserBoard;

  it('gives two boards run by the same gym different subtitles', () => {
    const items = userBoardsToItems([bergen, { ...bergen, uuid: 'bergen-2', sizeId: 8 } as UserBoard]);
    expect(items.map((item) => item.subtitle)).toEqual(['Bergen Klatresenter · 12×14', 'Bergen Klatresenter · 8×12']);
  });

  it('leaves a lone board with a plain subtitle', () => {
    expect(userBoardsToItems([bergen])[0].subtitle).toBe('Bergen Klatresenter');
  });

  it('ignores a dropped board when deciding what needs disambiguating', () => {
    const bad = { ...bergen, uuid: 'nope', boardType: 'not-a-board' } as UserBoard;
    const items = userBoardsToItems([bad, bergen]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'bergen-1', subtitle: 'Bergen Klatresenter' });
  });

  it('passes each board its own offline state', () => {
    const items = userBoardsToItems([bergen], 'bergen-1', () => 'downloaded');
    expect(items[0]).toMatchObject({ isActive: true, offlineState: 'downloaded' });
  });
});

describe('popularConfigToItem', () => {
  it('maps a popular config, joining numeric setIds into the wire string', () => {
    const item = popularConfigToItem(config);
    expect(item).toMatchObject({
      boardName: 'tension',
      layoutId: 9,
      sizeId: 8,
      setIds: '7,6',
      title: 'Tension 8x10',
    });
  });

  it('builds a stable key from the config tuple (configs have no uuid)', () => {
    expect(popularConfigToItem(config)?.key).toBe('popular:tension:9:8:7-6');
  });

  it('falls back to the brand name, never the raw lowercase board type', () => {
    const bare = { ...config, sizeName: null, layoutName: null, boardType: 'kilter' } as unknown as PopularBoardConfig;
    expect(popularConfigToItem(bare)?.subtitle).toBe('Kilter');
  });

  it('drops a config whose board type is unsupported', () => {
    const bad = { ...config, boardType: 'xyz' } as unknown as PopularBoardConfig;
    expect(popularConfigToItem(bad)).toBeNull();
  });

  // A popular setup is nobody's board yet, so it must never carry an ownership
  // badge (and therefore never an unfollow).
  it('never stamps ownership on a popular config', () => {
    expect(popularConfigToItem(config)?.isViewerOwner).toBeUndefined();
  });
});

describe('findOwnedBoardForConfig', () => {
  const owned = [
    { uuid: 'a', boardType: 'kilter', layoutId: 1, sizeId: 2, setIds: '3,4' },
    { uuid: 'b', boardType: 'tension', layoutId: 9, sizeId: 8, setIds: '7,6' },
  ] as unknown as UserBoard[];

  it('returns the board that matches the full config tuple', () => {
    const match = findOwnedBoardForConfig(owned, { boardType: 'tension', layoutId: 9, sizeId: 8, setIds: '7,6' });
    expect(match?.uuid).toBe('b');
  });

  it('matches an owned board whose set ids are in a different order', () => {
    // Re-ticking a set in the builder re-appends it at the end, so the wire
    // order can diverge from the stored order for the same physical board.
    const match = findOwnedBoardForConfig(owned, { boardType: 'kilter', layoutId: 1, sizeId: 2, setIds: '4,3' });
    expect(match?.uuid).toBe('a');
  });

  it('matches regardless of whitespace or duplicate set ids', () => {
    const match = findOwnedBoardForConfig(owned, {
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 2,
      setIds: ' 3 , 4 , 4 ',
    });
    expect(match?.uuid).toBe('a');
  });

  it('returns undefined when any field differs', () => {
    // same board/layout/size but different sets
    expect(
      findOwnedBoardForConfig(owned, { boardType: 'kilter', layoutId: 1, sizeId: 2, setIds: '3' }),
    ).toBeUndefined();
    // different board type
    expect(
      findOwnedBoardForConfig(owned, { boardType: 'decoy', layoutId: 1, sizeId: 2, setIds: '3,4' }),
    ).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(findOwnedBoardForConfig([], { boardType: 'kilter', layoutId: 1, sizeId: 2, setIds: '3,4' })).toBeUndefined();
  });
});

describe('offline state on discovery items', () => {
  it('carries the download state a caller supplies for an owned board', () => {
    const board = {
      uuid: 'garage',
      name: "Marco's garage",
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    } as UserBoard;
    expect(userBoardToItem(board, null, 'downloaded')?.offlineState).toBe('downloaded');
    expect(userBoardToItem(board, null)?.offlineState).toBeUndefined();
  });

  // A popular config has no uuid, so rememberOfflineBoards filters it out
  // (settings/offline-boards.ts): its data would download but the board could
  // never appear in the offline picker. It must never carry a download state.
  it('never gives a popular config a download state', () => {
    const item = popularConfigToItem({
      boardType: 'tension',
      layoutId: 9,
      sizeId: 8,
      setIds: [1, 2],
      displayName: 'Tension 8x10',
    } as unknown as PopularBoardConfig);
    expect(item?.offlineState).toBeUndefined();
    expect(item?.key.startsWith('popular:')).toBe(true);
  });
});

describe('pin state', () => {
  it('takes the pin from the board by default', () => {
    const pinned = { ...board, isPinnedByMe: true } as unknown as UserBoard;
    expect(userBoardToItem(pinned)?.isPinned).toBe(true);
    expect(userBoardToItem(board)?.isPinned).toBe(false);
  });

  // An offline snapshot written before the field existed carries no answer; the
  // card must read "not pinned" rather than undefined.
  it('reads a board with no pin field as unpinned', () => {
    const legacy = { ...board } as Record<string, unknown>;
    delete legacy.isPinnedByMe;
    expect(userBoardToItem(legacy as unknown as UserBoard)?.isPinned).toBe(false);
  });

  it('lets an optimistic override win over the server answer', () => {
    const overrides = new Map([['b-1', true]]);
    const [item] = userBoardsToItems([board], null, undefined, undefined, overrides);
    expect(item.isPinned).toBe(true);

    const unpinning = new Map([['b-1', false]]);
    const pinnedBoard = { ...board, isPinnedByMe: true } as unknown as UserBoard;
    const [flipped] = userBoardsToItems([pinnedBoard], null, undefined, undefined, unpinning);
    expect(flipped.isPinned).toBe(false);
  });
});
