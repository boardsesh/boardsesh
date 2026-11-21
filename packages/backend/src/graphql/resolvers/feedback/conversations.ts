import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { AppBugReport, AppBugReportMessage, ConnectionContext } from '@boardsesh/shared-schema';
import { appFeedback, appFeedbackMessages, users } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { pubsub } from '../../../pubsub';
import {
  feedbackIssueMatches,
  requestFeedbackGithubIssueRefresh,
} from '../../../services/feedback-github-conversations';
import { screenshotPublicUrls } from '../../../services/feedback-screenshot-urls';
import { enqueueOn, requireJobQueue } from '../../../services/job-queue';
import { NOTIFICATION_PUSH_RETRIES } from '../../../services/notification-push-options';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { hasAdmin } from '../social/roles';
import {
  AppBugReportIdSchema,
  AppBugReportsInputSchema,
  AppBugReportMessagesInputSchema,
  SendAppBugReportMessageInputSchema,
} from '../../../validation/schemas';

const BUG_SOURCES = ['shake-bug', 'drawer-bug'];
const notFound = () => new Error('Bug report not found');
// GitHub timestamps have second precision. Its comment ID preserves canonical
// order within that second; local outbox rows follow every confirmed comment.
const OUTBOX_MESSAGE_SORT_ID = '9223372036854775807';
const messageSortId = sql<bigint>`CASE WHEN ${appFeedbackMessages.deliveryStatus} = 'sent'
  AND ${appFeedbackMessages.githubCommentId} IS NOT NULL
  THEN ${appFeedbackMessages.githubCommentId}::bigint ELSE ${OUTBOX_MESSAGE_SORT_ID}::bigint END`;
const messageColumns = {
  id: appFeedbackMessages.id,
  reportId: appFeedbackMessages.reportId,
  body: appFeedbackMessages.body,
  deliveryStatus: appFeedbackMessages.deliveryStatus,
  authorRole: appFeedbackMessages.authorRole,
  createdAt: appFeedbackMessages.createdAt,
  githubCommentId: appFeedbackMessages.githubCommentId,
};

function mapReport(report: typeof appFeedback.$inferSelect): AppBugReport {
  return {
    id: String(report.id),
    comment: report.comment,
    createdAt: report.createdAt,
    status:
      report.githubIssueState === 'open'
        ? 'new'
        : report.githubIssueState === 'closed'
          ? ['not_planned', 'duplicate'].includes(report.githubIssueStateReason ?? '')
            ? 'wont_fix'
            : 'resolved'
          : report.status,
    screenshotUrls: screenshotPublicUrls(report.screenshotKeys),
    githubIssueNumber: report.githubIssueNumber,
    githubIssueUrl: report.githubIssueUrl,
    canReply:
      report.userId !== null &&
      report.githubIssueNumber !== null &&
      feedbackIssueMatches(report.githubIssueUrl, report.githubIssueNumber),
    lastMessageAt: report.lastMessageAt,
    lastMessagePreview: report.lastMessagePreview,
  };
}
function mapMessage(message: {
  id: bigint;
  reportId: bigint;
  body: string;
  authorRole: 'reporter' | 'staff';
  deliveryStatus: 'pending' | 'sent' | 'failed';
  createdAt: string;
}): AppBugReportMessage {
  return {
    id: String(message.id),
    reportId: String(message.reportId),
    body: message.body,
    authorRole: message.authorRole,
    deliveryStatus: message.deliveryStatus,
    createdAt: message.createdAt,
  };
}

async function authorizedReport(id: string, ctx: ConnectionContext) {
  requireAuthenticated(ctx);
  const reportId = validateInput(AppBugReportIdSchema, id, 'id');
  const admin = await hasAdmin(ctx.userId!);
  const [report] = await db
    .select()
    .from(appFeedback)
    .where(
      and(
        eq(appFeedback.id, BigInt(reportId)),
        inArray(appFeedback.source, BUG_SOURCES),
        admin ? undefined : eq(appFeedback.userId, ctx.userId!),
      ),
    )
    .limit(1);
  return report;
}

export const feedbackConversationQueries = {
  myAppBugReports: async (_: unknown, { input }: { input?: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const validated = validateInput(AppBugReportsInputSchema, input ?? {}, 'input');
    const limit = validated.limit ?? 20;
    const rows = await db
      .select()
      .from(appFeedback)
      .where(
        and(
          eq(appFeedback.userId, ctx.userId!),
          inArray(appFeedback.source, BUG_SOURCES),
          validated.after ? lt(appFeedback.id, BigInt(validated.after)) : undefined,
        ),
      )
      .orderBy(desc(appFeedback.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    await Promise.all(
      page
        .filter((report) => report.githubIssueNumber && report.githubIssueState === null)
        .map((report) => requestFeedbackGithubIssueRefresh(String(report.id))),
    );
    const reports = page.map(mapReport);
    return { reports, hasMore: rows.length > limit, endCursor: reports.at(-1)?.id ?? null };
  },
  appBugReport: async (_: unknown, { id }: { id: string }, ctx: ConnectionContext) => {
    const report = await authorizedReport(id, ctx);
    if (report?.githubIssueNumber) await requestFeedbackGithubIssueRefresh(String(report.id));
    return report ? mapReport(report) : null;
  },
  appBugReportMessages: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const validated = validateInput(AppBugReportMessagesInputSchema, input, 'input');
    if (!(await authorizedReport(validated.reportId, ctx))) throw notFound();
    const limit = validated.limit ?? 20;
    const rows = await db
      .select(messageColumns)
      .from(appFeedbackMessages)
      .where(
        and(
          eq(appFeedbackMessages.reportId, BigInt(validated.reportId)),
          isNull(appFeedbackMessages.withdrawnAt),
          validated.before
            ? or(
                lt(appFeedbackMessages.createdAt, validated.before.createdAt),
                and(
                  eq(appFeedbackMessages.createdAt, validated.before.createdAt),
                  lt(messageSortId, BigInt(validated.before.sortId)),
                ),
                and(
                  eq(appFeedbackMessages.createdAt, validated.before.createdAt),
                  eq(messageSortId, BigInt(validated.before.sortId)),
                  lt(appFeedbackMessages.id, BigInt(validated.before.id)),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(appFeedbackMessages.createdAt), desc(messageSortId), desc(appFeedbackMessages.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const messages = page.map(mapMessage);
    const last = page.at(-1);
    return {
      messages,
      hasMore: rows.length > limit,
      endCursor: last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.createdAt,
              sortId:
                last.deliveryStatus === 'sent' && last.githubCommentId ? last.githubCommentId : OUTBOX_MESSAGE_SORT_ID,
              id: String(last.id),
            }),
          ).toString('base64url')
        : null,
    };
  },
};

export const feedbackConversationMutations = {
  retryAppBugReportMessage: async (
    _: unknown,
    { id }: { id: string },
    ctx: ConnectionContext,
  ): Promise<AppBugReportMessage> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'retryAppBugReportMessage');
    const messageId = validateInput(AppBugReportIdSchema, id, 'id');
    const result = await db.transaction(async (transaction) => {
      const [message] = await transaction
        .select()
        .from(appFeedbackMessages)
        .where(
          and(
            eq(appFeedbackMessages.id, BigInt(messageId)),
            eq(appFeedbackMessages.authorId, ctx.userId!),
            eq(appFeedbackMessages.authorRole, 'reporter'),
            isNull(appFeedbackMessages.withdrawnAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!message) throw notFound();
      const [report] = await transaction
        .select()
        .from(appFeedback)
        .where(and(eq(appFeedback.id, message.reportId), eq(appFeedback.userId, ctx.userId!)))
        .limit(1);
      if (!report?.githubIssueNumber || !feedbackIssueMatches(report.githubIssueUrl, report.githubIssueNumber))
        throw notFound();
      if (message.deliveryStatus !== 'failed') return mapMessage(message);
      await transaction
        .update(appFeedbackMessages)
        .set({ deliveryStatus: 'pending' })
        .where(eq(appFeedbackMessages.id, message.id));
      const jobId = await requireJobQueue().send(
        'feedback-github-comment',
        { messageId },
        {
          ...NOTIFICATION_PUSH_RETRIES,
          db: enqueueOn(transaction),
        },
      );
      if (!jobId) throw new Error('GITHUB_COMMENT_ENQUEUE_FAILED');
      return mapMessage({ ...message, deliveryStatus: 'pending' });
    });
    pubsub.publishAppBugReportChanged(ctx.userId!, { reportId: result.reportId });
    return result;
  },
  sendAppBugReportMessage: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<AppBugReportMessage> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'sendAppBugReportMessage');
    const validated = validateInput(SendAppBugReportMessageInputSchema, input, 'input');
    const userId = ctx.userId!;
    const result = await db.transaction(async (transaction) => {
      // Account deletion locks users before feedback; take the same order before any FK write.
      const [account] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('key share')
        .limit(1);
      if (!account) throw notFound();
      // Serialize writes to one conversation so its latest-message summary is accurate.
      const [report] = await transaction
        .select()
        .from(appFeedback)
        .where(
          and(
            eq(appFeedback.id, BigInt(validated.reportId)),
            inArray(appFeedback.source, BUG_SOURCES),
            eq(appFeedback.userId, userId),
          ),
        )
        .for('update')
        .limit(1);
      if (!report || !report.userId) throw notFound();
      if (!report.githubIssueNumber || !feedbackIssueMatches(report.githubIssueUrl, report.githubIssueNumber))
        throw new Error('The GitHub issue is not linked yet');
      const authorRole = 'reporter' as const;
      const [inserted] = await transaction
        .insert(appFeedbackMessages)
        .values({
          reportId: report.id,
          authorId: userId,
          authorRole,
          body: validated.body,
          submittedBodyHash: createHash('sha256').update(validated.body).digest('hex'),
          clientMutationId: validated.clientMutationId,
          notificationUuid: randomUUID(),
        })
        .onConflictDoNothing({ target: [appFeedbackMessages.authorId, appFeedbackMessages.clientMutationId] })
        .returning();
      if (!inserted) {
        const [previous] = await transaction
          .select()
          .from(appFeedbackMessages)
          .where(
            and(
              eq(appFeedbackMessages.authorId, userId),
              eq(appFeedbackMessages.clientMutationId, validated.clientMutationId),
            ),
          )
          .limit(1);
        if (
          !previous ||
          previous.reportId !== report.id ||
          previous.submittedBodyHash !== createHash('sha256').update(validated.body).digest('hex')
        ) {
          throw new Error('This message identifier has already been used');
        }
        return mapMessage(previous);
      }
      const jobId = await requireJobQueue().send(
        'feedback-github-comment',
        { messageId: String(inserted.id) },
        {
          ...NOTIFICATION_PUSH_RETRIES,
          db: enqueueOn(transaction),
        },
      );
      if (!jobId) throw new Error('GITHUB_COMMENT_ENQUEUE_FAILED');
      return mapMessage(inserted);
    });
    pubsub.publishAppBugReportChanged(userId, { reportId: result.reportId });
    return result;
  },
};
