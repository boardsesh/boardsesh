import { and, countDistinct, eq, gte, lt, max, min, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';
import { dbRead, type Database } from '../db/client';
import { captureBackendEvent, flushBackendEvents } from './analytics/posthog';
import { deterministicEventUuid } from './analytics/deterministic-event-uuid';

export const HISTORICAL_ACTIVE_USERS_VERSION = 'v1';
export const REQUEST_ACTIVITY_START_DAY = '2026-10-09';
export const FIRST_COMPLETE_REQUEST_WINDOW_DAY = '2026-11-07';
const WINDOW_DAYS = 30;
const ACTION_SOURCES = 'native_tick_created_at+explicit_session_created_at+explicit_participant_joined_at';

export type HistoricalActiveUsersSnapshot = {
  snapshotDay: string;
  windowStart: string;
  /** Inclusive final UTC day of the 30-day window. */
  windowEnd: string;
  activeUsers30d: number;
  basis: 'historical_action_proxy' | 'mixed_action_proxy_and_requests';
  version: string;
  countSource: string;
};

type QueryDatabase = Pick<Database, 'select'>;

export class HistoricalActivityCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoricalActivityCoverageError';
  }
}

function utcDay(timestamp: Date): string {
  return timestamp.toISOString().slice(0, 10);
}

function shiftDay(day: string, delta: number): string {
  const timestamp = new Date(`${day}T00:00:00.000Z`);
  timestamp.setUTCDate(timestamp.getUTCDate() + delta);
  return utcDay(timestamp);
}

/** Historical timestamps are UTC wall-clock values, without a timezone. */
function localActions(database: QueryDatabase, now: Date) {
  const { boardseshTicks, boardSessions, boardSessionParticipants, users } = dbSchema;
  const cutover = `${REQUEST_ACTIVITY_START_DAY}T00:00:00.000Z`;
  const latest = now.toISOString();
  const ticks = database
    .select({ userId: users.id, actionAt: sql<string>`${boardseshTicks.createdAt}`.as('action_at') })
    .from(boardseshTicks)
    .innerJoin(users, eq(boardseshTicks.userId, users.id))
    .where(
      and(
        eq(boardseshTicks.origin, 'native'),
        gte(boardseshTicks.createdAt, users.createdAt),
        lt(boardseshTicks.createdAt, cutover),
        lt(boardseshTicks.createdAt, latest),
      ),
    );
  const sessionCreators = database
    .select({ userId: users.id, actionAt: sql<string>`${boardSessions.createdAt}`.as('action_at') })
    .from(boardSessions)
    .innerJoin(users, eq(boardSessions.createdByUserId, users.id))
    .where(
      and(
        eq(boardSessions.origin, 'explicit'),
        gte(boardSessions.createdAt, users.createdAt),
        lt(boardSessions.createdAt, new Date(cutover)),
        lt(boardSessions.createdAt, now),
      ),
    );
  const sessionParticipants = database
    .select({ userId: users.id, actionAt: sql<string>`${boardSessionParticipants.joinedAt}`.as('action_at') })
    .from(boardSessionParticipants)
    .innerJoin(boardSessions, eq(boardSessionParticipants.sessionId, boardSessions.id))
    .innerJoin(users, eq(boardSessionParticipants.userId, users.id))
    .where(
      and(
        eq(boardSessions.origin, 'explicit'),
        gte(boardSessionParticipants.joinedAt, users.createdAt),
        lt(boardSessionParticipants.joinedAt, new Date(cutover)),
        lt(boardSessionParticipants.joinedAt, now),
      ),
    );
  return unionAll(ticks, sessionCreators, sessionParticipants);
}

/** Month-end points only, stopping before the first complete request-based window. */
export function historicalSnapshotDays(firstActionDay: string, now: Date): string[] {
  const cursor = new Date(`${firstActionDay.slice(0, 7)}-01T00:00:00.000Z`);
  const today = utcDay(now);
  const snapshots: string[] = [];
  while (true) {
    const lastDay = utcDay(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)));
    if (lastDay >= today || lastDay >= FIRST_COMPLETE_REQUEST_WINDOW_DAY) break;
    snapshots.push(lastDay);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return snapshots;
}

/** Refuse a mixed window once either edge of its request-day history is unavailable. */
export function assertHistoricalRequestCoverage(
  snapshots: readonly HistoricalActiveUsersSnapshot[],
  firstRetainedDay: string | null,
  lastRetainedDay: string | null,
): void {
  const mixed = snapshots.filter((snapshot) => snapshot.basis === 'mixed_action_proxy_and_requests');
  for (const snapshot of mixed) {
    if (
      !firstRetainedDay ||
      firstRetainedDay > REQUEST_ACTIVITY_START_DAY ||
      !lastRetainedDay ||
      lastRetainedDay < snapshot.windowEnd
    ) {
      throw new HistoricalActivityCoverageError(
        `Cannot recompute ${snapshot.snapshotDay}: request activity must retain ${REQUEST_ACTIVITY_START_DAY} through ${snapshot.windowEnd}; available ${firstRetainedDay ?? 'none'} through ${lastRetainedDay ?? 'none'}. Existing snapshots must remain unchanged.`,
      );
    }
  }
}

async function computeSnapshots(database: QueryDatabase, now: Date): Promise<HistoricalActiveUsersSnapshot[]> {
  const actions = localActions(database, now).as('historical_actions');
  const [firstAction] = await database
    .select({ firstActionDay: sql<string>`min(${actions.actionAt})::date::text` })
    .from(actions);
  if (!firstAction?.firstActionDay) return [];

  const snapshotDays = historicalSnapshotDays(firstAction.firstActionDay, now);
  const snapshots: HistoricalActiveUsersSnapshot[] = snapshotDays.map((snapshotDay) => {
    const mixed = snapshotDay >= REQUEST_ACTIVITY_START_DAY;
    return {
      snapshotDay,
      windowStart: shiftDay(snapshotDay, -(WINDOW_DAYS - 1)),
      windowEnd: snapshotDay,
      activeUsers30d: 0,
      basis: mixed ? 'mixed_action_proxy_and_requests' : 'historical_action_proxy',
      version: HISTORICAL_ACTIVE_USERS_VERSION,
      countSource: mixed ? `${ACTION_SOURCES}+user_activity_days` : ACTION_SOURCES,
    };
  });
  if (snapshots.length === 0) return [];

  const { userActivityDays, users } = dbSchema;
  const requestActivity = database
    .select({ userId: users.id, actionAt: sql<string>`${userActivityDays.day}::timestamp`.as('action_at') })
    .from(userActivityDays)
    .innerJoin(users, eq(userActivityDays.userId, users.id))
    .where(
      and(
        gte(userActivityDays.day, REQUEST_ACTIVITY_START_DAY),
        gte(userActivityDays.day, sql`${users.createdAt}::date`),
        lt(userActivityDays.day, utcDay(now)),
      ),
    );
  const [coverage] = await database
    .select({ firstDay: min(userActivityDays.day), lastDay: max(userActivityDays.day) })
    .from(userActivityDays)
    .where(lt(userActivityDays.day, utcDay(now)));
  assertHistoricalRequestCoverage(snapshots, coverage?.firstDay ?? null, coverage?.lastDay ?? null);

  const allActivity = unionAll(localActions(database, now), requestActivity).as('all_activity');
  // A parameterized VALUES relation lets Postgres count the complete union for
  // every rolling window in one query. Only the aggregate counts leave the DB.
  const windows = sql`(values ${sql.join(
    snapshots.map(
      (snapshot) =>
        sql`(${snapshot.snapshotDay}::date, ${snapshot.windowStart}::timestamp, ${shiftDay(snapshot.windowEnd, 1)}::timestamp)`,
    ),
    sql`, `,
  )}) as snapshot_windows(snapshot_day, window_start, window_end_exclusive)`;
  const counts = await database
    .select({
      snapshotDay: sql<string>`snapshot_windows.snapshot_day::text`,
      activeUsers30d: countDistinct(allActivity.userId),
    })
    .from(windows)
    .leftJoin(
      allActivity,
      and(
        gte(allActivity.actionAt, sql`snapshot_windows.window_start`),
        lt(allActivity.actionAt, sql`snapshot_windows.window_end_exclusive`),
      ),
    )
    .groupBy(sql`snapshot_windows.snapshot_day`);
  const countsByDay = new Map(counts.map((snapshot) => [snapshot.snapshotDay, snapshot.activeUsers30d]));
  return snapshots.map((snapshot) => ({ ...snapshot, activeUsers30d: countsByDay.get(snapshot.snapshotDay) ?? 0 }));
}

/** Counts are a lower-bound action proxy, not historical request-based MAU. */
export async function computeHistoricalActiveUsersSnapshots({
  database = dbRead,
  now = new Date(),
}: { database?: Database; now?: Date } = {}): Promise<HistoricalActiveUsersSnapshot[]> {
  if (!Number.isFinite(now.getTime())) throw new Error('now must be a valid timestamp');
  // The coverage check and all counts see the same retained rows, even if the
  // retention sweep runs concurrently. No snapshot is published until it ends.
  return database.transaction((transaction) => computeSnapshots(transaction, now), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

export async function publishHistoricalActiveUsersSnapshots(
  snapshots: readonly HistoricalActiveUsersSnapshot[],
): Promise<void> {
  for (const snapshot of snapshots) {
    const captured = captureBackendEvent('Historical Active Users Snapshot', {
      systemDistinctId: 'system:historical-active-users',
      timestamp: new Date(`${snapshot.snapshotDay}T12:00:00.000Z`),
      uuid: deterministicEventUuid(
        `boardsesh:historical-active-users-snapshot:${snapshot.version}:${snapshot.snapshotDay}`,
      ),
      properties: { ...snapshot },
    });
    if (!captured) throw new Error(`Historical active-user snapshot ${snapshot.snapshotDay} was not queued`);
  }
  await flushBackendEvents();
}
