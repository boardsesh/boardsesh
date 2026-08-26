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
  postVerdictComment,
  readOpenPullRequests,
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

/**
 * `bundle_created_at` and `head_committed_at` are `timestamp` columns (no zone),
 * so Postgres keeps the wall clock and drops a client's `+02:00`. Left alone, a
 * bundle published at 09:30+02:00 would store as 09:30 and read as two hours
 * *newer* than the 07:30Z head commit it should be compared against — exactly
 * inverting the "tested an older revision" warning. Normalise to UTC on the way
 * in so both sides of that comparison live in the same frame.
 */
function toUtcTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

    // `failed` is the reader's own flag, not a guess from an empty list: the
    // first failure throws and the next 30 seconds are negative-cached as `[]`,
    // and both must read the same way here. Don't tell a tester their still-open
    // PR was closed, and don't record a verdict we can't place against a head.
    const { pullRequests: openPullRequests, failed } = await readOpenPullRequests();
    if (failed) {
      throw new Error('Could not reach GitHub to check the pull request; try again in a minute');
    }
    const pullRequest = openPullRequests.find((candidate) => candidate.number === validated.prNumber);
    if (!pullRequest) {
      throw new Error('Pull request is not open');
    }

    const headCommittedAt = toUtcTimestamp(await getHeadCommitDate(pullRequest.headSha));
    const bundleCreatedAt = toUtcTimestamp(validated.bundleCreatedAt);

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
        bundleCreatedAt,
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
          // The UTC values from above, not the row's — Postgres hands a
          // `timestamp` column back as `2026-08-26 07:30:00`, which reads as
          // local time to `Date.parse` and as a typo to a human.
          bundleCreatedAt,
          headSha: row.headSha,
          headCommittedAt,
          otherApproved: totalFor('approved'),
          otherDeclined: totalFor('declined'),
        });

        // Record the comment before touching labels: `github_comment_id IS NULL`
        // is the runbook's "replay this one by hand" signal, and a label failure
        // in between would otherwise strand a comment that did post.
        const posted = await postVerdictComment(row.prNumber, body);
        if (posted) {
          await db
            .update(dbSchema.qaVerdicts)
            .set({ githubCommentId: posted.id, githubCommentUrl: posted.htmlUrl })
            .where(eq(dbSchema.qaVerdicts.id, row.id));
        }

        // Latest verdict wins: the label always ends up matching this row.
        await applyQaLabel(row.prNumber, row.verdict);
      } catch (error) {
        logger.error('[qa] verdict mirror side-effect failed:', error);
      }
    })();

    return toQaVerdict(row);
  },
};
