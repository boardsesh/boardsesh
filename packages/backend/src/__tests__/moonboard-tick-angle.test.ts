import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { setupWorkerDatabase } from './worker-db';

// Read persisted angles from Postgres and observe recompute keys; unrelated
// event delivery stays mocked so this suite focuses on the saved ascent.
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
const MOON_GRADED_40 = `${PREFIX}MOON-40`; // catalog climb graded at 40 only
const MOON_PHANTOM_25 = `${PREFIX}MOON-PHANTOM`; // graded 40, only tick counts at 25
const MOON_BOTH_ANGLES = `${PREFIX}MOON-BOTH`; // graded 40, REAL catalog data at 25 too (post-#3849)
const MOON_NULL_ANGLE = `${PREFIX}MOON-NULLANGLE`; // angle-agnostic climb row (post-#3851)
const MOON_UNKNOWN = `${PREFIX}MOON-NOT-IN-CATALOG`; // never inserted into board_climbs
const MOON_USER_CREATED = `${PREFIX}MOON-USERSET`; // a climber's own problem, re-angled to 40
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

async function insertFaOnlyStatsRow(uuid: string, angle: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, ascensionist_count, upstream_ascensionist_count,
       boardsesh_ascensionist_count, fa_username, quality_normalized)
    VALUES ('moonboard', ${uuid}, ${angle}, 0, 0, 0, 'setter', true)
    ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING
  `);
}

async function insertGradedStatsRow(uuid: string, boardType: string, angle: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, ascensionist_count, upstream_ascensionist_count,
       boardsesh_ascensionist_count, display_difficulty, upstream_quality_average, quality_normalized)
    VALUES (${boardType}, ${uuid}, ${angle}, 12, 12, 0, 17.5, 3.4, true)
    ON CONFLICT (board_type, climb_uuid, angle) DO NOTHING
  `);
}

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

describe('MoonBoard ticks preserve the requested angle (#5534)', () => {
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
    recomputeClimbStatsNowMock.mockClear();
  });

  afterEach(async () => {
    await db.execute(sql`DELETE FROM board_beta_links WHERE climb_uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
  });
  it('saves a MoonBoard tick at 25 degrees despite a legacy catalog angle of 40', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_GRADED_40, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_GRADED_40)).toEqual([25]);
    expect(queueClimbStatsRecomputeMock).toHaveBeenCalledExactlyOnceWith('moonboard', MOON_GRADED_40, 25);
    expect(recomputeClimbStatsNowMock).toHaveBeenCalledExactlyOnceWith('moonboard', MOON_GRADED_40, 25);
    expect(snapEvents()).toHaveLength(0);
  });
  it('leaves a MoonBoard tick at an angle the climb IS graded at', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_GRADED_40, angle: 40 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_GRADED_40)).toEqual([40]);
    expect(snapEvents()).toHaveLength(0);
  });
  it('preserves the requested angle when its stats row carries only tick counts', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_PHANTOM_25, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_PHANTOM_25)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });
  it('leaves a two-angle MoonBoard climb alone when the requested angle carries catalog data', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_BOTH_ANGLES, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_BOTH_ANGLES)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });
  it('leaves a MoonBoard tick alone at an angle outside the narrow 25/40 set', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_GRADED_40, angle: 35 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_GRADED_40)).toEqual([35]);
    expect(snapEvents()).toHaveLength(0);
  });
  it('leaves a MoonBoard tick alone when the climb row carries no angle (post-#3851 shape)', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_NULL_ANGLE, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_NULL_ANGLE)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });
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
  it('preserves the requested angle with only a catalog benchmark grade there', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_BENCHMARK_ONLY, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_BENCHMARK_ONLY)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });

  it('preserves the requested angle with only a catalog quality rating there', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_QUALITY_ONLY, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_QUALITY_ONLY)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });
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
  it('saves at the requested angle when the climb is not in the catalog at all', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_UNKNOWN, angle: 25 }) },
      authCtx(),
    );

    expect(await storedAngles(MOON_UNKNOWN)).toEqual([25]);
    expect(snapEvents()).toHaveLength(0);
  });
  it('keeps an attached beta video at the requested angle', async () => {
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

    expect(await storedAngles(MOON_GRADED_40)).toEqual([25]);
    expect(await betaLinkAngles(MOON_GRADED_40)).toEqual([25]);
  });
  it('edits 40 to 25 degrees, moves linked beta, and recomputes both angles', async () => {
    const saved = (await tickMutations.saveTick(
      undefined,
      {
        input: tickInput({
          boardType: 'moonboard',
          climbUuid: MOON_GRADED_40,
          angle: 40,
          videoUrl: 'https://www.tiktok.com/@climber/video/7300000000000000002',
        }),
      },
      authCtx(),
    )) as { uuid: string };
    queueClimbStatsRecomputeMock.mockClear();
    recomputeClimbStatsNowMock.mockClear();

    const updated = (await tickMutations.updateTick(
      undefined,
      { uuid: saved.uuid, input: { angle: 25 } },
      authCtx(),
    )) as { angle: number };

    expect(updated.angle).toBe(25);
    expect(await storedAngles(MOON_GRADED_40)).toEqual([25]);
    expect(await betaLinkAngles(MOON_GRADED_40)).toEqual([25]);
    for (const recompute of [queueClimbStatsRecomputeMock, recomputeClimbStatsNowMock]) {
      expect(recompute).toHaveBeenCalledTimes(2);
      expect(recompute).toHaveBeenCalledWith('moonboard', MOON_GRADED_40, 40);
      expect(recompute).toHaveBeenCalledWith('moonboard', MOON_GRADED_40, 25);
    }
    expect(snapEvents()).toHaveLength(0);
  });

  it.each([{ comment: 'crimpy' }, { comment: 'crimpy', angle: 25 }])(
    'preserves 25 degrees on a comment edit: %j',
    async (input) => {
      const saved = (await tickMutations.saveTick(
        undefined,
        { input: tickInput({ boardType: 'moonboard', climbUuid: MOON_GRADED_40, angle: 25 }) },
        authCtx(),
      )) as { uuid: string };
      queueClimbStatsRecomputeMock.mockClear();
      recomputeClimbStatsNowMock.mockClear();

      const updated = (await tickMutations.updateTick(undefined, { uuid: saved.uuid, input }, authCtx())) as {
        angle: number;
        comment: string;
      };
      expect(updated).toMatchObject({ angle: 25, comment: 'crimpy' });
      expect(await storedAngles(MOON_GRADED_40)).toEqual([25]);
      expect(queueClimbStatsRecomputeMock).toHaveBeenCalledExactlyOnceWith('moonboard', MOON_GRADED_40, 25);
      expect(recomputeClimbStatsNowMock).toHaveBeenCalledExactlyOnceWith('moonboard', MOON_GRADED_40, 25);
      expect(snapEvents()).toHaveLength(0);
    },
  );

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
    await db.execute(sql`
      UPDATE boardsesh_ticks SET angle = 15 WHERE climb_uuid = ${MOON_BOTH_ANGLES} AND user_id = ${USER_ID}
    `);

    await tickMutations.updateTick(undefined, { uuid: existing.uuid, input: { comment: 'crimpy' } }, authCtx());

    expect(await storedAngles(MOON_BOTH_ANGLES)).toEqual([15]);
    expect(snapEvents()).toHaveLength(0);
  });
});
