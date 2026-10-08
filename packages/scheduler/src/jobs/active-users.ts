import type { JobRun } from './types';
import { hasNonNegativeCounts, runBackendCronMutation } from './backend-cron-mutation';

/**
 * The two daily jobs behind the first-party active-user count (#2644,
 * docs/analytics-consent.md). Signed-in requests write `user_activity_days` in
 * the backend whatever a climber's analytics consent; these turn it into
 * numbers and keep it bounded:
 *
 * - `snapshot-active-users` counts yesterday's DAU and the trailing 7- and
 *   30-day WAU/MAU, overall and per platform, and sends PostHog one aggregate
 *   `Active Users Snapshot` event. Overlap-safe: the counts are reads, and the
 *   event carries a uuid derived from the day, so a second send for the same
 *   day collapses into the first in PostHog.
 * - `purge-user-activity` deletes rows older than 13 months. Overlap-safe: a
 *   second run finds nothing older than the cutoff.
 *
 * Both are backend mutations for the reason the spray-wall purge is: the
 * scheduler has no database client, and the PostHog key lives in the backend.
 */

export const SNAPSHOT_ACTIVE_USERS_MUTATION = `
  mutation SnapshotActiveUsers {
    snapshotActiveUsers {
      day dailyActiveUsers weeklyActiveUsers monthlyActiveUsers captured durationMs
      platforms { platform dailyActiveUsers weeklyActiveUsers monthlyActiveUsers }
    }
  }
`;

export const PURGE_EXPIRED_USER_ACTIVITY_MUTATION = `
  mutation PurgeExpiredUserActivity {
    purgeExpiredUserActivity { rowsDeleted cutoffDay durationMs }
  }
`;

export type ActiveUsersSnapshot = {
  day: string;
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  monthlyActiveUsers: number;
  captured: boolean;
  durationMs: number;
};

export type UserActivityPurge = { rowsDeleted: number; cutoffDay: string; durationMs: number };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const snapshotActiveUsers: JobRun = async (context) => {
  const snapshot = await runBackendCronMutation({
    context,
    mutationName: 'snapshotActiveUsers',
    mutation: SNAPSHOT_ACTIVE_USERS_MUTATION,
  });
  if (
    typeof snapshot.day !== 'string' ||
    !DAY_PATTERN.test(snapshot.day) ||
    typeof snapshot.captured !== 'boolean' ||
    !hasNonNegativeCounts(snapshot, ['dailyActiveUsers', 'weeklyActiveUsers', 'monthlyActiveUsers', 'durationMs'])
  ) {
    throw new Error('snapshotActiveUsers returned an invalid result');
  }
  if (!snapshot.captured) {
    // Counted but not sent: the backend has no PostHog key or is not a
    // production runtime. Worth a line, not a failed run.
    context.logger.warn('active users snapshot was not sent to PostHog', { day: snapshot.day });
  }
  // Narrowed by the checks above, which `Record<string, unknown>` cannot express.
  // The per-platform rows ride along unchecked: they are for a human reading
  // the run log, and the event the backend sent already carries them.
  return snapshot as ActiveUsersSnapshot;
};

export const purgeUserActivity: JobRun = async (context) => {
  const purge = await runBackendCronMutation({
    context,
    mutationName: 'purgeExpiredUserActivity',
    mutation: PURGE_EXPIRED_USER_ACTIVITY_MUTATION,
  });
  if (
    typeof purge.cutoffDay !== 'string' ||
    !DAY_PATTERN.test(purge.cutoffDay) ||
    !hasNonNegativeCounts(purge, ['rowsDeleted', 'durationMs'])
  ) {
    throw new Error('purgeExpiredUserActivity returned an invalid result');
  }
  // Narrowed by the checks above, which `Record<string, unknown>` cannot express.
  return purge as UserActivityPurge;
};
