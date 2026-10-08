import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';

// Typed structurally: vi.hoisted runs before imports, so the real option type
// isn't reachable here.
type CapturedEventOptions = {
  properties?: Record<string, string | number | boolean | null | undefined>;
  systemDistinctId?: string;
  timestamp?: Date;
  uuid?: string;
};
const { captureBackendEventMock } = vi.hoisted(() => ({
  captureBackendEventMock: vi.fn((_eventName: string, _options: CapturedEventOptions) => true),
}));
vi.mock('../services/analytics/posthog', () => ({
  captureBackendEvent: captureBackendEventMock,
}));

import { db } from '../db/client';
import {
  purgeExpiredUserActivity,
  retentionCutoffDay,
  snapshotActiveUsers,
} from '../services/active-users-snapshot';
import { activeUsersMutations } from '../graphql/resolvers/users/active-users';

/**
 * The daily first-party active-user snapshot and the 13-month retention sweep
 * (#2644), against the worker database.
 */

// The job runs just after midnight, so it reports the day before.
const RUN_AT = new Date('2026-10-09T00:20:00.000Z');
const SNAPSHOT_DAY = '2026-10-08';

async function createUser(): Promise<string> {
  const userId = randomUUID();
  await db.insert(dbSchema.users).values({ id: userId, email: `${userId}@example.invalid` });
  return userId;
}

async function seedActivity(rows: Array<{ userId: string; day: string; platform: string }>): Promise<void> {
  await db.insert(dbSchema.userActivityDays).values(rows);
}

function cronCtx(): ConnectionContext {
  return {
    connectionId: `http-cron-${randomUUID()}`,
    transport: 'http',
    isAuthenticated: false,
    isCronAuthenticated: true,
  } as ConnectionContext;
}

beforeEach(async () => {
  captureBackendEventMock.mockClear();
  // The counts are table-wide, so every test starts from an empty table.
  await db.delete(dbSchema.userActivityDays);
});

describe('snapshotActiveUsers', () => {
  it('counts distinct climbers per window and per platform', async () => {
    const [bothPlatforms, weekOnly, monthOnly, tooOld, today] = await Promise.all([
      createUser(),
      createUser(),
      createUser(),
      createUser(),
      createUser(),
    ]);
    await seedActivity([
      // Active yesterday on two platforms: one daily user overall, one per platform.
      { userId: bothPlatforms, day: SNAPSHOT_DAY, platform: 'web' },
      { userId: bothPlatforms, day: SNAPSHOT_DAY, platform: 'ios' },
      // Seen again earlier in the month: still one monthly user.
      { userId: bothPlatforms, day: '2026-10-01', platform: 'web' },
      // First day of the 7-day window.
      { userId: weekOnly, day: '2026-10-02', platform: 'android' },
      // First day of the 30-day window.
      { userId: monthOnly, day: '2026-09-09', platform: 'web' },
      // One day before the 30-day window.
      { userId: tooOld, day: '2026-09-08', platform: 'web' },
      // Today has not finished; the snapshot is about yesterday.
      { userId: today, day: '2026-10-09', platform: 'ios' },
    ]);

    const result = await snapshotActiveUsers({ now: RUN_AT });

    expect(result).toMatchObject({
      day: SNAPSHOT_DAY,
      dailyActiveUsers: 1,
      weeklyActiveUsers: 2,
      monthlyActiveUsers: 3,
      captured: true,
    });
    expect(result.platforms).toEqual([
      { platform: 'web', dailyActiveUsers: 1, weeklyActiveUsers: 1, monthlyActiveUsers: 2 },
      { platform: 'ios', dailyActiveUsers: 1, weeklyActiveUsers: 1, monthlyActiveUsers: 1 },
      { platform: 'android', dailyActiveUsers: 0, weeklyActiveUsers: 1, monthlyActiveUsers: 1 },
      { platform: 'unknown', dailyActiveUsers: 0, weeklyActiveUsers: 0, monthlyActiveUsers: 0 },
    ]);
  });

  it('sends one aggregate event on the system id with counts and no user ids', async () => {
    const userId = await createUser();
    await seedActivity([{ userId, day: SNAPSHOT_DAY, platform: 'android' }]);

    await snapshotActiveUsers({ now: RUN_AT });

    expect(captureBackendEventMock).toHaveBeenCalledTimes(1);
    const [eventName, options] = captureBackendEventMock.mock.calls[0];
    expect(eventName).toBe('Active Users Snapshot');
    expect(options.systemDistinctId).toBe('system:active-users');
    expect(options.timestamp?.toISOString()).toBe('2026-10-08T12:00:00.000Z');
    expect(options.properties).toMatchObject({
      day: SNAPSHOT_DAY,
      dailyActiveUsers: 1,
      weeklyActiveUsers: 1,
      monthlyActiveUsers: 1,
      dailyActiveUsersAndroid: 1,
      dailyActiveUsersWeb: 0,
      monthlyActiveUsersUnknown: 0,
    });
    expect(JSON.stringify(options)).not.toContain(userId);
  });

  it('sends the same event uuid for the same day, so a re-run collapses in PostHog', async () => {
    await snapshotActiveUsers({ now: RUN_AT });
    await snapshotActiveUsers({ now: new Date('2026-10-09T09:00:00.000Z') });
    await snapshotActiveUsers({ now: new Date('2026-10-10T00:20:00.000Z') });

    const uuids = captureBackendEventMock.mock.calls.map(([, options]) => options.uuid);
    expect(uuids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuids[1]).toBe(uuids[0]);
    expect(uuids[2]).not.toBe(uuids[0]);
  });

  it('reports zeros, not an error, on an empty table', async () => {
    const result = await snapshotActiveUsers({ now: RUN_AT });

    expect(result).toMatchObject({ dailyActiveUsers: 0, weeklyActiveUsers: 0, monthlyActiveUsers: 0 });
    expect(result.platforms.every((platformCount) => platformCount.monthlyActiveUsers === 0)).toBe(true);
  });
});

describe('retentionCutoffDay', () => {
  it.each([
    ['2026-10-08T05:00:00.000Z', '2025-09-08'],
    ['2026-01-15T05:00:00.000Z', '2024-12-15'],
    // March 31 minus 13 months has no Feb 31: clamp to the last day.
    ['2027-03-31T05:00:00.000Z', '2026-02-28'],
  ])('keeps 13 months back from %s', (now, expectedCutoff) => {
    expect(retentionCutoffDay(new Date(now))).toBe(expectedCutoff);
  });
});

describe('purgeExpiredUserActivity', () => {
  it('deletes rows older than 13 months and keeps the cutoff day itself', async () => {
    const userId = await createUser();
    await seedActivity([
      { userId, day: '2025-09-07', platform: 'web' },
      { userId, day: '2025-09-08', platform: 'web' },
      { userId, day: '2026-10-07', platform: 'ios' },
    ]);

    const result = await purgeExpiredUserActivity({ now: new Date('2026-10-08T07:00:00.000Z') });

    expect(result).toMatchObject({ rowsDeleted: 1, cutoffDay: '2025-09-08' });
    const remainingDays = (await db.select().from(dbSchema.userActivityDays)).map((row) => row.day).sort();
    expect(remainingDays).toEqual(['2025-09-08', '2026-10-07']);
  });

  it('is idempotent: a second run deletes nothing', async () => {
    const userId = await createUser();
    await seedActivity([{ userId, day: '2024-01-01', platform: 'web' }]);
    const now = new Date('2026-10-08T07:00:00.000Z');

    expect((await purgeExpiredUserActivity({ now })).rowsDeleted).toBe(1);
    expect((await purgeExpiredUserActivity({ now })).rowsDeleted).toBe(0);
  });
});

describe('cron-only mutations', () => {
  const signedInCtx = {
    connectionId: 'http-user',
    transport: 'http',
    isAuthenticated: true,
    userId: 'someone',
  } as ConnectionContext;
  const webSocketCronCtx = { ...cronCtx(), transport: 'ws' } as ConnectionContext;

  it.each([
    ['a signed-in climber', signedInCtx],
    ['a WebSocket connection, even one claiming cron auth', webSocketCronCtx],
  ])('refuses %s', async (_label, ctx) => {
    await expect(activeUsersMutations.snapshotActiveUsers(null, {}, ctx)).rejects.toThrow(
      'Cron authentication required',
    );
    await expect(activeUsersMutations.purgeExpiredUserActivity(null, {}, ctx)).rejects.toThrow(
      'Cron authentication required',
    );
    expect(captureBackendEventMock).not.toHaveBeenCalled();
  });

  it('runs for the scheduler', async () => {
    const snapshot = await activeUsersMutations.snapshotActiveUsers(null, {}, cronCtx());
    const purge = await activeUsersMutations.purgeExpiredUserActivity(null, {}, cronCtx());

    expect(snapshot.platforms).toHaveLength(4);
    expect(purge.rowsDeleted).toBe(0);
  });
});
