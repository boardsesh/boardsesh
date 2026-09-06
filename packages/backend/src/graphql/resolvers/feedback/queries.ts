import type { AppFeedbackReport, AppFeedbackStatus, ConnectionContext } from '@boardsesh/shared-schema';
import { and, count, desc, eq, ilike, inArray, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import type { FeedbackContext } from '@boardsesh/db/schema';
import { requireAdmin } from '../social/roles';
import { validateInput } from '../shared/helpers';
import { AdminAppFeedbackInputSchema } from '../../../validation/schemas';
import { screenshotPublicUrls } from '../../../services/feedback-screenshot-urls';

const BUG_SOURCES = ['shake-bug', 'drawer-bug'];
const RATING_SOURCES = ['prompt', 'drawer-feedback'];

const feedback = dbSchema.appFeedback;
// The users table joined twice: once as the reporter (user_id) and once as the
// admin who resolved the row (resolved_by). Both must be aliased.
const reporter = alias(dbSchema.users, 'reporter');
const resolver = alias(dbSchema.users, 'resolver');

// The columns every admin-feedback read returns. `resolvedBy` surfaces the
// resolving admin's email (most useful in the dashboard) rather than the raw id.
const reportColumns = {
  id: feedback.id,
  source: feedback.source,
  rating: feedback.rating,
  comment: feedback.comment,
  platform: feedback.platform,
  appVersion: feedback.appVersion,
  boardName: feedback.boardName,
  angle: feedback.angle,
  contactConsent: feedback.contactConsent,
  context: feedback.context,
  screenshotKeys: feedback.screenshotKeys,
  createdAt: feedback.createdAt,
  status: feedback.status,
  resolvedAt: feedback.resolvedAt,
  githubIssueNumber: feedback.githubIssueNumber,
  githubIssueUrl: feedback.githubIssueUrl,
  reporterId: feedback.userId,
  reporterEmail: reporter.email,
  reporterName: reporter.name,
  resolvedByEmail: resolver.email,
} as const;

type FeedbackRow = {
  id: bigint;
  source: string;
  rating: number | null;
  comment: string | null;
  platform: string;
  appVersion: string | null;
  boardName: string | null;
  angle: number | null;
  contactConsent: boolean | null;
  context: FeedbackContext | null;
  screenshotKeys: string[] | null;
  createdAt: string;
  status: AppFeedbackStatus;
  resolvedAt: string | null;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  reporterId: string | null;
  reporterEmail: string | null;
  reporterName: string | null;
  resolvedByEmail: string | null;
};

function mapFeedbackRow(row: FeedbackRow): AppFeedbackReport {
  return {
    id: String(row.id),
    source: row.source as AppFeedbackReport['source'],
    rating: row.rating,
    comment: row.comment,
    platform: row.platform as AppFeedbackReport['platform'],
    appVersion: row.appVersion,
    boardName: row.boardName,
    angle: row.angle,
    contactConsent: row.contactConsent,
    createdAt: row.createdAt,
    status: row.status,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedByEmail ?? null,
    githubIssueNumber: row.githubIssueNumber,
    githubIssueUrl: row.githubIssueUrl,
    reporter: row.reporterId
      ? { userId: row.reporterId, email: row.reporterEmail ?? null, name: row.reporterName ?? null }
      : null,
    context: row.context ?? null,
    // The dashboard renders the pictures; the keys stay server-side. An
    // unmintable key, or a media bucket with no public base, resolves to no
    // screenshots rather than an error.
    screenshotUrls: screenshotPublicUrls(row.screenshotKeys),
  };
}

/**
 * Re-fetch a single feedback row in the admin-report shape (with reporter +
 * resolver joins). Used by updateAppFeedbackStatus to return the updated row.
 */
export async function loadFeedbackReport(id: bigint): Promise<AppFeedbackReport | null> {
  const rows = await db
    .select(reportColumns)
    .from(feedback)
    .leftJoin(reporter, eq(feedback.userId, reporter.id))
    .leftJoin(resolver, eq(feedback.resolvedBy, resolver.id))
    .where(eq(feedback.id, id))
    .limit(1);
  return rows[0] ? mapFeedbackRow(rows[0]) : null;
}

// Escape LIKE metacharacters so a `%`/`_` in the search box matches literally.
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

export const feedbackQueries = {
  adminAppFeedback: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    const validated = validateInput(AdminAppFeedbackInputSchema, input ?? {}, 'input');

    const limit = validated.limit ?? 50;
    const offset = validated.offset ?? 0;

    const typeCondition =
      validated.type === 'bugs'
        ? inArray(feedback.source, BUG_SOURCES)
        : validated.type === 'ratings'
          ? inArray(feedback.source, RATING_SOURCES)
          : undefined;
    const platformCondition = validated.platform ? eq(feedback.platform, validated.platform) : undefined;
    const searchCondition = validated.search ? ilike(feedback.comment, `%${escapeLike(validated.search)}%`) : undefined;
    const statusCondition = validated.status ? eq(feedback.status, validated.status) : undefined;

    const combine = (parts: Array<SQL | undefined>): SQL | undefined => {
      const present = parts.filter((part): part is SQL => part !== undefined);
      return present.length ? and(...present) : undefined;
    };

    // The list respects every filter; the status-tab counts respect everything
    // except status (so each tab shows how many rows it would reveal).
    const listWhere = combine([typeCondition, platformCondition, searchCondition, statusCondition]);
    const countsWhere = combine([typeCondition, platformCondition, searchCondition]);

    // The page, the filtered total, and the per-status counts are independent
    // reads — run them concurrently rather than paying three serial round-trips.
    const [rows, totalRows, grouped] = await Promise.all([
      db
        .select(reportColumns)
        .from(feedback)
        .leftJoin(reporter, eq(feedback.userId, reporter.id))
        .leftJoin(resolver, eq(feedback.resolvedBy, resolver.id))
        .where(listWhere)
        // Secondary sort on id keeps ordering (and offset pagination) stable when
        // rows share a created_at.
        .orderBy(desc(feedback.createdAt), desc(feedback.id))
        .limit(limit + 1)
        .offset(offset),
      db.select({ value: count() }).from(feedback).where(listWhere),
      db.select({ status: feedback.status, value: count() }).from(feedback).where(countsWhere).groupBy(feedback.status),
    ]);

    const hasMore = rows.length > limit;
    const reports = (hasMore ? rows.slice(0, limit) : rows).map(mapFeedbackRow);
    const totalCount = Number(totalRows[0]?.value ?? 0);
    const byStatus = new Map(grouped.map((entry) => [entry.status, Number(entry.value)]));

    return {
      reports,
      totalCount,
      hasMore,
      statusCounts: {
        new: byStatus.get('new') ?? 0,
        inProgress: byStatus.get('in_progress') ?? 0,
        resolved: byStatus.get('resolved') ?? 0,
        wontFix: byStatus.get('wont_fix') ?? 0,
      },
    };
  },
};
