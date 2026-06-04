import { describe, it, expect, vi } from 'vitest';
import type { CreateBoardInput, UserBoard } from '@boardsesh/shared-schema';
import {
  parseBoardConfigFromPath,
  findOwnedBoardForSession,
  buildCreateBoardInput,
  resolveBoardForSession,
} from '../board-path-to-user-board';

function makeBoard(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'board-uuid',
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '27,28',
    name: 'Kilter',
    angle: 40,
    isOwned: true,
    isAngleAdjustable: true,
    ...overrides,
  } as unknown as UserBoard;
}

describe('parseBoardConfigFromPath', () => {
  it('parses a full board path into a config tuple', () => {
    expect(parseBoardConfigFromPath('kilter/8/17/27,28/40')).toEqual({
      boardType: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '27,28',
      angle: 40,
    });
  });

  it('tolerates a locale prefix and leading slash', () => {
    expect(parseBoardConfigFromPath('/es/tension/9/8/7,6/25')).toEqual({
      boardType: 'tension',
      layoutId: 9,
      sizeId: 8,
      setIds: '7,6',
      angle: 25,
    });
  });

  it('returns null when the path has no angle', () => {
    expect(parseBoardConfigFromPath('kilter/8/17/27,28')).toBeNull();
  });

  it('returns null for an unparseable path', () => {
    expect(parseBoardConfigFromPath('not-a-board-path')).toBeNull();
  });
});

describe('findOwnedBoardForSession', () => {
  const config = { boardType: 'kilter', layoutId: 8, sizeId: 17, setIds: '27,28', angle: 30 };

  it('reuses an exact-config owned board, overriding the angle from the session', () => {
    const owned = makeBoard({ angle: 40 });
    const result = findOwnedBoardForSession([owned], config);
    expect(result).toMatchObject({ uuid: 'board-uuid', angle: 30 });
    // Must not mutate the cached board in place.
    expect(owned.angle).toBe(40);
  });

  it('returns the same reference when the angle already matches', () => {
    const owned = makeBoard({ angle: 30 });
    const result = findOwnedBoardForSession([owned], config);
    expect(result).toBe(owned);
  });

  it('returns undefined when no owned board matches the config', () => {
    const owned = makeBoard({ boardType: 'tension' });
    expect(findOwnedBoardForSession([owned], config)).toBeUndefined();
  });

  it('does not match on set-id differences', () => {
    const owned = makeBoard({ setIds: '27' });
    expect(findOwnedBoardForSession([owned], config)).toBeUndefined();
  });
});

describe('buildCreateBoardInput', () => {
  it('builds an unowned create input with a derived board name', () => {
    const input: CreateBoardInput = buildCreateBoardInput({
      boardType: 'moonboard',
      layoutId: 1,
      sizeId: 2,
      setIds: '3',
      angle: 25,
    });
    expect(input).toEqual({
      boardType: 'moonboard',
      layoutId: 1,
      sizeId: 2,
      setIds: '3',
      angle: 25,
      isOwned: false,
      name: 'MoonBoard',
    });
  });
});

describe('resolveBoardForSession', () => {
  it('reuses an owned board without creating one', async () => {
    const owned = makeBoard({ angle: 40 });
    const createBoard = vi.fn();
    const result = await resolveBoardForSession('kilter/8/17/27,28/30', {
      ownedBoards: [owned],
      createBoard,
    });
    expect(result).toMatchObject({ uuid: 'board-uuid', angle: 30 });
    expect(createBoard).not.toHaveBeenCalled();
  });

  it('creates a board when none is owned', async () => {
    const created = makeBoard({ uuid: 'fresh-uuid', isOwned: false, angle: 30 });
    const createBoard = vi.fn().mockResolvedValue(created);
    const result = await resolveBoardForSession('kilter/8/17/27,28/30', {
      ownedBoards: [],
      createBoard,
    });
    expect(createBoard).toHaveBeenCalledWith({
      boardType: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '27,28',
      angle: 30,
      isOwned: false,
      name: 'Kilter',
    });
    expect(result).toBe(created);
  });

  it('throws on an unparseable board path', async () => {
    await expect(
      resolveBoardForSession('garbage', { ownedBoards: [], createBoard: vi.fn() }),
    ).rejects.toThrow(/Cannot resolve a board/);
  });
});
