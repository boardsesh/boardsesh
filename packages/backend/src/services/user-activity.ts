import { isClientPlatform, type ClientPlatform } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';

/**
 * First-party active-user counting (`user_activity_days`, #2644).
 *
 * Every authenticated request marks its climber active for the UTC day on the
 * platform it came from. This runs whatever the climber's analytics consent:
 * it is our own service statistic (legitimate interest), it never leaves our
 * database except as aggregate counts, and it is how MAU survives opt-outs.
 * See docs/analytics-consent.md.
 *
 * Cost: one `INSERT ... ON CONFLICT DO NOTHING` per climber per UTC day per
 * platform per backend replica. The in-process set below swallows every other
 * request, so a climber's hundredth request of the day costs a Set lookup.
 */

export type ActivityPlatform = ClientPlatform | 'unknown';

/**
 * Bounds the set at a few MB. Far above one replica's daily signed-in climbers;
 * if it is ever reached the set is emptied and the next requests re-insert,
 * which ON CONFLICT turns into no-ops.
 */
const MAX_REMEMBERED_ACTIVITY_KEYS = 50_000;

let rememberedDay: string | null = null;
const rememberedActivityKeys = new Set<string>();
let failureWarnedForDay: string | null = null;

/** `2026-10-08` for any instant on that UTC day. */
export function utcDayOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Map a client-supplied platform label onto the four the table accepts.
 * Anything missing or unrecognised is `unknown`: the label is a statistic,
 * never an input to authorisation, so a lie only miscounts its own row.
 */
export function resolveActivityPlatform(rawPlatform: unknown): ActivityPlatform {
  if (typeof rawPlatform !== 'string') return 'unknown';
  const normalizedPlatform = rawPlatform.trim().toLowerCase();
  return isClientPlatform(normalizedPlatform) ? normalizedPlatform : 'unknown';
}

async function insertActivityDay(userId: string, day: string, platform: ActivityPlatform): Promise<void> {
  try {
    await db.insert(dbSchema.userActivityDays).values({ userId, day, platform }).onConflictDoNothing();
  } catch (error) {
    // 23503: the user row is gone (deleted mid-request). Expected, not worth a warning.
    if (getPostgresErrorCode(error) === '23503') {
      logger.debug('[UserActivity] Skipped activity for a user that no longer exists');
      return;
    }
    // The key stays remembered, so a failing database is not retried on every
    // request. The cost is at most this replica's count for this climber today;
    // other replicas and tomorrow's first request still record.
    if (failureWarnedForDay !== day) {
      failureWarnedForDay = day;
      logger.warn('[UserActivity] Failed to record user activity; further failures today log at debug', error);
    } else {
      logger.debug('[UserActivity] Failed to record user activity', error);
    }
  }
}

/**
 * Mark `userId` active today on `platform`. Fire-and-forget: callers must not
 * await it on a request path (`void recordUserActivity(...)`). The returned
 * promise never rejects; tests await it.
 */
export function recordUserActivity(userId: string, platform: ActivityPlatform, now: Date = new Date()): Promise<void> {
  const day = utcDayOf(now);
  if (day !== rememberedDay) {
    rememberedActivityKeys.clear();
    rememberedDay = day;
  }

  const activityKey = `${userId}:${day}:${platform}`;
  if (rememberedActivityKeys.has(activityKey)) return Promise.resolve();
  if (rememberedActivityKeys.size >= MAX_REMEMBERED_ACTIVITY_KEYS) rememberedActivityKeys.clear();
  // Remembered before the insert, so concurrent requests from one climber
  // can't each fire their own.
  rememberedActivityKeys.add(activityKey);

  return insertActivityDay(userId, day, platform);
}

/** Test-only: forget every remembered key so each test starts cold. */
export function resetUserActivityMemoryForTests(): void {
  rememberedActivityKeys.clear();
  rememberedDay = null;
  failureWarnedForDay = null;
}
