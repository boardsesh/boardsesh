import { and, eq, isNull, or } from 'drizzle-orm';
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
// overall volume. Known limitation: in-memory de-dup resets on deploy and doesn't
// span instances, so the same pair can re-email after a restart or from another node.
// A Redis-backed (SET NX EX) de-dup + a durable reports table are the follow-up.
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

/**
 * A live (not soft-deleted, not already merged away) gym by uuid, visible to the
 * viewer, or undefined. Visibility mirrors findSimilarGyms: public gyms and the
 * viewer's own private gyms only. Without this gate a stranger's private gym would
 * report as NOT_FOUND vs reported, an oracle confirming the private gym exists (and
 * leaking its name to admins over email). A viewer can still report their own
 * private gym as a duplicate.
 */
async function loadLiveGym(
  gymUuid: string,
  viewerUserId: string,
): Promise<{ id: number; uuid: string; name: string } | undefined> {
  const [gym] = await db
    .select({ id: dbSchema.gyms.id, uuid: dbSchema.gyms.uuid, name: dbSchema.gyms.name })
    .from(dbSchema.gyms)
    .where(
      and(
        eq(dbSchema.gyms.uuid, gymUuid),
        isNull(dbSchema.gyms.deletedAt),
        isNull(dbSchema.gyms.mergedIntoGymId),
        or(eq(dbSchema.gyms.isPublic, true), eq(dbSchema.gyms.ownerId, viewerUserId)),
      ),
    )
    .limit(1);
  return gym;
}

export const socialGymReportMutations = {
  reportGymDuplicate: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<{ status: 'reported' | 'already_reported' }> => {
    // Intentionally NOT owner-gated: a duplicate report is a community data-quality
    // signal, so any signed-in climber who spots two listings of a gym can flag them
    // (not just the owner). The 10/min per-user ceiling — shared with the gym-claim
    // flow — bounds abuse. Do not tighten this to owners-only.
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
      loadLiveGym(validatedInput.gymUuid, userId),
      loadLiveGym(validatedInput.duplicateGymUuid, userId),
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

    // Resolve the reporter name BEFORE claiming the de-dup window: if this read
    // threw after marking, the catch below (which only fires for the send) would
    // never run, stranding the pair as 'reported' for the full window with no email
    // ever sent — the report would be silently lost.
    const reporterName = await loadReporterName(userId);

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
