import type { ConnectionContext, QaPreview, QaVerdict } from '@boardsesh/shared-schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { QaVerdictRow } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { QaPreviewsArgsSchema } from '../../../validation/schemas';
import { buildingPrNumbers, readOtaBuildStates } from '../../../services/github-ota-deployments';
import { buildQaPreview, getHeadCommitDates, readOpenPullRequests } from '../../../services/github-qa';

/**
 * `created_at` is a zone-less `timestamp`, so the driver hands back Postgres's
 * own `2026-08-26 20:52:39.998322` — no `T`, no zone. Hermes (the app's JS
 * engine) parses that as `Invalid Date`, so the verdict would render with no
 * time at all. The column is written by `now()` on a UTC server, so stamp it as
 * UTC and hand the client a real ISO 8601 instant.
 */
function toIsoInstant(timestamp: string): string {
  const withSeparator = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T');
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(withSeparator) ? withSeparator : `${withSeparator}Z`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
}

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
    createdAt: toIsoInstant(row.createdAt),
    githubCommentUrl: row.githubCommentUrl,
  };
}

export const qaQueries = {
  /**
   * What a caller needs to QA the previews they can load: the open PRs among
   * the requested numbers, each with its test plan, risk score, and the
   * caller's own last verdict. Numbers that aren't open PRs are dropped, so the
   * app can pass every `pr-<n>` branch it sees without pre-filtering.
   *
   * Signed-in, not tester-only: the branch picker is open to every user, and
   * this is public data on a public repo. Without it a non-tester's pick list
   * renders bare `pr-N` rows — the app degrades to that on any failure here, so
   * gating it only ever cost readability.
   */
  qaPreviews: async (_: unknown, args: unknown, ctx: ConnectionContext): Promise<QaPreview[]> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'qaPreviews');

    const { prNumbers, includeBuilding } = validateInput(QaPreviewsArgsSchema, args, 'prNumbers');
    // No loadable previews is a normal state, not a bad request. With
    // `includeBuilding` there may still be something to say — a tester who just
    // pushed has no branch yet and an empty `prNumbers`.
    if (prNumbers.length === 0 && !includeBuilding) return [];

    // GitHub being unreachable is not the caller's problem and not an error
    // worth failing the screen over — an empty list renders "nothing to test".
    // Neither read throws; both log under `[qa]`.
    const [{ pullRequests: openPullRequests }, otaBuildStates] = await Promise.all([
      readOpenPullRequests(),
      readOtaBuildStates(),
    ]);

    // A PR whose bundle is mid-publish has no xprem branch, so the client
    // cannot have named it. Add it here or nobody ever sees it.
    const wanted = new Set(prNumbers);
    if (includeBuilding) {
      for (const prNumber of buildingPrNumbers(otaBuildStates)) wanted.add(prNumber);
    }

    const openByNumber = new Map(openPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));
    const requested = [...wanted]
      .map((prNumber) => openByNumber.get(prNumber))
      .filter((pullRequest): pullRequest is NonNullable<typeof pullRequest> => pullRequest !== undefined);
    if (requested.length === 0) return [];
    const requestedNumbers = requested.map((pullRequest) => pullRequest.number);

    // One query for every verdict this caller filed on the requested PRs,
    // newest first; the first row seen per PR is that PR's latest.
    const verdictRows = await db
      .select()
      .from(dbSchema.qaVerdicts)
      .where(and(eq(dbSchema.qaVerdicts.userId, ctx.userId!), inArray(dbSchema.qaVerdicts.prNumber, requestedNumbers)))
      .orderBy(desc(dbSchema.qaVerdicts.createdAt), desc(dbSchema.qaVerdicts.id));

    const latestVerdictByPr = new Map<number, QaVerdict>();
    for (const row of verdictRows) {
      if (!latestVerdictByPr.has(row.prNumber)) latestVerdictByPr.set(row.prNumber, toQaVerdict(row));
    }

    // Head commit dates let the app warn "you're testing an older revision"
    // before the caller files. Cached per SHA, fail-soft to null, and fetched a
    // few at a time — the steady-state cost of this is zero extra GitHub calls.
    const headCommittedAtBySha = await getHeadCommitDates(requested.map((pullRequest) => pullRequest.headSha));

    return requested.map((pullRequest) =>
      buildQaPreview(
        pullRequest,
        latestVerdictByPr.get(pullRequest.number) ?? null,
        headCommittedAtBySha.get(pullRequest.headSha) ?? null,
        otaBuildStates.get(pullRequest.number) ?? 'unknown',
      ),
    );
  },
};
