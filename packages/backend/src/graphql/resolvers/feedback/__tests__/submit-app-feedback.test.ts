/**
 * Real-DB coverage for `submitAppFeedback` — the path a shake-bug takes from the
 * app to a GitHub issue. Until this file existed, none of it was tested: the
 * insert, the fire-and-forget issue creation, the issue link written back onto
 * the row, and the consent-gated email were all only exercised in production.
 *
 * Only the two outbound side effects are stubbed (`createFeedbackGithubIssue`
 * and the bug-report email). Everything else is real, including the zod schema
 * and the screenshot key → public URL step.
 *
 * Seeds via raw SQL and calls the resolvers directly against the per-worker DB,
 * matching resolvers/feedback/__tests__/admin-feedback.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { FeedbackIssuePayload } from '../../../../services/github-feedback';

const { createFeedbackGithubIssueMock, sendBugReportIssueEmailMock } = vi.hoisted(() => ({
  createFeedbackGithubIssueMock: vi.fn(),
  sendBugReportIssueEmailMock: vi.fn(),
}));

vi.mock('../../../../services/github-feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/github-feedback')>();
  return { ...actual, createFeedbackGithubIssue: createFeedbackGithubIssueMock };
});

vi.mock('@boardsesh/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/email')>();
  return { ...actual, sendBugReportIssueEmail: sendBugReportIssueEmailMock };
});

// The public media bucket, so a report's screenshot keys resolve to real URLs
// instead of degrading to none. Read lazily on the first `getPublicUrl`, so
// setting it here is early enough; nothing in this file talks to R2.
process.env.MEDIA_S3_BUCKET_NAME = 'boardsesh-user-media';
process.env.MEDIA_AWS_ENDPOINT_URL = 'https://acct123.r2.cloudflarestorage.com';
process.env.MEDIA_AWS_REGION = 'auto';
process.env.MEDIA_AWS_ACCESS_KEY_ID = 'media-key';
process.env.MEDIA_AWS_SECRET_ACCESS_KEY = 'media-secret';
process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.boardsesh.com';

const { resetStorageClients } = await import('../../../../storage/s3');
resetStorageClients();

const { db } = await import('../../../../db/client');
const { feedbackMutations } = await import('../mutations');

const SCREENSHOT_KEYS = [
  'feedback-screenshots/11111111-2222-4333-8444-555555555555.jpg',
  'feedback-screenshots/66666666-7777-4888-8999-aaaaaaaaaaaa.png',
];
const SCREENSHOT_URLS = SCREENSHOT_KEYS.map((key) => `https://media.boardsesh.com/${key}`);

const ISSUE = { number: 4321, htmlUrl: 'https://github.com/boardsesh/boardsesh/issues/4321' };

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

const anonCtx = (): ConnectionContext =>
  ({ connectionId: 'conn-anon', isAuthenticated: false, clientIp: '203.0.113.9' }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

// A fresh reporter per test. The in-process rate limiter is keyed
// `userId:operation` and never resets between tests, so reusing one id across
// the file would eventually trip the 10-per-window bound on submitAppFeedback.
let reporterSequence = 0;
const freshReporter = async (): Promise<string> => {
  reporterSequence += 1;
  const userId = `fb-submitter-${reporterSequence}`;
  await insertUser(userId);
  return userId;
};

type StoredRow = {
  // postgres.js hands a bigserial back as a string; the resolver's own returned
  // row carries a bigint. Normalise at the comparison, not here.
  id: string;
  user_id: string | null;
  source: string;
  comment: string | null;
  rating: number | null;
  platform: string;
  contact_consent: boolean | null;
  screenshot_keys: string[] | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
};

const readLatestRow = async (): Promise<StoredRow> => {
  const result = await db.execute(sql`
    SELECT id, user_id, source, comment, rating, platform, contact_consent,
           screenshot_keys, github_issue_number, github_issue_url
    FROM app_feedback ORDER BY id DESC LIMIT 1
  `);
  return Array.from(result as Iterable<StoredRow>)[0];
};

const bugInput = (overrides: Record<string, unknown> = {}) => ({
  comment: 'The board screen freezes when I open the queue',
  platform: 'ios',
  source: 'shake-bug',
  appVersion: '2.3.1',
  ...overrides,
});

const issuePayload = (): FeedbackIssuePayload => createFeedbackGithubIssueMock.mock.calls[0][0] as FeedbackIssuePayload;

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE "app_feedback", "community_roles", "users" RESTART IDENTITY CASCADE`);
  createFeedbackGithubIssueMock.mockReset().mockResolvedValue(ISSUE);
  sendBugReportIssueEmailMock.mockReset().mockResolvedValue(undefined);
});

describe('submitAppFeedback', () => {
  it('stores a bug report, opens an issue, and writes the issue link back onto the row', async () => {
    const reporter = await freshReporter();

    await expect(feedbackMutations.submitAppFeedback(null, { input: bugInput() }, authCtx(reporter))).resolves.toBe(
      true,
    );

    await vi.waitFor(async () => {
      const row = await readLatestRow();
      expect(row.github_issue_number).toBe(ISSUE.number);
      expect(row.github_issue_url).toBe(ISSUE.htmlUrl);
    });

    const row = await readLatestRow();
    expect(row.user_id).toBe(reporter);
    expect(row.source).toBe('shake-bug');
    expect(row.comment).toBe('The board screen freezes when I open the queue');
    expect(issuePayload()).toMatchObject({ feedbackId: BigInt(row.id), source: 'shake-bug', platform: 'ios' });
  });

  it('takes an anonymous report and never tries to email one', async () => {
    await expect(feedbackMutations.submitAppFeedback(null, { input: bugInput() }, anonCtx())).resolves.toBe(true);

    await vi.waitFor(() => {
      expect(createFeedbackGithubIssueMock).toHaveBeenCalledTimes(1);
    });
    expect((await readLatestRow()).user_id).toBeNull();
    expect(sendBugReportIssueEmailMock).not.toHaveBeenCalled();
  });

  it('emails the reporter the issue link only when they consented', async () => {
    const consenting = await freshReporter();

    await feedbackMutations.submitAppFeedback(null, { input: bugInput({ contactConsent: true }) }, authCtx(consenting));

    await vi.waitFor(() => {
      expect(sendBugReportIssueEmailMock).toHaveBeenCalledWith({
        to: `${consenting}@test.com`,
        issueUrl: ISSUE.htmlUrl,
        issueNumber: ISSUE.number,
      });
    });
  });

  it('opens the issue but sends no email when the reporter declined contact', async () => {
    const declining = await freshReporter();

    await feedbackMutations.submitAppFeedback(null, { input: bugInput({ contactConsent: false }) }, authCtx(declining));

    await vi.waitFor(() => {
      expect(createFeedbackGithubIssueMock).toHaveBeenCalledTimes(1);
    });
    expect(sendBugReportIssueEmailMock).not.toHaveBeenCalled();
  });

  it('leaves the issue columns null when no issue was opened', async () => {
    // A rating is not a bug: `createFeedbackGithubIssue` answers null for it,
    // and nothing downstream may run.
    createFeedbackGithubIssueMock.mockResolvedValue(null);
    const rater = await freshReporter();

    await feedbackMutations.submitAppFeedback(
      null,
      { input: { rating: 5, platform: 'ios', source: 'prompt', contactConsent: true } },
      authCtx(rater),
    );

    await vi.waitFor(() => {
      expect(createFeedbackGithubIssueMock).toHaveBeenCalledTimes(1);
    });
    const row = await readLatestRow();
    expect(row.rating).toBe(5);
    expect(row.github_issue_number).toBeNull();
    expect(row.github_issue_url).toBeNull();
    expect(sendBugReportIssueEmailMock).not.toHaveBeenCalled();
  });

  it('still records the report when the GitHub side effect blows up', async () => {
    createFeedbackGithubIssueMock.mockRejectedValue(new Error('GitHub is down'));
    const reporter = await freshReporter();

    await expect(
      feedbackMutations.submitAppFeedback(null, { input: bugInput({ contactConsent: true }) }, authCtx(reporter)),
    ).resolves.toBe(true);

    await vi.waitFor(() => {
      expect(createFeedbackGithubIssueMock).toHaveBeenCalledTimes(1);
    });
    const row = await readLatestRow();
    expect(row.comment).toBe('The board screen freezes when I open the queue');
    expect(row.github_issue_url).toBeNull();
    expect(sendBugReportIssueEmailMock).not.toHaveBeenCalled();
  });

  it('stores the screenshot keys and hands the issue their public URLs', async () => {
    const reporter = await freshReporter();

    await feedbackMutations.submitAppFeedback(
      null,
      { input: bugInput({ screenshotKeys: SCREENSHOT_KEYS }) },
      authCtx(reporter),
    );

    await vi.waitFor(() => {
      expect(createFeedbackGithubIssueMock).toHaveBeenCalledTimes(1);
    });
    // Keys on the row, URLs on the issue: the public base is a deploy-time
    // detail, so a CDN domain change must not strand the stored rows.
    expect((await readLatestRow()).screenshot_keys).toEqual(SCREENSHOT_KEYS);
    expect(issuePayload().screenshotUrls).toEqual(SCREENSHOT_URLS);
  });

  it('files the report anyway when the screenshot keys are unusable', async () => {
    // A malformed key is a client bug; losing the crash report over it is the
    // BOARDSESH-84 failure mode this schema's `bestEffort` exists to prevent.
    const reporter = await freshReporter();

    await expect(
      feedbackMutations.submitAppFeedback(
        null,
        { input: bugInput({ screenshotKeys: ['feedback-screenshots/../../etc/passwd'] }) },
        authCtx(reporter),
      ),
    ).resolves.toBe(true);

    await vi.waitFor(() => {
      expect(createFeedbackGithubIssueMock).toHaveBeenCalledTimes(1);
    });
    const row = await readLatestRow();
    expect(row.comment).toBe('The board screen freezes when I open the queue');
    expect(row.screenshot_keys).toBeNull();
    expect(issuePayload().screenshotUrls).toEqual([]);
  });

  it('refuses a bug report with no usable description', async () => {
    const reporter = await freshReporter();

    await expect(
      feedbackMutations.submitAppFeedback(null, { input: bugInput({ comment: 'broke' }) }, authCtx(reporter)),
    ).rejects.toThrow('at least 10 characters');

    expect(createFeedbackGithubIssueMock).not.toHaveBeenCalled();
  });
});
