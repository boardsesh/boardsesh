import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Rendered-SQL coverage for `SearchGymsInput.requireSlug` on the proximity path.
 *
 * The proximity path issues its count and its rows as two SEPARATE `db.execute`
 * calls that only agree because both interpolate the same filter clause. A
 * predicate that lands on the rows query but not the count makes `totalCount`
 * and `hasMore` describe a different result set than the rows returned — broken
 * pagination that a resolver-output test never sees. So this asserts on the SQL
 * the resolver actually emits, on BOTH statements, rather than on a rebuilt copy.
 *
 * The second assertion is the one that matters most: with `requireSlug` omitted,
 * the emitted SQL must be byte-identical to what the resolver emitted before the
 * flag existed. Mobile's `useNearbyGyms` (limit 50) and the gym picker ride this
 * exact query — the expected strings below are the pre-change output, pasted in
 * full so any drift is a diff, not a judgement call.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn((_statement: unknown) => Promise.resolve([] as unknown[])),
  },
}));

vi.mock('../db/client', () => ({ db: mockDb }));

import { socialGymQueries } from '../graphql/resolvers/social/gyms';

const dialect = new PgDialect();

const anonCtx = (): ConnectionContext =>
  ({ connectionId: 'conn-sql-test', isAuthenticated: false }) as ConnectionContext;

/** The rendered SQL of every `db.execute` the resolver issued, in call order. */
function renderedStatements(): string[] {
  return mockDb.execute.mock.calls.map(([statement]) => dialect.sqlToQuery(statement as unknown as SQL).sql);
}

async function searchWith(input: Record<string, unknown>): Promise<string[]> {
  await socialGymQueries.searchGyms(null, { input }, anonCtx());
  return renderedStatements();
}

const PROXIMITY_INPUT = { latitude: 52.37, longitude: 4.89, radiusKm: 25, limit: 20, offset: 0 };

// The pre-`requireSlug` output, verbatim. Parameters are placeholders ($1…), so
// these strings capture query shape — exactly what a no-regression guard needs.
const BASELINE_PROXIMITY_COUNT_SQL =
  'SELECT count(*)::int as count FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint($1, $2)::geography, $3)';
const BASELINE_PROXIMITY_ROWS_SQL =
  'SELECT *, ST_Distance(location, ST_MakePoint($1, $2)::geography) as distance_meters FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint($3, $4)::geography, $5) ORDER BY distance_meters ASC LIMIT $6 OFFSET $7';

// The empty string is a SQL literal, not a bound parameter — it's a constant of
// the predicate, never caller input.
const SLUG_PREDICATE = "gyms.slug IS NOT NULL AND gyms.slug <> ''";

describe('searchGyms requireSlug — rendered SQL', () => {
  beforeEach(() => {
    mockDb.execute.mockClear();
  });

  it('puts the slug predicate in BOTH proximity statements (count and rows)', async () => {
    const [countSql, rowsSql, ...extra] = await searchWith({ ...PROXIMITY_INPUT, requireSlug: true });

    expect(extra).toEqual([]);
    expect(countSql).toContain('count(*)::int as count');
    expect(rowsSql).toContain('ORDER BY distance_meters ASC');

    // The predicate itself, identical on both statements — that identity is the
    // whole guard, since totalCount comes from one and the rows from the other.
    expect(countSql).toContain(SLUG_PREDICATE);
    expect(rowsSql).toContain(SLUG_PREDICATE);
  });

  it('excludes empty-string slugs, not just NULL, and leaves the caller params untouched', async () => {
    await socialGymQueries.searchGyms(null, { input: { ...PROXIMITY_INPUT, requireSlug: true } }, anonCtx());
    const [countCall, rowsCall] = mockDb.execute.mock.calls;
    const countQuery = dialect.sqlToQuery(countCall[0] as unknown as SQL);
    const rowsQuery = dialect.sqlToQuery(rowsCall[0] as unknown as SQL);

    // `/gym/` is as broken a link as `/gym/null`, so '' is excluded alongside NULL.
    expect(countQuery.sql).toContain("gyms.slug <> ''");
    expect(rowsQuery.sql).toContain("gyms.slug <> ''");
    // The predicate binds nothing, so it can't shift the caller's placeholders.
    expect(countQuery.params).toEqual([4.89, 52.37, 25000]);
    expect(rowsQuery.params).toEqual([4.89, 52.37, 4.89, 52.37, 25000, 20, 0]);
  });

  it('emits byte-identical SQL to the pre-flag resolver when requireSlug is omitted', async () => {
    const [countSql, rowsSql] = await searchWith(PROXIMITY_INPUT);

    expect(countSql).toBe(BASELINE_PROXIMITY_COUNT_SQL);
    expect(rowsSql).toBe(BASELINE_PROXIMITY_ROWS_SQL);
  });

  it('emits byte-identical SQL when requireSlug is explicitly false', async () => {
    const [countSql, rowsSql] = await searchWith({ ...PROXIMITY_INPUT, requireSlug: false });

    expect(countSql).toBe(BASELINE_PROXIMITY_COUNT_SQL);
    expect(rowsSql).toBe(BASELINE_PROXIMITY_ROWS_SQL);
  });

  it('composes with the board-type filter without either clause displacing the other', async () => {
    const [countSql, rowsSql] = await searchWith({
      ...PROXIMITY_INPUT,
      boardTypes: ['kilter'],
      requireSlug: true,
    });

    for (const statement of [countSql, rowsSql]) {
      expect(statement).toContain('ub.board_type IN (');
      expect(statement).toContain(SLUG_PREDICATE);
    }
  });
});
