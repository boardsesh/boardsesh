import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createRequire } from 'node:module';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type * as GraphQLModule from 'graphql';
import { betaLinkIdentity, type ConnectionContext } from '@boardsesh/shared-schema';
import { setupWorkerDatabase } from './worker-db';

// The real lookup, with a switch to make the next call fail the way a database
// error would. Everything else in this file runs it untouched.
const { revisionLookupFailure } = vi.hoisted(() => ({ revisionLookupFailure: { next: null as Error | null } }));
vi.mock('../graphql/resolvers/ticks/tick-climb-revision', async (importOriginal) => {
  const original = await importOriginal<typeof import('../graphql/resolvers/ticks/tick-climb-revision')>();
  return {
    ...original,
    resolveTickClimbRevision: async (params: Parameters<typeof original.resolveTickClimbRevision>[0]) => {
      const failure = revisionLookupFailure.next;
      revisionLookupFailure.next = null;
      if (failure) throw failure;
      return original.resolveTickClimbRevision(params);
    },
  };
});

// The beta-link path below goes through the rate limiter.
vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn(), resetAllRateLimits: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

// Side effects saveTick and updateTick fire after the write; none of them are
// under test and they would otherwise pull in Redis / the social event bus.
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async () => undefined),
}));
vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: vi.fn(() => true) }));

import { db } from '../db/client';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { schema } from '../graphql/index';
import { logger } from '../utils/logger';

// `graphql` resolves to two module instances under the test transform. The
// schema was built with the CJS copy, so `execute` has to come from the same
// one. See spray-visibility-sweep.test.ts for the long version.
const requireFromHere = createRequire(import.meta.url);
const { execute, parse } = requireFromHere('graphql') as typeof GraphQLModule;

const USER_ID = 'u-tick-revision';
const BOARD = 'moonboard';

// Prefixed so cleanup can't touch a neighbouring suite's fixtures.
const PREFIX = 'TICKREV-';
/** Never edited: `revision_number` is the column default, 1, and it has no revision rows. */
const UNEDITED = `${PREFIX}UNEDITED`;
/** On revision 3, with a row for each revision. */
const EDITED = `${PREFIX}EDITED`;
/** On revision 4, with revisions 2 and 3 pruned away. */
const PRUNED = `${PREFIX}PRUNED`;
/** Retired, aliased to EDITED. */
const RETIRED_TO_EDITED = `${PREFIX}RETIRED-TO-EDITED`;
/** Retired, aliased to UNEDITED. */
const RETIRED_TO_UNEDITED = `${PREFIX}RETIRED-TO-UNEDITED`;
/** In no table at all. */
const NOT_IN_CATALOG = `${PREFIX}NOT-IN-CATALOG`;

// When each revision of EDITED (and the surviving ones of PRUNED) was made.
const REVISION_1_AT = '2026-06-01T12:00:00.000Z';
const REVISION_2_AT = '2026-07-01T12:00:00.000Z';
const REVISION_3_AT = '2026-08-01T12:00:00.000Z';
const BEFORE_REVISION_1 = '2026-05-15T12:00:00.000Z';
const DURING_REVISION_1 = '2026-06-15T12:00:00.000Z';
const DURING_REVISION_2 = '2026-07-15T12:00:00.000Z';
const DURING_REVISION_3 = '2026-08-15T12:00:00.000Z';

function authCtx(): ConnectionContext {
  return {
    connectionId: `conn-${Math.random().toString(36).slice(2)}`,
    isAuthenticated: true,
    userId: USER_ID,
  } as ConnectionContext;
}

function tickInput(climbUuid: string, overrides: Record<string, unknown> = {}) {
  return {
    boardType: BOARD,
    climbUuid,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    quality: 4,
    difficulty: 17,
    isBenchmark: false,
    comment: '',
    climbedAt: DURING_REVISION_3,
    ...overrides,
  };
}

type SavedTick = { uuid: string; climbUuid: string; climbRevision: number | null };

const saveTick = async (climbUuid: string, overrides: Record<string, unknown> = {}) =>
  (await tickMutations.saveTick(undefined, { input: tickInput(climbUuid, overrides) }, authCtx())) as SavedTick;

async function storedRevision(tickUuid: string): Promise<number | null | undefined> {
  const rows = (await db.execute(sql`
    SELECT climb_revision FROM boardsesh_ticks WHERE uuid = ${tickUuid}
  `)) as unknown as Array<{ climb_revision: number | null }>;
  return [...rows][0]?.climb_revision;
}

/**
 * What `saveTick` stores in `boardsesh_ticks.climb_revision` (#6023), against
 * the real database.
 *
 * The client says which revision it was showing; the server falls back to the
 * revision that was live at `climbedAt`. No value the client can send is allowed
 * to fail the tick, because a rejected send dead-letters in the offline drainer.
 */
describe('saveTick stamps the climb revision', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();

    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${USER_ID}, ${`${USER_ID}@test.com`}, 'Rev Vision', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    for (const uuid of [UNEDITED, EDITED, PRUNED]) {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed)
        VALUES (${uuid}, ${BOARD}, 1, 'setter', 'Test Climb', '', 'p1r1', true)
        ON CONFLICT (uuid) DO NOTHING
      `);
    }
    await db.execute(
      sql`UPDATE board_climbs SET revision_number = 3, holds_revision_number = 2 WHERE uuid = ${EDITED}`,
    );
    await db.execute(
      sql`UPDATE board_climbs SET revision_number = 4, holds_revision_number = 4 WHERE uuid = ${PRUNED}`,
    );
    await db.execute(sql`
      INSERT INTO board_climb_revisions (board_type, climb_uuid, revision_number, name, created_at)
      VALUES
        (${BOARD}, ${EDITED}, 1, 'As published', ${REVISION_1_AT}),
        (${BOARD}, ${EDITED}, 2, 'First edit', ${REVISION_2_AT}),
        (${BOARD}, ${EDITED}, 3, 'Second edit', ${REVISION_3_AT}),
        (${BOARD}, ${PRUNED}, 1, 'As published', ${REVISION_1_AT}),
        (${BOARD}, ${PRUNED}, 4, 'Latest edit', ${REVISION_3_AT})
    `);
    await db.execute(sql`
      INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
      VALUES
        (${BOARD}, ${RETIRED_TO_EDITED}, ${EDITED}, 'moonboard-angle-dedup'),
        (${BOARD}, ${RETIRED_TO_UNEDITED}, ${UNEDITED}, 'moonboard-angle-dedup')
      ON CONFLICT (board_type, alias_uuid) DO NOTHING
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM board_beta_links WHERE climb_uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM board_climb_aliases WHERE alias_uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM board_climb_revisions WHERE climb_uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  });

  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
  });

  const revisionWarnings = () =>
    warnSpy.mock.calls.filter((call: unknown[]) => typeof call[0] === 'string' && call[0].includes('climbRevision'));

  it('stores NULL for a climb the catalogue has no row for', async () => {
    const tick = await saveTick(NOT_IN_CATALOG, { climbRevision: 2 });

    expect(tick.climbRevision).toBeNull();
    expect(await storedRevision(tick.uuid)).toBeNull();
  });

  it('stores 1 for a never-edited climb when the client sends nothing', async () => {
    const tick = await saveTick(UNEDITED);

    expect(tick.climbRevision).toBe(1);
    expect(await storedRevision(tick.uuid)).toBe(1);
  });

  it('stores the revision the client sent when the climb has reached it', async () => {
    // Logged while revision 3 was live, but the phone was showing revision 2:
    // an offline send drained after the setter's next edit. The client wins.
    const older = await saveTick(EDITED, { climbRevision: 2, climbedAt: DURING_REVISION_3 });
    const current = await saveTick(EDITED, { climbRevision: 3 });
    const first = await saveTick(EDITED, { climbRevision: 1 });

    expect([older.climbRevision, current.climbRevision, first.climbRevision]).toEqual([2, 3, 1]);
    expect(await storedRevision(older.uuid)).toBe(2);
    expect(revisionWarnings()).toEqual([]);
  });

  it('stores an in-range revision even when its row has been pruned', async () => {
    // PRUNED is on revision 4 and only rows 1 and 4 are left. Revision 2 was
    // real; there is only nothing left to show for it.
    const tick = await saveTick(PRUNED, { climbRevision: 2 });

    expect(tick.climbRevision).toBe(2);
    expect(await storedRevision(tick.uuid)).toBe(2);
  });

  it('falls back to the revision live at climbedAt, with a warning, when the client is ahead of the climb', async () => {
    const tick = await saveTick(EDITED, { climbRevision: 9, climbedAt: DURING_REVISION_2 });

    expect(tick.climbRevision).toBe(2);
    expect(await storedRevision(tick.uuid)).toBe(2);
    expect(revisionWarnings()).toHaveLength(1);
  });

  it('stores 1, with a warning, when the client is ahead of a never-edited climb', async () => {
    const tick = await saveTick(UNEDITED, { climbRevision: 2 });

    expect(tick.climbRevision).toBe(1);
    expect(revisionWarnings()).toHaveLength(1);
  });

  it.each([
    ['before the climb was published', BEFORE_REVISION_1, 1],
    ['while revision 1 was live', DURING_REVISION_1, 1],
    ['while revision 2 was live', DURING_REVISION_2, 2],
    ['at the instant revision 3 was made', REVISION_3_AT, 3],
    ['while revision 3 was live', DURING_REVISION_3, 3],
  ])('works the revision out from climbedAt when the client sends nothing: %s', async (_label, climbedAt, expected) => {
    const tick = await saveTick(EDITED, { climbedAt });

    expect(tick.climbRevision).toBe(expected);
    expect(await storedRevision(tick.uuid)).toBe(expected);
    expect(revisionWarnings()).toEqual([]);
  });

  it('skips pruned revisions when working it out from climbedAt', async () => {
    // Revision 2 or 3 was live then, but neither row survives. The newest row
    // at or before the tick is revision 1.
    const tick = await saveTick(PRUNED, { climbedAt: DURING_REVISION_2 });

    expect(tick.climbRevision).toBe(1);
  });

  it('ignores the client revision when the uuid was an alias, and uses climbedAt', async () => {
    // The client counted revisions on the retired row. They mean nothing on the
    // canonical one the tick is stored under.
    const tick = await saveTick(RETIRED_TO_EDITED, { climbRevision: 1, climbedAt: DURING_REVISION_2 });

    expect(tick.climbUuid).toBe(EDITED);
    expect(tick.climbRevision).toBe(2);
    expect(await storedRevision(tick.uuid)).toBe(2);
    // Not a client that is ahead, so nothing to warn about.
    expect(revisionWarnings()).toEqual([]);
  });

  it('stores 1 for an alias of a never-edited climb, whatever the client sent', async () => {
    const tick = await saveTick(RETIRED_TO_UNEDITED, { climbRevision: 7 });

    expect(tick.climbUuid).toBe(UNEDITED);
    expect(tick.climbRevision).toBe(1);
  });

  it.each([[0], [-3], [null]])('saves the tick when the client sends %s, and falls back', async (bad) => {
    const tick = await saveTick(EDITED, { climbRevision: bad, climbedAt: DURING_REVISION_2 });

    expect(tick.climbRevision).toBe(2);
    expect(await storedRevision(tick.uuid)).toBe(2);
  });

  it('returns the stored revision on a replay, even after the climb has been edited', async () => {
    const uuid = uuidv4();
    const first = await saveTick(UNEDITED, { uuid });
    expect(first.climbRevision).toBe(1);

    // The setter edits the climb between the first delivery and the replay.
    await db.execute(sql`UPDATE board_climbs SET revision_number = 2 WHERE uuid = ${UNEDITED}`);
    try {
      // The pre-check path: the same uuid, and this time naming the new revision.
      const replay = await saveTick(UNEDITED, { uuid, climbRevision: 2 });

      expect(replay.climbRevision).toBe(1);
      expect(await storedRevision(uuid)).toBe(1);
    } finally {
      await db.execute(sql`UPDATE board_climbs SET revision_number = 1 WHERE uuid = ${UNEDITED}`);
    }
  });

  it('returns the stored revision when two deliveries of one tick race', async () => {
    // Both pass the pre-check; one wins the insert and the other takes the
    // onConflictDoNothing path. Each named a different revision, and both must
    // come back with whichever one was stored.
    const uuid = uuidv4();
    const [left, right] = await Promise.all([
      saveTick(EDITED, { uuid, climbRevision: 2 }),
      saveTick(EDITED, { uuid, climbRevision: 3 }),
    ]);

    const stored = await storedRevision(uuid);
    expect([2, 3]).toContain(stored);
    expect(left.climbRevision).toBe(stored);
    expect(right.climbRevision).toBe(stored);
  });

  it('is left alone by updateTick, and returned from it', async () => {
    const tick = await saveTick(EDITED, { climbRevision: 2, climbedAt: DURING_REVISION_2 });

    // Everything an edit can move, including the date the fallback reads.
    const updated = (await tickMutations.updateTick(
      undefined,
      {
        uuid: tick.uuid,
        input: { status: 'attempt', attemptCount: 3, comment: 'Not yet', climbedAt: DURING_REVISION_3, angle: 25 },
      },
      authCtx(),
    )) as SavedTick;

    expect(updated.climbRevision).toBe(2);
    expect(await storedRevision(tick.uuid)).toBe(2);
  });

  // What the wire can actually deliver, through the executable schema. "No
  // integer fails the tick" is the resolver's promise; a value that is not an
  // `Int` at all is refused by GraphQL before any resolver runs, the same as a
  // malformed `angle` would be.
  describe('through the schema', () => {
    const SAVE_TICK = `mutation Save($input: SaveTickInput!) {
      saveTick(input: $input) { uuid climbRevision }
    }`;
    const send = (input: Record<string, unknown>) =>
      execute({ schema, document: parse(SAVE_TICK), variableValues: { input }, contextValue: authCtx() });
    const tickCount = async () => {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS count FROM boardsesh_ticks WHERE user_id = ${USER_ID}`,
      )) as unknown as Array<{ count: number }>;
      return Number([...rows][0].count);
    };

    it.each([[0], [-1]])('accepts %s and stores the fallback', async (climbRevision) => {
      const result = await send(tickInput(EDITED, { climbRevision, climbedAt: DURING_REVISION_2 }));

      expect(result.errors ?? []).toEqual([]);
      expect((result.data as { saveTick: SavedTick }).saveTick.climbRevision).toBe(2);
      expect(await tickCount()).toBe(1);
    });

    it.each([[2.5], ['2'], [2147483648], [{}]])(
      'refuses %j as a malformed request, before the resolver',
      async (bad) => {
        const result = await send(tickInput(EDITED, { climbRevision: bad }));

        expect(result.errors).toHaveLength(1);
        expect(result.errors?.[0].message).toMatch(/climbRevision/);
        expect(result.data ?? null).toBeNull();
        expect(await tickCount()).toBe(0);
      },
    );
  });

  // A database error in the lookup is not swallowed. The client sees a masked
  // INTERNAL_SERVER_ERROR, which the offline drainer retries, and the replay is
  // idempotent on the tick uuid, so the send lands with a real revision instead
  // of being saved once with NULL for good.
  describe('when the lookup fails', () => {
    it('fails the save, stores nothing, and stamps the replay', async () => {
      const uuid = uuidv4();
      revisionLookupFailure.next = new Error('connection terminated unexpectedly');

      await expect(saveTick(EDITED, { uuid, climbedAt: DURING_REVISION_2 })).rejects.toThrow(
        'connection terminated unexpectedly',
      );
      expect(await storedRevision(uuid)).toBeUndefined();

      const replay = await saveTick(EDITED, { uuid, climbedAt: DURING_REVISION_2 });
      expect(replay.climbRevision).toBe(2);
      expect(await storedRevision(uuid)).toBe(2);
    });

    it('leaves no unhandled rejection when something else fails the save first', async () => {
      // The lookup runs alongside the board and beta-link work and is awaited
      // after it. Here the beta link is refused (the video is already on another
      // climb) before that await is reached, so the lookup's own rejection has
      // nobody waiting for it.
      const videoUrl = 'https://www.tiktok.com/@climber/video/7234567890123456789';
      await db.execute(sql`
        INSERT INTO board_beta_links (board_type, climb_uuid, link, video_identity, is_listed)
        VALUES (${BOARD}, ${UNEDITED}, ${videoUrl}, ${betaLinkIdentity(videoUrl)}, true)
      `);
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const uuid = uuidv4();
        revisionLookupFailure.next = new Error('connection terminated unexpectedly');

        await expect(saveTick(EDITED, { uuid, videoUrl })).rejects.toThrow(/already attached/);
        // The lookup was started and did reject: the switch has been consumed.
        expect(revisionLookupFailure.next).toBeNull();
        // Node reports an unhandled rejection after the microtask queue drains.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));

        expect(unhandled).not.toHaveBeenCalled();
        expect(await storedRevision(uuid)).toBeUndefined();
      } finally {
        process.off('unhandledRejection', unhandled);
        await db.execute(sql`DELETE FROM board_beta_links WHERE climb_uuid = ${UNEDITED}`);
      }
    });
  });
});
