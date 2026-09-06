import type { ConnectionContext, QaVerdict } from '@boardsesh/shared-schema';
import { and, count, desc, eq, ne } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { readTesterRole } from '../users/tester';
import { SubmitQaVerdictInputSchema } from '../../../validation/schemas';
import {
  applyQaLabel,
  buildVerdictComment,
  getHeadCommitDate,
  getPullRequest,
  postVerdictComment,
  readOpenPullRequests,
} from '../../../services/github-qa';
import type { QaPullRequest } from '../../../services/github-qa';
import { toQaVerdict } from './queries';
import { logger } from '../../../utils/logger';

/**
 * The author's Boardsesh display name, for the public PR comment. Falls back to
 * `users.name`, then to null (the comment then names them anonymously).
 * Never returns an email or a user id — the repo is public.
 */
async function loadAuthorDisplayName(userId: string): Promise<string | null> {
  const [author] = await db
    .select({ displayName: dbSchema.userProfiles.displayName, name: dbSchema.users.name })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
    .where(eq(dbSchema.users.id, userId))
    .limit(1);

  return author?.displayName?.trim() || author?.name?.trim() || null;
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
   * File a verdict on a PR preview. The row is committed before anything touches
   * GitHub; the comment and the label are mirrored afterwards, fire-and-forget,
   * so a GitHub outage costs the mirror and never the verdict.
   *
   * Open to any signed-in user, because the branch picker is. The tester role
   * still decides one thing — whether this verdict moves the qa-approved /
   * qa-declined label — and that is recorded on the row as `byTester`, not
   * re-read later: a role granted or revoked afterwards must not rewrite what a
   * past verdict counted for.
   */
  submitQaVerdict: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<QaVerdict> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'submitQaVerdict');

    const validated = validateInput(SubmitQaVerdictInputSchema, input, 'input');
    const comment = validated.comment?.trim() ? validated.comment.trim() : null;
    // After validation on purpose: a malformed payload is rejected without
    // spending a community_roles read. The STRICT lookup, not the fail-soft
    // `userIsTester`: this answer is written down and decides whether the
    // verdict can ever move the label, so a read failure has to fail the
    // mutation rather than quietly record a tester as a non-tester.
    const byTester = await readTesterRole(ctx.userId!);

    // Read this PR fresh rather than off the three-minute list cache. Inside
    // that window a PR can pick up a new head commit — recording the verdict
    // against a revision the tester never ran, and silently skipping the
    // "older revision" warning — or be closed, which would take a verdict and
    // a qa-approved label on a PR nobody can act on.
    const fresh = await getPullRequest(validated.prNumber);
    if (fresh.status === 'closed') {
      throw new Error('Pull request is not open');
    }

    let pullRequest: QaPullRequest;
    if (fresh.status === 'open') {
      pullRequest = fresh.pullRequest;
    } else {
      // GitHub didn't answer the single-PR read. The cached list is a worse
      // answer than a fresh one but a much better one than losing the verdict,
      // so fall back to it — and only give up when it has nothing either.
      // `failed` is the reader's own flag, not a guess from an empty list: the
      // first failure throws and the next 30 seconds are negative-cached as
      // `[]`, and both must read the same way here.
      const { pullRequests: openPullRequests, failed } = await readOpenPullRequests();
      if (failed) {
        throw new Error('Could not reach GitHub to verify the pull request');
      }
      const cached = openPullRequests.find((candidate) => candidate.number === validated.prNumber);
      if (!cached) {
        throw new Error('Pull request is not open');
      }
      pullRequest = cached;
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
        byTester,
        comment,
        platform: validated.platform,
        deviceModel: validated.deviceModel ?? null,
        osVersion: validated.osVersion ?? null,
        appVersion: validated.appVersion ?? null,
        updateId: validated.updateId ?? null,
        runtimeVersion: validated.runtimeVersion ?? null,
        bundleCreatedAt,
      })
      .returning();

    if (!row) throw new Error('Could not record the verdict');

    // Fire-and-forget mirror to GitHub. Failures are logged under `[qa]` and
    // never surface to the caller; the row stands either way, and a row with
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
          displayName: await loadAuthorDisplayName(ctx.userId!),
          comment,
          platform: row.platform,
          deviceModel: row.deviceModel,
          osVersion: row.osVersion,
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

        // Latest TESTER verdict wins — but "latest" is whatever the table says,
        // not whatever this job is carrying. Two verdicts filed seconds apart run
        // independent side effects that can finish in either order, so an older
        // approval could otherwise stamp qa-approved over a newer decline.
        //
        // Restricted to `by_tester` because the label gates a merge on a PUBLIC
        // repo: anyone signed in can file a verdict and have it posted as a
        // comment, but only a tester moves the label. No tester has weighed in
        // yet → leave the label alone rather than clearing one a tester set.
        const [newestTesterVerdict] = await db
          .select({ verdict: dbSchema.qaVerdicts.verdict })
          .from(dbSchema.qaVerdicts)
          .where(and(eq(dbSchema.qaVerdicts.prNumber, row.prNumber), eq(dbSchema.qaVerdicts.byTester, true)))
          .orderBy(desc(dbSchema.qaVerdicts.createdAt), desc(dbSchema.qaVerdicts.id))
          .limit(1);
        if (newestTesterVerdict) await applyQaLabel(row.prNumber, newestTesterVerdict.verdict);
      } catch (error) {
        logger.error('[qa] verdict mirror side-effect failed:', error);
      }
    })();

    return toQaVerdict(row);
  },
};
