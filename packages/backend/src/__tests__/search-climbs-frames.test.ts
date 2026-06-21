import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardRouteParams, ClimbSearchParams } from '@boardsesh/db/queries';

// Regression guard for issue #2690: searchClimbs must select and surface
// frames_count/frames_pace so multi-frame climbs reached via search play back
// at their authored pace instead of the default. The bug was a missing column
// in the DB projection + mapping; this test drives the real shared query
// against a stubbed drizzle client and asserts both the projection and output.

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
}));

vi.mock('../db/client', () => ({
  db: mockDb,
  dbRead: mockDb,
}));

import { searchClimbs } from '../db/queries/climbs/search-climbs';

const params: BoardRouteParams = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  angle: 40,
};

// One raw search row in the snake_case shape `mapResultToClimbRow` consumes.
// frames_count > 1 / frames_pace > 0 stand in for a multi-frame route.
function rawRow(uuid: string) {
  return {
    uuid,
    setter_username: 'alice',
    userId: null,
    name: 'Multi-frame Route',
    frames: 'p1r1,p2r1',
    is_draft: false,
    angle: 40,
    ascensionist_count: '5',
    difficulty_id: 20,
    quality_average: 4.5,
    difficulty_error: 0.1,
    benchmark_difficulty: null,
    description: '',
    created_at: null,
    published_at: null,
    frames_count: 2,
    frames_pace: 1200,
  };
}

// Chainable drizzle stub: every builder method returns the same chain, and the
// chain is awaitable, resolving to the canned rows. Covers both query paths
// (innerJoin for stats-driven, leftJoin for standard) plus offset.
function makeChain(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset'];
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  return chain;
}

function capturedSelectKeys(): string[] {
  const firstCallArg = mockDb.select.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  return firstCallArg ? Object.keys(firstCallArg) : [];
}

describe('searchClimbs surfaces frames_count/frames_pace (issue #2690)', () => {
  beforeEach(() => {
    mockDb.select.mockReset();
  });

  it('projects and maps frame fields on the stats-driven path', async () => {
    // Default sort (ascents DESC), page 0, no stats filters -> stats-driven path.
    // pageSize 1 + 2 rows -> hasMore, so it returns without the standard fallback.
    mockDb.select.mockReturnValue(makeChain([rawRow('c1'), rawRow('c2')]));

    const searchParams: ClimbSearchParams = { page: 0, pageSize: 1 };
    const result = await searchClimbs(params, searchParams);

    expect(capturedSelectKeys()).toContain('frames_count');
    expect(capturedSelectKeys()).toContain('frames_pace');
    expect(result.climbs[0].framesCount).toBe(2);
    expect(result.climbs[0].framesPace).toBe(1200);
  });

  it('projects and maps frame fields on the standard path', async () => {
    // 'creation' sort forces the standard (LEFT JOIN) path.
    mockDb.select.mockReturnValue(makeChain([rawRow('c1'), rawRow('c2')]));

    const searchParams: ClimbSearchParams = { page: 0, pageSize: 1, sortBy: 'creation' };
    const result = await searchClimbs(params, searchParams);

    expect(capturedSelectKeys()).toContain('frames_count');
    expect(capturedSelectKeys()).toContain('frames_pace');
    expect(result.climbs[0].framesCount).toBe(2);
    expect(result.climbs[0].framesPace).toBe(1200);
  });
});

describe('searchClimbs stamps boardType/layoutId from the searched board', () => {
  beforeEach(() => {
    mockDb.select.mockReset();
  });

  // The search WHERE filters on board + layout, so every row belongs to the
  // searched board. mapResultToClimbRow stamps them from params (like angle) so
  // queued climbs carry the board metadata the BLE spill guard reads.
  it('carries the route board/layout onto each result climb', async () => {
    mockDb.select.mockReturnValue(makeChain([rawRow('c1'), rawRow('c2')]));

    const searchParams: ClimbSearchParams = { page: 0, pageSize: 1 };
    const result = await searchClimbs(params, searchParams);

    expect(result.climbs[0].boardType).toBe('kilter');
    expect(result.climbs[0].layoutId).toBe(1);
  });
});
