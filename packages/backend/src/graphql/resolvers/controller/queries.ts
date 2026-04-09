import type { ConnectionContext, ControllerInfo } from '@boardsesh/shared-schema';

import type { RequestDbInstance } from '../../../db/client';import { esp32Controllers } from '@boardsesh/db/schema/app';
import { eq } from 'drizzle-orm';
import { requireAuthenticated } from '../shared/helpers';

// Consider controller online if seen within last 60 seconds
const ONLINE_THRESHOLD_MS = 60 * 1000;

export const controllerQueries = {
  /**
   * Get all controllers registered by the current user
   * Requires authentication
   */
  myControllers: async (
    _: unknown,
    __: unknown,
    ctx: ConnectionContext
  ): Promise<ControllerInfo[]> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);

    if (!ctx.userId) {
      throw new Error('User ID not available');
    }

    const controllers = await db
      .select()
      .from(esp32Controllers)
      .where(eq(esp32Controllers.userId, ctx.userId));

    const now = Date.now();

    return controllers.map((controller) => ({
      id: controller.id,
      name: controller.name ?? undefined,
      boardName: controller.boardName,
      layoutId: controller.layoutId,
      sizeId: controller.sizeId,
      setIds: controller.setIds,
      isOnline: controller.lastSeenAt
        ? now - controller.lastSeenAt.getTime() < ONLINE_THRESHOLD_MS
        : false,
      lastSeen: controller.lastSeenAt?.toISOString(),
      createdAt: controller.createdAt.toISOString(),
    }));
  },
};
