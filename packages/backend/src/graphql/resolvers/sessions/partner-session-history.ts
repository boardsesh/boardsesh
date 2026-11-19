import { and, eq } from 'drizzle-orm';
import { boardSessions } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { eligiblePartnerSessionCondition } from '../../../services/public-api/sessions';
import { applyRateLimit, requireAuthenticated } from '../shared/helpers';

const EXPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const partnerSessionHistoryQueries = {
  resolvePartnerSessionHistory: async (
    _: unknown,
    { exportId }: { exportId: string },
    ctx: ConnectionContext,
  ): Promise<string | null> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'resolvePartnerSessionHistory');
    if (!EXPORT_ID.test(exportId)) return null;
    const [session] = await db
      .select({ id: boardSessions.id })
      .from(boardSessions)
      .where(and(eq(boardSessions.exportId, exportId), eligiblePartnerSessionCondition(ctx.userId!)))
      .limit(1);
    return session?.id ?? null;
  },
};
