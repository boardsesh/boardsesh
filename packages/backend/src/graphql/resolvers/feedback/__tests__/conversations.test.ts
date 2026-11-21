import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import {
  appFeedback,
  appFeedbackMessages,
  communityRoles,
  notifications,
  notificationDevices,
  notificationDeliveries,
  users,
} from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import { startJobQueue, stopJobQueue, requireJobQueue } from '../../../../services/job-queue';
import { feedbackConversationQueries as queries, feedbackConversationMutations as mutations } from '../conversations';
import { feedbackQueries } from '../queries';
import {
  importFeedbackGithubComment,
  publishFeedbackGithubComment,
  refreshFeedbackGithubIssue,
  customerReplyBody,
} from '../../../../services/feedback-github-conversations';
import { deliverSprayNotification } from '../../../../services/spray-detection-notifications';
import { socialNotificationQueries } from '../../social/notifications';
import { AppBugReportIdSchema } from '../../../../validation/schemas';
import { pubsub } from '../../../../pubsub';
import { GithubRequestError } from '../../../../lib/github-error';

const { githubRequestMock } = vi.hoisted(() => ({ githubRequestMock: vi.fn() }));
vi.mock('../../../../lib/github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/github-client')>();
  return {
    ...actual,
    githubRequest: githubRequestMock,
    resolveGithubToken: vi.fn().mockResolvedValue('test-token'),
    resolveGithubRepo: () => 'boardsesh/boardsesh',
  };
});
vi.mock('../../../../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

const ctx = (userId: string): ConnectionContext => ({ connectionId: userId, userId, isAuthenticated: true });
const anonymous: ConnectionContext = { connectionId: 'anonymous', isAuthenticated: false };
async function account() {
  const id = randomUUID();
  await db.insert(users).values({ id, name: 'Support tester', email: `${id}@example.test` });
  return id;
}
async function report(userId: string | null, extra: Partial<typeof appFeedback.$inferInsert> = {}) {
  const [row] = await db
    .insert(appFeedback)
    .values({
      userId,
      source: 'drawer-bug',
      platform: 'ios',
      comment: 'The list stopped loading',
      contactConsent: false,
      githubIssueNumber: 4711,
      githubIssueUrl: 'https://github.com/boardsesh/boardsesh/issues/4711',
      ...extra,
    })
    .returning();
  return row;
}
const githubComment = (id = 100, body = '#replytocustomer\nPlease try again.') => ({
  id,
  body,
  created_at: '2026-11-21T12:00:00Z',
  issue_url: 'https://api.github.com/repos/boardsesh/boardsesh/issues/4711',
  user: { login: 'maintainer', type: 'User' },
});
const job = { commentId: 100, issueNumber: 4711, repository: 'boardsesh/boardsesh' };
let reporter: string;
let outsider: string;
let admin: string;
let activeReport: typeof appFeedback.$inferSelect;

beforeAll(async () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await initializeJobQueueSchema(drizzle(client));
  } finally {
    await client.end();
  }
  await startJobQueue();
});
afterAll(() => stopJobQueue());
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  githubRequestMock.mockReset();
  // Every test gets a unique issue number? The issue lookup intentionally keys one report.
  await db.delete(appFeedback).where(eq(appFeedback.githubIssueNumber, 4711));
  reporter = await account();
  outsider = await account();
  admin = await account();
  await db.insert(communityRoles).values({ userId: admin, role: 'admin' });
  activeReport = await report(reporter);
  githubRequestMock.mockImplementation(async (path: string) =>
    path.includes('/permission') ? { permission: 'write' } : githubComment(),
  );
});

describe('reporter-safe bug history and replies', () => {
  it("requires authentication and hides another account's reports", async () => {
    await expect(queries.myAppBugReports(null, {}, anonymous)).rejects.toThrow('Authentication required');
    expect((await queries.myAppBugReports(null, {}, ctx(outsider))).reports).toEqual([]);
    expect(await queries.appBugReport(null, { id: String(activeReport.id) }, ctx(outsider))).toBeNull();
    await expect(
      queries.appBugReportMessages(null, { input: { reportId: String(activeReport.id) } }, ctx(outsider)),
    ).rejects.toThrow('not found');
    const own = await queries.appBugReport(null, { id: String(activeReport.id) }, ctx(reporter));
    expect(own).toMatchObject({ id: String(activeReport.id), canReply: true });
    expect(own).not.toHaveProperty('reporter');
    expect(own).not.toHaveProperty('context');
    expect(own).not.toHaveProperty('resolvedBy');
  });
  it('returns historical bugs, excludes ratings, and pages without repetition', async () => {
    const older = activeReport;
    const newer = await report(reporter, { githubIssueNumber: 4712 });
    await report(reporter, { source: 'prompt', rating: 4 });
    const first = await queries.myAppBugReports(null, { input: { limit: 1 } }, ctx(reporter));
    expect(first.reports.map((entry) => entry.id)).toEqual([String(newer.id)]);
    const second = await queries.myAppBugReports(null, { input: { limit: 1, after: first.endCursor } }, ctx(reporter));
    expect(second.reports.map((entry) => entry.id)).toEqual([String(older.id)]);
    expect(second.hasMore).toBe(false);
  });
  it('queues an owner reply regardless of email consent and deduplicates retries', async () => {
    const input = {
      reportId: String(activeReport.id),
      body: 'I can reproduce this again.',
      clientMutationId: randomUUID(),
    };
    const first = await mutations.sendAppBugReportMessage(null, { input }, ctx(reporter));
    const retried = await mutations.sendAppBugReportMessage(null, { input }, ctx(reporter));
    expect(first).toMatchObject({ authorRole: 'reporter', deliveryStatus: 'pending', body: input.body });
    expect(retried.id).toBe(first.id);
    const stored = await db.select().from(appFeedbackMessages).where(eq(appFeedbackMessages.reportId, activeReport.id));
    expect(stored).toHaveLength(1);
    const [summary] = await db.select().from(appFeedback).where(eq(appFeedback.id, activeReport.id));
    expect(summary.needsReply).toBe(false);
    await expect(mutations.sendAppBugReportMessage(null, { input }, ctx(outsider))).rejects.toThrow('not found');
    await expect(mutations.sendAppBugReportMessage(null, { input }, ctx(admin))).rejects.toThrow('not found');
    await expect(
      mutations.sendAppBugReportMessage(null, { input: { ...input, body: 'A different body' } }, ctx(reporter)),
    ).rejects.toThrow('already been used');
  });
  it.each(['send', 'import'])('orders %s behind account deletion without a row-lock cycle', async (operation) => {
    let signalLocked!: () => void;
    let resumeDeletion!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      resumeDeletion = resolve;
    });
    const deleting = db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '2000ms'`);
      await transaction.select({ id: users.id }).from(users).where(eq(users.id, reporter)).for('update');
      signalLocked();
      await proceed;
      await transaction.delete(users).where(eq(users.id, reporter));
    });
    await locked;
    const concurrent = (
      operation === 'send'
        ? mutations.sendAppBugReportMessage(
            null,
            { input: { reportId: String(activeReport.id), body: 'Details', clientMutationId: randomUUID() } },
            ctx(reporter),
          )
        : importFeedbackGithubComment(job)
    ).then(
      () => 'completed',
      () => 'rejected',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    resumeDeletion();
    await expect(deleting).resolves.toBeUndefined();
    expect(await concurrent).toBe(operation === 'send' ? 'rejected' : 'completed');
    expect(
      await db.select().from(appFeedbackMessages).where(eq(appFeedbackMessages.reportId, activeReport.id)),
    ).toHaveLength(0);
  });
  it('rejects empty/oversized replies and waits for an issue link', async () => {
    const input = { reportId: String(activeReport.id), body: ' ', clientMutationId: randomUUID() };
    await expect(mutations.sendAppBugReportMessage(null, { input }, ctx(reporter))).rejects.toThrow();
    await expect(
      mutations.sendAppBugReportMessage(null, { input: { ...input, body: 'a'.repeat(2001) } }, ctx(reporter)),
    ).rejects.toThrow();
    await db.update(appFeedback).set({ githubIssueNumber: null }).where(eq(appFeedback.id, activeReport.id));
    expect((await queries.appBugReport(null, { id: String(activeReport.id) }, ctx(reporter)))?.canReply).toBe(false);
    await expect(
      mutations.sendAppBugReportMessage(null, { input: { ...input, body: 'Details here' } }, ctx(reporter)),
    ).rejects.toThrow('not linked');
  });
  it('rolls back the message when the durable enqueue fails', async () => {
    vi.spyOn(requireJobQueue(), 'send').mockResolvedValueOnce(null);
    await expect(
      mutations.sendAppBugReportMessage(
        null,
        {
          input: {
            reportId: String(activeReport.id),
            body: 'New details',
            clientMutationId: randomUUID(),
          },
        },
        ctx(reporter),
      ),
    ).rejects.toThrow('ENQUEUE_FAILED');
    expect(
      await db.select().from(appFeedbackMessages).where(eq(appFeedbackMessages.reportId, activeReport.id)),
    ).toHaveLength(0);
  });
  it('restricts failed delivery retry to the owner and keeps the marker stable', async () => {
    const message = await mutations.sendAppBugReportMessage(
      null,
      {
        input: {
          reportId: String(activeReport.id),
          body: 'New details',
          clientMutationId: randomUUID(),
        },
      },
      ctx(reporter),
    );
    await db
      .update(appFeedbackMessages)
      .set({ deliveryStatus: 'failed' })
      .where(eq(appFeedbackMessages.id, BigInt(message.id)));
    await expect(mutations.retryAppBugReportMessage(null, { id: message.id }, ctx(outsider))).rejects.toThrow();
    expect((await mutations.retryAppBugReportMessage(null, { id: message.id }, ctx(reporter))).deliveryStatus).toBe(
      'pending',
    );
    expect(
      await db.select().from(appFeedbackMessages).where(eq(appFeedbackMessages.reportId, activeReport.id)),
    ).toHaveLength(1);
  });
});

describe('trusted GitHub comments', () => {
  it('requires an exact first-line tag', () => {
    expect(customerReplyBody('#replytocustomer\nHello')).toBe('Hello');
    for (const body of [
      'Hello #replytocustomer',
      '> #replytocustomer\nHello',
      '```\n#replytocustomer\n```',
      '#ReplyToCustomer\nHello',
      '#replytocustomer',
    ]) {
      expect(customerReplyBody(body)).toBeNull();
    }
  });
  it('imports a trusted reply once, privately notifies the owner, and ignores consent', async () => {
    const publish = vi.spyOn(pubsub, 'publishNotificationEvent');
    await importFeedbackGithubComment(job);
    await importFeedbackGithubComment(job);
    const messages = await queries.appBugReportMessages(
      null,
      { input: { reportId: String(activeReport.id) } },
      ctx(reporter),
    );
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]).toMatchObject({
      body: 'Please try again.',
      authorRole: 'staff',
      deliveryStatus: 'sent',
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await socialNotificationQueries.notifications(null, {}, ctx(reporter))).notifications).toHaveLength(1);
    expect((await socialNotificationQueries.notifications(null, {}, ctx(outsider))).notifications).toHaveLength(0);
  });
  it.each(['read', 'triage', 'none'])('rejects collaborators with %s permission', async (permission) => {
    githubRequestMock.mockImplementation(async (path: string) =>
      path.includes('/permission') ? { permission } : githubComment(),
    );
    await importFeedbackGithubComment(job);
    expect(
      (await queries.appBugReportMessages(null, { input: { reportId: String(activeReport.id) } }, ctx(reporter)))
        .messages,
    ).toHaveLength(0);
  });
  it('rejects bots even if they could write, and rejects foreign repositories/issues', async () => {
    githubRequestMock.mockResolvedValue({ ...githubComment(), user: { login: 'bot[bot]', type: 'Bot' } });
    await importFeedbackGithubComment(job);
    await importFeedbackGithubComment({ ...job, repository: 'someone/else' });
    await importFeedbackGithubComment({ ...job, issueNumber: 999 });
    expect(
      await db.select().from(appFeedbackMessages).where(eq(appFeedbackMessages.reportId, activeReport.id)),
    ).toHaveLength(0);
  });
  it('edits a cached staff reply without a second push, and withdraws it when its tag disappears', async () => {
    await importFeedbackGithubComment(job);
    githubRequestMock.mockImplementation(async (path: string) =>
      path.includes('/permission')
        ? { permission: 'write' }
        : githubComment(100, '#replytocustomer\nUpdated instructions'),
    );
    await importFeedbackGithubComment(job);
    expect(
      (await queries.appBugReportMessages(null, { input: { reportId: String(activeReport.id) } }, ctx(reporter)))
        .messages[0].body,
    ).toBe('Updated instructions');
    githubRequestMock.mockResolvedValue(githubComment(100, 'Internal comment now'));
    await importFeedbackGithubComment(job);
    expect(
      (await queries.appBugReportMessages(null, { input: { reportId: String(activeReport.id) } }, ctx(reporter)))
        .messages,
    ).toHaveLength(0);
    expect((await socialNotificationQueries.notifications(null, {}, ctx(reporter))).notifications).toHaveLength(0);
  });
  it('withdraws deleted comments from the cache using the current canonical 404', async () => {
    await importFeedbackGithubComment(job);
    githubRequestMock.mockRejectedValue(
      new GithubRequestError('GET', '/comment', {
        status: 404,
        body: 'Not Found',
        requestId: null,
        rateLimitRemaining: null,
        rateLimitReset: null,
      }),
    );
    await importFeedbackGithubComment(job);
    expect(
      (await queries.appBugReportMessages(null, { input: { reportId: String(activeReport.id) } }, ctx(reporter)))
        .messages,
    ).toHaveLength(0);
  });
  it('orders delayed webhook deliveries by GitHub chronology and pages with opaque cursors', async () => {
    githubRequestMock.mockImplementation(async (path: string) =>
      path.includes('/permission')
        ? { permission: 'write' }
        : {
            ...githubComment(path.endsWith('/100') ? 100 : 101),
            created_at: path.endsWith('/100') ? '2026-11-22T10:00:00Z' : '2026-11-20T10:00:00Z',
          },
    );
    await importFeedbackGithubComment(job);
    await importFeedbackGithubComment({ ...job, commentId: 101 });
    const first = await queries.appBugReportMessages(
      null,
      { input: { reportId: String(activeReport.id), limit: 1 } },
      ctx(reporter),
    );
    expect(first.messages[0].createdAt).toContain('2026-11-22');
    expect(first.endCursor).not.toBe(first.messages[0].id);
    const second = await queries.appBugReportMessages(
      null,
      { input: { reportId: String(activeReport.id), limit: 1, before: first.endCursor } },
      ctx(reporter),
    );
    expect(second.messages[0].createdAt).toContain('2026-11-20');
    expect(second.hasMore).toBe(false);
    const [summary] = await db.select().from(appFeedback).where(eq(appFeedback.id, activeReport.id));
    expect(summary.lastMessageAt).toContain('2026-11-22');
  });
  it('filters the admin dashboard by reporter and unanswered app reply', async () => {
    await mutations.sendAppBugReportMessage(
      null,
      { input: { reportId: String(activeReport.id), body: 'Still broken', clientMutationId: randomUUID() } },
      ctx(reporter),
    );
    const [pending] = await db
      .select()
      .from(appFeedbackMessages)
      .where(eq(appFeedbackMessages.reportId, activeReport.id));
    githubRequestMock.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? {
            ...githubComment(201, (JSON.parse(init.body as string) as { body: string }).body),
            user: { login: 'feedback[bot]', type: 'Bot' },
          }
        : [],
    );
    await publishFeedbackGithubComment(String(pending.id));
    githubRequestMock.mockImplementation(async (path: string) =>
      path.includes('/permission') ? { permission: 'write' } : githubComment(),
    );
    const inbox = await feedbackQueries.adminAppFeedback(
      null,
      { input: { reporterId: reporter, needsReply: true } },
      ctx(admin),
    );
    expect(inbox.reports.map((entry) => entry.id)).toEqual([String(activeReport.id)]);
    await importFeedbackGithubComment(job);
    expect(
      (await feedbackQueries.adminAppFeedback(null, { input: { reporterId: reporter, needsReply: true } }, ctx(admin)))
        .reports,
    ).toHaveLength(0);
  });
});

describe('GitHub bot outbox', () => {
  it('posts through the bot without identity, redacts sensitive text, and records delivery', async () => {
    const message = await mutations.sendAppBugReportMessage(
      null,
      {
        input: {
          reportId: String(activeReport.id),
          body: 'Contact me at secret@example.com about this bug.',
          clientMutationId: randomUUID(),
        },
      },
      ctx(reporter),
    );
    githubRequestMock.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? {
            ...githubComment(201, (JSON.parse(init.body as string) as { body: string }).body),
            user: { login: 'feedback[bot]', type: 'Bot' },
          }
        : [],
    );
    await publishFeedbackGithubComment(message.id);
    const posted = githubRequestMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    expect(posted?.[1].body).not.toContain('secret@example.com');
    expect(posted?.[1].body).not.toContain(reporter);
    expect(posted?.[1].body).toContain('boardsesh-feedback-message:');
    const [stored] = await db
      .select()
      .from(appFeedbackMessages)
      .where(eq(appFeedbackMessages.id, BigInt(message.id)));
    expect(stored.deliveryStatus).toBe('sent');
    await publishFeedbackGithubComment(message.id);
    expect(
      githubRequestMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST'),
    ).toHaveLength(1);
  });
  it('mirrors canonical bot edits/deletion while retaining original mutation idempotency', async () => {
    const input = {
      reportId: String(activeReport.id),
      body: 'My email is secret@example.com',
      clientMutationId: randomUUID(),
    };
    const message = await mutations.sendAppBugReportMessage(null, { input }, ctx(reporter));
    githubRequestMock.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? {
            ...githubComment(201, (JSON.parse(init.body as string) as { body: string }).body),
            user: { login: 'feedback[bot]', type: 'Bot' },
          }
        : [],
    );
    await publishFeedbackGithubComment(message.id);
    let cached = (
      await queries.appBugReportMessages(null, { input: { reportId: String(activeReport.id) } }, ctx(reporter))
    ).messages[0];
    expect(cached.body).not.toContain('secret@example.com');
    expect((await mutations.sendAppBugReportMessage(null, { input }, ctx(reporter))).id).toBe(message.id);
    githubRequestMock.mockResolvedValue({
      ...githubComment(201, 'Maintainer corrected this report'),
      user: { login: 'feedback[bot]', type: 'Bot' },
    });
    await importFeedbackGithubComment({ ...job, commentId: 201 });
    cached = (await queries.appBugReportMessages(null, { input: { reportId: String(activeReport.id) } }, ctx(reporter)))
      .messages[0];
    expect(cached).toMatchObject({ authorRole: 'reporter', body: 'Maintainer corrected this report' });
    expect((await mutations.sendAppBugReportMessage(null, { input }, ctx(reporter))).id).toBe(message.id);
    githubRequestMock.mockRejectedValue(
      new GithubRequestError('GET', '/comment', {
        status: 404,
        body: 'Not Found',
        requestId: null,
        rateLimitRemaining: null,
        rateLimitReset: null,
      }),
    );
    await importFeedbackGithubComment({ ...job, commentId: 201 });
    expect(
      (await queries.appBugReportMessages(null, { input: { reportId: String(activeReport.id) } }, ctx(reporter)))
        .messages,
    ).toHaveLength(0);
  });
  it('reconciles an ambiguous POST across comment pages using the bot marker', async () => {
    process.env.FEEDBACK_GITHUB_APP_ID = '123';
    const message = await mutations.sendAppBugReportMessage(
      null,
      {
        input: {
          reportId: String(activeReport.id),
          body: 'Details',
          clientMutationId: randomUUID(),
        },
      },
      ctx(reporter),
    );
    const [stored] = await db
      .select()
      .from(appFeedbackMessages)
      .where(eq(appFeedbackMessages.id, BigInt(message.id)));
    githubRequestMock.mockImplementation(async (path: string) =>
      path.endsWith('page=1')
        ? Array.from({ length: 100 }, (_, index) => githubComment(1000 + index, 'other'))
        : [
            {
              ...githubComment(10000, `Posted\n<!-- boardsesh-feedback-message:${stored.notificationUuid} -->`),
              user: { login: 'feedback[bot]', type: 'Bot' },
              performed_via_github_app: { id: 123 },
            },
          ],
    );
    await publishFeedbackGithubComment(message.id);
    expect(githubRequestMock).toHaveBeenCalledTimes(2);
    expect(
      (
        await db
          .select()
          .from(appFeedbackMessages)
          .where(eq(appFeedbackMessages.id, BigInt(message.id)))
      )[0].githubCommentId,
    ).toBe('10000');
  });
});

describe('support push delivery', () => {
  it.each(['revoked', 'expired', 'reassigned'])(
    'skips %s installations while keeping the inbox reply',
    async (reason) => {
      const installationId = randomUUID();
      await db.insert(notificationDevices).values({
        installationId,
        userId: reporter,
        token: `ExponentPushToken[${installationId}]`,
        platform: 'ios',
        locale: 'en-US',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await importFeedbackGithubComment(job);
      const [notice] = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.recipientId, reporter), eq(notifications.type, 'app_feedback_reply')));
      const [delivery] = await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.notificationUuid, notice.uuid));
      await db
        .update(notificationDevices)
        .set(
          reason === 'revoked'
            ? { active: false }
            : reason === 'expired'
              ? { expiresAt: new Date(0) }
              : { userId: outsider },
        )
        .where(eq(notificationDevices.installationId, installationId));
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await deliverSprayNotification(requireJobQueue(), delivery.id);
      expect(fetch).not.toHaveBeenCalled();
      expect(
        (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id)))[0].status,
      ).toBe('skipped');
      expect((await socialNotificationQueries.notifications(null, {}, ctx(reporter))).notifications).toHaveLength(1);
    },
  );
  it('sends generic copy and the report route, without exposing the discussion body', async () => {
    const installationId = randomUUID();
    await db.insert(notificationDevices).values({
      installationId,
      userId: reporter,
      token: `ExponentPushToken[${installationId}]`,
      platform: 'ios',
      locale: 'en-US',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await importFeedbackGithubComment(job);
    const [notice] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.recipientId, reporter), eq(notifications.type, 'app_feedback_reply')));
    const [delivery] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationUuid, notice.uuid));
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'ok', id: 'ticket' } }) });
    vi.stubGlobal('fetch', fetch);
    await deliverSprayNotification(requireJobQueue(), delivery.id);
    const payload = JSON.parse(fetch.mock.calls[0][1].body as string) as {
      data: { type: string; reportId: string };
      body: string;
    };
    expect(payload.data).toMatchObject({ type: 'app_feedback_reply', reportId: String(activeReport.id) });
    expect(payload.body).not.toContain('Please try again.');
  });
});

describe('GitHub issue status', () => {
  it.each([
    ['open', null, 'new'],
    ['closed', 'completed', 'resolved'],
    ['closed', 'not_planned', 'wont_fix'],
    ['closed', 'duplicate', 'wont_fix'],
  ] as const)('maps canonical %s/%s to %s without altering internal triage', async (state, reason, expected) => {
    await db.update(appFeedback).set({ status: 'in_progress' }).where(eq(appFeedback.id, activeReport.id));
    githubRequestMock.mockImplementation(async (path: string) =>
      path.includes('/comments?')
        ? []
        : {
            number: 4711,
            html_url: activeReport.githubIssueUrl,
            state,
            state_reason: reason,
          },
    );
    await refreshFeedbackGithubIssue({ reportId: String(activeReport.id) });
    expect((await queries.appBugReport(null, { id: String(activeReport.id) }, ctx(reporter)))?.status).toBe(expected);
    expect((await db.select().from(appFeedback).where(eq(appFeedback.id, activeReport.id)))[0].status).toBe(
      'in_progress',
    );
  });
  it('serializes overlapping canonical state refreshes across issue and detail jobs', async () => {
    let started!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let issueReads = 0;
    githubRequestMock.mockImplementation(async (path: string) => {
      if (path.includes('/comments?')) return [];
      issueReads++;
      if (issueReads === 1) {
        started();
        await release;
      }
      return { number: 4711, html_url: activeReport.githubIssueUrl, state: issueReads === 1 ? 'closed' : 'open' };
    });
    const first = refreshFeedbackGithubIssue({ reportId: String(activeReport.id) });
    await firstStarted;
    const second = refreshFeedbackGithubIssue({ issueNumber: 4711, repository: 'boardsesh/boardsesh' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const readsBeforeRelease = issueReads;
    releaseFirst();
    await Promise.all([first, second]);
    expect(readsBeforeRelease).toBe(1);
    expect((await db.select().from(appFeedback).where(eq(appFeedback.id, activeReport.id)))[0].githubIssueState).toBe(
      'open',
    );
  });
  it('recovers missed comments and deletions by reconciling a complete paginated snapshot', async () => {
    await db.update(appFeedback).set({ githubIssueState: 'open' }).where(eq(appFeedback.id, activeReport.id));
    let deleted = false;
    githubRequestMock.mockImplementation(async (path: string) => {
      if (path.includes('/permission')) return { permission: 'write' };
      if (path.includes('/comments?'))
        return deleted
          ? []
          : path.endsWith('page=1')
            ? Array.from({ length: 100 }, (_, index) => githubComment(1000 + index, 'Internal discussion'))
            : [githubComment()];
      if (path.endsWith('/issues/comments/100')) {
        if (deleted)
          throw new GithubRequestError('GET', path, {
            status: 404,
            body: 'Not Found',
            requestId: null,
            rateLimitRemaining: null,
            rateLimitReset: null,
          });
        return githubComment();
      }
      return { number: 4711, html_url: activeReport.githubIssueUrl, state: 'open', state_reason: null };
    });
    const send = vi.spyOn(requireJobQueue(), 'send');
    await refreshFeedbackGithubIssue({ reportId: String(activeReport.id) });
    let queued = send.mock.calls.filter((call) => call[0] === 'feedback-github-inbound');
    expect(queued).toHaveLength(1);
    await importFeedbackGithubComment(queued[0][1] as typeof job);
    expect(
      (await queries.appBugReportMessages(null, { input: { reportId: String(activeReport.id) } }, ctx(reporter)))
        .messages,
    ).toHaveLength(1);
    send.mockClear();
    deleted = true;
    await refreshFeedbackGithubIssue({ reportId: String(activeReport.id) });
    queued = send.mock.calls.filter((call) => call[0] === 'feedback-github-inbound');
    expect(queued).toHaveLength(1);
    await importFeedbackGithubComment(queued[0][1] as typeof job);
    expect(
      (await queries.appBugReportMessages(null, { input: { reportId: String(activeReport.id) } }, ctx(reporter)))
        .messages,
    ).toHaveLength(0);
  });
  it('ignores foreign issue identities and pull requests', async () => {
    githubRequestMock.mockResolvedValue({
      number: 4711,
      html_url: 'https://github.com/else/else/issues/4711',
      state: 'closed',
    });
    await refreshFeedbackGithubIssue({ reportId: String(activeReport.id) });
    expect(
      (await db.select().from(appFeedback).where(eq(appFeedback.id, activeReport.id)))[0].githubIssueState,
    ).toBeNull();
    githubRequestMock.mockResolvedValue({
      number: 4711,
      html_url: activeReport.githubIssueUrl,
      state: 'closed',
      pull_request: {},
    });
    await refreshFeedbackGithubIssue({ reportId: String(activeReport.id) });
    expect(
      (await db.select().from(appFeedback).where(eq(appFeedback.id, activeReport.id)))[0].githubIssueState,
    ).toBeNull();
  });
  it('returns cached history when refresh queueing is unavailable', async () => {
    vi.spyOn(requireJobQueue(), 'send').mockRejectedValue(new Error('queue unavailable'));
    expect((await queries.appBugReport(null, { id: String(activeReport.id) }, ctx(reporter)))?.id).toBe(
      String(activeReport.id),
    );
    expect((await queries.myAppBugReports(null, {}, ctx(reporter))).reports).toHaveLength(1);
  });
  it('reports malformed IDs as validation failures without throwing BigInt errors', () => {
    expect(AppBugReportIdSchema.safeParse('abc').success).toBe(false);
    expect(AppBugReportIdSchema.safeParse('9223372036854775808').success).toBe(false);
  });
});
