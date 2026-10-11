import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { asc } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';

// Mock the read client: capture what the resolver selects and feed it canned
// rows. The chain mirrors dbRead.select().from().leftJoin().where().orderBy().
const { selectRows, dbReadMock } = vi.hoisted(() => {
  const state: { rows: unknown[] } = { rows: [] };
  const chain = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
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
  climbQueries.boardseshGradesForAngles(undefined, { boardName, climbUuid }, ctx);

describe('boardseshGradesForAngles resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.rows = [];
  });

  it('maps board_climb_grades rows to the GraphQL field names, one per angle', async () => {
    selectRows.rows = [
      {
        angle: 25,
        localGrade: 15.1,
        universalGrade: 14.8,
        gradeLow: 13.5,
        gradeHigh: 16.2,
        confidence: 'provisional',
        ascensionistCount: 6,
        modelVersion: 'v1',
        computedAt: '2026-07-01T00:00:00Z',
      },
      {
        angle: 40,
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

    const result = await callResolver('kilter', 'CLIMB-1');

    expect(result).toEqual([
      {
        angle: 25,
        localGrade: 15.1,
        universalGrade: 14.8,
        gradeLow: 13.5,
        gradeHigh: 16.2,
        confidence: 'provisional',
        ascensionistCount: 6,
        modelVersion: 'v1',
        computedAt: '2026-07-01T00:00:00Z',
      },
      {
        angle: 40,
        localGrade: 18.4,
        universalGrade: 17.9,
        gradeLow: 16.5,
        gradeHigh: 19.2,
        confidence: 'confirmed',
        ascensionistCount: 42,
        modelVersion: 'v1',
        computedAt: '2026-07-01T00:00:00Z',
      },
    ]);
  });

  it('orders the query by angle ascending', async () => {
    selectRows.rows = [];

    await callResolver('kilter', 'CLIMB-1');

    // The terminal .orderBy runs once, and with the actual ascending-angle
    // ordering — not just "some" ordering. `asc()`/`desc()` on the same
    // column produce structurally-distinct (but reference-stable, since the
    // column object is a shared singleton) SQL ASTs, so a deep-equal
    // comparison against a freshly-built `asc(...)` call catches a
    // regression to `desc()` or a different column that `toHaveBeenCalledTimes`
    // alone would miss.
    const chain = dbReadMock.select.mock.results[0]?.value as { orderBy: ReturnType<typeof vi.fn> };
    expect(chain.orderBy).toHaveBeenCalledTimes(1);
    expect(chain.orderBy).toHaveBeenCalledWith(asc(dbSchema.boardClimbGrades.angle));
  });

  it('passes through null universalGrade / grade band for an unanchorable grade', async () => {
    selectRows.rows = [
      {
        angle: 30,
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

    const [entry] = await callResolver('tension', 'CLIMB-2');

    expect(entry).toMatchObject({
      angle: 30,
      localGrade: 12.0,
      universalGrade: null,
      gradeLow: null,
      gradeHigh: null,
      confidence: 'provisional',
    });
  });

  it('returns an empty array for a climb with no computed grades', async () => {
    selectRows.rows = [];

    const result = await callResolver('kilter', 'CLIMB-NONE');

    expect(result).toEqual([]);
    expect(dbReadMock.select).toHaveBeenCalledTimes(1);
  });

  it('applies a 60/min rate limit for this operation before querying', async () => {
    await callResolver('kilter', 'CLIMB-1');

    expect(applyRateLimitMock).toHaveBeenCalledWith(ctx, 60, 'boardsesh-grades-for-angles');
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
