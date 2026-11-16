import { describe, it, expect } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  userBoardToItem,
  userBoardsToItems,
  boardRowsToItems,
  findOwnedBoardForConfig,
  pickerTopBoardsToItems,
} from '../board-items';

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
    const items = userBoardsToItems([bergen], { activeUuid: 'bergen-1', offlineStateFor: () => 'downloaded' });
    expect(items[0]).toMatchObject({ isActive: true, offlineState: 'downloaded' });
  });
});

describe('boardRowsToItems', () => {
  // A hidden board found by serial has no uuid (#6552), so In range rows key on
  // their own row key, and each item must keep it.
  it('keeps each row its own key, and marks the active board', () => {
    const hidden = { ...board, uuid: '' } as unknown as UserBoard;
    const items = boardRowsToItems(
      [
        { key: 'board:b-1', board },
        { key: 'board:serial-751737', board: hidden },
      ],
      { activeUuid: 'b-1' },
    );
    expect(items.map((item) => item.key)).toEqual(['board:b-1', 'board:serial-751737']);
    expect(items[0].isActive).toBe(true);
  });

  it('leaves out a board the card cannot draw, without shifting the keys of the rest', () => {
    const unknownType = { ...board, uuid: 'x', boardType: 'not-a-board' } as unknown as UserBoard;
    const tension = { ...board, uuid: 't', boardType: 'tension', name: 'Tension' } as unknown as UserBoard;
    const items = boardRowsToItems([
      { key: 'board:x', board: unknownType },
      { key: 'board:t', board: tension },
    ]);
    expect(items.map((item) => [item.key, item.title])).toEqual([['board:t', 'Tension']]);
  });
});

describe('pickerTopBoardsToItems', () => {
  const gymBoard = { ...board, gymUuid: 'gym-crux', gymName: 'Crux', name: 'Crux - Cave' } as unknown as UserBoard;

  it("keeps the top's key, shown name and selection", () => {
    const items = pickerTopBoardsToItems([
      { key: 'b-1', board: gymBoard, title: 'Cave', selected: true },
      { key: 'other', board: { ...gymBoard, uuid: 'other', name: 'Arch' }, title: 'Arch', selected: false },
    ]);
    expect(items.map((item) => [item.key, item.title, item.isActive])).toEqual([
      ['b-1', 'Cave', true],
      ['other', 'Arch', false],
    ]);
  });

  // At {gym} names the gym in its title: its rows lead with what the wall is.
  it('drops the gym from the subtitles in the within-gym scope', () => {
    const [global] = pickerTopBoardsToItems([{ key: 'b-1', board: gymBoard, title: 'Cave', selected: false }]);
    const [withinGym] = pickerTopBoardsToItems([{ key: 'b-1', board: gymBoard, title: 'Cave', selected: false }], {
      labelOptions: { scope: 'within-gym' },
    });
    expect(global?.subtitle).toBe('Crux');
    expect(withinGym?.subtitle).toBe('Original');
  });

  // Only At {gym} drops the gym: Your boards has no heading that names it.
  it('keeps the gym and the full name for the same wall in Your boards', () => {
    const [atGym] = pickerTopBoardsToItems([{ key: 'b-1', board: gymBoard, title: 'Cave', selected: false }], {
      labelOptions: { scope: 'within-gym' },
    });
    const [yours] = userBoardsToItems([gymBoard]);
    expect([atGym?.title, atGym?.subtitle]).toEqual(['Cave', 'Original']);
    expect([yours?.title, yours?.subtitle]).toEqual(['Crux - Cave', 'Crux']);
  });

  it('leaves out a board the card cannot draw', () => {
    const unknownType = { ...board, boardType: 'not-a-board' } as unknown as UserBoard;
    expect(pickerTopBoardsToItems([{ key: 'b-1', board: unknownType, title: 'X', selected: true }])).toEqual([]);
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
    const [item] = userBoardsToItems([board], { activeUuid: null, pinnedOverrides: overrides });
    expect(item.isPinned).toBe(true);

    const unpinning = new Map([['b-1', false]]);
    const pinnedBoard = { ...board, isPinnedByMe: true } as unknown as UserBoard;
    const [flipped] = userBoardsToItems([pinnedBoard], { activeUuid: null, pinnedOverrides: unpinning });
    expect(flipped.isPinned).toBe(false);
  });
});
