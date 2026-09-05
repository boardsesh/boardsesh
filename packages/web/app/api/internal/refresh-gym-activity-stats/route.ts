import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import {
  GYM_ACTIVITY_REFRESH_LOCK_KEY,
  countGymsWithActivity,
  rebuildGymActivityStats,
  type GymActivityRefreshSkipReason,
} from '@boardsesh/db/queries';
import { getDb } from '@/app/lib/db/db';
import { requireCronAuth } from '@/app/lib/auth/cron-auth';
import { createRequestLogger } from '@/app/lib/observability/request-logger';
import { reportHandledError } from '@/app/lib/observability/report-error';

/**
 * Rebuilds `gym_activity_stats`: distinct climbers per gym, from the dwell-gated
 * `board_climb_events` stream.
 *
 * This table is the only place the pre-instrumentation history exists. PostHog
 * gained a gym dimension when the `gym_uuid` super property shipped and can
 * answer nothing before that; the events themselves go back to 2026-06-14.
 *
 * Fired by the Railway scheduler's `refresh-gym-activity-stats` job
 * (packages/scheduler/src/jobs/registry.ts); `requireCronAuth` checks
 * `Authorization: Bearer $CRON_SECRET` here and for a by-hand run.
 *
 * `?force=1` bypasses the >50%-shrink guard, so the guard cannot wedge the
 * table permanently if the drop is real.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const log = createRequestLogger(request);
  const authError = requireCronAuth(request);
  if (authError) {
    return authError;
  }

  const force = new URL(request.url).searchParams.get('force') === '1';
  const startedAt = Date.now();

  try {
    const db = getDb();

    const [previousRow] = await db.execute<{ gym_count: number }>(
      sql`SELECT COUNT(*)::int AS gym_count FROM gym_activity_stats`,
    );
    const previousGymCount = Number(previousRow?.gym_count ?? 0);

    const gymCount = await countGymsWithActivity(db);
    const scanDurationMs = Date.now() - startedAt;

    const declined = (skipped: GymActivityRefreshSkipReason, error: string) =>
      NextResponse.json({ gymCount, previousGymCount, skipped, scanDurationMs, forced: force, error }, { status: 409 });

    // A refusal to write is NOT a success. Both branches leave the table frozen
    // at whatever it held while the admin list keeps serving it, and a 200 would
    // make that visible only to whoever greps the logs.
    if (gymCount === 0) {
      return declined(
        'empty',
        'the refresh found 0 gyms with activity — refusing to store a count that would empty the table',
      );
    }
    // A refresh that suddenly reports a third of the gyms is a regressed
    // predicate far more often than it is a real collapse.
    if (!force && previousGymCount > 0 && gymCount * 2 < previousGymCount) {
      return declined(
        'shrank',
        `the refresh found ${gymCount} gyms, down from ${previousGymCount} — refusing to store a >50% shrink. Re-run with ?force=1 if the drop is real.`,
      );
    }

    const written = await db.transaction(async (tx) => {
      // Transaction-scoped, never the session-scoped `pg_try_advisory_lock`:
      // on a pooled connection a session lock can outlive the request that took
      // it and wedge every later refresh.
      const lockRows = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${GYM_ACTIVITY_REFRESH_LOCK_KEY}) AS locked`,
      );
      if (!lockRows[0]?.locked) return null;
      return rebuildGymActivityStats(tx);
    });

    // Another instance holds the lock; this request did not refresh anything.
    // Report the conflict so the scheduler does not record a completed refresh.
    if (written === null) {
      return declined('locked', 'another gym activity stats refresh is already running');
    }

    return NextResponse.json({
      gymCount: written,
      previousGymCount,
      skipped: null,
      scanDurationMs,
      forced: force,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reportHandledError(error, { logger: log, message: 'Gym activity stats refresh failed' });
    return NextResponse.json({ error: 'Gym activity stats refresh failed' }, { status: 500 });
  }
}
