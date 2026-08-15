import { afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { standingsQueries } from '../graphql/resolvers/social/standings';

/**
 * Standings ranking semantics.
 *
 * These pin down the three properties the design rests on — distinct-climb
 * scoring, the per-day cap, and shared ranks — plus consent and the fallback
 * ladder. Each is a decision that would be easy to "simplify" back into a bug.
 */

const OWNER_ID = 'standings-owner';
const ALICE = 'standings-alice';
const BOB = 'standings-bob';
const CARA = 'standings-cara';
const BOT = 'standings-bot';

const ALL_USERS = [OWNER_ID, ALICE, BOB, CARA, BOT];

const BOARD_TYPE = 'kilter';
const LAYOUT_ID = 1;

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

function ctxFor(userId: string | null): ConnectionContext {
  return {
    connectionId: `standings-conn-${userId ?? 'anon'}`,
    transport: 'ws',
    isAuthenticated: userId != null,
    userId: userId ?? undefined,
  };
}

let boardId = 0;
let boardUuid = '';
let virtualBoardUuid = '';
let gymUuid = '';
let climbSequence = 0;

/** A distinct climb on the ranked layout. Returns its uuid. */
async function makeClimb(): Promise<string> {
  const uuid = `standings-climb-${climbSequence++}`;
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft)
    VALUES (${uuid}, ${BOARD_TYPE}, ${LAYOUT_ID}, 'Test Climb', true, false)
    ON CONFLICT (uuid) DO NOTHING
  `);
  return uuid;
}

let tickSequence = 0;

async function logSend(params: {
  userId: string;
  climbUuid: string;
  boardId?: number | null;
  daysAgo?: number;
  origin?: string;
  status?: 'flash' | 'send' | 'attempt';
}) {
  const daysAgo = params.daysAgo ?? 1;
  await db.execute(sql`
    INSERT INTO boardsesh_ticks
      (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count,
       difficulty, is_benchmark, comment, climbed_at, created_at, updated_at, board_id, origin)
    VALUES
      (${`standings-tick-${tickSequence++}`}, ${params.userId}, ${BOARD_TYPE}, ${params.climbUuid}, 40, false,
       ${params.status ?? 'send'}, 1, 17, false, '',
       NOW() - make_interval(days => ${daysAgo}::int), NOW(), NOW(),
       ${params.boardId ?? null}, ${params.origin ?? 'native'})
  `);
}

beforeAll(async () => {
  for (const id of ALL_USERS) {
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${id}, ${`${id}@standings.test`}, ${id}, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `);
  }
  await db.execute(sql`UPDATE users SET is_internal = true WHERE id = ${BOT}`);

  const [gym] = (await db.execute(sql`
    INSERT INTO gyms (uuid, name, owner_id) VALUES ('standings-gym-uuid', 'Standings Gym', ${OWNER_ID})
    ON CONFLICT (uuid) DO UPDATE SET name = EXCLUDED.name
    RETURNING id, uuid
  `)) as unknown as { id: number; uuid: string }[];
  gymUuid = gym.uuid;

  const [board] = (await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public)
    VALUES ('standings-board-uuid', 'standings-board', ${OWNER_ID}, ${BOARD_TYPE}, ${LAYOUT_ID}, 10, '1,2',
            'Standings Wall', ${gym.id}, true)
    ON CONFLICT (uuid) DO UPDATE SET name = EXCLUDED.name
    RETURNING id, uuid
  `)) as unknown as { id: number; uuid: string }[];
  boardId = Number(board.id);
  boardUuid = board.uuid;

  const [virtualBoard] = (await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, is_virtual)
    VALUES ('standings-virtual-uuid', 'standings-virtual', ${OWNER_ID}, ${BOARD_TYPE}, ${LAYOUT_ID}, 10, '1,2',
            'Kilter Board Shared Feed', true, true)
    ON CONFLICT (uuid) DO UPDATE SET is_virtual = true
    RETURNING uuid
  `)) as unknown as { uuid: string }[];
  virtualBoardUuid = virtualBoard.uuid;
});

afterEach(async () => {
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid LIKE 'standings-tick-%'`);
  await db.execute(sql`
    UPDATE user_profiles SET leaderboard_visibility = 'public'
    WHERE user_id = ANY(${sql.raw(`ARRAY[${ALL_USERS.map((id) => `'${id}'`).join(',')}]`)})
  `);
});

describeWithDatabase('standings', () => {
  it('scores DISTINCT climbs, so re-logging one climb does not climb the ranking', async () => {
    const first = await makeClimb();
    const second = await makeClimb();
    // Alice: 3 ticks but only 2 distinct climbs. Bob: 2 distinct climbs too.
    await logSend({ userId: ALICE, climbUuid: first });
    await logSend({ userId: ALICE, climbUuid: first });
    await logSend({ userId: ALICE, climbUuid: second });
    await logSend({ userId: BOB, climbUuid: first });
    await logSend({ userId: BOB, climbUuid: second });

    const result = await standingsQueries.standings(undefined, { input: { scope: { kind: 'global' } } }, ctxFor(ALICE));

    const alice = result.entries.find((entry) => entry.isViewer);
    expect(alice?.score).toBe(2);
    // Same score means the same rank — Alice's extra row buys her nothing.
    expect(result.entries.map((entry) => entry.rank)).toEqual([1, 1]);
  });

  it('caps a single day at the 99th-percentile climb count', async () => {
    // 35 distinct climbs, all on the same day. Only 30 score.
    const climbs = await Promise.all(Array.from({ length: 35 }, () => makeClimb()));
    for (const climbUuid of climbs) {
      await logSend({ userId: ALICE, climbUuid, daysAgo: 2 });
    }

    const result = await standingsQueries.standings(undefined, { input: { scope: { kind: 'global' } } }, ctxFor(ALICE));
    expect(result.entries[0].score).toBe(30);
  });

  it('does not cap across separate days', async () => {
    const climbs = await Promise.all(Array.from({ length: 4 }, () => makeClimb()));
    await logSend({ userId: ALICE, climbUuid: climbs[0], daysAgo: 2 });
    await logSend({ userId: ALICE, climbUuid: climbs[1], daysAgo: 2 });
    await logSend({ userId: ALICE, climbUuid: climbs[2], daysAgo: 5 });
    await logSend({ userId: ALICE, climbUuid: climbs[3], daysAgo: 5 });

    const result = await standingsQueries.standings(undefined, { input: { scope: { kind: 'global' } } }, ctxFor(ALICE));
    expect(result.entries[0].score).toBe(4);
  });

  it('gives tied climbers the same rank and reports the tie size', async () => {
    const climb = await makeClimb();
    await logSend({ userId: ALICE, climbUuid: climb });
    await logSend({ userId: BOB, climbUuid: climb });
    await logSend({ userId: CARA, climbUuid: climb });

    const result = await standingsQueries.standings(undefined, { input: { scope: { kind: 'global' } } }, ctxFor(ALICE));
    expect(result.entries.map((entry) => entry.rank)).toEqual([1, 1, 1]);
    expect(result.entries.map((entry) => entry.tieSize)).toEqual([3, 3, 3]);
    expect(result.viewer?.tieSize).toBe(3);
  });

  it('excludes the frozen bulk import, internal accounts and attempts', async () => {
    const climb = await makeClimb();
    await logSend({ userId: ALICE, climbUuid: climb });
    await logSend({ userId: BOB, climbUuid: climb, origin: 'json_import' });
    await logSend({ userId: BOT, climbUuid: climb });
    await logSend({ userId: CARA, climbUuid: climb, status: 'attempt' });

    const result = await standingsQueries.standings(undefined, { input: { scope: { kind: 'global' } } }, ctxFor(ALICE));
    expect(result.entries.map((entry) => entry.userId)).toEqual([ALICE]);
    expect(result.totalCount).toBe(1);
  });

  it('drops an opted-out climber from the entries and the denominator', async () => {
    const climb = await makeClimb();
    await logSend({ userId: ALICE, climbUuid: climb });
    await logSend({ userId: BOB, climbUuid: climb });
    await db.execute(sql`
      INSERT INTO user_profiles (user_id, leaderboard_visibility) VALUES (${BOB}, 'off')
      ON CONFLICT (user_id) DO UPDATE SET leaderboard_visibility = 'off'
    `);

    const result = await standingsQueries.standings(undefined, { input: { scope: { kind: 'global' } } }, ctxFor(ALICE));
    expect(result.entries.map((entry) => entry.userId)).toEqual([ALICE]);
    // Filtered inside the ranking, not stripped from the page — otherwise the
    // UI promises a row it can never show.
    expect(result.totalCount).toBe(1);
  });

  it('keeps an anonymous climber ranked but strips their identity from OTHER viewers', async () => {
    const climb = await makeClimb();
    await logSend({ userId: BOB, climbUuid: climb });
    await db.execute(sql`
      INSERT INTO user_profiles (user_id, display_name, leaderboard_visibility)
      VALUES (${BOB}, 'Bob Bobson', 'anonymous')
      ON CONFLICT (user_id) DO UPDATE SET display_name = 'Bob Bobson', leaderboard_visibility = 'anonymous'
    `);

    const seenByAlice = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'global' } } },
      ctxFor(ALICE),
    );
    const [row] = seenByAlice.entries;
    expect(row.isAnonymous).toBe(true);
    expect(row.displayName).toBeNull();
    expect(row.userId).not.toBe(BOB);
    expect(row.userId.startsWith('anon:')).toBe(true);
    expect(seenByAlice.totalCount).toBe(1);

    // Bob still sees himself — he knows who he is, and his row has to be
    // identifiable for the surface to pin it.
    const seenByBob = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'global' } } },
      ctxFor(BOB),
    );
    expect(seenByBob.entries[0].userId).toBe(BOB);
    expect(seenByBob.entries[0].isViewer).toBe(true);
    expect(seenByBob.entries[0].displayName).toBe('Bob Bobson');
  });

  it('ranks a physical board and ignores ticks with no wall attached', async () => {
    const climb = await makeClimb();
    await logSend({ userId: ALICE, climbUuid: climb, boardId });
    await logSend({ userId: BOB, climbUuid: climb, boardId: null });

    const result = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'board', key: boardUuid } } },
      ctxFor(ALICE),
    );
    expect(result.resolvedScope.kind).toBe('board');
    expect(result.entries.map((entry) => entry.userId)).toEqual([ALICE]);
    expect(result.resolvedScope.label).toBe('Standings Wall');
  });

  it('refuses to rank a Shared Feed pseudo-board and demotes instead', async () => {
    const climb = await makeClimb();
    await logSend({ userId: ALICE, climbUuid: climb });

    const result = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'board', key: virtualBoardUuid } } },
      ctxFor(ALICE),
    );
    // Not a wall — 39 of these absorb ~7,780 ticks and would top every real board.
    expect(result.resolvedScope.kind).toBe('global');
    expect(result.demotionReason).toBe('unknownScope');
  });

  it('reports the measured attribution coverage of the scope actually ranked', async () => {
    const climb = await makeClimb();
    await logSend({ userId: ALICE, climbUuid: climb, boardId });

    // The surface uses this to decide whether to explain a low number ("sends
    // synced from the Kilter app don't carry a wall"). A hardcoded 1 would make
    // it silently under-report instead.
    const gym = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'gym', key: gymUuid } } },
      ctxFor(ALICE),
    );
    expect(gym.coverage).toBeLessThan(0.5);

    const global = await standingsQueries.standings(undefined, { input: { scope: { kind: 'global' } } }, ctxFor(ALICE));
    expect(global.coverage).toBe(1);

    // And it describes the RESOLVED scope: a demoted request reports the
    // coverage of the board it actually shows, not the one that was asked for.
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid LIKE 'standings-tick-%'`);
    await logSend({ userId: ALICE, climbUuid: climb, boardId: null });
    const demoted = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'gym', key: gymUuid } } },
      ctxFor(ALICE),
    );
    expect(demoted.resolvedScope.kind).toBe('global');
    expect(demoted.coverage).toBe(1);
  });

  it('ranks a gym through its walls', async () => {
    const climb = await makeClimb();
    await logSend({ userId: ALICE, climbUuid: climb, boardId });

    const result = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'gym', key: gymUuid } } },
      ctxFor(ALICE),
    );
    expect(result.resolvedScope.kind).toBe('gym');
    expect(result.resolvedScope.label).toBe('Standings Gym');
    expect(result.entries.map((entry) => entry.userId)).toEqual([ALICE]);
  });

  it('does NOT demote when a later page is empty, only when the first one is', async () => {
    const climb = await makeClimb();
    await logSend({ userId: ALICE, climbUuid: climb, boardId });

    // Page past the end of a wall that genuinely has climbers on it. totalCount
    // is read off the returned rows, so an empty tail reports zero — without the
    // first-page guard this would silently swap the reader onto the global
    // board, which is far worse than the empty tail they asked for.
    const tail = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'board', key: boardUuid }, offset: 50 } },
      ctxFor(ALICE),
    );
    expect(tail.resolvedScope.kind).toBe('board');
    expect(tail.demotionReason).toBeNull();
    expect(tail.entries).toEqual([]);
    expect(tail.hasMore).toBe(false);
  });

  it('ranks a layout without needing any board attribution', async () => {
    const climb = await makeClimb();
    // No board_id at all — the layout tier resolves through board_climbs, which
    // is why it has essentially no attribution gap.
    await logSend({ userId: ALICE, climbUuid: climb, boardId: null });

    const result = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'layout', key: `${BOARD_TYPE}:${LAYOUT_ID}` } } },
      ctxFor(ALICE),
    );
    expect(result.resolvedScope.kind).toBe('layout');
    expect(result.entries.map((entry) => entry.userId)).toEqual([ALICE]);
  });

  it('demotes an empty scope to global rather than rendering nothing', async () => {
    const climb = await makeClimb();
    // Activity exists globally, but nothing on this wall.
    await logSend({ userId: ALICE, climbUuid: climb, boardId: null });

    const result = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'board', key: boardUuid } } },
      ctxFor(ALICE),
    );
    expect(result.requestedScope.kind).toBe('board');
    expect(result.resolvedScope.kind).toBe('global');
    expect(result.demotionReason).toBe('empty');
    // And the demotion is useful, not just non-empty.
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('reports the viewer rank and the distinct scores above, without naming anyone', async () => {
    const climbs = await Promise.all(Array.from({ length: 4 }, () => makeClimb()));
    // Bob 3, Cara 2, Alice 1.
    await logSend({ userId: BOB, climbUuid: climbs[0] });
    await logSend({ userId: BOB, climbUuid: climbs[1] });
    await logSend({ userId: BOB, climbUuid: climbs[2] });
    await logSend({ userId: CARA, climbUuid: climbs[0] });
    await logSend({ userId: CARA, climbUuid: climbs[1] });
    await logSend({ userId: ALICE, climbUuid: climbs[0] });

    const result = await standingsQueries.standings(undefined, { input: { scope: { kind: 'global' } } }, ctxFor(ALICE));
    expect(result.viewer).not.toBeNull();
    expect(result.viewer?.score).toBe(1);
    expect(result.viewer?.rank).toBe(3);
    // Distinct scores only: the UI turns the nearest one into "one more and
    // you're 2nd" without ever printing Cara's name.
    expect(result.viewer?.scoresAbove).toEqual([2, 3]);
  });

  it('returns no viewer block for a signed-out reader, who can still read the list', async () => {
    const climb = await makeClimb();
    await logSend({ userId: ALICE, climbUuid: climb });

    const result = await standingsQueries.standings(undefined, { input: { scope: { kind: 'global' } } }, ctxFor(null));
    expect(result.viewer).toBeNull();
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].isViewer).toBe(false);
  });

  it('excludes ticks outside the rolling window, and the week window is tighter than the month', async () => {
    const recent = await makeClimb();
    const older = await makeClimb();
    await logSend({ userId: ALICE, climbUuid: recent, daysAgo: 2 });
    await logSend({ userId: ALICE, climbUuid: older, daysAgo: 20 });

    const month = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'global' }, window: 'month' } },
      ctxFor(ALICE),
    );
    expect(month.entries[0].score).toBe(2);

    const week = await standingsQueries.standings(
      undefined,
      { input: { scope: { kind: 'global' }, window: 'week' } },
      ctxFor(ALICE),
    );
    expect(week.entries[0].score).toBe(1);
  });

  it('rejects a scope kind that requires a key without one', async () => {
    await expect(
      standingsQueries.standings(undefined, { input: { scope: { kind: 'board' } } }, ctxFor(ALICE)),
    ).rejects.toThrow();
  });
});
