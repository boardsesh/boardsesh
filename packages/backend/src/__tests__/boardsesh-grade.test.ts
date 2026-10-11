import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Mock the read client: capture what the resolver selects and feed it canned
// rows. The chain mirrors dbRead.select().from().leftJoin().where().limit().
const { selectRows, dbReadMock } = vi.hoisted(() => {
  const state: { rows: unknown[] } = { rows: [] };
  const chain = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => state.rows),
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

const callResolver = (boardName: string, climbUuid: string, angle: number) =>
  climbQueries.boardseshGrade(undefined, { boardName, climbUuid, angle }, ctx);

describe('boardseshGrade resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.rows = [];
  });

  it('maps a board_climb_grades row to the GraphQL field names', async () => {
    selectRows.rows = [
      {
        localGrade: 18.4,
        universalGrade: 17.9,
        gradeLow: 16.5,
        gradeHigh: 19.2,
        confidence: 'confirmed',
        ascensionistCount: 42,
        modelVersion: 'v1',
        computedAt: '2026-07-01T00:00:00Z',
      },
    ];

    const result = await callResolver('kilter', 'CLIMB-1', 40);

    expect(result).toEqual({
      localGrade: 18.4,
      universalGrade: 17.9,
      gradeLow: 16.5,
      gradeHigh: 19.2,
      confidence: 'confirmed',
      ascensionistCount: 42,
      modelVersion: 'v1',
      computedAt: '2026-07-01T00:00:00Z',
    });
  });

  it('passes through null universalGrade / grade band for an unanchorable grade', async () => {
    selectRows.rows = [
      {
        localGrade: 12.0,
        universalGrade: null,
        gradeLow: null,
        gradeHigh: null,
        confidence: 'provisional',
        ascensionistCount: 3,
        modelVersion: 'v1',
        computedAt: '2026-07-01T00:00:00Z',
      },
    ];

    const result = await callResolver('tension', 'CLIMB-2', 30);

    expect(result).toMatchObject({
      localGrade: 12.0,
      universalGrade: null,
      gradeLow: null,
      gradeHigh: null,
      confidence: 'provisional',
    });
  });

  it('returns null when no grade has been computed for the climb+angle', async () => {
    selectRows.rows = [];

    const result = await callResolver('kilter', 'CLIMB-NONE', 40);

    expect(result).toBeNull();
    expect(dbReadMock.select).toHaveBeenCalledTimes(1);
  });

  it('applies a 60/min rate limit for this operation before querying', async () => {
    await callResolver('kilter', 'CLIMB-1', 40);

    expect(applyRateLimitMock).toHaveBeenCalledWith(ctx, 60, 'boardsesh-grade');
  });

  it('propagates a rate-limit rejection without touching the DB', async () => {
    applyRateLimitMock.mockRejectedValueOnce(new Error('RATE_LIMITED'));

    await expect(callResolver('kilter', 'CLIMB-1', 40)).rejects.toThrow('RATE_LIMITED');
    expect(dbReadMock.select).not.toHaveBeenCalled();
  });

  it('rejects an unknown board name', async () => {
    await expect(callResolver('notaboard', 'CLIMB-1', 40)).rejects.toThrow();
    expect(dbReadMock.select).not.toHaveBeenCalled();
  });

  it('rejects an empty climb uuid', async () => {
    await expect(callResolver('kilter', '', 40)).rejects.toThrow();
    expect(dbReadMock.select).not.toHaveBeenCalled();
  });
});
