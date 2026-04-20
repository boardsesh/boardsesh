import { describe, it, expect, vi } from 'vitest';

// Mock board-utils so boardConfigToBoardDetails doesn't pull heavy board data.
// board-config.ts only imports getBoardDetailsForBoard — we don't call that
// helper directly from the tests below, but the import graph still resolves
// board-constants, which is slow / pulls JSON. Stub it out.
vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(),
}));

import {
  configKey,
  boardConfigFromDetails,
  boardConfigFromUserBoard,
  boardConfigToBaseBoardPath,
  boardConfigEquals,
  decideAdd,
  deriveAcceptedConfigs,
  normalizeQueueItem,
  type BoardConfig,
} from '../board-config';
import type { BoardDetails } from '@/app/lib/types';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@/app/components/queue-control/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: [1, 2],
    angle: 40,
    ...overrides,
  };
}

function makeBoardDetails(overrides: Partial<BoardDetails> = {}): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 2],
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Full Size',
    set_names: ['Standard', 'Extended'],
    ...overrides,
  } as unknown as BoardDetails;
}

function makeUserBoard(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'user-board-uuid',
    slug: 'my-board',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'My Kilter',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2024-01-01T00:00:00Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    ...overrides,
  } as UserBoard;
}

function makeQueueItem(overrides: Partial<ClimbQueueItem> = {}): ClimbQueueItem {
  return {
    uuid: 'item-1',
    addedBy: null,
    suggested: false,
    climb: {
      uuid: 'climb-1',
      setter_username: 'setter',
      name: 'Test Climb',
      description: '',
      frames: '',
      angle: 40,
      ascensionist_count: 0,
      difficulty: '6A',
      quality_average: '3',
      stars: 3,
      difficulty_error: '',
      mirrored: false,
      benchmark_difficulty: null,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// configKey
// ---------------------------------------------------------------------------

describe('configKey', () => {
  it('produces a stable key combining boardName, layoutId, setIds', () => {
    const key = configKey({ boardName: 'kilter', layoutId: 1, setIds: [1, 2] });
    expect(key).toBe('kilter|1|1,2');
  });

  it('is order-independent in setIds', () => {
    const a = configKey({ boardName: 'kilter', layoutId: 1, setIds: [2, 1] });
    const b = configKey({ boardName: 'kilter', layoutId: 1, setIds: [1, 2] });
    expect(a).toBe(b);
  });

  it('matches between two configs that differ only in size or angle', () => {
    const a = configKey({ boardName: 'kilter', layoutId: 1, setIds: [1, 2] });
    // Extra fields on the input are irrelevant — Pick<>
    const b = configKey({ boardName: 'kilter', layoutId: 1, setIds: [1, 2] });
    expect(a).toBe(b);
  });

  it('differs when boardName, layoutId, or setIds contents differ', () => {
    const base = configKey({ boardName: 'kilter', layoutId: 1, setIds: [1, 2] });
    expect(base).not.toBe(configKey({ boardName: 'tension', layoutId: 1, setIds: [1, 2] }));
    expect(base).not.toBe(configKey({ boardName: 'kilter', layoutId: 2, setIds: [1, 2] }));
    expect(base).not.toBe(configKey({ boardName: 'kilter', layoutId: 1, setIds: [1, 3] }));
  });
});

// ---------------------------------------------------------------------------
// boardConfigFromDetails
// ---------------------------------------------------------------------------

describe('boardConfigFromDetails', () => {
  it('returns a BoardConfig with all fields copied from details + angle', () => {
    const details = makeBoardDetails({
      board_name: 'tension',
      layout_id: 2,
      size_id: 20,
      set_ids: [5, 6, 7],
    });
    const cfg = boardConfigFromDetails(details, 30);
    expect(cfg).toEqual({
      boardName: 'tension',
      layoutId: 2,
      sizeId: 20,
      setIds: [5, 6, 7],
      angle: 30,
    });
  });
});

// ---------------------------------------------------------------------------
// boardConfigFromUserBoard
// ---------------------------------------------------------------------------

describe('boardConfigFromUserBoard', () => {
  it('parses a clean comma-separated setIds string', () => {
    const board = makeUserBoard({ setIds: '1,2,3' });
    const cfg = boardConfigFromUserBoard(board, 40);
    expect(cfg.setIds).toEqual([1, 2, 3]);
  });

  it('trims surrounding whitespace around each set id', () => {
    const board = makeUserBoard({ setIds: ' 1 , 2 ,  3 ' });
    const cfg = boardConfigFromUserBoard(board, 40);
    expect(cfg.setIds).toEqual([1, 2, 3]);
  });

  it('ignores entries that parse to NaN (non-numeric text)', () => {
    // Only `Number.isFinite(NaN) === false` is filtered. `Number(' ') === 0`
    // (whitespace-only coerces to 0 and IS finite) so empty slots are kept.
    const board = makeUserBoard({ setIds: '1,foo,2,bar,3' });
    const cfg = boardConfigFromUserBoard(board, 40);
    expect(cfg.setIds).toEqual([1, 2, 3]);
  });

  it('populates every BoardConfig field from the UserBoard', () => {
    const board = makeUserBoard({
      boardType: 'tension',
      layoutId: 9,
      sizeId: 99,
      setIds: '11,22',
    });
    const cfg = boardConfigFromUserBoard(board, 25);
    expect(cfg).toEqual({
      boardName: 'tension',
      layoutId: 9,
      sizeId: 99,
      setIds: [11, 22],
      angle: 25,
    });
  });
});

// ---------------------------------------------------------------------------
// boardConfigToBaseBoardPath
// ---------------------------------------------------------------------------

describe('boardConfigToBaseBoardPath', () => {
  it('produces the canonical kilter path with setIds sorted', () => {
    const cfg = makeConfig({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [2, 1] });
    expect(boardConfigToBaseBoardPath(cfg)).toBe('/kilter/1/10/1,2');
  });

  it('produces the canonical tension path', () => {
    const cfg = makeConfig({ boardName: 'tension', layoutId: 7, sizeId: 42, setIds: [3, 4] });
    expect(boardConfigToBaseBoardPath(cfg)).toBe('/tension/7/42/3,4');
  });

  it('moonboard omits the size segment', () => {
    const cfg = makeConfig({ boardName: 'moonboard', layoutId: 99, sizeId: 0, setIds: [18, 17] });
    expect(boardConfigToBaseBoardPath(cfg)).toBe('/moonboard/99/17,18');
  });
});

// ---------------------------------------------------------------------------
// boardConfigEquals
// ---------------------------------------------------------------------------

describe('boardConfigEquals', () => {
  it('returns true for identical configs', () => {
    expect(boardConfigEquals(makeConfig(), makeConfig())).toBe(true);
  });

  it('returns false when boardName differs', () => {
    expect(boardConfigEquals(makeConfig(), makeConfig({ boardName: 'tension' }))).toBe(false);
  });

  it('returns false when layoutId differs', () => {
    expect(boardConfigEquals(makeConfig(), makeConfig({ layoutId: 99 }))).toBe(false);
  });

  it('returns false when sizeId differs', () => {
    expect(boardConfigEquals(makeConfig(), makeConfig({ sizeId: 99 }))).toBe(false);
  });

  it('returns false when angle differs', () => {
    expect(boardConfigEquals(makeConfig(), makeConfig({ angle: 50 }))).toBe(false);
  });

  it('treats setIds as unordered (sorted equality)', () => {
    expect(
      boardConfigEquals(makeConfig({ setIds: [1, 2] }), makeConfig({ setIds: [2, 1] })),
    ).toBe(true);
  });

  it('returns false when setIds lengths differ', () => {
    expect(
      boardConfigEquals(makeConfig({ setIds: [1, 2] }), makeConfig({ setIds: [1, 2, 3] })),
    ).toBe(false);
  });

  it('returns false when one side is null and the other is a config', () => {
    expect(boardConfigEquals(null, makeConfig())).toBe(false);
    expect(boardConfigEquals(makeConfig(), null)).toBe(false);
  });

  it('returns false when one side is undefined and the other is a config', () => {
    expect(boardConfigEquals(undefined, makeConfig())).toBe(false);
    expect(boardConfigEquals(makeConfig(), undefined)).toBe(false);
  });

  it('mirrors strict equality when both sides are null/undefined', () => {
    expect(boardConfigEquals(null, null)).toBe(true);
    expect(boardConfigEquals(undefined, undefined)).toBe(true);
    // null !== undefined under strict equality
    expect(boardConfigEquals(null, undefined)).toBe(false);
    expect(boardConfigEquals(undefined, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decideAdd
// ---------------------------------------------------------------------------

describe('decideAdd', () => {
  it('returns allow when the accepted set is empty (queue is empty)', () => {
    const decision = decideAdd(makeConfig(), new Set(), new Map());
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('returns allow when key is in accepted and size equals an accepted size', () => {
    const cfg = makeConfig({ sizeId: 10 });
    const key = configKey(cfg);
    const accepted = new Set([key]);
    const acceptedSizes = new Map([[key, [10]]]);
    expect(decideAdd(cfg, accepted, acceptedSizes)).toEqual({ kind: 'allow' });
  });

  it('returns allow when incoming size is smaller than all accepted sizes for that key', () => {
    const cfg = makeConfig({ sizeId: 5 });
    const key = configKey(cfg);
    const accepted = new Set([key]);
    const acceptedSizes = new Map([[key, [10, 20]]]);
    expect(decideAdd(cfg, accepted, acceptedSizes)).toEqual({ kind: 'allow' });
  });

  it('returns confirm:larger_size when incoming size is larger than every accepted size', () => {
    const cfg = makeConfig({ sizeId: 30 });
    const key = configKey(cfg);
    const accepted = new Set([key]);
    const acceptedSizes = new Map([[key, [10, 20]]]);
    expect(decideAdd(cfg, accepted, acceptedSizes)).toEqual({
      kind: 'confirm',
      reason: 'larger_size',
    });
  });

  it('returns confirm:new_config when the key is not yet in accepted', () => {
    const cfg = makeConfig({ boardName: 'tension' });
    const accepted = new Set([configKey(makeConfig({ boardName: 'kilter' }))]);
    const acceptedSizes = new Map([[configKey(makeConfig({ boardName: 'kilter' })), [10]]]);
    expect(decideAdd(cfg, accepted, acceptedSizes)).toEqual({
      kind: 'confirm',
      reason: 'new_config',
    });
  });

  it('returns allow when key is accepted but acceptedSizes for it is empty or missing', () => {
    const cfg = makeConfig();
    const key = configKey(cfg);
    const accepted = new Set([key]);
    const emptySizes = new Map([[key, []]]);
    expect(decideAdd(cfg, accepted, emptySizes)).toEqual({ kind: 'allow' });
    const missingSizes = new Map<string, number[]>();
    expect(decideAdd(cfg, accepted, missingSizes)).toEqual({ kind: 'allow' });
  });
});

// ---------------------------------------------------------------------------
// deriveAcceptedConfigs
// ---------------------------------------------------------------------------

describe('deriveAcceptedConfigs', () => {
  it('returns an empty set and empty map for an empty queue', () => {
    const { accepted, acceptedSizes } = deriveAcceptedConfigs([]);
    expect(accepted.size).toBe(0);
    expect(acceptedSizes.size).toBe(0);
  });

  it('dedupes keys and aggregates sizes per key (no duplicate sizes)', () => {
    const items: ClimbQueueItem[] = [
      makeQueueItem({ uuid: 'a', boardConfig: makeConfig({ sizeId: 10 }) }),
      // Same key, same size — should not duplicate the size entry
      makeQueueItem({ uuid: 'b', boardConfig: makeConfig({ sizeId: 10 }) }),
      // Same key, different size — aggregates
      makeQueueItem({ uuid: 'c', boardConfig: makeConfig({ sizeId: 20 }) }),
      // Different key (different board)
      makeQueueItem({
        uuid: 'd',
        boardConfig: makeConfig({ boardName: 'tension', sizeId: 15 }),
      }),
    ];
    const { accepted, acceptedSizes } = deriveAcceptedConfigs(items);
    expect(accepted.size).toBe(2);
    const kilterKey = configKey(makeConfig());
    const tensionKey = configKey(makeConfig({ boardName: 'tension' }));
    expect(accepted.has(kilterKey)).toBe(true);
    expect(accepted.has(tensionKey)).toBe(true);
    expect(acceptedSizes.get(kilterKey)?.sort((a, b) => a - b)).toEqual([10, 20]);
    expect(acceptedSizes.get(tensionKey)).toEqual([15]);
  });

  it('ignores items without boardConfig silently', () => {
    const items: ClimbQueueItem[] = [
      makeQueueItem({ uuid: 'a', boardConfig: makeConfig() }),
      makeQueueItem({ uuid: 'b', boardConfig: null }),
      makeQueueItem({ uuid: 'c' }), // no boardConfig at all
    ];
    const { accepted, acceptedSizes } = deriveAcceptedConfigs(items);
    expect(accepted.size).toBe(1);
    expect(acceptedSizes.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeQueueItem
// ---------------------------------------------------------------------------

describe('normalizeQueueItem', () => {
  const fallback = makeConfig({ boardName: 'tension', layoutId: 9 });

  it('is a no-op when the item already has a boardConfig', () => {
    const original = makeQueueItem({ boardConfig: makeConfig() });
    const result = normalizeQueueItem(original, fallback);
    expect(result).toBe(original);
  });

  it('is a no-op when the fallback is null and the item has no boardConfig', () => {
    const original = makeQueueItem();
    const result = normalizeQueueItem(original, null);
    expect(result).toBe(original);
  });

  it('backfills boardConfig and climb.boardType / climb.layoutId from the fallback', () => {
    const original = makeQueueItem({
      climb: { ...makeQueueItem().climb, boardType: undefined, layoutId: null },
    });
    const result = normalizeQueueItem(original, fallback);
    expect(result).not.toBe(original);
    expect(result.boardConfig).toBe(fallback);
    expect(result.climb.boardType).toBe('tension');
    expect(result.climb.layoutId).toBe(9);
  });

  it('preserves climb.boardType and climb.layoutId when already set', () => {
    const original = makeQueueItem({
      climb: {
        ...makeQueueItem().climb,
        boardType: 'kilter',
        layoutId: 7,
      },
    });
    const result = normalizeQueueItem(original, fallback);
    expect(result.boardConfig).toBe(fallback);
    // Pre-existing values survive
    expect(result.climb.boardType).toBe('kilter');
    expect(result.climb.layoutId).toBe(7);
  });

  it('preserves boardId untouched through backfill', () => {
    const original = makeQueueItem({ boardId: 'ub-42' });
    const result = normalizeQueueItem(original, fallback);
    expect(result.boardId).toBe('ub-42');
  });
});
