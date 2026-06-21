import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';

// ---------------------------------------------------------------------------
// Mock harness
// ---------------------------------------------------------------------------
// `sessionDetail` drives several differently-shaped Drizzle fluent chains plus
// two raw `dbRead.execute(sql)` calls. Rather than emulate one rigid chain (as
// session-feed-query.test.ts does for the single sessionGroupedFeed query), we
// install a dispatching `dbRead` that branches on the table passed to
// `.from(...)`. Every chain resolves to a row array; the beta-links branch is
// counted so we can assert the per-session batch is a single query (no N+1
// per tick) and that the resolver groups the returned rows back onto each tick
// by the direct beta↔tick link (`tick_uuid`).
//
// Session beta is now scoped to the session's OWN ticks via
// `board_beta_links.tick_uuid IN (<session tick uuids>)` (migration
// 0128_direct_beta_tick_links). The is_listed = true / KayaClimb exclusion are
// SQL predicates evaluated by Postgres, so a pure mock cannot exercise the DB
// filter itself. We therefore (a) assert the resolver builds the tick_uuid +
// is_listed + KayaClimb predicates into the beta-links WHERE clause, and (b)
// have the mock return only the rows the real query would (listed, non-Kaya,
// tick-linked), proving the resolver attributes each clip to exactly its tick
// and never bleeds beta onto another tick on the same climb.

const betaLinkTestState = vi.hoisted(() => {
  // Rows the *real* board_beta_links query would return after Postgres applies
  // `tick_uuid IN (...) AND is_listed = true AND link !~* kayaclimb`. Unlisted,
  // Kaya, and community (non-session-tick) rows are intentionally absent — the
  // DB drops them — so the resolver only ever sees the crew's own tick-linked
  // clips.
  const betaLinkRowsByQuery: Array<Record<string, unknown>[]> = [];

  const executeMock = vi.fn();
  const betaLinkWhereClauses: unknown[] = [];
  const betaLinkSelectCallCount = { value: 0 };
  // Tick rows the big sessionDetail select resolves to. Mutated per-test; the
  // mock reads it live so each case controls its own session shape.
  const state: {
    betaLinkRowsByQuery: Array<Record<string, unknown>[]>;
    executeMock: typeof executeMock;
    betaLinkWhereClauses: unknown[];
    betaLinkSelectCallCount: { value: number };
    tickRows: Record<string, unknown>[];
  } = {
    betaLinkRowsByQuery,
    executeMock,
    betaLinkWhereClauses,
    betaLinkSelectCallCount,
    tickRows: [],
  };
  return state;
});

// Resolve a fluent select chain to a row array. Drizzle's builder is then-able
// (awaiting it runs the query), and also chains .from/.leftJoin/.where/.orderBy
// /.limit. We model that with a thenable proxy that ignores every intermediate
// call and resolves to `rows` when awaited.
function makeChain(rows: Record<string, unknown>[], onWhere?: (clause: unknown) => void) {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain.leftJoin = passthrough;
  chain.innerJoin = passthrough;
  chain.orderBy = passthrough;
  chain.limit = passthrough;
  chain.groupBy = passthrough;
  chain.where = (clause: unknown) => {
    onWhere?.(clause);
    return chain;
  };
  // Make the chain awaitable -> resolves to the row array.
  chain.then = (resolve: (value: Record<string, unknown>[]) => unknown) => resolve(rows);
  return chain;
}

vi.mock('../db/client', () => {
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      if (table === dbSchema.boardBetaLinks) {
        betaLinkTestState.betaLinkSelectCallCount.value += 1;
        const callIndex = betaLinkTestState.betaLinkSelectCallCount.value - 1;
        const rows = betaLinkTestState.betaLinkRowsByQuery[callIndex] ?? [];
        return makeChain(rows, (clause) => betaLinkTestState.betaLinkWhereClauses.push(clause));
      }
      if (table === dbSchema.boardSessions) {
        return makeChain([
          {
            id: 'party-1',
            name: 'Lunch Laps',
            goal: 'Finish the set',
            createdByUserId: 'user-1',
          },
        ]);
      }
      if (table === dbSchema.boardseshTicks) {
        return makeChain(betaLinkTestState.tickRows);
      }
      if (table === dbSchema.voteCounts) {
        // Both the per-tick batch (entityType='tick') and the session-level
        // count resolve through here; an empty array is a valid result for
        // both (no votes recorded).
        return makeChain([]);
      }
      if (table === dbSchema.comments) {
        return makeChain([{ count: 0 }]);
      }
      if (table === dbSchema.sessionHealthKitWorkouts) {
        return makeChain([]);
      }
      return makeChain([]);
    },
  }));

  const fakeDb = {
    select,
    // totalAttempts CTE + fetchParticipants both call dbRead.execute(sql).
    // rowsFromResult requires an array; returning [] keeps both happy.
    execute: betaLinkTestState.executeMock,
  };
  return { db: fakeDb, dbRead: fakeDb };
});

// Serialize a captured WHERE condition to real Postgres text using drizzle's
// own compiler — the same path the resolver uses to emit SQL. Far less brittle
// than hand-walking queryChunks: column names render as their snake_case
// identifiers (e.g. "tick_uuid", "is_listed") and inline `sql` fragments (the
// kayaclimb regex) render verbatim, so we can assert the predicates are present.
const pgDialect = new PgDialect();
function conditionToText(node: unknown): string {
  try {
    return pgDialect.sqlToQuery(node as SQL).sql;
  } catch {
    return '';
  }
}
// Bound parameter values (tick UUIDs render as params, not inline SQL), so the
// tick-scoping assertion checks params rather than the SQL text.
function conditionToParams(node: unknown): unknown[] {
  try {
    return pgDialect.sqlToQuery(node as SQL).params;
  } catch {
    return [];
  }
}

const { sessionDetail } = await import('../graphql/resolvers/social/session-feed').then(
  (module) => module.sessionFeedQueries,
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeTickRow(overrides: {
  uuid: string;
  climbUuid: string;
  climbName: string;
  /** Alias-resolved canonical UUID; defaults to climbUuid (no alias). */
  canonicalClimbUuid?: string;
  boardType?: string;
  angle?: number;
  status?: string;
}) {
  const boardType = overrides.boardType ?? 'kilter';
  const angle = overrides.angle ?? 40;
  return {
    tick: {
      uuid: overrides.uuid,
      userId: 'user-1',
      climbUuid: overrides.climbUuid,
      boardType,
      angle,
      status: overrides.status ?? 'send',
      attemptCount: 1,
      difficulty: 10,
      quality: 3,
      isMirror: false,
      isBenchmark: false,
      comment: null,
      climbedAt: '2024-01-15T10:00:00.000Z',
    },
    climbName: overrides.climbName,
    climbDescription: '',
    setterUsername: 'setter',
    layoutId: 1,
    frames: 'p1r1',
    difficultyName: 'V10',
    consensusDifficulty: 10,
    canonicalClimbUuid: overrides.canonicalClimbUuid ?? overrides.climbUuid,
  };
}

// A board_beta_links row as it would arrive AFTER Postgres applied the
// tick_uuid / is_listed / KayaClimb predicates. `betaLinkTickUuid` carries the
// direct beta↔tick link the resolver groups on; `boardId` rides along.
function makeBetaRow(overrides: {
  tickUuid: string;
  climbUuid: string;
  link: string;
  foreignUsername?: string | null;
  boardId?: number | null;
}) {
  return {
    climbUuid: overrides.climbUuid,
    link: overrides.link,
    foreignUsername: overrides.foreignUsername ?? 'marco',
    angle: 40,
    thumbnail: null,
    isListed: true,
    createdAt: '2024-01-10T00:00:00.000Z',
    betaLinkTickUuid: overrides.tickUuid,
    boardId: overrides.boardId ?? 7,
  };
}

const LISTED_INSTAGRAM_LINK = 'https://www.instagram.com/p/LISTED/';
const LISTED_TIKTOK_LINK = 'https://www.tiktok.com/@climber/video/123';

describe('sessionDetail per-tick betaLinks (tick-scoped to the crew)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    betaLinkTestState.betaLinkRowsByQuery.length = 0;
    betaLinkTestState.betaLinkWhereClauses.length = 0;
    betaLinkTestState.betaLinkSelectCallCount.value = 0;
    // execute() backs the totalAttempts CTE and fetchParticipants; both go
    // through rowsFromResult, which requires an array.
    betaLinkTestState.executeMock.mockResolvedValue([]);
  });

  it('attaches the beta linked to a tick onto exactly that tick', async () => {
    betaLinkTestState.tickRows = [makeTickRow({ uuid: 'tick-1', climbUuid: 'climb-a', climbName: 'Crimpathon' })];
    betaLinkTestState.betaLinkRowsByQuery.push([
      makeBetaRow({ tickUuid: 'tick-1', climbUuid: 'climb-a', link: LISTED_INSTAGRAM_LINK }),
    ]);

    const result = await sessionDetail(undefined, { sessionId: 'party-1' });

    expect(result).not.toBeNull();
    expect(result?.ticks).toHaveLength(1);
    for (const tick of result?.ticks ?? []) {
      expect(Array.isArray(tick.betaLinks)).toBe(true);
    }
    // The mapped clip carries the direct tick link + boardId so the client can
    // attribute it to the participant who logged that tick.
    expect(result?.ticks[0]?.betaLinks).toEqual([
      {
        climbUuid: 'climb-a',
        link: LISTED_INSTAGRAM_LINK,
        foreignUsername: 'marco',
        angle: 40,
        thumbnail: null,
        isListed: true,
        createdAt: '2024-01-10T00:00:00.000Z',
        tickUuid: 'tick-1',
        boardId: 7,
      },
    ]);
  });

  it('does not bleed a clip onto another tick on the same climb', async () => {
    // Two sends of the SAME climb in the session, but beta is attached only to
    // tick-1. The old climb-keyed query showed it on both; tick-scoping must not.
    betaLinkTestState.tickRows = [
      makeTickRow({ uuid: 'tick-1', climbUuid: 'climb-a', climbName: 'Crimpathon' }),
      makeTickRow({ uuid: 'tick-2', climbUuid: 'climb-a', climbName: 'Crimpathon' }),
    ];
    betaLinkTestState.betaLinkRowsByQuery.push([
      makeBetaRow({ tickUuid: 'tick-1', climbUuid: 'climb-a', link: LISTED_INSTAGRAM_LINK }),
    ]);

    const result = await sessionDetail(undefined, { sessionId: 'party-1' });

    const byUuid = new Map((result?.ticks ?? []).map((tick) => [tick.uuid, tick] as const));
    expect(byUuid.get('tick-1')?.betaLinks?.map((link) => link.link)).toEqual([LISTED_INSTAGRAM_LINK]);
    // The other send of the same climb has no clip attached → empty, not the
    // sibling's clip.
    expect(byUuid.get('tick-2')?.betaLinks).toEqual([]);
  });

  it('scopes the query to the session tick uuids with is_listed + KayaClimb gates', async () => {
    betaLinkTestState.tickRows = [
      makeTickRow({ uuid: 'tick-1', climbUuid: 'climb-a', climbName: 'Crimpathon' }),
      makeTickRow({ uuid: 'tick-2', climbUuid: 'climb-b', climbName: 'Slopefest' }),
    ];
    betaLinkTestState.betaLinkRowsByQuery.push([
      makeBetaRow({ tickUuid: 'tick-1', climbUuid: 'climb-a', link: LISTED_INSTAGRAM_LINK }),
    ]);

    const result = await sessionDetail(undefined, { sessionId: 'party-1' });

    const links = result?.ticks.find((tick) => tick.uuid === 'tick-1')?.betaLinks ?? [];
    expect(links.map((betaLink) => betaLink.link)).toEqual([LISTED_INSTAGRAM_LINK]);
    expect(links.every((betaLink) => betaLink.isListed === true)).toBe(true);
    expect(links.some((betaLink) => /kayaclimb\.com/i.test(betaLink.link))).toBe(false);

    // The tick_uuid IN-list + is_listed + KayaClimb-exclusion predicates must
    // actually be in the WHERE the resolver sent to board_beta_links — that's
    // what scopes beta to the crew's own ticks and drops unlisted/Kaya rows.
    const betaWhereText = betaLinkTestState.betaLinkWhereClauses.map(conditionToText).join(' | ');
    expect(betaWhereText).toContain('tick_uuid');
    expect(betaWhereText).toContain('is_listed');
    expect(betaWhereText.toLowerCase()).toContain('kayaclimb');
    // The session's tick uuids are bound as the IN-list params.
    const betaParams = betaLinkTestState.betaLinkWhereClauses.flatMap(conditionToParams);
    expect(betaParams).toContain('tick-1');
    expect(betaParams).toContain('tick-2');
  });

  it('batches all ticks into a single query and groups links by tick (no per-tick N+1)', async () => {
    // Three ticks; two carry their own clip, one carries none.
    betaLinkTestState.tickRows = [
      makeTickRow({ uuid: 'tick-1', climbUuid: 'climb-a', climbName: 'Crimpathon' }),
      makeTickRow({ uuid: 'tick-2', climbUuid: 'climb-b', climbName: 'Slopefest' }),
      makeTickRow({ uuid: 'tick-3', climbUuid: 'climb-c', climbName: 'Roof Project' }),
    ];
    betaLinkTestState.betaLinkRowsByQuery.push([
      makeBetaRow({ tickUuid: 'tick-1', climbUuid: 'climb-a', link: LISTED_INSTAGRAM_LINK, foreignUsername: 'marco' }),
      makeBetaRow({ tickUuid: 'tick-2', climbUuid: 'climb-b', link: LISTED_TIKTOK_LINK, foreignUsername: 'sam' }),
    ]);

    const result = await sessionDetail(undefined, { sessionId: 'party-1' });

    // Exactly one query hit board_beta_links for the whole session — the N+1 guard.
    expect(betaLinkTestState.betaLinkSelectCallCount.value).toBe(1);

    const byUuid = new Map((result?.ticks ?? []).map((tick) => [tick.uuid, tick] as const));
    expect(byUuid.get('tick-1')?.betaLinks?.map((link) => link.link)).toEqual([LISTED_INSTAGRAM_LINK]);
    expect(byUuid.get('tick-2')?.betaLinks?.map((link) => link.link)).toEqual([LISTED_TIKTOK_LINK]);
    // The tick with no attached clip gets an empty array, never undefined.
    expect(byUuid.get('tick-3')?.betaLinks).toEqual([]);
    // A tick's clip never bleeds onto another tick.
    expect(byUuid.get('tick-2')?.betaLinks?.some((link) => link.link === LISTED_INSTAGRAM_LINK)).toBe(false);
  });

  it('returns an empty betaLinks array for ticks with no attached clip', async () => {
    betaLinkTestState.tickRows = [
      makeTickRow({ uuid: 'tick-1', climbUuid: 'climb-a', climbName: 'Crimpathon' }),
      makeTickRow({ uuid: 'tick-2', climbUuid: 'climb-z', climbName: 'No Beta Here' }),
    ];
    betaLinkTestState.betaLinkRowsByQuery.push([
      makeBetaRow({ tickUuid: 'tick-1', climbUuid: 'climb-a', link: LISTED_INSTAGRAM_LINK }),
    ]);

    const result = await sessionDetail(undefined, { sessionId: 'party-1' });

    const byUuid = new Map((result?.ticks ?? []).map((tick) => [tick.uuid, tick] as const));
    expect(byUuid.get('tick-1')?.betaLinks?.map((link) => link.link)).toEqual([LISTED_INSTAGRAM_LINK]);
    expect(byUuid.get('tick-2')?.betaLinks).toEqual([]);
  });
});
