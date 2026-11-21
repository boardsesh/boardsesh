import { and, eq, inArray } from 'drizzle-orm';
import { appFeedback } from '@boardsesh/db/schema';
import type { AppBugReportChangedEvent, ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { pubsub } from '../../../pubsub';
import { AppBugReportIdSchema } from '../../../validation/schemas';
import { requireAuthenticated } from '../shared/helpers';
import { createEagerAsyncIterator } from '../shared/async-iterators';
import { withSubscriptionCleanup } from '../shared/managed-subscription';

export const feedbackConversationSubscriptions = {
  appBugReportChanged: {
    subscribe: withSubscriptionCleanup(async function* (lifetime, _: unknown, __: unknown, ctx: ConnectionContext) {
      requireAuthenticated(ctx);
      const userId = ctx.userId!;
      const source = await lifetime.own(
        createEagerAsyncIterator<AppBugReportChangedEvent>(
          (push) => pubsub.subscribeAppBugReportChanges(userId, push),
          `appBugReportChanged:${userId}`,
        ),
      );
      for await (const event of source) {
        const reportId = AppBugReportIdSchema.safeParse(event.reportId);
        if (!reportId.success) continue;
        // A socket outlives account deletion and report reassignment. The topic
        // alone never authorizes a report ID supplied by another replica.
        const [owned] = await db
          .select({ id: appFeedback.id })
          .from(appFeedback)
          .where(
            and(
              eq(appFeedback.id, BigInt(reportId.data)),
              eq(appFeedback.userId, userId),
              inArray(appFeedback.source, ['shake-bug', 'drawer-bug']),
            ),
          )
          .limit(1);
        if (!owned) continue;
        yield { appBugReportChanged: { reportId: String(owned.id) } };
      }
    }),
  },
};
