import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';

// The HTTP context builder authenticates through validateToken; a token shaped
// `valid:<userId>` stands in for a real JWT so the test can name its climber.
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    validateToken: async (token: string) =>
      token.startsWith('valid:') ? { userId: token.slice('valid:'.length), isAuthenticated: true } : null,
  };
});

import { db } from '../db/client';
import { buildHttpConnectionContext } from '../graphql/yoga';
import {
  recordUserActivity,
  resetUserActivityMemoryForTests,
  resolveActivityPlatform,
  utcDayOf,
} from '../services/user-activity';

/**
 * The first-party active-user write (#2644): one row per climber per UTC day per
 * platform, never more than one INSERT per key per replica, and never able to
 * fail the request that triggered it.
 */

async function createUser(): Promise<string> {
  const userId = randomUUID();
  await db.insert(dbSchema.users).values({ id: userId, email: `${userId}@example.invalid` });
  return userId;
}

function activityRowsFor(userId: string) {
  return db.select().from(dbSchema.userActivityDays).where(eq(dbSchema.userActivityDays.userId, userId));
}

const OCT_8_MORNING = new Date('2026-10-08T07:00:00.000Z');
const OCT_8_NIGHT = new Date('2026-10-08T23:59:59.999Z');
const OCT_9_JUST_AFTER_MIDNIGHT = new Date('2026-10-09T00:00:00.001Z');

beforeEach(() => {
  resetUserActivityMemoryForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveActivityPlatform', () => {
  it.each([
    ['web', 'web'],
    ['ios', 'ios'],
    ['android', 'android'],
    [' IOS ', 'ios'],
    ['Android', 'android'],
  ])('maps %j to %s', (rawPlatform, expected) => {
    expect(resolveActivityPlatform(rawPlatform)).toBe(expected);
  });

  it.each([[undefined], [null], [''], ['desktop'], ['ios; drop table'], [['ios']], [7]])(
    'counts %j as unknown',
    (rawPlatform) => {
      expect(resolveActivityPlatform(rawPlatform)).toBe('unknown');
    },
  );
});

describe('utcDayOf', () => {
  it('uses the UTC calendar day, not the server zone', () => {
    expect(utcDayOf(new Date('2026-10-08T23:30:00.000-02:00'))).toBe('2026-10-09');
    expect(utcDayOf(OCT_8_NIGHT)).toBe('2026-10-08');
  });
});

describe('recordUserActivity', () => {
  it('writes one row and one INSERT however many requests a climber makes in a day', async () => {
    const userId = await createUser();
    const insertSpy = vi.spyOn(db, 'insert');

    await recordUserActivity(userId, 'ios', OCT_8_MORNING);
    await recordUserActivity(userId, 'ios', OCT_8_MORNING);
    await recordUserActivity(userId, 'ios', OCT_8_NIGHT);

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(await activityRowsFor(userId)).toEqual([{ userId, day: '2026-10-08', platform: 'ios' }]);
  });

  it('fires one INSERT for a burst of concurrent requests', async () => {
    const userId = await createUser();
    const insertSpy = vi.spyOn(db, 'insert');

    await Promise.all(Array.from({ length: 5 }, () => recordUserActivity(userId, 'web', OCT_8_MORNING)));

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(await activityRowsFor(userId)).toHaveLength(1);
  });

  it('counts each platform separately and starts again on the next UTC day', async () => {
    const userId = await createUser();

    await recordUserActivity(userId, 'ios', OCT_8_MORNING);
    await recordUserActivity(userId, 'web', OCT_8_MORNING);
    await recordUserActivity(userId, 'ios', OCT_9_JUST_AFTER_MIDNIGHT);

    const rows = await activityRowsFor(userId);
    expect(rows.map((row) => `${row.day}:${row.platform}`).sort()).toEqual([
      '2026-10-08:ios',
      '2026-10-08:web',
      '2026-10-09:ios',
    ]);
  });

  it('stays at one row when a second replica (cold memory) records the same day', async () => {
    const userId = await createUser();

    await recordUserActivity(userId, 'android', OCT_8_MORNING);
    resetUserActivityMemoryForTests();
    await recordUserActivity(userId, 'android', OCT_8_NIGHT);

    expect(await activityRowsFor(userId)).toHaveLength(1);
  });

  it('never rejects, even for a user that does not exist', async () => {
    const missingUserId = randomUUID();

    await expect(recordUserActivity(missingUserId, 'web', OCT_8_MORNING)).resolves.toBeUndefined();
    expect(await activityRowsFor(missingUserId)).toHaveLength(0);
  });

  it('never rejects when the database write throws', async () => {
    const userId = await createUser();
    vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('synthetic database outage');
    });

    await expect(recordUserActivity(userId, 'web', OCT_8_MORNING)).resolves.toBeUndefined();
  });
});

describe('the authenticated HTTP request path', () => {
  it('records platform activity while retaining the client identity', async () => {
    const userId = await createUser();

    const context = await buildHttpConnectionContext({
      request: new Request('http://localhost/graphql', {
        method: 'POST',
        headers: {
          authorization: `Bearer valid:${userId}`,
          'x-boardsesh-platform': 'android',
          'x-boardsesh-client': 'boardsesh-mobile/2.6.0 (android; build 45)',
        },
      }),
    });

    expect(context.userId).toBe(userId);
    expect(context.clientIdentity).toEqual({
      name: 'boardsesh-mobile',
      version: '2.6.0',
      platform: 'android',
      build: '45',
    });
    await vi.waitFor(async () => {
      const rows = await activityRowsFor(userId);
      expect(rows).toEqual([{ userId, day: utcDayOf(new Date()), platform: 'android' }]);
    });
  });

  it('records a client that sends no platform as unknown', async () => {
    const userId = await createUser();

    await buildHttpConnectionContext({
      request: new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { authorization: `Bearer valid:${userId}` },
      }),
    });

    await vi.waitFor(async () => {
      const rows = await activityRowsFor(userId);
      expect(rows.map((row) => row.platform)).toEqual(['unknown']);
    });
  });

  it('records nothing for an anonymous request', async () => {
    const insertSpy = vi.spyOn(db, 'insert');

    await buildHttpConnectionContext({
      request: new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'x-boardsesh-platform': 'web' },
      }),
    });

    expect(insertSpy).not.toHaveBeenCalled();
  });
});
