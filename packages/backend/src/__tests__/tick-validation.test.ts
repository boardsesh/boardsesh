import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const queueMocks = vi.hoisted(() => ({
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async (_boardType: string, _climbUuid: string, _angle: number) => {}),
}));

const loggerMocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const betaMocks = vi.hoisted(() => ({
  invalidateRecentBetaLinksCache: vi.fn(() => Promise.resolve()),
}));

vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => queueMocks);
vi.mock('../utils/logger', () => loggerMocks);
// updateTick busts the recent-beta strip cache when a linked beta's angle moves.
// Stub the cache module so the assertions don't depend on Redis, and provide
// only the export mutations.ts consumes.
vi.mock('../graphql/resolvers/beta-videos/queries', () => betaMocks);

import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { UpdateTickInputSchema, readTimestampFractionalSeconds } from '../validation/schemas/ticks';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';

const TEST_USER_ID = 'tick-validation-test-user';
const TEST_TICK_UUID_PREFIX = 'tick-validation-test-tick';
const TEST_CLIMB_UUID = 'tick-validation-test-climb';

const authenticatedContext: ConnectionContext = {
  connectionId: 'connection-1',
  transport: 'ws',
  isAuthenticated: true,
  userId: TEST_USER_ID,
};
const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

beforeEach(() => {
  queueMocks.queueClimbStatsRecompute.mockClear();
  queueMocks.recomputeClimbStatsNow.mockClear();
  loggerMocks.logger.warn.mockClear();
  betaMocks.invalidateRecentBetaLinksCache.mockClear();
});

async function cleanupTickValidationRows() {
  await db.execute(sql`DELETE FROM board_beta_links WHERE climb_uuid = ${TEST_CLIMB_UUID}`);
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid LIKE ${TEST_TICK_UUID_PREFIX + '%'}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${TEST_USER_ID}`);
}

async function insertTickValidationUser() {
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${TEST_USER_ID}, 'tick-validation@test.boardsesh.com', 'Tick Validation Test User', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertTickValidationTick(params: {
  uuid: string;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  climbedAt?: string;
  boardType?: string;
}) {
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (
      uuid,
      user_id,
      board_type,
      climb_uuid,
      angle,
      status,
      attempt_count,
      quality,
      difficulty,
      is_benchmark,
      comment,
      climbed_at
    )
    VALUES (
      ${params.uuid},
      ${TEST_USER_ID},
      ${params.boardType ?? 'kilter'},
      ${TEST_CLIMB_UUID},
      40,
      ${params.status},
      ${params.attemptCount},
      null,
      null,
      false,
      '',
      ${params.climbedAt ?? '2026-06-01T10:30:00.000Z'}
    )
  `);
}

// A beta video directly linked to a tick (board_beta_links.tick_uuid), carrying
// the tick's angle the way saveTick / attachBetaLink write it.
async function insertTickValidationBetaLink(params: { tickUuid: string; angle: number }) {
  await db.execute(sql`
    INSERT INTO board_beta_links (board_type, climb_uuid, link, angle, tick_uuid, is_listed)
    VALUES ('kilter', ${TEST_CLIMB_UUID}, ${'https://instagram.com/reel/' + params.tickUuid}, ${params.angle}, ${params.tickUuid}, true)
  `);
}

describe('UpdateTickInputSchema', () => {
  it('accepts a one-try send so existing quick-tick rows remain editable', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        status: 'send',
        attemptCount: 1,
        quality: 4,
        difficulty: 22,
        comment: 'Still counts',
      }),
    ).not.toThrow();
  });

  it('still rejects flashes with attempt counts above one', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        status: 'flash',
        attemptCount: 2,
      }),
    ).toThrowError(/Flash requires attemptCount of 1/);
  });

  it('accepts a climbed-at timestamp for date edits', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        climbedAt: '2026-06-01T10:30:00.000Z',
      }),
    ).not.toThrow();
  });

  it('rejects invalid climbed-at timestamps', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        climbedAt: 'not a date',
      }),
    ).toThrowError(/Climbed at must be a valid date/);
  });

  it('rejects future climbed-at timestamps', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        climbedAt: new Date(Date.now() + 120_000).toISOString(),
      }),
    ).toThrowError(/Climbed at cannot be in the future/);
  });

  it('accepts an angle within the valid 0-90 range', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        angle: 25,
      }),
    ).not.toThrow();
  });

  it('accepts -5 for deferred board-aware resolver validation', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        angle: -5,
      }),
    ).not.toThrow();
  });

  it('rejects an angle below the supported negative bound', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        angle: -10,
      }),
    ).toThrow();
  });

  it('rejects an angle above 90', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        angle: 95,
      }),
    ).toThrow();
  });

  it('rejects a non-integer angle', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        angle: 27.5,
      }),
    ).toThrow();
  });
});

describe('readTimestampFractionalSeconds', () => {
  // One pattern feeds both the six-digit precision refine and the resolver's
  // normalizeClimbedAt. A zone shape it fails to read passes the refine
  // vacuously and then gets stored as `.000`, so every form `new Date()`
  // accepts alongside a fraction has to match.
  it.each([
    ['2026-05-02T01:02:03.123456Z', '123456'],
    ['2026-05-02T01:02:03.123456', '123456'],
    ['2026-05-02T01:02:03.123456+07:00', '123456'],
    ['2026-05-02T01:02:03.123456+0700', '123456'],
    ['2026-05-02 01:02:03.123456+07', '123456'],
    ['2026-05-02 01:02:03.123456 +07:00', '123456'],
  ])('reads the fraction out of %s', (value, expected) => {
    expect(Number.isNaN(new Date(value).getTime())).toBe(false);
    expect(readTimestampFractionalSeconds(value)).toBe(expected);
  });

  it('rejects a seven-digit fraction sitting behind an hour-only offset', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        climbedAt: '2026-05-02 01:02:03.1234567+07',
      }),
    ).toThrowError(/at most six fractional-second digits/);
  });
});

describe('tickMutations.saveTick validation', () => {
  it('rejects an invalid climbed-at timestamp before querying or writing the database', async () => {
    const selectSpy = vi.spyOn(db, 'select');
    const transactionSpy = vi.spyOn(db, 'transaction');

    try {
      await expect(
        tickMutations.saveTick(
          null,
          {
            input: {
              boardType: 'kilter',
              climbUuid: TEST_CLIMB_UUID,
              angle: 40,
              isMirror: false,
              status: 'attempt',
              attemptCount: 1,
              isBenchmark: false,
              comment: '',
              climbedAt: 'not a date',
            },
          },
          authenticatedContext,
        ),
      ).rejects.toThrowError(/Climbed at must be a valid date/);
      expect(selectSpy).not.toHaveBeenCalled();
      expect(transactionSpy).not.toHaveBeenCalled();
    } finally {
      selectSpy.mockRestore();
      transactionSpy.mockRestore();
    }
  });
});

describeWithDatabase('tickMutations.updateTick', () => {
  beforeEach(async () => {
    await cleanupTickValidationRows();
    await insertTickValidationUser();
  });

  afterEach(async () => {
    await cleanupTickValidationRows();
  });

  it('coerces attempt count when an existing flash tick is updated without status', async () => {
    const tickUuid = `${TEST_TICK_UUID_PREFIX}-flash`;
    await insertTickValidationTick({ uuid: tickUuid, attemptCount: 1, status: 'flash' });

    const result = await tickMutations.updateTick(
      null,
      {
        uuid: tickUuid,
        input: { attemptCount: 5 },
      },
      authenticatedContext,
    );
    const [storedTick] = await db
      .select()
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, tickUuid));

    expect(result).toMatchObject({
      uuid: tickUuid,
      status: 'flash',
      attemptCount: 1,
    });
    expect(storedTick?.attemptCount).toBe(1);
    expect(loggerMocks.logger.warn).toHaveBeenCalledWith(
      '[updateTick] Coerced flash tick attemptCount to 1',
      expect.objectContaining({
        tickUuid,
        userId: authenticatedContext.userId,
        previousAttemptCount: 5,
      }),
    );
    expect(queueMocks.queueClimbStatsRecompute).toHaveBeenCalledWith('kilter', TEST_CLIMB_UUID, 40);
  });

  it('persists climbed-at edits through the real update query', async () => {
    const tickUuid = `${TEST_TICK_UUID_PREFIX}-climbed-at`;
    const editedClimbedAt = '2026-06-02T12:45:00.000Z';
    await insertTickValidationTick({ uuid: tickUuid, attemptCount: 3, status: 'send' });

    const result = await tickMutations.updateTick(
      null,
      {
        uuid: tickUuid,
        input: { climbedAt: editedClimbedAt },
      },
      authenticatedContext,
    );
    const [storedTick] = await db
      .select()
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, tickUuid));

    expect(result).toMatchObject({
      uuid: tickUuid,
      climbedAt: expect.stringContaining('2026-06-02'),
    });
    expect(storedTick?.climbedAt).toContain('2026-06-02');
    expect(storedTick?.climbedAt).toContain('12:45');
    expect(queueMocks.queueClimbStatsRecompute).toHaveBeenCalledWith('kilter', TEST_CLIMB_UUID, 40);
  });

  it('moving a tick to a new angle recomputes stats at BOTH the old and new angle', async () => {
    const tickUuid = `${TEST_TICK_UUID_PREFIX}-angle-move`;
    await insertTickValidationTick({ uuid: tickUuid, attemptCount: 1, status: 'send' });

    const result = await tickMutations.updateTick(
      null,
      {
        uuid: tickUuid,
        input: { angle: 25 },
      },
      authenticatedContext,
    );
    const [storedTick] = await db
      .select()
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, tickUuid));

    expect(result).toMatchObject({ uuid: tickUuid, angle: 25 });
    expect(storedTick?.angle).toBe(25);

    // The tick started at angle 40 (insertTickValidationTick's fixture angle).
    // A move to 25 must recompute BOTH buckets: the new angle (where the tick
    // now lives) and the old angle (which just lost a tick and would
    // otherwise stay stale forever — board_climb_stats has no self-heal path
    // for a tick that moved away from a key).
    expect(queueMocks.queueClimbStatsRecompute).toHaveBeenCalledTimes(2);
    expect(queueMocks.queueClimbStatsRecompute).toHaveBeenCalledWith('kilter', TEST_CLIMB_UUID, 25);
    expect(queueMocks.queueClimbStatsRecompute).toHaveBeenCalledWith('kilter', TEST_CLIMB_UUID, 40);

    // Both keys also recompute inline, before the mutation returns — the client
    // refetches on success and would otherwise beat the 2s debounce to a stats
    // row that has no grade at the angle the tick just moved to (#4798).
    expect(queueMocks.recomputeClimbStatsNow).toHaveBeenCalledTimes(2);
    expect(queueMocks.recomputeClimbStatsNow).toHaveBeenCalledWith('kilter', TEST_CLIMB_UUID, 25);
    expect(queueMocks.recomputeClimbStatsNow).toHaveBeenCalledWith('kilter', TEST_CLIMB_UUID, 40);
    expect(queueMocks.recomputeClimbStatsNow.mock.invocationCallOrder[0]).toBeLessThan(
      queueMocks.queueClimbStatsRecompute.mock.invocationCallOrder[0],
    );
  });

  it('an update that keeps the same angle recomputes stats only once', async () => {
    const tickUuid = `${TEST_TICK_UUID_PREFIX}-angle-unchanged`;
    await insertTickValidationTick({ uuid: tickUuid, attemptCount: 1, status: 'send' });

    // Fixture angle is 40 — re-supplying the same value must not trigger a
    // second (wasted, no-op) recompute at the "old" angle.
    await tickMutations.updateTick(
      null,
      {
        uuid: tickUuid,
        input: { angle: 40, comment: 'no angle change here' },
      },
      authenticatedContext,
    );

    expect(queueMocks.queueClimbStatsRecompute).toHaveBeenCalledTimes(1);
    expect(queueMocks.queueClimbStatsRecompute).toHaveBeenCalledWith('kilter', TEST_CLIMB_UUID, 40);
    // Same for the inline pass: one key, one recompute.
    expect(queueMocks.recomputeClimbStatsNow).toHaveBeenCalledTimes(1);
    expect(queueMocks.recomputeClimbStatsNow).toHaveBeenCalledWith('kilter', TEST_CLIMB_UUID, 40);
  });

  it('rejects -5 for a stored Kilter tick before updating it', async () => {
    const tickUuid = `${TEST_TICK_UUID_PREFIX}-kilter-negative`;
    await insertTickValidationTick({ uuid: tickUuid, attemptCount: 1, status: 'send' });

    await expect(
      tickMutations.updateTick(null, { uuid: tickUuid, input: { angle: -5 } }, authenticatedContext),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });

    const [storedTick] = await db
      .select({ angle: dbSchema.boardseshTicks.angle })
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, tickUuid));
    expect(storedTick?.angle).toBe(40);
  });

  it('accepts -5 for a stored Grasshopper tick', async () => {
    const tickUuid = `${TEST_TICK_UUID_PREFIX}-grasshopper-negative`;
    await insertTickValidationTick({
      uuid: tickUuid,
      attemptCount: 1,
      status: 'send',
      boardType: 'grasshopper',
    });

    const result = await tickMutations.updateTick(null, { uuid: tickUuid, input: { angle: -5 } }, authenticatedContext);

    expect(result).toMatchObject({ uuid: tickUuid, angle: -5 });
  });

  it('an angle edit follows through to a directly linked beta video', async () => {
    const tickUuid = `${TEST_TICK_UUID_PREFIX}-beta-angle-move`;
    await insertTickValidationTick({ uuid: tickUuid, attemptCount: 1, status: 'send' });
    await insertTickValidationBetaLink({ tickUuid, angle: 40 });

    await tickMutations.updateTick(null, { uuid: tickUuid, input: { angle: 25 } }, authenticatedContext);

    const [betaLink] = await db
      .select({ angle: dbSchema.boardBetaLinks.angle })
      .from(dbSchema.boardBetaLinks)
      .where(eq(dbSchema.boardBetaLinks.tickUuid, tickUuid));

    // The linked beta must move to the tick's new angle, and the home-strip
    // cache must be busted so the correction shows up on the next read.
    expect(betaLink?.angle).toBe(25);
    expect(betaMocks.invalidateRecentBetaLinksCache).toHaveBeenCalledTimes(1);
  });

  it('an angle edit with no linked beta leaves the recent-beta cache alone', async () => {
    const tickUuid = `${TEST_TICK_UUID_PREFIX}-beta-none`;
    await insertTickValidationTick({ uuid: tickUuid, attemptCount: 1, status: 'send' });

    await tickMutations.updateTick(null, { uuid: tickUuid, input: { angle: 25 } }, authenticatedContext);

    // No linked beta row moved, so no cache churn.
    expect(betaMocks.invalidateRecentBetaLinksCache).not.toHaveBeenCalled();
  });

  it('a non-angle edit leaves a linked beta video untouched', async () => {
    const tickUuid = `${TEST_TICK_UUID_PREFIX}-beta-non-angle`;
    await insertTickValidationTick({ uuid: tickUuid, attemptCount: 1, status: 'send' });
    await insertTickValidationBetaLink({ tickUuid, angle: 40 });

    await tickMutations.updateTick(null, { uuid: tickUuid, input: { comment: 'nice send' } }, authenticatedContext);

    const [betaLink] = await db
      .select({ angle: dbSchema.boardBetaLinks.angle })
      .from(dbSchema.boardBetaLinks)
      .where(eq(dbSchema.boardBetaLinks.tickUuid, tickUuid));

    // The comment edit didn't move the angle, so the beta row and cache stay put.
    expect(betaLink?.angle).toBe(40);
    expect(betaMocks.invalidateRecentBetaLinksCache).not.toHaveBeenCalled();
  });
});
