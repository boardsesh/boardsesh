import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { AppFeedbackReport, ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import { feedbackQueries } from '../queries';
import { feedbackMutations } from '../mutations';

/**
 * Real-DB coverage for the admin feedback dashboard: the adminAppFeedback list
 * query (admin gate, type/status/search filters, reporter join, counts,
 * pagination) and the updateAppFeedbackStatus mutation (status stamping). Seeds
 * via raw SQL and calls the resolvers directly against the per-worker test DB.
 */

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

const anonCtx = (): ConnectionContext => ({ connectionId: 'conn-anon', isAuthenticated: false }) as ConnectionContext;

const ADMIN = 'fb-admin';
const NON_ADMIN = 'fb-plain';
const REPORTER = 'fb-reporter';

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertRole = (userId: string, role: string, boardType: string | null) =>
  db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES (${userId}, ${role}, ${boardType}, now())
  `);

const insertFeedback = async (opts: {
  userId?: string | null;
  source: string;
  comment?: string | null;
  rating?: number | null;
  platform?: string;
  status?: string;
  contactConsent?: boolean | null;
  githubIssueNumber?: number | null;
  githubIssueUrl?: string | null;
  createdAt?: string;
}): Promise<bigint> => {
  const {
    userId = null,
    source,
    comment = null,
    rating = null,
    platform = 'ios',
    status = 'new',
    contactConsent = null,
    githubIssueNumber = null,
    githubIssueUrl = null,
    createdAt,
  } = opts;
  const result = await db.execute(sql`
    INSERT INTO app_feedback
      (user_id, source, comment, rating, platform, status, contact_consent, github_issue_number, github_issue_url, created_at)
    VALUES (
      ${userId}, ${source}, ${comment}, ${rating}, ${platform}, ${status},
      ${contactConsent}, ${githubIssueNumber}, ${githubIssueUrl}, ${createdAt ?? sql`now()`}
    )
    RETURNING id
  `);
  return BigInt(Array.from(result as Iterable<{ id: bigint }>)[0].id);
};

const readRow = async (
  id: bigint,
): Promise<{ status: string; resolved_at: string | null; resolved_by: string | null }> => {
  const result = await db.execute(sql`
    SELECT status, resolved_at, resolved_by FROM app_feedback WHERE id = ${id} LIMIT 1
  `);
  return Array.from(result as Iterable<{ status: string; resolved_at: string | null; resolved_by: string | null }>)[0];
};

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE "app_feedback", "community_roles", "users" RESTART IDENTITY CASCADE`);
  await Promise.all([insertUser(ADMIN), insertUser(NON_ADMIN), insertUser(REPORTER)]);
  await insertRole(ADMIN, 'admin', null);
});

describe('adminAppFeedback auth gate', () => {
  it('rejects an unauthenticated caller', async () => {
    await expect(feedbackQueries.adminAppFeedback(null, { input: {} }, anonCtx())).rejects.toThrow(
      /Authentication required/i,
    );
  });

  it('rejects an authenticated non-admin caller', async () => {
    await expect(feedbackQueries.adminAppFeedback(null, { input: {} }, authCtx(NON_ADMIN))).rejects.toThrow(
      /Admin role required/i,
    );
  });
});

describe('adminAppFeedback listing', () => {
  it('returns rows newest-first with reporter email joined', async () => {
    await insertFeedback({
      userId: REPORTER,
      source: 'drawer-bug',
      comment: 'older bug',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await insertFeedback({
      userId: null,
      source: 'shake-bug',
      comment: 'newer anon bug',
      createdAt: '2026-01-02T00:00:00Z',
    });

    const result = await feedbackQueries.adminAppFeedback(null, { input: {} }, authCtx(ADMIN));

    expect(result.totalCount).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.reports.map((r: AppFeedbackReport) => r.comment)).toEqual(['newer anon bug', 'older bug']);

    const [newer, older] = result.reports;
    expect(newer.reporter).toBeNull(); // anonymous row
    expect(older.reporter?.email).toBe('fb-reporter@test.com');
    expect(older.reporter?.userId).toBe(REPORTER);
  });

  it('filters by type (bugs vs ratings)', async () => {
    await insertFeedback({ source: 'drawer-bug', comment: 'a bug' });
    await insertFeedback({ source: 'shake-bug', comment: 'another bug' });
    await insertFeedback({ source: 'prompt', rating: 5, comment: 'nice app' });
    await insertFeedback({ source: 'drawer-feedback', rating: 2, comment: 'meh' });

    const bugs = await feedbackQueries.adminAppFeedback(null, { input: { type: 'bugs' } }, authCtx(ADMIN));
    expect(bugs.totalCount).toBe(2);
    expect(bugs.reports.every((r: AppFeedbackReport) => r.source === 'drawer-bug' || r.source === 'shake-bug')).toBe(
      true,
    );

    const ratings = await feedbackQueries.adminAppFeedback(null, { input: { type: 'ratings' } }, authCtx(ADMIN));
    expect(ratings.totalCount).toBe(2);
    expect(
      ratings.reports.every((r: AppFeedbackReport) => r.source === 'prompt' || r.source === 'drawer-feedback'),
    ).toBe(true);

    const all = await feedbackQueries.adminAppFeedback(null, { input: { type: 'all' } }, authCtx(ADMIN));
    expect(all.totalCount).toBe(4);
  });

  it('filters by status and reports status counts independent of the status filter', async () => {
    await insertFeedback({ source: 'drawer-bug', comment: 'new one', status: 'new' });
    await insertFeedback({ source: 'drawer-bug', comment: 'in prog', status: 'in_progress' });
    await insertFeedback({ source: 'drawer-bug', comment: 'done one', status: 'resolved' });
    await insertFeedback({ source: 'drawer-bug', comment: 'done two', status: 'resolved' });

    const resolved = await feedbackQueries.adminAppFeedback(
      null,
      { input: { type: 'bugs', status: 'resolved' } },
      authCtx(ADMIN),
    );
    expect(resolved.totalCount).toBe(2);
    expect(resolved.reports.every((r: AppFeedbackReport) => r.status === 'resolved')).toBe(true);
    // Counts reflect the type filter, not the active status filter.
    expect(resolved.statusCounts).toEqual({ new: 1, inProgress: 1, resolved: 2, wontFix: 0 });
  });

  it('filters by comment search (case-insensitive, metachars escaped)', async () => {
    await insertFeedback({ source: 'drawer-bug', comment: 'Crash on the SEARCH screen' });
    await insertFeedback({ source: 'drawer-bug', comment: 'unrelated' });
    await insertFeedback({ source: 'drawer-bug', comment: '100% broken' });

    const match = await feedbackQueries.adminAppFeedback(null, { input: { search: 'search' } }, authCtx(ADMIN));
    expect(match.totalCount).toBe(1);
    expect(match.reports[0].comment).toBe('Crash on the SEARCH screen');

    // A '%' in the query must match literally, not act as a wildcard.
    const literal = await feedbackQueries.adminAppFeedback(null, { input: { search: '100%' } }, authCtx(ADMIN));
    expect(literal.totalCount).toBe(1);
    expect(literal.reports[0].comment).toBe('100% broken');
  });

  it('paginates with hasMore + offset', async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertFeedback({
        source: 'drawer-bug',
        comment: `bug ${index}`,
        createdAt: `2026-02-0${index + 1}T00:00:00Z`,
      });
    }

    const firstPage = await feedbackQueries.adminAppFeedback(null, { input: { limit: 2, offset: 0 } }, authCtx(ADMIN));
    expect(firstPage.reports).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.totalCount).toBe(3);

    const secondPage = await feedbackQueries.adminAppFeedback(null, { input: { limit: 2, offset: 2 } }, authCtx(ADMIN));
    expect(secondPage.reports).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
  });
});

describe('updateAppFeedbackStatus', () => {
  it('rejects a non-admin caller', async () => {
    const id = await insertFeedback({ source: 'drawer-bug', comment: 'a bug' });
    await expect(
      feedbackMutations.updateAppFeedbackStatus(
        null,
        { input: { id: String(id), status: 'resolved' } },
        authCtx(NON_ADMIN),
      ),
    ).rejects.toThrow(/Admin role required/i);
  });

  it('stamps resolved_at + resolved_by when moved to a terminal state', async () => {
    const id = await insertFeedback({ source: 'drawer-bug', comment: 'a bug', status: 'new' });

    const report = await feedbackMutations.updateAppFeedbackStatus(
      null,
      { input: { id: String(id), status: 'resolved' } },
      authCtx(ADMIN),
    );
    expect(report.status).toBe('resolved');
    // resolvedBy surfaces the resolving admin's email.
    expect(report.resolvedBy).toBe('fb-admin@test.com');

    const row = await readRow(id);
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolved_by).toBe(ADMIN);
  });

  it('clears resolved_at + resolved_by when reopened', async () => {
    const id = await insertFeedback({ source: 'drawer-bug', comment: 'a bug', status: 'new' });
    await feedbackMutations.updateAppFeedbackStatus(
      null,
      { input: { id: String(id), status: 'resolved' } },
      authCtx(ADMIN),
    );

    await feedbackMutations.updateAppFeedbackStatus(
      null,
      { input: { id: String(id), status: 'in_progress' } },
      authCtx(ADMIN),
    );

    const row = await readRow(id);
    expect(row.status).toBe('in_progress');
    expect(row.resolved_at).toBeNull();
    expect(row.resolved_by).toBeNull();
  });

  it('throws when the feedback row does not exist', async () => {
    await expect(
      feedbackMutations.updateAppFeedbackStatus(null, { input: { id: '999999', status: 'resolved' } }, authCtx(ADMIN)),
    ).rejects.toThrow(/not found/i);
  });
});
