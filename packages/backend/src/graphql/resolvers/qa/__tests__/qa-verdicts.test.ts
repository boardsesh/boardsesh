/**
 * Real-DB coverage for the crowdsourced-QA resolvers: the tester gate, the
 * preview mapping (test plan + risk parsed out of a real PR body), the verdict
 * round-trip, and the fire-and-forget GitHub mirror writing its comment id back
 * onto the row.
 *
 * Only the GitHub *I/O* is stubbed — `buildQaPreview` and `buildVerdictComment`
 * stay real, so the parsing and the comment wording are exercised end to end.
 * Seeds via raw SQL and calls the resolvers directly against the per-worker DB,
 * matching resolvers/feedback/__tests__/admin-feedback.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { QaPullRequest } from '../../../../services/github-qa';

const {
  readOpenPullRequestsMock,
  getHeadCommitDateMock,
  getHeadCommitDatesMock,
  postVerdictCommentMock,
  applyQaLabelMock,
} = vi.hoisted(() => ({
  readOpenPullRequestsMock: vi.fn(),
  getHeadCommitDateMock: vi.fn(),
  getHeadCommitDatesMock: vi.fn(),
  postVerdictCommentMock: vi.fn(),
  applyQaLabelMock: vi.fn(),
}));

vi.mock('../../../../services/github-qa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/github-qa')>();
  return {
    ...actual,
    readOpenPullRequests: readOpenPullRequestsMock,
    getHeadCommitDate: getHeadCommitDateMock,
    getHeadCommitDates: getHeadCommitDatesMock,
    postVerdictComment: postVerdictCommentMock,
    applyQaLabel: applyQaLabelMock,
  };
});

const { db } = await import('../../../../db/client');
const { qaQueries } = await import('../queries');
const { qaMutations } = await import('../mutations');

const TESTER = 'qa-tester';
const PLAIN = 'qa-plain';

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

const anonCtx = (): ConnectionContext => ({ connectionId: 'conn-anon', isAuthenticated: false }) as ConnectionContext;

const PR_BODY = [
  '## Test plan',
  '',
  '1. Open the You tab → the note field grows',
  '2. Type 300 characters → the counter turns red',
  '',
  '## Risk',
  '',
  'Risk: 3/5 — new resolver',
].join('\n');

const openPullRequest = (overrides: Partial<QaPullRequest> = {}): QaPullRequest => ({
  number: 4792,
  title: 'Grow the tick note field',
  body: PR_BODY,
  htmlUrl: 'https://github.com/boardsesh/boardsesh/pull/4792',
  isDraft: false,
  updatedAt: '2026-08-26T10:00:00Z',
  author: 'marcodejongh',
  headSha: 'abcdef1234567890',
  ...overrides,
});

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

const insertProfile = (userId: string, displayName: string) =>
  db.execute(sql`
    INSERT INTO user_profiles (user_id, display_name, created_at, updated_at)
    VALUES (${userId}, ${displayName}, now(), now())
    ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name
  `);

const readVerdictRow = async (id: string) => {
  // The timestamps come back as text so the assertions read the stored wall
  // clock exactly, without a driver's Date parsing in the middle.
  const result = await db.execute(sql`
    SELECT github_comment_id, github_comment_url, head_sha, verdict, comment,
           app_version, update_id, runtime_version,
           to_char(head_committed_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS head_committed_at_text,
           to_char(bundle_created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS bundle_created_at_text
    FROM qa_verdicts WHERE id = ${Number(id)} LIMIT 1
  `);
  return Array.from(
    result as Iterable<{
      github_comment_id: string | number | null;
      github_comment_url: string | null;
      head_sha: string | null;
      verdict: string;
      comment: string | null;
      app_version: string | null;
      update_id: string | null;
      runtime_version: string | null;
      head_committed_at_text: string | null;
      bundle_created_at_text: string | null;
    }>,
  )[0];
};

const validInput = (overrides: Record<string, unknown> = {}) => ({
  prNumber: 4792,
  branch: 'pr-4792',
  verdict: 'approved',
  comment: 'LEDs light up on every climb',
  platform: 'ios',
  appVersion: '2.3.1',
  updateId: 'update-abc',
  runtimeVersion: 'fingerprint-1',
  bundleCreatedAt: '2026-08-26T09:30:00Z',
  ...overrides,
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE "qa_verdicts", "community_roles", "user_profiles", "users" RESTART IDENTITY CASCADE`,
  );
  await Promise.all([insertUser(TESTER), insertUser(PLAIN)]);
  await insertRole(TESTER, 'tester', null);
  await insertProfile(TESTER, 'Nic');

  readOpenPullRequestsMock.mockReset().mockResolvedValue({ pullRequests: [openPullRequest()], failed: false });
  getHeadCommitDateMock.mockReset().mockResolvedValue('2026-08-26T09:00:00Z');
  getHeadCommitDatesMock
    .mockReset()
    .mockImplementation(async (shas: string[]) => new Map(shas.map((sha) => [sha, '2026-08-26T09:00:00Z'])));
  postVerdictCommentMock
    .mockReset()
    .mockResolvedValue({ id: 555, htmlUrl: 'https://github.com/boardsesh/boardsesh/pull/4792#issuecomment-555' });
  applyQaLabelMock.mockReset().mockResolvedValue(undefined);
});

describe('qaPreviews tester gate', () => {
  it('rejects an unauthenticated caller', async () => {
    await expect(qaQueries.qaPreviews(null, { prNumbers: [4792] }, anonCtx())).rejects.toThrow(
      'Authentication required',
    );
  });

  it('rejects a signed-in caller without the tester role', async () => {
    await expect(qaQueries.qaPreviews(null, { prNumbers: [4792] }, authCtx(PLAIN))).rejects.toThrow(
      'Tester role required for this operation',
    );
  });
});

describe('qaPreviews', () => {
  it('serves the PR with its test plan steps and risk score', async () => {
    const previews = await qaQueries.qaPreviews(null, { prNumbers: [4792] }, authCtx(TESTER));

    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      prNumber: 4792,
      branch: 'pr-4792',
      title: 'Grow the tick note field',
      author: 'marcodejongh',
      isDraft: false,
      risk: 3,
      riskReason: 'new resolver',
      headCommittedAt: '2026-08-26T09:00:00Z',
      myLatestVerdict: null,
    });
    expect(previews[0].testPlanSteps).toEqual([
      'Open the You tab → the note field grows',
      'Type 300 characters → the counter turns red',
    ]);
  });

  it('omits numbers that are not open pull requests', async () => {
    const previews = await qaQueries.qaPreviews(null, { prNumbers: [4792, 9999] }, authCtx(TESTER));

    expect(previews.map((preview) => preview.prNumber)).toEqual([4792]);
  });

  it('returns an empty list when GitHub is unreachable rather than failing', async () => {
    readOpenPullRequestsMock.mockResolvedValue({ pullRequests: [], failed: true });

    await expect(qaQueries.qaPreviews(null, { prNumbers: [4792] }, authCtx(TESTER))).resolves.toEqual([]);
  });

  it('answers an empty request with an empty list instead of an error', async () => {
    await expect(qaQueries.qaPreviews(null, { prNumbers: [] }, authCtx(TESTER))).resolves.toEqual([]);
    expect(readOpenPullRequestsMock).not.toHaveBeenCalled();
  });

  it('rejects an out-of-bounds request', async () => {
    await expect(qaQueries.qaPreviews(null, { prNumbers: [-3] }, authCtx(TESTER))).rejects.toThrow('Invalid prNumbers');
    await expect(
      qaQueries.qaPreviews(null, { prNumbers: Array.from({ length: 51 }, (_, index) => index + 1) }, authCtx(TESTER)),
    ).rejects.toThrow('Invalid prNumbers');
  });

  it('answers in the order the tester asked, dropping the closed numbers', async () => {
    readOpenPullRequestsMock.mockResolvedValue({
      pullRequests: [openPullRequest({ number: 10 }), openPullRequest({ number: 20 }), openPullRequest({ number: 30 })],
      failed: false,
    });

    const previews = await qaQueries.qaPreviews(null, { prNumbers: [30, 9999, 10, 20] }, authCtx(TESTER));

    expect(previews.map((preview) => preview.prNumber)).toEqual([30, 10, 20]);
  });

  it('round-trips the caller’s latest verdict, and shows it only to them', async () => {
    const submitted = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    const mine = await qaQueries.qaPreviews(null, { prNumbers: [4792] }, authCtx(TESTER));
    expect(mine[0].myLatestVerdict).toMatchObject({
      id: submitted.id,
      prNumber: 4792,
      branch: 'pr-4792',
      verdict: 'approved',
      comment: 'LEDs light up on every climb',
      headSha: 'abcdef1234567890',
    });

    await insertRole(PLAIN, 'tester', null);
    const theirs = await qaQueries.qaPreviews(null, { prNumbers: [4792] }, authCtx(PLAIN));
    expect(theirs[0].myLatestVerdict).toBeNull();
  });
});

describe('submitQaVerdict', () => {
  it('rejects a caller without the tester role', async () => {
    await expect(qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(PLAIN))).rejects.toThrow(
      'Tester role required for this operation',
    );
  });

  it('records the verdict with the PR head it was filed against', async () => {
    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    expect(verdict).toMatchObject({
      prNumber: 4792,
      branch: 'pr-4792',
      verdict: 'approved',
      headSha: 'abcdef1234567890',
    });
    const row = await readVerdictRow(verdict.id);
    expect(row.head_sha).toBe('abcdef1234567890');
    expect(row.head_committed_at_text).toBe('2026-08-26T09:00:00');
  });

  it('refuses a decline with no explanation', async () => {
    await expect(
      qaMutations.submitQaVerdict(null, { input: validInput({ verdict: 'declined', comment: null }) }, authCtx(TESTER)),
    ).rejects.toThrow('at least 10 characters');

    await expect(
      qaMutations.submitQaVerdict(
        null,
        { input: validInput({ verdict: 'declined', comment: 'broke' }) },
        authCtx(TESTER),
      ),
    ).rejects.toThrow('at least 10 characters');
  });

  it('refuses a branch that does not match the PR number', async () => {
    await expect(
      qaMutations.submitQaVerdict(null, { input: validInput({ branch: 'pr-1234' }) }, authCtx(TESTER)),
    ).rejects.toThrow('branch must be pr-4792');
  });

  it('refuses a PR that is not open', async () => {
    readOpenPullRequestsMock.mockResolvedValue({ pullRequests: [openPullRequest({ number: 5000 })], failed: false });

    await expect(qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER))).rejects.toThrow(
      'Pull request is not open',
    );
  });

  it('says GitHub is unreachable instead of claiming the PR is closed', async () => {
    readOpenPullRequestsMock.mockResolvedValue({ pullRequests: [], failed: true });

    await expect(qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER))).rejects.toThrow(
      'Could not reach GitHub',
    );
  });

  it('still says "not open" when the repo really has no open pull requests', async () => {
    readOpenPullRequestsMock.mockResolvedValue({ pullRequests: [], failed: false });

    await expect(qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER))).rejects.toThrow(
      'Pull request is not open',
    );
  });

  it('stores a bundle timestamp with an offset in UTC, so staleness compares like for like', async () => {
    const verdict = await qaMutations.submitQaVerdict(
      null,
      // 09:30+02:00 is 07:30Z — half an hour BEFORE the 08:00Z head commit.
      { input: validInput({ bundleCreatedAt: '2026-08-26T09:30:00+02:00' }) },
      authCtx(TESTER),
    );

    const row = await readVerdictRow(verdict.id);
    expect(row.bundle_created_at_text).toBe('2026-08-26T07:30:00');
  });

  it('mirrors the verdict to GitHub and writes the comment id back onto the row', async () => {
    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    await vi.waitFor(async () => {
      const row = await readVerdictRow(verdict.id);
      expect(Number(row.github_comment_id)).toBe(555);
      expect(row.github_comment_url).toBe('https://github.com/boardsesh/boardsesh/pull/4792#issuecomment-555');
    });

    expect(applyQaLabelMock).toHaveBeenCalledWith(4792, 'approved');
    const [, body] = postVerdictCommentMock.mock.calls[0];
    expect(body).toContain('### ✅ QA approved by Nic');
    expect(body).toContain(`<!-- boardsesh-qa-verdict:${verdict.id} -->`);
    expect(body).not.toContain(`${TESTER}@test.com`);
    expect(body).not.toContain(TESTER);
  });

  it('still returns the verdict when the GitHub mirror fails', async () => {
    postVerdictCommentMock.mockResolvedValue(null);
    applyQaLabelMock.mockRejectedValue(new Error('403'));

    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    expect(verdict.prNumber).toBe(4792);
    const row = await readVerdictRow(verdict.id);
    expect(row.github_comment_id).toBeNull();
  });

  it('records a comment that did post even when the label swap then blows up', async () => {
    applyQaLabelMock.mockRejectedValue(new Error('403'));

    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    // github_comment_id IS NULL is the runbook's "replay by hand" signal, so a
    // comment that landed must never be left looking un-mirrored.
    await vi.waitFor(async () => {
      expect(Number((await readVerdictRow(verdict.id)).github_comment_id)).toBe(555);
    });
  });

  it('takes an approve with no device context at all and still builds a comment', async () => {
    // The app fills device context in on a best effort — an approve with none
    // of it, and no note, is the leanest thing a tester can file.
    const verdict = await qaMutations.submitQaVerdict(
      null,
      {
        input: {
          prNumber: 4792,
          branch: 'pr-4792',
          verdict: 'approved',
          comment: null,
          platform: 'ios',
          appVersion: null,
          updateId: null,
          runtimeVersion: null,
          bundleCreatedAt: null,
        },
      },
      authCtx(TESTER),
    );

    expect(verdict).toMatchObject({ prNumber: 4792, verdict: 'approved', comment: null });

    const row = await readVerdictRow(verdict.id);
    expect(row.comment).toBeNull();
    expect(row.app_version).toBeNull();
    expect(row.update_id).toBeNull();
    expect(row.runtime_version).toBeNull();
    expect(row.bundle_created_at_text).toBeNull();

    // The mirror must render the gaps rather than throw on them.
    await vi.waitFor(() => {
      expect(postVerdictCommentMock).toHaveBeenCalledTimes(1);
    });
    const [, body] = postVerdictCommentMock.mock.calls[0];
    expect(body).toContain('### ✅ QA approved by Nic');
    expect(body).toContain('_No notes._');
    expect(body).toContain('| App version | unknown |');
    expect(body).toContain('| Update id | unknown |');
    expect(body).toContain('| Runtime | unknown |');
    expect(body).toContain('| Bundle published | unknown |');
    expect(body).toContain('| Platform | ios |');
    expect(body).not.toContain('Tested an older revision');
  });

  it('returns createdAt as an instant the app can parse', async () => {
    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    expect(verdict.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/);
    expect(Math.abs(Date.now() - Date.parse(verdict.createdAt))).toBeLessThan(60_000);
  });
});
