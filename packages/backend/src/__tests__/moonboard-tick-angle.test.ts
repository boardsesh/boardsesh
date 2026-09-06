import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { setupWorkerDatabase } from './worker-db';

// Same mocking stance as save-tick-climb-catalog.test.ts: mock only the post-
// insert side effects (which would otherwise pull in Redis and the social event
// bus) and let the resolver run against the worker database. What is under test
// is the PERSISTED angle, so every assertion reads boardsesh_ticks back.
type CapturedEventOptions = {
  distinctId: string;
  properties?: Record<string, string | number | boolean | null | undefined>;
  processPersonProfile?: boolean;
};
const { captureBackendEventMock, queueClimbStatsRecomputeMock, recomputeClimbStatsNowMock } = vi.hoisted(() => ({
  captureBackendEventMock: vi.fn((_eventName: string, _options: CapturedEventOptions) => true),
  queueClimbStatsRecomputeMock: vi.fn((_boardType: string, _climbUuid: string, _angle: number) => undefined),
  recomputeClimbStatsNowMock: vi.fn(async (_boardType: string, _climbUuid: string, _angle: number) => {}),
}));
vi.mock('../services/analytics/posthog', () => ({
  captureBackendEvent: captureBackendEventMock,
}));
vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: queueClimbStatsRecomputeMock,
  recomputeClimbStatsNow: recomputeClimbStatsNowMock,
}));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));

import { db } from '../db/client';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';

const USER_ID = 'u-moonboard-angle';
const PREFIX = 'MBANG-';

// One climb per shape the resolver has to tell apart.
const MOON_GRADED_40 = `${PREFIX}MOON-40`; // catalog climb graded at 40 only
const MOON_PHANTOM_25 = `${PREFIX}MOON-PHANTOM`; // graded 40, phantom stats row at 25 (the prod shape)
const MOON_BOTH_ANGLES = `${PREFIX}MOON-BOTH`; // graded 40, REAL catalog data at 25 too (post-#3849)
const MOON_NULL_ANGLE = `${PREFIX}MOON-NULLANGLE`; // angle-agnostic climb row (post-#3851)
const MOON_UNKNOWN = `${PREFIX}MOON-NOT-IN-CATALOG`; // never inserted into board_climbs
const MOON_USER_CREATED = `${PREFIX}MOON-USERSET`; // a climber's own problem, re-angled to 40 (the moonboard_wrong_angle_stats_cleanup migration fences this off)
const MOON_BENCHMARK_ONLY = `${PREFIX}MOON-BENCH`; // graded 40; at 25 ONLY benchmark_difficulty is set
const MOON_QUALITY_ONLY = `${PREFIX}MOON-QUAL`; // graded 40; at 25 ONLY upstream_quality_average is set
const KILTER_NULL_ANGLE = `${PREFIX}KILTER-NULLANGLE`;
const KILTER_ANGLED_40 = `${PREFIX}KILTER-40`;

function authCtx(): ConnectionContext {
  return {
    connectionId: `conn-${Math.random().toString(36).slice(2)}`,
    isAuthenticated: true,
    userId: USER_ID,
  } as ConnectionContext;
}

function tickInput(args: { boardType: string; climbUuid: string; angle: number; videoUrl?: string }) {
  return {
    boardType: args.boardType,
    climbUuid: args.climbUuid,
    angle: args.angle,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    quality: 4,
    difficulty: 17,
    isBenchmark: false,
    comment: '',
    climbedAt: new Date().toISOString(),
    ...(args.videoUrl ? { videoUrl: args.videoUrl } : {}),
  };
}

async function storedAngles(climbUuid: string): Promise<number[]> {
  const result = (await db.execute(sql`
    SELECT angle FROM boardsesh_ticks WHERE climb_uuid = ${climbUuid} AND user_id = ${USER_ID} ORDER BY angle
  `)) as unknown as Array<{ angle: number }>;
  const rows = Array.isArray(result) ? result : (result as { rows: Array<{ angle: number }> }).rows;
  return rows.map((row) => Number(row.angle));
}

async function betaLinkAngles(climbUuid: string): Promise<number[]> {
  const result = (await db.execute(sql`
    SELECT angle FROM board_beta_links WHERE climb_uuid = ${climbUuid} ORDER BY angle
  `)) as unknown as Array<{ angle: number }>;
  const rows = Array.isArray(result) ? result : (result as { rows: Array<{ angle: number }> }).rows;
  return rows.map((row) => Number(row.angle));
}

async function insertClimb(
  uuid: string,
  boardType: string,
  angle: number | null,
  ownerUserId: string | null = null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, angle, user_id)
    VALUES (${uuid}, ${boardType}, 1, 'setter', 'Test Climb', '', 'p1r1', true, ${angle}, ${ownerUserId})
    ON CONFLICT (uuid) DO NOTHING
  `);
}

/**
 * A stats row whose ONLY non-NULL catalog column is the one named. Each of the
 * four legs of statsRowCarriesRealCatalogData has to be able to keep a tick in
 * place on its own — insertGradedStatsRow sets three of them at once, so it
 * cannot prove any single leg is load-bearing.
 */
async function insertSingleSignalStatsRow(
  uuid: string,
  angle: number,
  signal: 'benchmark_difficulty' | 'upstream_quality_average',
): Promise<void> {
  const benchmarkDifficulty = signal === 'benchmark_difficulty' ? 17.5 : null;
  const upstreamQualityAverage = signal === 'upstream_quality_average' ? 3.4 : null;
  await db.execute(sql`
    INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, ascensionist_count, upstream_ascensionist_count,
       boardsesh_ascensionist_count, display_difficulty, benchmark_difficulty,
       upstream_quality_average, quality_normalized)
    VALUES ('moonboard', ${uuid}, ${angle}, 0, 0, 0, NULL,
            ${benchmarkDifficulty}, ${upstreamQualityAverage}, true)
    ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING
  `);
}

/**
 * What createClimb actually writes for a user-created climb: a stats row
 * carrying fa_username and nothing else. That row scores FALSE under
 * statsRowCarriesRealCatalogData — which is exactly why the resolver needs its
 * own user_id fence rather than leaning on the catalog-data predicate.
 */
async function insertFaOnlyStatsRow(uuid: string, angle: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, ascensionist_count, upstream_ascensionist_count,
       boardsesh_ascensionist_count, fa_username, quality_normalized)
    VALUES ('moonboard', ${uuid}, ${angle}, 0, 0, 0, 'setter', true)
    ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING
  `);
}

/**
 * A stats row carrying real catalog data — a graded angle of the problem.
 */
async function insertGradedStatsRow(uuid: string, boardType: string, angle: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, ascensionist_count, upstream_ascensionist_count,
       boardsesh_ascensionist_count, display_difficulty, upstream_quality_average, quality_normalized)
    VALUES (${boardType}, ${uuid}, ${angle}, 12, 12, 0, 17.5, 3.4, true)
    ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING
  `);
}

/**
 * The #3529 damage shape: a stats row minted purely by a stranded tick — zero
 * upstream count, every catalog column NULL.
 */
async function insertPhantomStatsRow(uuid: string, boardType: string, angle: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, ascensionist_count, upstream_ascensionist_count,
       boardsesh_ascensionist_count, quality_normalized)
    VALUES (${boardType}, ${uuid}, ${angle}, 1, 0, 1, false)
    ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING
  `);
}

function snapEvents() {
  return captureBackendEventMock.mock.calls.filter((call) => call[0] === 'MoonBoard Tick Angle Snapped');
}

describe('MoonBoard tick angle resolution (#3529)', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();

    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${USER_ID}, ${`${USER_ID}@test.com`}, 'Mona Board', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);

    await insertClimb(MOON_GRADED_40, 'moonboard', 40);
    await insertGradedStatsRow(MOON_GRADED_40, 'moonboard', 40);

    await insertClimb(MOON_PHANTOM_25, 'moonboard', 40);
    await insertGradedStatsRow(MOON_PHANTOM_25, 'moonboard', 40);
    await insertPhantomStatsRow(MOON_PHANTOM_25, 'moonboard', 25);

    await insertClimb(MOON_BOTH_ANGLES, 'moonboard', 40);
    await insertGradedStatsRow(MOON_BOTH_ANGLES, 'moonboard', 40);
    await insertGradedStatsRow(MOON_BOTH_ANGLES, 'moonboard', 25);

    await insertClimb(MOON_NULL_ANGLE, 'moonboard', null);
    await insertGradedStatsRow(MOON_NULL_ANGLE, 'moonboard', 40);

    // A climber's own MoonBoard problem: set at 25, later re-angled to 40.
    // editClimb leaves the old angle's stats row (fa_username only) behind.
    await insertClimb(MOON_USER_CREATED, 'moonboard', 40, USER_ID);
    await insertFaOnlyStatsRow(MOON_USER_CREATED, 40);
    await insertFaOnlyStatsRow(MOON_USER_CREATED, 25);

    await insertClimb(MOON_BENCHMARK_ONLY, 'moonboard', 40);
    await insertGradedStatsRow(MOON_BENCHMARK_ONLY, 'moonboard', 40);
    await insertSingleSignalStatsRow(MOON_BENCHMARK_ONLY, 25, 'benchmark_difficulty');

    await insertClimb(MOON_QUALITY_ONLY, 'moonboard', 40);
    await insertGradedStatsRow(MOON_QUALITY_ONLY, 'moonboard', 40);
    await insertSingleSignalStatsRow(MOON_QUALITY_ONLY, 25, 'upstream_quality_average');

    await insertClimb(KILTER_NULL_ANGLE, 'kilter', null);
    await insertClimb(KILTER_ANGLED_40, 'kilter', 40);
    await insertGradedStatsRow(KILTER_ANGLED_40, 'kilter', 40);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM board_beta_links WHERE climb_uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  });

  beforeEach(() => {
    captureBackendEventMock.mockClear();
    queueClimbStatsRecomputeMock.mockClear();
  });

  afterEach(async () => {
    await db.execute(sql`DELETE FROM board_beta_links WHERE climb_uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
  });

  // 1. The headline behaviour.
  it('snaps a MoonBoard tick to the angle the climb is graded at', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_GRADED_40, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_GRADED_40)).toEqual([40]);
    // The recompute must be queued at the STORED angle, not the requested one —
    // otherwise the count is re-derived into the phantom key all over again.
    expect(queueClimbStatsRecomputeMock).toHaveBeenCalledWith('moonboard', MOON_GRADED_40, 40);
    expect(queueClimbStatsRecomputeMock).not.toHaveBeenCalledWith('moonboard', MOON_GRADED_40, 25);

    const events = snapEvents();
    expect(events).toHaveLength(1);
    expect(events[0][1].distinctId).toBe(USER_ID);
    expect(events[0][1].properties).toMatchObject({
      climbUuid: MOON_GRADED_40,
      requestedAngle: 25,
      effectiveAngle: 40,
    });
  });

  // 2. Control: the snap must not rewrite an angle that was already right.
  it('leaves a MoonBoard tick at an angle the climb IS graded at', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_GRADED_40, angle: 40 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_GRADED_40)).toEqual([40]);
    expect(snapEvents()).toHaveLength(0);
  });

  // 3. The prod shape, and the test that proves the predicate is about CATALOG
  // DATA rather than row existence. Every one of the ~100 affected climbs in
  // prod already HAS a stats row at the wrong angle — that phantom row is the
  // bug — so a bare `EXISTS(stats row at requested angle)` rule would return 25
  // here and the code fix would be inert on exactly the population it exists for.
  it('snaps even when a PHANTOM stats row already sits at the requested angle', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_PHANTOM_25, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_PHANTOM_25)).toEqual([40]);
    expect(snapEvents()).toHaveLength(1);
  });

  // 4. The forward-compat guard for #3849/#3851: once a MoonBoard problem
  // carries REAL catalog data at both 25 and 40, a per-angle tick must pass
  // through untouched. Simplifying the rule to "always snap to
  // board_climbs.angle" turns this red.
  it('leaves a two-angle MoonBoard climb alone when the requested angle carries catalog data', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_BOTH_ANGLES, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_BOTH_ANGLES)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });

  // 4b. #3852 (moonboard-wide-angles): a tick at an angle outside MOONBOARD_ANGLES
  // (25°/40°) can only have come from the wide-angle picker, which only exists
  // behind the feature flag — there's no "stale narrow-UI mismatch" to correct at
  // 35°, so rule (d) must not fire even though the climb is graded at 40 with no
  // stats yet at 35.
  it('leaves a MoonBoard tick alone at an angle outside the narrow 25/40 set', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_GRADED_40, angle: 35 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_GRADED_40)).toEqual([35]);
    expect(snapEvents()).toHaveLength(0);
  });

  // 5. The OTHER forward-compat guard, and the real removal trigger: #3851 sets
  // board_climbs.angle = NULL on the canonical climb, at which point rule (d)
  // must go inert on its own with no code change and no flag.
  it('leaves a MoonBoard tick alone when the climb row carries no angle (post-#3851 shape)', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_NULL_ANGLE, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_NULL_ANGLE)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });

  // 5b. USER-CREATED climbs are fenced off, matching the moonboard_wrong_angle_stats_cleanup migration's
  // `bc.user_id IS NULL` on statements A and B. createClimb writes a non-null
  // board_climbs.angle plus an fa_username-only stats row, and editClimb changes
  // the angle while deliberately leaving the old angle's row behind — so this
  // shape scores FALSE under statsRowCarriesRealCatalogData and would otherwise
  // be snapped. Deleting the `ownerUserId != null` guard from the resolver turns
  // this red.
  it('leaves a tick on a USER-CREATED MoonBoard climb at the angle the climber sent', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_USER_CREATED, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_USER_CREATED)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
    expect(queueClimbStatsRecomputeMock).toHaveBeenCalledWith('moonboard', MOON_USER_CREATED, 25);
  });

  // 5c/5d. Each remaining leg of the catalog-data predicate on its own.
  // insertGradedStatsRow sets upstream count + display_difficulty +
  // upstream_quality_average together, so it can never show that
  // benchmark_difficulty or upstream_quality_average is individually
  // load-bearing. Deleting either leg from real-catalog-data.ts turns the
  // matching test red.
  it('treats a benchmark_difficulty-only stats row as real catalog data', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_BENCHMARK_ONLY, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_BENCHMARK_ONLY)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });

  it('treats an upstream_quality_average-only stats row as real catalog data', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_QUALITY_ONLY, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_QUALITY_ONLY)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });

  // 6. Blast-radius fence. Kilter and Tension grade every angle independently,
  // so their ticks must never be touched — including the case where the climb
  // row happens to carry an angle.
  it('never touches Kilter ticks, with or without an angle on the climb row', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'kilter', climbUuid: KILTER_NULL_ANGLE, angle: 25 }) },
      authCtx(),
    );
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'kilter', climbUuid: KILTER_ANGLED_40, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(KILTER_NULL_ANGLE)).toEqual([25]);
    expect(await storedAngles(KILTER_ANGLED_40)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });

  // 7. A send must never fail on this. The #3528 log-only stance has to survive.
  it('saves at the requested angle when the climb is not in the catalog at all', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_UNKNOWN, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_UNKNOWN)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });

  // 8. The mobile home feed opens a beta video at the beta row's angle, so a
  // beta pinned to 25 on a 40-graded problem opens a page it isn't graded at.
  it('moves the beta-link angle with the snapped tick', async () => {
    await tickMutations.saveTick(
      undefined,
      {
        input: tickInput({
          boardType: 'moonboard',
          climbUuid: MOON_GRADED_40,
          angle: 25,
          videoUrl: 'https://www.tiktok.com/@climber/video/7300000000000000001',
        }),
      },
      authCtx(),
    );

    expect(await storedAngles(MOON_GRADED_40)).toEqual([40]);
    expect(await betaLinkAngles(MOON_GRADED_40)).toEqual([40]);
  });

  // 9. updateTick has the same hole: it wrote validatedInput.angle verbatim.
  it('snaps an updateTick angle edit too, and queues no phantom old-angle recompute', async () => {
    const saved = (await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_GRADED_40, angle: 40 }) },
      authCtx(),
    )) as { uuid: string };
    queueClimbStatsRecomputeMock.mockClear();

    await tickMutations.updateTick(undefined, { uuid: saved.uuid, input: { angle: 25 } }, authCtx());

    expect(await storedAngles(MOON_GRADED_40)).toEqual([40]);
    // The angle never actually moved, so the old-angle second recompute must not
    // fire — one call, at 40.
    expect(queueClimbStatsRecomputeMock).toHaveBeenCalledTimes(1);
    expect(queueClimbStatsRecomputeMock).toHaveBeenCalledWith('moonboard', MOON_GRADED_40, 40);
    // Reported off the RETURNING row, after the UPDATE landed — same stance as
    // saveTick, so one event name means one thing across both mutations.
    const events = snapEvents();
    expect(events).toHaveLength(1);
    expect(events[0][1].properties).toMatchObject({
      climbUuid: MOON_GRADED_40,
      requestedAngle: 25,
      effectiveAngle: 40,
    });
  });

  // 10. An edit that OMITS the angle field must not reach the resolver at all.
  // That is the shape web's logbook edit sends (logbook-feed-item.tsx handleSave
  // has no `angle` key), and on it a historical tick predating the fix stays
  // where the climber put it. Mobile's LogbookEditSheet always sends the tick's
  // current angle, so its comment-only save does NOT take this path — see the
  // note on updateTick's resolve branch.
  it('leaves the angle untouched on an edit that does not mention the angle', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_BOTH_ANGLES, angle: 25 }) },
      authCtx(),
    );
    const existingResult = (await db.execute(sql`
      SELECT uuid FROM boardsesh_ticks WHERE climb_uuid = ${MOON_BOTH_ANGLES} AND user_id = ${USER_ID}
    `)) as unknown as Array<{ uuid: string }>;
    const [existing] = Array.isArray(existingResult)
      ? existingResult
      : (existingResult as { rows: Array<{ uuid: string }> }).rows;
    // Move it to an angle nothing grades, the way a pre-fix tick sits in prod.
    await db.execute(sql`
      UPDATE boardsesh_ticks SET angle = 15 WHERE climb_uuid = ${MOON_BOTH_ANGLES} AND user_id = ${USER_ID}
    `);

    await tickMutations.updateTick(undefined, { uuid: existing.uuid, input: { comment: 'crimpy' } }, authCtx());

    expect(await storedAngles(MOON_BOTH_ANGLES)).toEqual([15]);
    // And nothing is reported: the tick sits at an angle nothing grades, but we
    // did not move it, so the counter must stay silent. The post-UPDATE report
    // compares against `validatedInput.angle`, which this edit never sets.
    expect(snapEvents()).toHaveLength(0);
  });
});
