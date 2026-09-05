import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * Rendered-SQL coverage for `SearchGymsInput.requireSlug` on BOTH searchGyms
 * code paths — the raw PostGIS proximity path and the Drizzle text path.
 *
 * The proximity path issues its count and its rows as two SEPARATE `db.execute`
 * calls that only agree because both interpolate the same filter clause. A
 * predicate that lands on the rows query but not the count makes `totalCount`
 * and `hasMore` describe a different result set than the rows returned — broken
 * pagination that a resolver-output test never sees. So this asserts on the SQL
 * the resolver actually emits, on BOTH statements, rather than on a rebuilt copy.
 *
 * The text path needs the same guard for a plainer reason: `/gyms` has no
 * coordinates, so the text path is what the public directory actually runs. It
 * builds through the Drizzle query builder rather than `db.execute`, so the
 * `db.select` stand-in below captures the `where` / `orderBy` the resolver hands
 * the builder and renders those.
 *
 * The `toBe()` baselines are the assertions that matter most: with `requireSlug`
 * omitted the emitted SQL must be byte-identical to what the resolver emitted
 * before the flag existed, because mobile's `useNearbyGyms` (limit 50) and the
 * gym picker ride these exact queries. They are pasted in full so any drift is a
 * diff, not a judgement call.
 */

type TextSelectCapture = { where?: SQL; orderBy?: unknown[] };

const { mockDb, textSelectCaptures } = vi.hoisted(() => {
  const textSelectCaptures: Array<{ where?: unknown; orderBy?: unknown[] }> = [];
  const makeSelectChain = () => {
    const capture: { where?: unknown; orderBy?: unknown[] } = {};
    textSelectCaptures.push(capture);
    const chain = {
      from: () => chain,
      where: (condition: unknown) => {
        capture.where = condition;
        return chain;
      },
      orderBy: (...columns: unknown[]) => {
        capture.orderBy = columns;
        return chain;
      },
      limit: () => chain,
      offset: () => chain,
      // Thenable on purpose: Drizzle's query builder is itself a thenable, so
      // `await db.select()...offset(n)` only works if the stand-in is one too.
      // It resolves to an empty row set, which also means enrichGym never runs
      // and nothing else touches the db.
      // oxlint-disable-next-line unicorn/no-thenable
      then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
    };
    return chain;
  };
  return {
    textSelectCaptures,
    mockDb: {
      execute: vi.fn((_statement: unknown) => Promise.resolve([] as unknown[])),
      select: vi.fn((_projection?: unknown) => makeSelectChain()),
    },
  };
});

vi.mock('../db/client', () => ({ db: mockDb }));

import { socialGymQueries, slugPresentFilter } from '../graphql/resolvers/social/gyms';

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

/** The `where` / `orderBy` the text path handed the Drizzle builder, rendered. */
async function textSearchWith(input: Record<string, unknown>): Promise<{ wheres: string[]; orderBys: string[] }> {
  await socialGymQueries.searchGyms(null, { input }, anonCtx());
  const captures = textSelectCaptures as TextSelectCapture[];
  return {
    wheres: captures.map((capture) => dialect.sqlToQuery(capture.where as SQL).sql),
    orderBys: captures
      .filter((capture) => capture.orderBy !== undefined)
      .map((capture) => dialect.sqlToQuery(sql.join(capture.orderBy as SQL[], sql`, `)).sql),
  };
}

const PROXIMITY_INPUT = { latitude: 52.37, longitude: 4.89, radiusKm: 25, limit: 20, offset: 0 };
const TEXT_INPUT = { limit: 24, offset: 0 };

// The pre-`requireSlug` output, verbatim, with `gyms.id` added to the rows
// ORDER BY as the deliberate pagination tiebreaker (see the resolver comment).
// Parameters are placeholders ($1…), so these strings capture query shape —
// exactly what a no-regression guard needs.
const BASELINE_PROXIMITY_COUNT_SQL =
  'SELECT count(*)::int as count FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint($1, $2)::geography, $3)';
const BASELINE_PROXIMITY_ROWS_SQL =
  'SELECT *, ST_Distance(location, ST_MakePoint($1, $2)::geography) as distance_meters FROM gyms WHERE is_public = true AND deleted_at IS NULL AND location IS NOT NULL AND ST_DWithin(location, ST_MakePoint($3, $4)::geography, $5) ORDER BY distance_meters ASC, gyms.id ASC LIMIT $6 OFFSET $7';

// The empty string is a SQL literal, not a bound parameter — it's a constant of
// the predicate, never caller input.
const SLUG_PREDICATE = "gyms.slug IS NOT NULL AND gyms.slug <> ''";

describe('searchGyms requireSlug — rendered SQL', () => {
  beforeEach(() => {
    mockDb.execute.mockClear();
    mockDb.select.mockClear();
    textSelectCaptures.length = 0;
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

  it('orders the proximity rows by distance then gyms.id, so OFFSET paging is stable across ties', async () => {
    const [, rowsSql] = await searchWith(PROXIMITY_INPUT);

    expect(rowsSql).toContain('ORDER BY distance_meters ASC, gyms.id ASC LIMIT');
  });

  // The count-vs-rows agreement stated as one assertion rather than two
  // substring checks. search-gyms-proximity.test.ts now proves the same property
  // behaviourally against real PostGIS, so this is no longer the only evidence —
  // it stays as the cheap structural guard, holding every rendered combination to
  // a byte-identical WHERE including the ones no fixture covers.
  it.each([
    ['requireSlug omitted', PROXIMITY_INPUT],
    ['requireSlug true', { ...PROXIMITY_INPUT, requireSlug: true }],
    ['requireSlug true + board filter', { ...PROXIMITY_INPUT, boardTypes: ['kilter'], requireSlug: true }],
    ['requireSlug true + free text', { ...PROXIMITY_INPUT, query: 'boulder', requireSlug: true }],
  ])('count and rows filter on an identical WHERE clause (%s)', async (_label, input) => {
    const [countSql, rowsSql] = await searchWith(input);

    // Placeholder numbering differs only because the rows query's ST_Distance
    // select list binds two params before the WHERE; normalise it away.
    const whereOf = (statement: string): string =>
      statement.slice(statement.indexOf(' WHERE ')).split(' ORDER BY ')[0].replace(/\$\d+/g, '$?');

    expect(whereOf(countSql)).toBe(whereOf(rowsSql));
  });
});

describe('searchGyms requireSlug — rendered SQL, text path', () => {
  beforeEach(() => {
    mockDb.execute.mockClear();
    mockDb.select.mockClear();
    textSelectCaptures.length = 0;
  });

  it('never touches the proximity path when no coordinates are given', async () => {
    await textSearchWith(TEXT_INPUT);

    // No raw db.execute at all: this is the Drizzle builder path, and it is what
    // `/gyms` runs, since the directory has no coordinates.
    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it('puts the slug predicate in BOTH text statements (count and rows)', async () => {
    const { wheres } = await textSearchWith({ ...TEXT_INPUT, requireSlug: true });

    expect(wheres).toHaveLength(2);
    const [countWhere, rowsWhere] = wheres;
    expect(countWhere).toContain(`"gyms"."slug" IS NOT NULL AND "gyms"."slug" <> ''`);
    expect(rowsWhere).toContain(`"gyms"."slug" IS NOT NULL AND "gyms"."slug" <> ''`);
    // Same predicate, same clause: the count and the rows derive from one shared
    // `whereClause`, so totalCount can never describe a different set than the
    // rows returned.
    expect(countWhere).toBe(rowsWhere);
  });

  it('leaves the text where-clause byte-identical when requireSlug is omitted', async () => {
    const { wheres } = await textSearchWith(TEXT_INPUT);

    const BASELINE_TEXT_WHERE = `("gyms"."is_public" = $1 and "gyms"."deleted_at" is null)`;
    expect(wheres).toEqual([BASELINE_TEXT_WHERE, BASELINE_TEXT_WHERE]);
  });

  it('leaves the text where-clause byte-identical when requireSlug is explicitly false', async () => {
    const { wheres } = await textSearchWith({ ...TEXT_INPUT, requireSlug: false });

    expect(wheres).toEqual([
      `("gyms"."is_public" = $1 and "gyms"."deleted_at" is null)`,
      `("gyms"."is_public" = $1 and "gyms"."deleted_at" is null)`,
    ]);
  });

  it('orders the text rows by created_at then gyms.id, so OFFSET paging is stable across ties', async () => {
    const { orderBys } = await textSearchWith(TEXT_INPUT);

    expect(orderBys).toEqual([`"gyms"."created_at" desc, "gyms"."id"`]);
  });
});

describe('slugPresentFilter', () => {
  it('is the single source of the predicate both paths interpolate', () => {
    // Rendering the exported helper against each path's slug expression
    // reproduces exactly what the two path assertions above matched, which is
    // what makes "both paths use the same SQL" a fact rather than a convention.
    const rawPathPredicate = slugPresentFilter(true, sql`gyms.slug`);
    const drizzlePathPredicate = slugPresentFilter(true, sql`${dbSchema.gyms.slug}`);

    expect(dialect.sqlToQuery(rawPathPredicate as SQL).sql).toBe(SLUG_PREDICATE);
    expect(dialect.sqlToQuery(drizzlePathPredicate as SQL).sql).toBe(
      `"gyms"."slug" IS NOT NULL AND "gyms"."slug" <> ''`,
    );
  });

  it('returns null — no clause at all — when the flag is absent or false', () => {
    expect(slugPresentFilter(undefined, sql`gyms.slug`)).toBeNull();
    expect(slugPresentFilter(false, sql`gyms.slug`)).toBeNull();
  });
});
