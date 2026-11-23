import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { peekRateLimit } from '../utils/rate-limiter';

// The backend fixture DB has no PostGIS. Capture the real WHERE clauses passed
// to count and page queries to cover the proximity branch without faking its SQL.
const { mockDb, predicates } = vi.hoisted(() => {
  const predicates: unknown[] = [];
  const makeSelect = (projection: unknown) => {
    const isCount = projection != null && typeof projection === 'object' && 'count' in projection;
    const chain = {
      from: () => chain,
      where: (predicate: unknown) => {
        predicates.push(predicate);
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      // oxlint-disable-next-line unicorn/no-thenable
      then: (resolve: (rows: unknown[]) => unknown) => resolve(isCount ? [{ count: 0 }] : []),
    };
    return chain;
  };
  return { predicates, mockDb: { select: vi.fn(makeSelect) } };
});

vi.mock('../db/client', () => ({ db: mockDb }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

import { socialBoardQueries } from '../graphql/resolvers/social/boards';

const dialect = new PgDialect();

async function queryPredicates(input: Record<string, unknown>) {
  predicates.length = 0;
  const ctx = { connectionId: 'board-angle-sql', isAuthenticated: false } as ConnectionContext;
  await socialBoardQueries.searchBoards(null, { input: { boardType: 'spray', ...input } }, ctx);
  return predicates.map((predicate) => dialect.sqlToQuery(predicate as SQL));
}

describe.each([
  { mode: 'text', origin: {} },
  { mode: 'proximity', origin: { latitude: 52.37, longitude: 4.89, radiusKm: 25 } },
])('searchBoards $mode angle filtering', ({ origin, mode }) => {
  beforeEach(() => mockDb.select.mockClear());

  it('applies the same exact-angle predicate and privacy gates to count and page', async () => {
    const statements = await queryPredicates({ ...origin, angles: [30, 40], limit: 1, offset: 1 });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toEqual(statements[1]);
    const { sql, params } = statements[0];
    expect(sql).toMatch(/"user_boards"\."angle" in \(\$\d+, \$\d+\)/);
    expect(params.slice(-2)).toEqual([30, 40]);
    expect(sql).toContain('sw.current_version_id IS NOT NULL');
    expect(sql).toContain('sw.hidden_at IS NULL');
    expect(sql).toContain('archived.archived_at IS NOT NULL');
    expect(sql).toContain('"user_boards"."deleted_at" is null');
    expect(sql).not.toContain('is_angle_adjustable');
    if (mode === 'proximity') expect(sql).toContain('ST_DWithin');
  });

  it('leaves both predicates identical when angles are omitted or empty', async () => {
    const baseline = await queryPredicates(origin);
    expect(await queryPredicates({ ...origin, angles: [] })).toEqual(baseline);
    expect(baseline[0].sql).not.toContain('"user_boards"."angle" in');
  });
});

describe('public spray-wall search allowance', () => {
  beforeEach(() => mockDb.select.mockClear());

  it('allows 300 SSR requests per IP and rejects request 301 before querying', async () => {
    const ctx: ConnectionContext = { connectionId: 'public-ssr', transport: 'http', clientIp: '192.0.2.10' };
    for (let request = 0; request < 300; request++) {
      await socialBoardQueries.publicSprayWalls(null, { input: { limit: 24 } }, ctx);
    }
    expect(mockDb.select).toHaveBeenCalledTimes(600);
    await expect(socialBoardQueries.publicSprayWalls(null, { input: {} }, ctx)).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMITED', operation: 'publicSprayWalls' },
    });
    expect(mockDb.select).toHaveBeenCalledTimes(600);
  });

  it('retains the 20-request generic search limit in a separate bucket', async () => {
    const ctx: ConnectionContext = { connectionId: 'generic-ssr', transport: 'http', clientIp: '192.0.2.11' };
    for (let request = 0; request < 20; request++) {
      await socialBoardQueries.searchBoards(null, { input: { boardType: 'kilter' } }, ctx);
    }
    await expect(socialBoardQueries.searchBoards(null, { input: {} }, ctx)).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMITED', operation: 'searchBoards' },
    });
    await expect(socialBoardQueries.publicSprayWalls(null, { input: {} }, ctx)).resolves.toMatchObject({
      totalCount: 0,
    });
  });

  it('charges the authenticated caller before reducing the read to anonymous visibility', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'owner-directory',
      transport: 'http',
      clientIp: '192.0.2.12',
      userId: 'directory-owner',
      isAuthenticated: true,
      controllerOwnerUserId: 'controller-owner',
    };
    predicates.length = 0;
    await socialBoardQueries.publicSprayWalls(null, { input: {} }, ctx);
    expect(peekRateLimit('directory-owner:publicSprayWalls')?.count).toBe(1);
    expect(peekRateLimit('ip:192.0.2.12:publicSprayWalls')).toBeNull();
    for (const predicate of predicates) {
      const { params } = dialect.sqlToQuery(predicate as SQL);
      expect(params).not.toContain('directory-owner');
      expect(params).not.toContain('controller-owner');
    }
  });

  it('uses anonymous spray predicates in proximity search even for an owner', async () => {
    predicates.length = 0;
    await socialBoardQueries.publicSprayWalls(
      null,
      { input: { latitude: 52.37, longitude: 4.89, angles: [40], boardType: 'kilter', boardTypes: ['kilter'] } },
      { connectionId: 'proximity-owner', isAuthenticated: true, userId: 'directory-owner' },
    );
    const statements = predicates.map((predicate) => dialect.sqlToQuery(predicate as SQL));
    expect(statements).toHaveLength(2);
    expect(statements[0]).toEqual(statements[1]);
    expect(statements[0].sql).toContain('ST_DWithin');
    expect(statements[0].params).toContain('spray');
    expect(statements[0].params).not.toContain('kilter');
    expect(statements[0].params).not.toContain('directory-owner');
    expect(statements[0].params.at(-1)).toBe(40);
  });
});
