import type { ConnectionContext } from '@boardsesh/shared-schema';
import { SyncRunner } from '@boardsesh/aurora-sync/runner';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

export interface SyncResult {
  success: boolean;
  message: string | null;
}

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

    const userId = ctx.userId!;

    const runner = new SyncRunner({
      onLog: (msg: string) => console.log(`[UserSync] ${msg}`),
      onError: (error: Error, context: { userId?: string; board?: string }) => {
        console.error(`[UserSync] Error for ${context.userId}/${context.board}:`, error.message);
      },
    });

    try {
      await runner.syncUser(userId, boardName);
      return {
        success: true,
        message: 'User data synced successfully.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync error';
      console.error(`[UserSync] Failed for user ${userId} on ${boardName}:`, message);
      return {
        success: false,
        message: `Sync failed: ${message}`,
      };
    }
  },
};
