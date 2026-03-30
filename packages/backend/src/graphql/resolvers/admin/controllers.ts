import { eq, and } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { esp32Controllers } from '@boardsesh/db/schema/app';
import { requireAuthenticated } from '../shared/helpers';

export const adminControllerMutation = {
  deleteControllerAdmin: async (
    _: unknown,
    { controllerId }: { controllerId: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    // Only delete if user owns the controller
    await db
      .delete(esp32Controllers)
      .where(
        and(
          eq(esp32Controllers.id, controllerId),
          eq(esp32Controllers.userId, userId),
        ),
      );

    return true;
  },
};
