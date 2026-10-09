import { GraphQLError } from 'graphql';
import type { ActiveUsersSnapshotResult, ConnectionContext, UserActivityPurgeResult } from '@boardsesh/shared-schema';
import { purgeExpiredUserActivity, snapshotActiveUsers } from '../../../services/active-users-snapshot';

/** Same gate as the other scheduler-driven mutations: HTTP cron bearer only. */
function requireCronAuthentication(ctx: ConnectionContext): void {
  if (ctx.transport !== 'http' || !ctx.isCronAuthenticated) {
    throw new GraphQLError('Cron authentication required', {
      extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
    });
  }
}

/**
 * The scheduler's `snapshot-active-users` and `purge-user-activity` jobs
 * (packages/scheduler) are the only callers. See docs/analytics-consent.md.
 */
export const activeUsersMutations = {
  snapshotActiveUsers: async (
    _: unknown,
    _args: unknown,
    ctx: ConnectionContext,
  ): Promise<ActiveUsersSnapshotResult> => {
    requireCronAuthentication(ctx);
    return snapshotActiveUsers();
  },

  purgeExpiredUserActivity: async (
    _: unknown,
    _args: unknown,
    ctx: ConnectionContext,
  ): Promise<UserActivityPurgeResult> => {
    requireCronAuthentication(ctx);
    return purgeExpiredUserActivity();
  },
};
