import { createHash } from 'node:crypto';
import { and, countDistinct, gte, lt, lte } from 'drizzle-orm';
import type {
  ActiveUsersPlatform,
  ActiveUsersSnapshotResult,
  UserActivityPurgeResult,
} from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db, type Database } from '../db/client';
import { captureBackendEvent } from './analytics/posthog';
import { utcDayOf } from './user-activity';
import { logger } from '../utils/logger';

/**
 * The daily first-party active-user snapshot and the retention sweep behind
 * `user_activity_days` (#2644). Both run as cron-authenticated backend
 * mutations fired by `packages/scheduler`; see docs/analytics-consent.md and
 * docs/scheduler.md.
 */

export const ACTIVE_USERS_PLATFORMS: readonly ActiveUsersPlatform[] = ['web', 'ios', 'android', 'unknown'];

/** Rows older than this many calendar months are deleted by the retention job. */
export const USER_ACTIVITY_RETENTION_MONTHS = 13;

/** The trailing windows, in UTC days ending on (and including) the snapshot day. */
const WEEKLY_WINDOW_DAYS = 7;
const MONTHLY_WINDOW_DAYS = 30;

const ACTIVE_USERS_SYSTEM_DISTINCT_ID = 'system:active-users';

const activityDays = dbSchema.userActivityDays;

function shiftUtcDay(day: string, deltaDays: number): string {
  const shifted = new Date(`${day}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return utcDayOf(shifted);
}

/**
 * Same day of the month, `USER_ACTIVITY_RETENTION_MONTHS` months back, clamped
 * to the end of a shorter month (2027-03-31 -> 2026-02-28).
 */
export function retentionCutoffDay(now: Date): string {
  const targetYear = now.getUTCFullYear();
  const targetMonth = now.getUTCMonth() - USER_ACTIVITY_RETENTION_MONTHS;
  // Date.UTC normalises a negative month into an earlier year; day 0 of the
  // next month is the last day of the target month.
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const dayOfMonth = Math.min(now.getUTCDate(), lastDayOfTargetMonth);
  return utcDayOf(new Date(Date.UTC(targetYear, targetMonth, dayOfMonth)));
}

type WindowCounts = { overall: number; byPlatform: Map<string, number> };

async function countActiveUsers(database: Database, firstDay: string, lastDay: string): Promise<WindowCounts> {
  const inWindow = and(gte(activityDays.day, firstDay), lte(activityDays.day, lastDay));
  // Two queries, not one summed: a climber on web and iOS is one active user
  // overall but one on each platform.
  const [overallRow] = await database
    .select({ activeUsers: countDistinct(activityDays.userId) })
    .from(activityDays)
    .where(inWindow);
  const platformRows = await database
    .select({ platform: activityDays.platform, activeUsers: countDistinct(activityDays.userId) })
    .from(activityDays)
    .where(inWindow)
    .groupBy(activityDays.platform);
  return {
    overall: overallRow?.activeUsers ?? 0,
    byPlatform: new Map<string, number>(platformRows.map((row) => [row.platform, row.activeUsers])),
  };
}

/**
 * A UUID derived from the day, so a second send for the same day (an operator
 * re-running the job) is the same PostHog event and collapses into the first.
 * RFC 4122 name-based layout (version 5 nibble, variant bits) over SHA-1.
 */
function snapshotEventUuid(day: string): string {
  const digest = createHash('sha1').update(`boardsesh:active-users-snapshot:${day}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function platformPropertyName(prefix: string, platform: ActiveUsersPlatform): string {
  return `${prefix}${platform.charAt(0).toUpperCase()}${platform.slice(1)}`;
}

export type SnapshotActiveUsersOptions = {
  /** Injected so a test can pin the day. The snapshot covers the UTC day before `now`. */
  now?: Date;
  database?: Database;
};

/**
 * Count yesterday's DAU and the trailing 7- and 30-day WAU and MAU (all UTC
 * days ending yesterday), overall and per platform, and send them to PostHog
 * as ONE `Active Users Snapshot` event on a fixed system id. Counts only: no
 * user id ever leaves the database.
 *
 * Yesterday, not today: the job runs just after midnight UTC, when today has
 * barely started and yesterday is complete.
 */
export async function snapshotActiveUsers({
  now = new Date(),
  database = db,
}: SnapshotActiveUsersOptions = {}): Promise<ActiveUsersSnapshotResult> {
  const startedAt = Date.now();
  const day = shiftUtcDay(utcDayOf(now), -1);

  const daily = await countActiveUsers(database, day, day);
  const weekly = await countActiveUsers(database, shiftUtcDay(day, -(WEEKLY_WINDOW_DAYS - 1)), day);
  const monthly = await countActiveUsers(database, shiftUtcDay(day, -(MONTHLY_WINDOW_DAYS - 1)), day);

  const platforms = ACTIVE_USERS_PLATFORMS.map((platform) => ({
    platform,
    dailyActiveUsers: daily.byPlatform.get(platform) ?? 0,
    weeklyActiveUsers: weekly.byPlatform.get(platform) ?? 0,
    monthlyActiveUsers: monthly.byPlatform.get(platform) ?? 0,
  }));

  const properties: Record<string, string | number> = {
    day,
    dailyActiveUsers: daily.overall,
    weeklyActiveUsers: weekly.overall,
    monthlyActiveUsers: monthly.overall,
    countSource: 'user_activity_days',
  };
  for (const platformCount of platforms) {
    properties[platformPropertyName('dailyActiveUsers', platformCount.platform)] = platformCount.dailyActiveUsers;
    properties[platformPropertyName('weeklyActiveUsers', platformCount.platform)] = platformCount.weeklyActiveUsers;
    properties[platformPropertyName('monthlyActiveUsers', platformCount.platform)] = platformCount.monthlyActiveUsers;
  }

  const captured = captureBackendEvent('Active Users Snapshot', {
    systemDistinctId: ACTIVE_USERS_SYSTEM_DISTINCT_ID,
    properties,
    // Dated to the day it counts, so a PostHog trend by day lines up with the
    // day the climbers were active rather than the morning after.
    timestamp: new Date(`${day}T12:00:00.000Z`),
    uuid: snapshotEventUuid(day),
  });

  const result: ActiveUsersSnapshotResult = {
    day,
    dailyActiveUsers: daily.overall,
    weeklyActiveUsers: weekly.overall,
    monthlyActiveUsers: monthly.overall,
    platforms,
    captured,
    durationMs: Date.now() - startedAt,
  };
  logger.info('[ActiveUsers] Snapshot computed', {
    day,
    dailyActiveUsers: result.dailyActiveUsers,
    weeklyActiveUsers: result.weeklyActiveUsers,
    monthlyActiveUsers: result.monthlyActiveUsers,
    captured,
  });
  return result;
}

export type PurgeExpiredUserActivityOptions = {
  now?: Date;
  database?: Database;
};

/**
 * Delete activity rows older than {@link USER_ACTIVITY_RETENTION_MONTHS}
 * months. Idempotent: a second run finds nothing older than the cutoff. One
 * statement, because at steady state it deletes a single day's rows (one per
 * climber active that day), through the `day` index.
 */
export async function purgeExpiredUserActivity({
  now = new Date(),
  database = db,
}: PurgeExpiredUserActivityOptions = {}): Promise<UserActivityPurgeResult> {
  const startedAt = Date.now();
  const cutoffDay = retentionCutoffDay(now);
  // postgres.js RowList: `count` is the affected-row count for DELETE.
  const deleted = await database.delete(activityDays).where(lt(activityDays.day, cutoffDay));
  const rowsDeleted = deleted.count ?? 0;
  logger.info('[ActiveUsers] Purged expired activity rows', { cutoffDay, rowsDeleted });
  return { rowsDeleted, cutoffDay, durationMs: Date.now() - startedAt };
}
