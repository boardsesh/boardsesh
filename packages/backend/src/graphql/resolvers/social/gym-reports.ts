import { and, eq, isNull } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { ReportGymDuplicateInputSchema } from '../../../validation/schemas';
import { sendGymDuplicateReportAdminNotification } from '../../../email/email-service';
import { checkRateLimit, cleanupRateLimit, RateLimitError } from '../../../utils/rate-limiter';
import { logger } from '../../../utils/logger';

// Owner-facing "report a duplicate" surfaces the pair to admins by email (the same
// admin-notification path a queued gym claim uses). It is deliberately migration-free:
// no dedicated table, so repeated reports of the SAME pair are de-duplicated with the
// in-memory window limiter below rather than a persisted row. This is per-instance,
// best-effort de-dup — enough to stop one flurry of clicks (or two climbers flagging
// the same pair) from spamming the team, while the per-user `applyRateLimit` bounds
// overall volume. A durable reports table can replace this in a later PR.
const REPORT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One stable key per unordered gym pair, so (A,B) and (B,A) de-dupe together. */
function duplicateReportDedupKey(firstUuid: string, secondUuid: string): string {
  const [low, high] = [firstUuid, secondUuid].sort();
  return `gymDuplicateReport:${low}:${high}`;
}

/** The reporter's display name for the admin email, falling back to a neutral label. */
async function loadReporterName(userId: string): Promise<string> {
  const [reporter] = await db
    .select({ name: dbSchema.users.name, displayName: dbSchema.userProfiles.displayName })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(eq(dbSchema.users.id, userId))
    .limit(1);
  return reporter?.displayName || reporter?.name || 'A Boardsesh user';
}

/** A live (not soft-deleted, not already merged away) gym by uuid, or undefined. */
async function loadLiveGym(gymUuid: string): Promise<{ id: number; uuid: string; name: string } | undefined> {
  const [gym] = await db
    .select({ id: dbSchema.gyms.id, uuid: dbSchema.gyms.uuid, name: dbSchema.gyms.name })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.uuid, gymUuid), isNull(dbSchema.gyms.deletedAt), isNull(dbSchema.gyms.mergedIntoGymId)))
    .limit(1);
  return gym;
}

export const socialGymReportMutations = {
  reportGymDuplicate: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<{ status: 'reported' | 'already_reported' }> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'reportGymDuplicate');

    const validatedInput = validateInput(ReportGymDuplicateInputSchema, input, 'input');
    const userId = ctx.userId!;

    if (validatedInput.gymUuid === validatedInput.duplicateGymUuid) {
      throw new GraphQLError("A gym can't be a duplicate of itself.", {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const [gym, duplicate] = await Promise.all([
      loadLiveGym(validatedInput.gymUuid),
      loadLiveGym(validatedInput.duplicateGymUuid),
    ]);
    if (!gym) {
      throw new GraphQLError('The gym you are reporting from no longer exists.', {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    if (!duplicate) {
      throw new GraphQLError('The gym you picked as a duplicate no longer exists.', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    // De-dup: the first report of this pair claims the window; a repeat inside it
    // returns without re-emailing. Marked BEFORE the send so concurrent clicks
    // collapse to one, and released on send failure so a retry isn't stranded.
    const dedupKey = duplicateReportDedupKey(gym.uuid, duplicate.uuid);
    try {
      checkRateLimit(dedupKey, 1, REPORT_DEDUP_WINDOW_MS);
    } catch (error) {
      if (error instanceof RateLimitError) {
        return { status: 'already_reported' };
      }
      throw error;
    }

    const reporterName = await loadReporterName(userId);
    try {
      await sendGymDuplicateReportAdminNotification({
        gymName: gym.name,
        gymUuid: gym.uuid,
        duplicateGymName: duplicate.name,
        duplicateGymUuid: duplicate.uuid,
        reporterName,
        note: validatedInput.note ?? null,
      });
    } catch (error) {
      // The email IS the record for this pair, so a failed send must not leave the
      // pair marked reported — release it so the climber can try again.
      cleanupRateLimit(dedupKey);
      logger.error('[GymDuplicateReport] Failed to send admin notification:', error);
      throw new GraphQLError("We couldn't send that report. Try again in a moment.", {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
    }

    return { status: 'reported' };
  },
};
