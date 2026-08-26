import type { ConnectionContext, QaVerdict } from '@boardsesh/shared-schema';
import { and, count, eq, ne } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { requireTester } from '../users/tester';
import { SubmitQaVerdictInputSchema } from '../../../validation/schemas';
import {
  applyQaLabel,
  buildVerdictComment,
  getHeadCommitDate,
  getOpenPullRequests,
  postVerdictComment,
} from '../../../services/github-qa';
import { toQaVerdict } from './queries';
import { logger } from '../../../utils/logger';

/**
 * The tester's Boardsesh display name, for the public PR comment. Falls back to
 * `users.name`, then to null (the comment then says "a Boardsesh tester").
 * Never returns an email or a user id — the repo is public.
 */
async function loadTesterDisplayName(userId: string): Promise<string | null> {
  const [tester] = await db
    .select({ displayName: dbSchema.userProfiles.displayName, name: dbSchema.users.name })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
    .where(eq(dbSchema.users.id, userId))
    .limit(1);

  return tester?.displayName?.trim() || tester?.name?.trim() || null;
}

export const qaMutations = {
  /**
   * File a tester's verdict on a PR preview. The row is committed before
   * anything touches GitHub; the comment and the label are mirrored afterwards,
   * fire-and-forget, so a GitHub outage costs the mirror and never the verdict.
   */
  submitQaVerdict: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<QaVerdict> => {
    await requireTester(ctx);
    await applyRateLimit(ctx, 10, 'submitQaVerdict');

    const validated = validateInput(SubmitQaVerdictInputSchema, input, 'input');
    const comment = validated.comment?.trim() ? validated.comment.trim() : null;

    const openPullRequests = await getOpenPullRequests();
    // An empty list means GitHub failed (the reader negative-caches [] for 30s)
    // rather than "this repo has no open PRs" — don't tell the tester their
    // still-open PR was closed, and don't record a verdict we can't place.
    if (openPullRequests.length === 0) {
      throw new Error('Could not reach GitHub to check the pull request; try again in a minute');
    }
    const pullRequest = openPullRequests.find((candidate) => candidate.number === validated.prNumber);
    if (!pullRequest) {
      throw new Error('Pull request is not open');
    }

    const headCommittedAt = await getHeadCommitDate(pullRequest.headSha);

    const [row] = await db
      .insert(dbSchema.qaVerdicts)
      .values({
        userId: ctx.userId!,
        prNumber: validated.prNumber,
        branch: validated.branch,
        headSha: pullRequest.headSha,
        headCommittedAt,
        verdict: validated.verdict,
        comment,
        platform: validated.platform,
        appVersion: validated.appVersion ?? null,
        updateId: validated.updateId ?? null,
        runtimeVersion: validated.runtimeVersion ?? null,
        bundleCreatedAt: validated.bundleCreatedAt ?? null,
      })
      .returning();

    if (!row) throw new Error('Could not record the verdict');

    // Fire-and-forget mirror to GitHub. Failures are logged under `[qa]` and
    // never surface to the tester; the row stands either way, and a row with
    // github_comment_id IS NULL is the "not mirrored" signal for the runbook.
    void (async () => {
      try {
        const tally = await db
          .select({ verdict: dbSchema.qaVerdicts.verdict, total: count() })
          .from(dbSchema.qaVerdicts)
          .where(
            and(
              eq(dbSchema.qaVerdicts.prNumber, row.prNumber),
              eq(dbSchema.qaVerdicts.headSha, pullRequest.headSha),
              ne(dbSchema.qaVerdicts.id, row.id),
            ),
          )
          .groupBy(dbSchema.qaVerdicts.verdict);
        const totalFor = (kind: 'approved' | 'declined'): number =>
          tally.find((entry) => entry.verdict === kind)?.total ?? 0;

        const body = buildVerdictComment({
          verdictId: row.id,
          verdict: row.verdict,
          displayName: await loadTesterDisplayName(ctx.userId!),
          comment,
          platform: row.platform,
          appVersion: row.appVersion,
          updateId: row.updateId,
          runtimeVersion: row.runtimeVersion,
          bundleCreatedAt: row.bundleCreatedAt,
          headSha: row.headSha,
          headCommittedAt: row.headCommittedAt,
          otherApproved: totalFor('approved'),
          otherDeclined: totalFor('declined'),
        });

        const posted = await postVerdictComment(row.prNumber, body);
        // Latest verdict wins: the label always ends up matching this row.
        await applyQaLabel(row.prNumber, row.verdict);

        if (posted) {
          await db
            .update(dbSchema.qaVerdicts)
            .set({ githubCommentId: posted.id, githubCommentUrl: posted.htmlUrl })
            .where(eq(dbSchema.qaVerdicts.id, row.id));
        }
      } catch (error) {
        logger.error('[qa] verdict mirror side-effect failed:', error);
      }
    })();

    return toQaVerdict(row);
  },
};
