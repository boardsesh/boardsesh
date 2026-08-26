import type { ConnectionContext, QaPreview, QaVerdict } from '@boardsesh/shared-schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { QaVerdictRow } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { requireTester } from '../users/tester';
import { QaPreviewsArgsSchema } from '../../../validation/schemas';
import { buildQaPreview, getHeadCommitDate, getOpenPullRequests } from '../../../services/github-qa';
import { logger } from '../../../utils/logger';

/**
 * Map a `qa_verdicts` row to the GraphQL type. The row id is a bigserial, and
 * GraphQL `ID` is a string, so it is stringified here in one place.
 */
export function toQaVerdict(row: QaVerdictRow): QaVerdict {
  return {
    id: String(row.id),
    prNumber: row.prNumber,
    branch: row.branch,
    verdict: row.verdict,
    comment: row.comment,
    headSha: row.headSha,
    createdAt: row.createdAt,
    githubCommentUrl: row.githubCommentUrl,
  };
}

export const qaQueries = {
  /**
   * What a tester needs to QA the previews they can load: the open PRs among
   * the requested numbers, each with its test plan, risk score, and the
   * caller's own last verdict. Numbers that aren't open PRs are dropped, so the
   * app can pass every `pr-<n>` branch it sees without pre-filtering.
   */
  qaPreviews: async (_: unknown, args: unknown, ctx: ConnectionContext): Promise<QaPreview[]> => {
    await requireTester(ctx);
    await applyRateLimit(ctx, 30, 'qaPreviews');

    const { prNumbers } = validateInput(QaPreviewsArgsSchema, args, 'prNumbers');

    let openPullRequests;
    try {
      openPullRequests = await getOpenPullRequests();
    } catch (error) {
      // GitHub being unreachable is not the tester's problem and not an error
      // worth failing the screen over — an empty list renders "nothing to test".
      logger.warn('[qa] open pull request lookup failed; serving no previews:', error);
      return [];
    }

    const openByNumber = new Map(openPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));
    const requested = prNumbers
      .map((prNumber) => openByNumber.get(prNumber))
      .filter((pullRequest): pullRequest is NonNullable<typeof pullRequest> => pullRequest !== undefined);
    if (requested.length === 0) return [];

    // One query for every verdict this tester filed on the requested PRs,
    // newest first; the first row seen per PR is that PR's latest.
    const verdictRows = await db
      .select()
      .from(dbSchema.qaVerdicts)
      .where(and(eq(dbSchema.qaVerdicts.userId, ctx.userId!), inArray(dbSchema.qaVerdicts.prNumber, prNumbers)))
      .orderBy(desc(dbSchema.qaVerdicts.createdAt), desc(dbSchema.qaVerdicts.id));

    const latestVerdictByPr = new Map<number, QaVerdict>();
    for (const row of verdictRows) {
      if (!latestVerdictByPr.has(row.prNumber)) latestVerdictByPr.set(row.prNumber, toQaVerdict(row));
    }

    // Head commit dates let the app warn "you're testing an older revision"
    // before the tester files. Cached per SHA and fail-soft to null, so the
    // steady-state cost of this fan-out is zero extra GitHub calls.
    const headCommittedAtBySha = new Map<string, string | null>();
    await Promise.all(
      [...new Set(requested.map((pullRequest) => pullRequest.headSha))].map(async (headSha) => {
        headCommittedAtBySha.set(headSha, await getHeadCommitDate(headSha));
      }),
    );

    return requested.map((pullRequest) =>
      buildQaPreview(
        pullRequest,
        latestVerdictByPr.get(pullRequest.number) ?? null,
        headCommittedAtBySha.get(pullRequest.headSha) ?? null,
      ),
    );
  },
};
