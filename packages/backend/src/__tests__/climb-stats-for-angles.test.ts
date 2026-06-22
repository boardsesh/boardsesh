import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Mock the live-stats query: capture what the resolver selects and feed it
// canned rows. The chain mirrors dbRead.select().from().where().orderBy().
const { selectRows, dbReadMock } = vi.hoisted(() => {
  const state: { rows: unknown[] } = { rows: [] };
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(async () => state.rows),
  };
  return {
    selectRows: state,
    dbReadMock: { select: vi.fn(() => chain) },
  };
});

vi.mock('../db/client', () => ({
  db: {},
  dbRead: dbReadMock,
}));

// Deterministic grade labels so we assert the mapping, not the grade table.
// Partial mock — keep every other export intact (validation schemas pull
// constants like MAX_SEARCH_PAGE from this module).
vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return {
    ...actual,
    getGradeLabel: (id: number | null) => (id == null ? '' : `V${id}`),
  };
});

// Spy on the shared rate-limit helper (keep validateInput and everything else
// real). Lets us assert the resolver enforces a limit without coupling to the
// limiter's module-global counter or NODE_ENV.
vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graphql/resolvers/shared/helpers')>();
  return { ...actual, applyRateLimit: vi.fn(async () => {}) };
});

import { climbQueries } from '../graphql/resolvers/climbs/queries';
import { applyRateLimit } from '../graphql/resolvers/shared/helpers';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const applyRateLimitMock = vi.mocked(applyRateLimit);

// Anonymous HTTP-style context: only the in-memory rate-limit tier runs (the
// Redis tier is gated on authenticated users), so no infra is needed.
const ctx = { isAuthenticated: false, connectionId: 'test-conn' } as unknown as ConnectionContext;

const callResolver = (boardName: string, climbUuid: string) =>
  climbQueries.climbStatsForAngles(undefined, { boardName, climbUuid }, ctx);

describe('climbStatsForAngles resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.rows = [];
  });

  it('labels difficulty from rounded displayDifficulty and passes fa fields through', async () => {
    selectRows.rows = [
      {
        angle: 40,
        ascensionistCount: 12,
        kilterAscensionistCount: 7,
        auroraAscensionistCount: 4,
        boardseshAscensionistCount: 5,
        qualityAverage: 3.5,
        difficultyAverage: 20.4,
        displayDifficulty: 20.6,
        faUsername: 'Alice',
        faAt: '2024-01-02T00:00:00Z',
      },
    ];

    const result = await callResolver('kilter', 'CLIMB-1');

    expect(result).toEqual([
      {
        angle: 40,
        ascensionistCount: 12,
        // Raw per-source counts pass straight through for the client to fold.
        kilterAscensionistCount: 7,
        auroraAscensionistCount: 4,
        boardseshAscensionistCount: 5,
        qualityAverage: 3.5,
        difficultyAverage: 20.4,
        displayDifficulty: 20.6,
        difficulty: 'V21', // round(20.6) -> 21
        faUsername: 'Alice',
        faAt: '2024-01-02T00:00:00Z',
      },
    ]);
  });

  it('returns null difficulty when displayDifficulty is null', async () => {
    selectRows.rows = [
      {
        angle: 30,
        ascensionistCount: 0,
        kilterAscensionistCount: null,
        auroraAscensionistCount: null,
        boardseshAscensionistCount: null,
        qualityAverage: null,
        difficultyAverage: null,
        displayDifficulty: null,
        faUsername: null,
        faAt: null,
      },
    ];

    const [entry] = await callResolver('tension', 'CLIMB-2');

    expect(entry.difficulty).toBeNull();
    expect(entry.displayDifficulty).toBeNull();
    // Untracked per-source counts surface as null (distinct from a genuine 0).
    expect(entry.kilterAscensionistCount).toBeNull();
    expect(entry.auroraAscensionistCount).toBeNull();
    expect(entry.boardseshAscensionistCount).toBeNull();
  });

  it('returns an empty array for a climb with no logged angles', async () => {
    selectRows.rows = [];

    const result = await callResolver('kilter', 'CLIMB-NONE');

    expect(result).toEqual([]);
    expect(dbReadMock.select).toHaveBeenCalledTimes(1);
  });

  it('applies a 60/min rate limit for this operation before querying', async () => {
    await callResolver('kilter', 'CLIMB-1');

    expect(applyRateLimitMock).toHaveBeenCalledWith(ctx, 60, 'climb-stats-for-angles');
  });

  it('propagates a rate-limit rejection without touching the DB', async () => {
    applyRateLimitMock.mockRejectedValueOnce(new Error('RATE_LIMITED'));

    await expect(callResolver('kilter', 'CLIMB-1')).rejects.toThrow('RATE_LIMITED');
    expect(dbReadMock.select).not.toHaveBeenCalled();
  });

  it('rejects an unknown board name', async () => {
    await expect(callResolver('notaboard', 'CLIMB-1')).rejects.toThrow();
    expect(dbReadMock.select).not.toHaveBeenCalled();
  });

  it('rejects an empty climb uuid', async () => {
    await expect(callResolver('kilter', '')).rejects.toThrow();
    expect(dbReadMock.select).not.toHaveBeenCalled();
  });
});
