import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const queueMocks = vi.hoisted(() => ({
  queueClimbStatsRecompute: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => queueMocks);
vi.mock('../utils/logger', () => loggerMocks);

import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { UpdateTickInputSchema } from '../validation/schemas/ticks';
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
  loggerMocks.logger.warn.mockClear();
});

async function cleanupTickValidationRows() {
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
      'kilter',
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

  it('rejects a negative angle', () => {
    expect(() =>
      UpdateTickInputSchema.parse({
        angle: -5,
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
  });
});
