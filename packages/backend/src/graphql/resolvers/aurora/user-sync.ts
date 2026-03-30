import type { ConnectionContext } from '@boardsesh/shared-schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

export interface SyncResult {
  success: boolean;
  message: string | null;
}

/**
 * Note: The original user-sync endpoint relied on Aurora session cookies
 * managed by iron-session in Next.js. In the GraphQL backend, we don't have
 * that cookie-based session management. Instead, user sync is handled by the
 * cron job (SyncRunner) which manages credentials and tokens itself.
 *
 * This resolver returns a message directing users to use stored credentials
 * for sync, which is handled automatically by the cron job.
 */
export const auroraUserSyncMutation = {
  auroraUserSync: async (
    _: unknown,
    { boardName }: { boardName: string },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    requireAuthenticated(ctx);
    validateInput(BoardNameSchema, boardName, 'boardName');

    if (boardName === 'moonboard') {
      throw new Error('MoonBoard does not support Aurora sync');
    }

    // In the backend, user sync is handled by the cron job.
    // The user's data will be synced automatically when the cron runs.
    // We return a success message indicating the sync is queued.
    return {
      success: true,
      message: 'User data sync is handled automatically. Your data will be synced on the next cron cycle.',
    };
  },
};
