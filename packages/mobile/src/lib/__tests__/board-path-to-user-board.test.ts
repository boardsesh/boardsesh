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
      loadOwnedBoards: async () => [owned],
      createBoard,
      fetchBoardBySlug: vi.fn(),
    });
    expect(result).toMatchObject({ uuid: 'board-uuid', angle: 30 });
    expect(createBoard).not.toHaveBeenCalled();
  });

  it('creates a board when none is owned', async () => {
    const created = makeBoard({ uuid: 'fresh-uuid', isOwned: false, angle: 30 });
    const createBoard = vi.fn().mockResolvedValue(created);
    const result = await resolveBoardForSession('kilter/8/17/27,28/30', {
      loadOwnedBoards: async () => [],
      createBoard,
      fetchBoardBySlug: vi.fn(),
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
      resolveBoardForSession('garbage', {
        loadOwnedBoards: async () => [],
        createBoard: vi.fn(),
        fetchBoardBySlug: vi.fn(),
      }),
    ).rejects.toThrow(/Cannot resolve a board/);
  });

  // The bug this contract exists for: a joiner's matching board sorts past the
  // first `myBoards` page. The resolver never slices the list it is handed, so a
  // match at the end of a full walk reuses that board instead of minting one.
  it('reuses a matching board from deep in the owned list rather than creating one', async () => {
    const matching = makeBoard({ uuid: 'page-two-uuid', angle: 40 });
    const nonMatching = Array.from({ length: 60 }, (_, index) => makeBoard({ uuid: `other-${index}`, sizeId: 99 }));
    const createBoard = vi.fn();
    const result = await resolveBoardForSession('kilter/8/17/27,28/30', {
      loadOwnedBoards: async () => [...nonMatching, matching],
      createBoard,
      fetchBoardBySlug: vi.fn(),
    });
    expect(result).toMatchObject({ uuid: 'page-two-uuid', angle: 30 });
    expect(createBoard).not.toHaveBeenCalled();
  });

  // "You own no boards" and "we couldn't find out which boards you own" are the
  // same input to the reuse step and mint the same duplicate, so a failed load
  // has to fail the resolve.
  it('propagates a failed owned-board load instead of creating a board', async () => {
    const createBoard = vi.fn();
    await expect(
      resolveBoardForSession('kilter/8/17/27,28/30', {
        loadOwnedBoards: async () => {
          throw new Error('Network request failed');
        },
        createBoard,
        fetchBoardBySlug: vi.fn(),
      }),
    ).rejects.toThrow(/Network request failed/);
    expect(createBoard).not.toHaveBeenCalled();
  });

  // A named board resolves by slug, so the owned-list walk (a round trip, and a
  // rejection while offline) must never run for it.
  it('never loads the owned list for a named-board path', async () => {
    const loadOwnedBoards = vi.fn(async () => []);
    const namedBoard = makeBoard({ uuid: 'named-uuid', slug: 'my-gym-moonboard', angle: 25 });
    await resolveBoardForSession('/b/my-gym-moonboard/40', {
      loadOwnedBoards,
      createBoard: vi.fn(),
      fetchBoardBySlug: vi.fn().mockResolvedValue(namedBoard),
    });
    expect(loadOwnedBoards).not.toHaveBeenCalled();
  });

  describe('named-board (/b/{slug}) paths', () => {
    it('resolves a named board via fetchBoardBySlug, applying the path angle', async () => {
      const namedBoard = makeBoard({ uuid: 'named-uuid', boardType: 'moonboard', slug: 'my-gym-moonboard', angle: 25 });
      const fetchBoardBySlug = vi.fn().mockResolvedValue(namedBoard);
      const createBoard = vi.fn();
      const result = await resolveBoardForSession('/b/my-gym-moonboard/40/list', {
        loadOwnedBoards: async () => [],
        createBoard,
        fetchBoardBySlug,
      });
      expect(fetchBoardBySlug).toHaveBeenCalledWith('my-gym-moonboard');
      expect(result).toMatchObject({ uuid: 'named-uuid', angle: 40 });
      // The shared entity is used directly — never minted as a personal copy.
      expect(createBoard).not.toHaveBeenCalled();
    });

    it("falls back to the board entity's stored angle for a bare /b/{slug}", async () => {
      const namedBoard = makeBoard({ uuid: 'named-uuid', slug: 'my-gym-moonboard', angle: 25 });
      const fetchBoardBySlug = vi.fn().mockResolvedValue(namedBoard);
      const result = await resolveBoardForSession('/b/my-gym-moonboard', {
        loadOwnedBoards: async () => [],
        createBoard: vi.fn(),
        fetchBoardBySlug,
      });
      expect(result).toBe(namedBoard);
      expect(result.angle).toBe(25);
    });

    it('throws when the slug no longer resolves to a board', async () => {
      const fetchBoardBySlug = vi.fn().mockResolvedValue(null);
      await expect(
        resolveBoardForSession('/b/deleted-board/40', {
          loadOwnedBoards: async () => [],
          createBoard: vi.fn(),
          fetchBoardBySlug,
        }),
      ).rejects.toThrow(/Cannot resolve a board/);
    });
  });
});
