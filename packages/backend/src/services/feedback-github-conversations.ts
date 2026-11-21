import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { z } from 'zod';
import { redactSensitiveText } from '@boardsesh/text-redaction';
import { appFeedback, appFeedbackMessages, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { githubRequest, resolveGithubRepo, resolveGithubToken } from '../lib/github-client';
import { GithubRequestError } from '../lib/github-error';
import { enqueueFeedbackReply } from './feedback-notifications';
import { pubsub } from '../pubsub';
import { enqueueOn, getJobQueue, requireJobQueue } from './job-queue';
import { NOTIFICATION_PUSH_RETRIES } from './notification-push-options';
import { logger } from '../utils/logger';
import { FEEDBACK_COMMENT_LOCK_SEED, FEEDBACK_ISSUE_LOCK_SEED } from './notification-locks';

export const FEEDBACK_GITHUB_COMMENT_QUEUE = 'feedback-github-comment';
export const FEEDBACK_GITHUB_INBOUND_QUEUE = 'feedback-github-inbound';
export const FEEDBACK_GITHUB_ISSUE_QUEUE = 'feedback-github-issue';
const BUG_SOURCES = ['shake-bug', 'drawer-bug'];
const commentSchema = z.object({
  id: z.number().int().positive().safe(),
  body: z.string().nullable(),
  issue_url: z.string(),
  created_at: z.string().datetime(),
  user: z.object({ login: z.string(), type: z.string() }),
  performed_via_github_app: z.object({ id: z.number().int().positive().safe() }).nullable().optional(),
});
export type FeedbackGithubInboundJob = { commentId: number; issueNumber: number; repository: string };

/** Only the exact marker on its own first line publishes a collaborator response. */
export function customerReplyBody(comment: string): string | null {
  const [firstLine, ...bodyLines] = comment.split('\n');
  const command = firstLine.trim();
  if (command !== '/reply' && command !== '#replytocustomer') return null;
  return bodyLines.join('\n').trim() || null;
}

export function feedbackIssueMatches(
  issueUrl: string | null,
  issueNumber: number,
  repository = resolveGithubRepo(),
): boolean {
  return issueUrl === `https://github.com/${repository}/issues/${issueNumber}`;
}

function reporterCommentBody(body: string, markerId: string): string {
  return body
    .replace(/^Reply from the bug reporter:\s*\n/, '')
    .replace(`<!-- boardsesh-feedback-message:${markerId} -->`, '')
    .trim();
}
function cacheChangeEvent(recipientId: string, message: typeof appFeedbackMessages.$inferSelect) {
  return { recipientId, reportId: String(message.reportId) };
}

async function requiredToken() {
  const token = await resolveGithubToken();
  if (!token) throw new Error('GitHub feedback authentication is unavailable');
  return token;
}

async function hasWritePermission(repository: string, login: string, token: string): Promise<boolean> {
  try {
    const permission = z
      .object({ permission: z.string() })
      .parse(
        await githubRequest<unknown>(
          `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
          { signal: AbortSignal.timeout(15_000) },
          token,
        ),
      );
    return ['write', 'maintain', 'admin'].includes(permission.permission);
  } catch (error) {
    if (error instanceof GithubRequestError && error.status === 404) return false;
    throw error;
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function refreshReportSummary(transaction: Transaction, reportId: bigint) {
  const [latest] = await transaction
    .select()
    .from(appFeedbackMessages)
    .where(
      and(
        eq(appFeedbackMessages.reportId, reportId),
        isNull(appFeedbackMessages.withdrawnAt),
        eq(appFeedbackMessages.deliveryStatus, 'sent'),
      ),
    )
    .orderBy(
      desc(appFeedbackMessages.createdAt),
      desc(sql`${appFeedbackMessages.githubCommentId}::bigint`),
      desc(appFeedbackMessages.id),
    )
    .limit(1);
  await transaction
    .update(appFeedback)
    .set({
      lastMessageAt: latest?.createdAt ?? null,
      lastMessagePreview: latest?.body.slice(0, 160) ?? null,
      needsReply: latest?.authorRole === 'reporter',
    })
    .where(eq(appFeedback.id, reportId));
}

/** Canonical GitHub reads make duplicate and reordered webhook deliveries harmless. */
export async function importFeedbackGithubComment(job: FeedbackGithubInboundJob): Promise<void> {
  const repository = resolveGithubRepo();
  if (job.repository !== repository) return;
  const token = await requiredToken();
  const event = await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`feedback-comment:${job.commentId}`}, ${FEEDBACK_COMMENT_LOCK_SEED}))`,
    );
    const [candidate] = await transaction
      .select()
      .from(appFeedback)
      .where(and(eq(appFeedback.githubIssueNumber, job.issueNumber), inArray(appFeedback.source, BUG_SOURCES)))
      .limit(1);
    if (!candidate?.userId || !feedbackIssueMatches(candidate.githubIssueUrl, job.issueNumber, repository)) return null;
    let canonical: z.infer<typeof commentSchema> | null;
    try {
      canonical = commentSchema.parse(
        await githubRequest<unknown>(
          `/repos/${repository}/issues/comments/${job.commentId}`,
          { signal: AbortSignal.timeout(15_000) },
          token,
        ),
      );
    } catch (error) {
      if (error instanceof GithubRequestError && error.status === 404) canonical = null;
      else throw error;
    }
    const staffBody =
      canonical?.user.type === 'User' &&
      canonical.id === job.commentId &&
      canonical.issue_url === `https://api.github.com/repos/${repository}/issues/${job.issueNumber}`
        ? customerReplyBody(canonical.body ?? '')
        : null;
    const trusted =
      staffBody !== null && canonical !== null && (await hasWritePermission(repository, canonical.user.login, token));
    // Fetch GitHub before row locks, then follow account deletion's users -> report order.
    const [account] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, candidate.userId))
      .for('key share')
      .limit(1);
    if (!account) return null;
    const [report] = await transaction
      .select()
      .from(appFeedback)
      .where(and(eq(appFeedback.id, candidate.id), eq(appFeedback.userId, candidate.userId)))
      .for('update')
      .limit(1);
    if (!report || !report.userId || !feedbackIssueMatches(report.githubIssueUrl, job.issueNumber, repository))
      return null;
    const [existing] = await transaction
      .select()
      .from(appFeedbackMessages)
      .where(eq(appFeedbackMessages.githubCommentId, String(job.commentId)))
      .limit(1);
    // A known bot comment remains a reporter message. Mirror canonical edits/deletion,
    // including staff edits to that bot comment, without classifying it as staff.
    if (existing?.authorRole === 'reporter') {
      if (existing.reportId !== report.id || (canonical === null && existing.withdrawnAt !== null)) return null;
      const body =
        canonical?.id === job.commentId &&
        canonical.issue_url === `https://api.github.com/repos/${repository}/issues/${job.issueNumber}`
          ? reporterCommentBody(canonical.body ?? '', existing.notificationUuid)
          : null;
      if (
        body !== null &&
        existing.withdrawnAt === null &&
        existing.body === body &&
        Date.parse(existing.createdAt) === Date.parse(canonical!.created_at)
      )
        return null;
      await transaction
        .update(appFeedbackMessages)
        .set(
          body === null
            ? { withdrawnAt: new Date().toISOString() }
            : { body, createdAt: canonical!.created_at, withdrawnAt: null, deliveryStatus: 'sent' },
        )
        .where(eq(appFeedbackMessages.id, existing.id));
      await refreshReportSummary(transaction, report.id);
      return cacheChangeEvent(report.userId, existing);
    }
    const body = staffBody;
    if (!trusted || !body) {
      if (existing && existing.reportId === report.id && existing.withdrawnAt === null) {
        await transaction
          .update(appFeedbackMessages)
          .set({ withdrawnAt: new Date().toISOString() })
          .where(eq(appFeedbackMessages.id, existing.id));
        await refreshReportSummary(transaction, report.id);
        return cacheChangeEvent(report.userId, existing);
      }
      return null;
    }
    if (existing) {
      if (existing.reportId !== report.id) return null;
      if (
        existing.withdrawnAt === null &&
        existing.body === body &&
        Date.parse(existing.createdAt) === Date.parse(canonical!.created_at)
      )
        return null;
      await transaction
        .update(appFeedbackMessages)
        .set({ body, createdAt: canonical!.created_at, withdrawnAt: null })
        .where(eq(appFeedbackMessages.id, existing.id));
      await refreshReportSummary(transaction, report.id);
      return cacheChangeEvent(report.userId, existing);
    }
    const [inserted] = await transaction
      .insert(appFeedbackMessages)
      .values({
        reportId: report.id,
        authorRole: 'staff',
        deliveryStatus: 'sent',
        body,
        createdAt: canonical!.created_at,
        clientMutationId: randomUUID(),
        notificationUuid: randomUUID(),
        githubCommentId: String(job.commentId),
      })
      .returning();
    await refreshReportSummary(transaction, report.id);
    const notification = await enqueueFeedbackReply(transaction, report.userId, inserted);
    return { recipientId: report.userId, reportId: String(report.id), notification };
  });
  if (event) {
    if ('notification' in event)
      pubsub.publishNotificationEvent(event.recipientId, { notification: event.notification });
    pubsub.publishAppBugReportChanged(event.recipientId, { reportId: event.reportId });
  }
}

/** Durable, idempotent app -> GitHub publishing. Marker contains no account identity. */
export async function publishFeedbackGithubComment(messageId: string): Promise<void> {
  const token = await requiredToken();
  const repository = resolveGithubRepo();
  const [pending] = await db
    .select({ reportId: appFeedbackMessages.reportId })
    .from(appFeedbackMessages)
    .where(eq(appFeedbackMessages.id, BigInt(messageId)))
    .limit(1);
  if (!pending) return;
  const event = await db.transaction(async (transaction) => {
    // All conversation writers lock the report before a message, avoiding an inversion with imports.
    const [report] = await transaction
      .select()
      .from(appFeedback)
      .where(eq(appFeedback.id, pending.reportId))
      .for('update')
      .limit(1);
    const [message] = await transaction
      .select()
      .from(appFeedbackMessages)
      .where(eq(appFeedbackMessages.id, BigInt(messageId)))
      .for('update')
      .limit(1);
    if (!message || message.authorRole !== 'reporter' || message.githubCommentId || message.withdrawnAt) return;
    if (
      !report?.userId ||
      !report.githubIssueNumber ||
      !feedbackIssueMatches(report.githubIssueUrl, report.githubIssueNumber, repository)
    )
      return;
    const marker = `<!-- boardsesh-feedback-message:${message.notificationUuid} -->`;
    const appId = process.env.FEEDBACK_GITHUB_APP_ID?.trim();
    let githubCommentId: number | null = null;
    let canonicalBody = redactSensitiveText(message.body);
    let canonicalCreatedAt = message.createdAt;
    for (let page = 1; ; page++) {
      const comments = z
        .array(commentSchema)
        .parse(
          await githubRequest<unknown>(
            `/repos/${repository}/issues/${report.githubIssueNumber}/comments?per_page=100&page=${page}`,
            { signal: AbortSignal.timeout(15_000) },
            token,
          ),
        );
      const previous = comments.find(
        (comment) =>
          comment.body?.includes(marker) &&
          comment.user.type === 'Bot' &&
          String(comment.performed_via_github_app?.id) === appId,
      );
      if (previous) {
        githubCommentId = previous.id;
        canonicalBody = reporterCommentBody(previous.body ?? '', message.notificationUuid);
        canonicalCreatedAt = previous.created_at;
        break;
      }
      if (comments.length < 100) break;
    }
    if (githubCommentId === null) {
      const posted = commentSchema.parse(
        await githubRequest<unknown>(
          `/repos/${repository}/issues/${report.githubIssueNumber}/comments`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(15_000),
            body: JSON.stringify({
              body: `Reply from the bug reporter:\n\n${redactSensitiveText(message.body)}\n\n${marker}`,
            }),
          },
          token,
        ),
      );
      githubCommentId = posted.id;
      canonicalBody = reporterCommentBody(posted.body ?? '', message.notificationUuid);
      canonicalCreatedAt = posted.created_at;
    }
    await transaction
      .update(appFeedbackMessages)
      .set({
        githubCommentId: String(githubCommentId),
        deliveryStatus: 'sent',
        body: canonicalBody,
        createdAt: canonicalCreatedAt,
      })
      .where(eq(appFeedbackMessages.id, message.id));
    await refreshReportSummary(transaction, report.id);
    return cacheChangeEvent(report.userId, message);
  });
  if (event) pubsub.publishAppBugReportChanged(event.recipientId, { reportId: event.reportId });
}

export type FeedbackGithubIssueJob = { reportId: string } | { issueNumber: number; repository: string };

/** Queries enqueue a throttled refresh without waiting for GitHub or blocking report access. */
export async function requestFeedbackGithubIssueRefresh(reportId: string): Promise<void> {
  try {
    await getJobQueue()?.send(
      FEEDBACK_GITHUB_ISSUE_QUEUE,
      { reportId },
      {
        ...NOTIFICATION_PUSH_RETRIES,
        singletonKey: reportId,
        singletonSeconds: 30,
      },
    );
  } catch {
    logger.warn('[feedback] GitHub issue refresh queue unavailable', { reportId });
  }
}

/** Recover missed webhooks from a complete canonical snapshot, without copying internal discussion. */
async function reconcileFeedbackCommentSnapshot(
  transaction: Transaction,
  reportId: bigint,
  issueNumber: number,
  repository: string,
  token: string,
): Promise<void> {
  const cached = await transaction
    .select({ githubCommentId: appFeedbackMessages.githubCommentId })
    .from(appFeedbackMessages)
    .where(
      and(
        eq(appFeedbackMessages.reportId, reportId),
        eq(appFeedbackMessages.deliveryStatus, 'sent'),
        isNotNull(appFeedbackMessages.githubCommentId),
      ),
    );
  // Known IDs are rechecked even when absent: canonical404 withdraws deleted comments.
  const commentIds = new Set(cached.map((message) => Number(message.githubCommentId)));
  for (let page = 1; ; page++) {
    const comments = z
      .array(commentSchema)
      .parse(
        await githubRequest<unknown>(
          `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
          { signal: AbortSignal.timeout(15_000) },
          token,
        ),
      );
    for (const comment of comments) {
      if (comment.user.type === 'User' && customerReplyBody(comment.body ?? '') !== null) commentIds.add(comment.id);
    }
    if (comments.length < 100) break;
  }
  if (commentIds.size === 0) return;
  const boss = requireJobQueue();
  for (const commentId of commentIds) {
    const queued = await boss.send(
      FEEDBACK_GITHUB_INBOUND_QUEUE,
      { commentId, issueNumber, repository },
      {
        ...NOTIFICATION_PUSH_RETRIES,
        db: enqueueOn(transaction),
      },
    );
    if (!queued) throw new Error('GITHUB_COMMENT_RECONCILIATION_ENQUEUE_FAILED');
  }
}

export async function refreshFeedbackGithubIssue(job: FeedbackGithubIssueJob): Promise<void> {
  const repository = resolveGithubRepo();
  if ('repository' in job && job.repository !== repository) return;
  const [candidate] = await db
    .select()
    .from(appFeedback)
    .where(
      and(
        'reportId' in job
          ? eq(appFeedback.id, BigInt(job.reportId))
          : eq(appFeedback.githubIssueNumber, job.issueNumber),
        inArray(appFeedback.source, BUG_SOURCES),
      ),
    )
    .limit(1);
  if (
    !candidate?.githubIssueNumber ||
    !feedbackIssueMatches(candidate.githubIssueUrl, candidate.githubIssueNumber, repository)
  )
    return;
  const event = await db.transaction(async (transaction) => {
    // Serialize all replicas and event kinds before reading GitHub's current state.
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`feedback-issue:${repository}:${candidate.githubIssueNumber}`}, ${FEEDBACK_ISSUE_LOCK_SEED}))`,
    );
    const [report] = await transaction.select().from(appFeedback).where(eq(appFeedback.id, candidate.id)).limit(1);
    if (
      !report?.githubIssueNumber ||
      !feedbackIssueMatches(report.githubIssueUrl, report.githubIssueNumber, repository)
    )
      return null;
    const token = await requiredToken();
    const canonical = z
      .object({
        number: z.number().int().positive().safe(),
        html_url: z.string(),
        state: z.enum(['open', 'closed']),
        state_reason: z.string().nullable().optional(),
        pull_request: z.unknown().optional(),
      })
      .parse(
        await githubRequest<unknown>(
          `/repos/${repository}/issues/${report.githubIssueNumber}`,
          { signal: AbortSignal.timeout(15_000) },
          token,
        ),
      );
    if (
      canonical.pull_request !== undefined ||
      canonical.number !== report.githubIssueNumber ||
      !feedbackIssueMatches(canonical.html_url, report.githubIssueNumber, repository)
    )
      return null;
    // This must also run when the cached issue status already matches GitHub.
    if (report.userId)
      await reconcileFeedbackCommentSnapshot(transaction, report.id, report.githubIssueNumber, repository, token);
    if (
      report.githubIssueState === canonical.state &&
      report.githubIssueStateReason === (canonical.state_reason ?? null)
    )
      return null;
    const [updated] = await transaction
      .update(appFeedback)
      .set({ githubIssueState: canonical.state, githubIssueStateReason: canonical.state_reason ?? null })
      .where(
        and(
          eq(appFeedback.id, report.id),
          eq(appFeedback.githubIssueNumber, canonical.number),
          eq(appFeedback.githubIssueUrl, canonical.html_url),
        ),
      )
      .returning({ userId: appFeedback.userId });
    return updated?.userId ? { recipientId: updated.userId, reportId: String(report.id) } : null;
  });
  if (event) pubsub.publishAppBugReportChanged(event.recipientId, { reportId: event.reportId });
}

export async function startFeedbackGithubConversations(boss: PgBoss): Promise<void> {
  await boss.work<FeedbackGithubIssueJob>(
    FEEDBACK_GITHUB_ISSUE_QUEUE,
    { localConcurrency: 1, batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await refreshFeedbackGithubIssue(job.data);
    },
  );
  await boss.work(
    FEEDBACK_GITHUB_COMMENT_QUEUE,
    { localConcurrency: 1, batchSize: 1, includeMetadata: true },
    async (jobs: JobWithMetadata<{ messageId: string }>[]) => {
      for (const job of jobs) {
        try {
          await publishFeedbackGithubComment(job.data.messageId);
        } catch (error) {
          if (job.retryCount >= job.retryLimit) {
            const [failed] = await db
              .update(appFeedbackMessages)
              .set({ deliveryStatus: 'failed' })
              .where(
                and(
                  eq(appFeedbackMessages.id, BigInt(job.data.messageId)),
                  isNull(appFeedbackMessages.githubCommentId),
                ),
              )
              .returning({ reportId: appFeedbackMessages.reportId });
            if (failed) {
              const [owner] = await db
                .select({ userId: appFeedback.userId })
                .from(appFeedback)
                .where(eq(appFeedback.id, failed.reportId))
                .limit(1);
              if (owner?.userId) pubsub.publishAppBugReportChanged(owner.userId, { reportId: String(failed.reportId) });
            }
          }
          throw error;
        }
      }
    },
  );
  await boss.work<FeedbackGithubInboundJob>(
    FEEDBACK_GITHUB_INBOUND_QUEUE,
    { localConcurrency: 1, batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await importFeedbackGithubComment(job.data);
    },
  );
}
