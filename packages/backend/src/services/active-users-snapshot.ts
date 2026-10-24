import { and, countDistinct, gte, lt, lte } from 'drizzle-orm';
import type { ActiveUsersPlatform, ActiveUsersSnapshotResult, UserActivityPurgeResult } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db, type Database } from '../db/client';
import { captureBackendEvent } from './analytics/posthog';
import { deterministicEventUuid } from './analytics/deterministic-event-uuid';
import { utcDayOf } from './user-activity';
import { logger } from '../utils/logger';

/**
 * The daily first-party active-user snapshot and the retention sweep behind
 * `user_activity_days` (#2644). Both run as cron-authenticated backend
 * mutations fired by `packages/scheduler`; see docs/analytics-consent.md and
 * docs/scheduler.md.
 */

export const ACTIVE_USERS_PLATFORMS: readonly ActiveUsersPlatform[] = ['web', 'ios', 'android', 'unknown'];

/**
 * Rows older than this many UTC days are deleted by the retention job. The
 * longest thing computed from the table is the trailing 30-day MAU, so 60 days
 * keeps that whole window for any day up to {@link MAX_SNAPSHOT_BACKFILL_DAYS}
 * back: a snapshot that failed can be re-run with `day` up to a month late.
 * Nothing computes yearly actives.
 */
export const USER_ACTIVITY_RETENTION_DAYS = 60;

/** The trailing windows, in UTC days ending on (and including) the snapshot day. */
const WEEKLY_WINDOW_DAYS = 7;
const MONTHLY_WINDOW_DAYS = 30;

/**
 * How far back a re-run may count. Retention minus the monthly window, so the
 * oldest re-runnable day still has all 30 days of rows behind it.
 */
export const MAX_SNAPSHOT_BACKFILL_DAYS = USER_ACTIVITY_RETENTION_DAYS - MONTHLY_WINDOW_DAYS;

const ACTIVE_USERS_SYSTEM_DISTINCT_ID = 'system:active-users';

const activityDays = dbSchema.userActivityDays;

function shiftUtcDay(day: string, deltaDays: number): string {
  const shifted = new Date(`${day}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return utcDayOf(shifted);
}

/** The oldest UTC day kept: `USER_ACTIVITY_RETENTION_DAYS` days before `now`'s day. */
export function retentionCutoffDay(now: Date): string {
  return shiftUtcDay(utcDayOf(now), -USER_ACTIVITY_RETENTION_DAYS);
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
 */
function snapshotEventUuid(day: string): string {
  return deterministicEventUuid(`boardsesh:active-users-snapshot:${day}`);
}

function platformPropertyName(prefix: string, platform: ActiveUsersPlatform): string {
  return `${prefix}${platform.charAt(0).toUpperCase()}${platform.slice(1)}`;
}

export type SnapshotActiveUsersOptions = {
  /** Injected so a test can pin the day. By default the snapshot covers the UTC day before `now`. */
  now?: Date;
  /**
   * A past UTC day (`YYYY-MM-DD`) to count instead of yesterday, for re-running
   * a snapshot that failed: yesterday back to {@link MAX_SNAPSHOT_BACKFILL_DAYS}
   * days before `now`'s day.
   */
  day?: string | null;
  database?: Database;
};

/** A `day` a snapshot cannot count: malformed, today or later, or past retention. */
export class InvalidSnapshotDayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSnapshotDayError';
  }
}

const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The day a snapshot counts: `requested` when valid, else yesterday. Throws on an invalid `requested`. */
export function resolveSnapshotDay(now: Date, requested: string | null | undefined): string {
  const yesterday = shiftUtcDay(utcDayOf(now), -1);
  if (requested === null || requested === undefined) return yesterday;
  // Round-tripping through Date rejects 2026-02-30 (it rolls over) and 2026-13-01 (invalid).
  const parsed = UTC_DAY_PATTERN.test(requested) ? new Date(`${requested}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || utcDayOf(parsed) !== requested) {
    throw new InvalidSnapshotDayError(`day must be a UTC date as YYYY-MM-DD, got "${requested}"`);
  }
  const earliest = shiftUtcDay(utcDayOf(now), -MAX_SNAPSHOT_BACKFILL_DAYS);
  // YYYY-MM-DD strings compare in date order.
  if (requested > yesterday || requested < earliest) {
    throw new InvalidSnapshotDayError(`day must be between ${earliest} and ${yesterday}, got ${requested}`);
  }
  return requested;
}

/**
 * Count one UTC day's DAU and the trailing 7- and 30-day WAU and MAU ending on
 * it, overall and per platform, and send them to PostHog as ONE `Active Users
 * Snapshot` event on a fixed system id. Counts only: no user id ever leaves
 * the database.
 *
 * Yesterday by default, not today: the job runs just after midnight UTC, when
 * today has barely started and yesterday is complete. An operator re-running a
 * failed snapshot passes the day it missed.
 */
export async function snapshotActiveUsers({
  now = new Date(),
  day: requestedDay,
  database = db,
}: SnapshotActiveUsersOptions = {}): Promise<ActiveUsersSnapshotResult> {
  const startedAt = Date.now();
  const day = resolveSnapshotDay(now, requestedDay);

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
 * Delete activity rows older than {@link USER_ACTIVITY_RETENTION_DAYS} days.
 * Idempotent: a second run finds nothing older than the cutoff. One statement,
 * because at steady state it deletes a single day's rows (one per climber
 * active that day), through the `day` index.
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
