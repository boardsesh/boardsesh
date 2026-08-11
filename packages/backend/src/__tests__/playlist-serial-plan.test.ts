/**
 * Regression net for the playlist recommendation fan-out and the Postgres DSM
 * guard (#4235, Sentry BOARDSESH-AK).
 *
 * A library-page load fired up to nine concurrent aggregates over
 * `board_climbs` x `board_climb_stats` — the counts CTE, board-target
 * resolution, and one count per recommendation type — none of them guarded. A
 * burst of those parallel hash joins exhausts Postgres's dynamic shared memory
 * on our small /dev/shm and the request fails with pgCode 53100.
 *
 * The fix is two-part and both parts need pinning: every entry point issues
 * `SET LOCAL max_parallel_workers_per_gather = 0` before its first SELECT, and
 * the whole fan-out shares ONE transaction (one connection, one guard) instead
 * of opening one per query. The executor parameter is what threads the handle
 * down, so the "passing an executor opens nothing new" cases matter as much as
 * the guard ones — re-wrapping an open transaction in `withSerialPlan` would
 * open a savepoint.
 *
 * These live in the backend suite because `packages/db` runs on node's test
 * runner and is not wired into CI, same reasoning as serial-plan-guard.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { BoardTarget, SerialPlanDb } from '@boardsesh/db/queries';
import { resolveRecommendationBoardTarget } from '../graphql/resolvers/playlists/helpers/recommendation-board-target';
import {
  selectRecommendationClimbRefs,
  countRecommendationClimbRefs,
} from '../graphql/resolvers/playlists/helpers/recommendation-refs';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

const GUARD_PATTERN = /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i;

const { fakeDb, fakeTx, state } = vi.hoisted(() => {
  const state = {
    /** Rendered SQL of every statement, in order. Assigned a real renderer below. */
    render: (_statement: unknown): string => '',
    executed: [] as string[],
    /** Which handle each execute ran on: 'db' (top-level) or 'tx' (transaction). */
    executeHandles: [] as string[],
    transactions: 0,
    rowsFor: (_renderedSql: string): unknown[] => [],
    selectQueue: [] as unknown[][],
    selectHandles: [] as string[],
  };

  const makeSelectBuilder = (handle: string) => {
    const builder: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy', 'having', 'orderBy', 'limit', 'as']) {
      builder[method] = () => builder;
    }
    // Deliberate: drizzle's query builder is awaitable, so the fake has to be a
    // real thenable for `await tx.select()...` to resolve like a genuine query.
    // oxlint-disable-next-line no-thenable
    builder.then = (
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => {
      state.selectHandles.push(handle);
      return Promise.resolve(state.selectQueue.shift() ?? []).then(onFulfilled, onRejected);
    };
    return builder;
  };

  const makeExecute = (handle: string) => (statement: unknown) => {
    const rendered = state.render(statement);
    state.executed.push(rendered);
    state.executeHandles.push(handle);
    if (GUARD_PATTERN.test(rendered)) return Promise.resolve([]);
    return Promise.resolve(state.rowsFor(rendered));
  };

  const fakeTx = {
    execute: makeExecute('tx'),
    select: () => makeSelectBuilder('tx'),
    selectDistinct: () => makeSelectBuilder('tx'),
  };

  const fakeDb = {
    execute: makeExecute('db'),
    select: () => makeSelectBuilder('db'),
    selectDistinct: () => makeSelectBuilder('db'),
    transaction: (callback: (transactionDb: typeof fakeTx) => unknown) => {
      state.transactions += 1;
      return callback(fakeTx);
    },
  };

  return { fakeDb, fakeTx, state };
});

vi.mock('../db/client', () => ({ db: fakeDb, dbRead: fakeDb }));

const dialect = new PgDialect();
state.render = (statement: unknown) => dialect.sqlToQuery(statement as SQL).sql;

const KILTER_TARGET: BoardTarget = { boardType: 'kilter', layoutId: 8, sizeId: 25, angle: 40, setIds: null };

/** A registered Kilter board, in the row shape resolveRegisteredTarget selects. */
const REGISTERED_BOARD_ROW = { boardType: 'kilter', layoutId: 8, sizeId: 25, setIds: null, angle: 40 };

function guardCount(): number {
  return state.executed.filter((statement) => GUARD_PATTERN.test(statement)).length;
}

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: 'user-123',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

beforeEach(() => {
  state.executed.length = 0;
  state.executeHandles.length = 0;
  state.selectHandles.length = 0;
  state.selectQueue.length = 0;
  state.transactions = 0;
  state.rowsFor = () => [];
});

describe('countRecommendationClimbRefs', () => {
  it('opens one guarded transaction and runs the count inside it', async () => {
    state.rowsFor = () => [{ count: 12 }];

    const count = await countRecommendationClimbRefs('RECOMMENDED_CROWD_FAVORITES', KILTER_TARGET, 'user-123');

    expect(count).toBe(12);
    expect(state.transactions).toBe(1);
    expect(state.executed[0]).toMatch(GUARD_PATTERN);
    expect(state.executed).toHaveLength(2);
    // Nothing ran on the top-level handle: SET LOCAL only covers its own transaction.
    expect(state.executeHandles).toEqual(['tx', 'tx']);
  });

  it('runs on a supplied executor without opening a transaction or re-issuing the guard', async () => {
    state.rowsFor = () => [{ count: 4 }];

    const count = await countRecommendationClimbRefs(
      'RECOMMENDED_CROWD_FAVORITES',
      KILTER_TARGET,
      'user-123',
      fakeTx as unknown as SerialPlanDb,
    );

    expect(count).toBe(4);
    expect(state.transactions).toBe(0);
    expect(guardCount()).toBe(0);
    expect(state.executed).toHaveLength(1);
  });
});

describe('selectRecommendationClimbRefs', () => {
  it('covers the AT_LEVEL grade-band query and the ranked page with one guard', async () => {
    // The newest BOARDSESH-AK event failed inside buildRecommendationRefsSql,
    // reached through this path — the grade band runs first, so both have to
    // sit inside the same guarded transaction.
    state.rowsFor = (renderedSql) =>
      /max_difficulty/.test(renderedSql)
        ? [{ board_type: 'kilter', max_difficulty: 20 }]
        : [{ climb_uuid: 'climb-1', board_type: 'kilter' }];

    const refs = await selectRecommendationClimbRefs('RECOMMENDED_AT_LEVEL', KILTER_TARGET, 'user-123', 0, 20);

    expect(refs).toEqual([{ climbUuid: 'climb-1', boardType: 'kilter' }]);
    expect(state.transactions).toBe(1);
    expect(guardCount()).toBe(1);
    expect(state.executed[0]).toMatch(GUARD_PATTERN);
    expect(state.executed[1]).toMatch(/max_difficulty/);
    expect(state.executeHandles.every((handle) => handle === 'tx')).toBe(true);
  });

  it('runs on a supplied executor without opening a transaction or re-issuing the guard', async () => {
    state.rowsFor = () => [{ climb_uuid: 'climb-1', board_type: 'kilter' }];

    const refs = await selectRecommendationClimbRefs(
      'RECOMMENDED_CROWD_FAVORITES',
      KILTER_TARGET,
      'user-123',
      0,
      20,
      fakeTx as unknown as SerialPlanDb,
    );

    expect(refs).toHaveLength(1);
    expect(state.transactions).toBe(0);
    expect(guardCount()).toBe(0);
  });
});

describe('resolveRecommendationBoardTarget', () => {
  it('guards the inferred-target path and keeps the angle/layout pair in one transaction', async () => {
    // No registered board, so it infers from ticks — the boardsesh_ticks x
    // board_climbs join for the dominant layout is the expensive one here.
    state.rowsFor = (renderedSql) => {
      if (/SELECT board_type FROM boardsesh_ticks/i.test(renderedSql)) return [{ board_type: 'kilter' }];
      if (/SELECT angle FROM boardsesh_ticks/i.test(renderedSql)) return [{ angle: 45 }];
      if (/layout_id/i.test(renderedSql)) return [{ layout_id: 8 }];
      return [];
    };

    const target = await resolveRecommendationBoardTarget('user-123');

    expect(target).toMatchObject({ boardType: 'kilter', layoutId: 8, angle: 45 });
    expect(state.transactions).toBe(1);
    expect(guardCount()).toBe(1);
    expect(state.executed[0]).toMatch(GUARD_PATTERN);
    // Guard + board type + angle + layout, all on the transaction handle.
    expect(state.executed).toHaveLength(4);
    expect(state.executeHandles.every((handle) => handle === 'tx')).toBe(true);
    expect(state.selectHandles).toEqual(['tx']); // the registered-board lookup
  });

  it('runs on a supplied executor without opening a transaction or re-issuing the guard', async () => {
    state.selectQueue.push([REGISTERED_BOARD_ROW]);

    const target = await resolveRecommendationBoardTarget('user-123', undefined, fakeTx as unknown as SerialPlanDb);

    expect(target).toMatchObject({ boardType: 'kilter', sizeId: 25 });
    expect(state.transactions).toBe(0);
    expect(guardCount()).toBe(0);
  });
});

describe('mySmartPlaylistCounts', () => {
  it('runs the counts CTE, board resolution and every recommendation count in one guarded transaction', async () => {
    state.selectQueue.push([REGISTERED_BOARD_ROW]);
    state.rowsFor = (renderedSql) => {
      if (/WITH base/i.test(renderedSql)) return [{ type: 'FIVE_STARS', count: 7 }];
      if (/max_difficulty/.test(renderedSql)) return [{ board_type: 'kilter', max_difficulty: 20 }];
      return [{ count: 3 }];
    };

    const counts = await playlistQueries.mySmartPlaylistCounts(null, undefined, makeCtx());

    expect(counts).toContainEqual({ type: 'FIVE_STARS', count: 7 });
    expect(counts.filter((entry) => entry.type.startsWith('RECOMMENDED_'))).toHaveLength(4);

    // One transaction and one guard for the whole fan-out — the point of the
    // fix. Before it, this was up to nine unguarded concurrent queries.
    expect(state.transactions).toBe(1);
    expect(guardCount()).toBe(1);
    expect(state.executed[0]).toMatch(GUARD_PATTERN);
    expect(state.executed[1]).toMatch(/WITH base/i);
    expect(state.executeHandles.every((handle) => handle === 'tx')).toBe(true);
    expect(state.selectHandles.every((handle) => handle === 'tx')).toBe(true);
  });
});

describe('smartPlaylist on a recommendation type', () => {
  it('resolves the target, the page and the total in one guarded transaction', async () => {
    state.selectQueue.push([REGISTERED_BOARD_ROW]); // registered-board lookup (tx)
    state.selectQueue.push([]); // fetchUserMeta (top-level db, after the tx)
    state.rowsFor = (renderedSql) =>
      /SELECT COUNT\(\*\)/i.test(renderedSql) ? [{ count: 9 }] : [{ climb_uuid: 'climb-1', board_type: 'kilter' }];

    const result = await playlistQueries.smartPlaylist(
      null,
      { input: { type: 'RECOMMENDED_CROWD_FAVORITES', userId: 'user-123', page: 0, pageSize: 20 } },
      makeCtx(),
    );

    expect(result.totalCount).toBe(9);
    expect(state.transactions).toBe(1);
    expect(guardCount()).toBe(1);
    expect(state.executed[0]).toMatch(GUARD_PATTERN);
    // Guard + ranked page + count. fetchUserMeta and the hydrator stay outside
    // the transaction on purpose (PK / IN-list lookups), so the connection is
    // held for the catalog queries only.
    expect(state.executed).toHaveLength(3);
    // Registered-board lookup inside the transaction; fetchUserMeta and the
    // hydrator after it, on the top-level handle.
    expect(state.selectHandles).toEqual(['tx', 'db', 'db']);
  });

  it('still short-circuits for a non-owner without opening a transaction', async () => {
    const result = await playlistQueries.smartPlaylist(
      null,
      { input: { type: 'RECOMMENDED_CROWD_FAVORITES', userId: 'user-123' } },
      makeCtx({ userId: 'someone-else' }),
    );

    expect(result.totalCount).toBe(0);
    expect(state.transactions).toBe(0);
    expect(state.executed).toHaveLength(0);
    expect(state.selectHandles).toHaveLength(0);
  });
});
