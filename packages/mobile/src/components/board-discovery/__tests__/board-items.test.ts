import { describe, it, expect } from 'vitest';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import { userBoardToItem, popularConfigToItem, findOwnedBoardForConfig } from '../board-items';

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
      subtitle: '12x12',
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

  it('drops a config whose board type is unsupported', () => {
    const bad = { ...config, boardType: 'xyz' } as unknown as PopularBoardConfig;
    expect(popularConfigToItem(bad)).toBeNull();
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
