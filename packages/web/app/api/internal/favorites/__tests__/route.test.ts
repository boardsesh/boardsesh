import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('server-only', () => ({}));

const session = vi.hoisted(() => ({ current: { user: { id: 'user-1' } } as { user: { id: string } } | null }));
vi.mock('next-auth/next', () => ({
  getServerSession: () => Promise.resolve(session.current),
}));
vi.mock('@/app/lib/auth/auth-options', () => ({ authOptions: {} }));

// Captures the WHERE condition the route hands drizzle, so a regression that
// drops the climb-uuid filter (and reads every favorite the user has ever made)
// fails here rather than in production latency graphs.
const capturedSelectWhere = vi.hoisted(() => ({ current: null as SQL | null }));
const selectRows = vi.hoisted(() => ({ current: [] as Array<{ climbUuid: string }> }));

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          capturedSelectWhere.current = condition;
          const rows = selectRows.current;
          return Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
        },
      }),
    }),
  }),
}));

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/internal/favorites?${query}`);
}

function whereParams(): unknown[] {
  const condition = capturedSelectWhere.current;
  if (!condition) throw new Error('no where condition captured');
  return new PgDialect().sqlToQuery(condition).params;
}

beforeEach(() => {
  session.current = { user: { id: 'user-1' } };
  capturedSelectWhere.current = null;
  selectRows.current = [];
});

describe('GET /api/internal/favorites', () => {
  it('filters by the requested climb uuids in SQL, not in JS', async () => {
    selectRows.current = [{ climbUuid: 'climb-1' }];
    const { GET } = await import('../route');

    const response = await GET(getRequest('climbUuids=climb-1,climb-2'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ favorites: ['climb-1'] });
    // user id + both uuids bound in the statement itself.
    expect(whereParams()).toEqual(['user-1', 'climb-1', 'climb-2']);
  });

  it('no longer requires boardName or angle', async () => {
    const { GET } = await import('../route');

    const response = await GET(getRequest('climbUuids=climb-1'));

    expect(response.status).toBe(200);
  });

  it('returns 400 when climbUuids is missing', async () => {
    const { GET } = await import('../route');

    const response = await GET(getRequest('boardName=kilter'));

    expect(response.status).toBe(400);
    expect(capturedSelectWhere.current).toBeNull();
  });

  it('returns an empty list for a signed-out visitor without touching the db', async () => {
    session.current = null;
    const { GET } = await import('../route');

    const response = await GET(getRequest('climbUuids=climb-1'));

    await expect(response.json()).resolves.toEqual({ favorites: [] });
    expect(capturedSelectWhere.current).toBeNull();
  });
});
