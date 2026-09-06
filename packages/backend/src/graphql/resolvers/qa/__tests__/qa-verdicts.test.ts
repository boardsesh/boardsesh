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
import { QA_PREVIEWS_MAX_PR_NUMBERS, type ConnectionContext } from '@boardsesh/shared-schema';
import type { QaPullRequest } from '../../../../services/github-qa';

const {
  readOpenPullRequestsMock,
  getPullRequestMock,
  getHeadCommitDateMock,
  getHeadCommitDatesMock,
  postVerdictCommentMock,
  applyQaLabelMock,
} = vi.hoisted(() => ({
  readOpenPullRequestsMock: vi.fn(),
  getPullRequestMock: vi.fn(),
  getHeadCommitDateMock: vi.fn(),
  getHeadCommitDatesMock: vi.fn(),
  postVerdictCommentMock: vi.fn(),
  applyQaLabelMock: vi.fn(),
}));

// The strict role lookup, forced to fail on demand. Delegates to the real
// implementation otherwise, so every other test in this file still exercises the
// genuine community_roles read.
const testerRole = vi.hoisted(() => ({ readFails: false }));
vi.mock('../../users/tester', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../users/tester')>();
  return {
    ...actual,
    readTesterRole: async (userId: string) => {
      if (testerRole.readFails) throw new Error('community_roles read failed');
      return actual.readTesterRole(userId);
    },
  };
});

vi.mock('../../../../services/github-qa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/github-qa')>();
  return {
    ...actual,
    readOpenPullRequests: readOpenPullRequestsMock,
    getPullRequest: getPullRequestMock,
    getHeadCommitDate: getHeadCommitDateMock,
    getHeadCommitDates: getHeadCommitDatesMock,
    postVerdictComment: postVerdictCommentMock,
    applyQaLabel: applyQaLabelMock,
  };
});

// The public media bucket, so a verdict's screenshot keys resolve to real URLs
// instead of degrading to none. Set before the first storage read, which is
// lazy — nothing here talks to R2; only `getPublicUrl` string-building is used.
process.env.MEDIA_S3_BUCKET_NAME = 'boardsesh-user-media';
process.env.MEDIA_AWS_ENDPOINT_URL = 'https://acct123.r2.cloudflarestorage.com';
process.env.MEDIA_AWS_REGION = 'auto';
process.env.MEDIA_AWS_ACCESS_KEY_ID = 'media-key';
process.env.MEDIA_AWS_SECRET_ACCESS_KEY = 'media-secret';
process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.boardsesh.com';

const { resetStorageClients } = await import('../../../../storage/s3');
resetStorageClients();

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
  labels: [],
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

// A verdict already on the books when the caller files theirs. Seeded straight
// into the table: the tally is a plain query over qa_verdicts, so who wrote the
// row and how it got there is exactly the part that must not matter. `byTester`
// is the one thing that does — only those rows move the label.
const insertExistingVerdict = (userId: string, verdict: string, headSha: string, byTester = true) =>
  db.execute(sql`
    INSERT INTO qa_verdicts (user_id, pr_number, branch, head_sha, verdict, platform, by_tester, created_at)
    VALUES (${userId}, 4792, 'pr-4792', ${headSha}, ${verdict}, 'ios', ${byTester}, now())
  `);

const readVerdictRow = async (id: string) => {
  // The timestamps come back as text so the assertions read the stored wall
  // clock exactly, without a driver's Date parsing in the middle.
  const result = await db.execute(sql`
    SELECT github_comment_id, github_comment_url, head_sha, verdict, comment,
           device_model, os_version, app_version, update_id, runtime_version, screenshot_keys,
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
      device_model: string | null;
      os_version: string | null;
      app_version: string | null;
      update_id: string | null;
      runtime_version: string | null;
      screenshot_keys: string[] | null;
      head_committed_at_text: string | null;
      bundle_created_at_text: string | null;
    }>,
  )[0];
};

const readByTester = async (id: string): Promise<boolean> => {
  const result = await db.execute(sql`SELECT by_tester FROM qa_verdicts WHERE id = ${Number(id)} LIMIT 1`);
  return Array.from(result as Iterable<{ by_tester: boolean }>)[0].by_tester;
};

const validInput = (overrides: Record<string, unknown> = {}) => ({
  prNumber: 4792,
  branch: 'pr-4792',
  verdict: 'approved',
  comment: 'LEDs light up on every climb',
  platform: 'ios',
  deviceModel: 'iPhone 17 Pro',
  osVersion: '26.1',
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
  getPullRequestMock.mockReset().mockResolvedValue({ status: 'open', pullRequest: openPullRequest() });
  getHeadCommitDateMock.mockReset().mockResolvedValue('2026-08-26T09:00:00Z');
  getHeadCommitDatesMock
    .mockReset()
    .mockImplementation(async (shas: string[]) => new Map(shas.map((sha) => [sha, '2026-08-26T09:00:00Z'])));
  postVerdictCommentMock
    .mockReset()
    .mockResolvedValue({ id: 555, htmlUrl: 'https://github.com/boardsesh/boardsesh/pull/4792#issuecomment-555' });
  applyQaLabelMock.mockReset().mockResolvedValue(undefined);
  testerRole.readFails = false;
});

describe('qaPreviews auth gate', () => {
  it('rejects an unauthenticated caller', async () => {
    await expect(qaQueries.qaPreviews(null, { prNumbers: [4792] }, anonCtx())).rejects.toThrow(
      'Authentication required',
    );
  });

  it('serves a signed-in caller who is not a tester', async () => {
    const previews = await qaQueries.qaPreviews(null, { prNumbers: [4792] }, authCtx(PLAIN));
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ prNumber: 4792 });
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
      qaQueries.qaPreviews(
        null,
        { prNumbers: Array.from({ length: QA_PREVIEWS_MAX_PR_NUMBERS + 1 }, (_, index) => index + 1) },
        authCtx(TESTER),
      ),
    ).rejects.toThrow('Invalid prNumbers');
  });

  it('takes a request as long as a busy repo actually produces', async () => {
    // A repo with a hundred-odd open PRs publishes a preview branch for each,
    // and the pick screen asks about every one it can load. The old cap of 50
    // rejected that outright, which cost EVERY row its title, risk and plan.
    const prNumbers = Array.from({ length: QA_PREVIEWS_MAX_PR_NUMBERS }, (_, index) => index + 1);
    readOpenPullRequestsMock.mockResolvedValue({ pullRequests: [openPullRequest({ number: 120 })], failed: false });

    const previews = await qaQueries.qaPreviews(null, { prNumbers }, authCtx(TESTER));

    expect(previews.map((preview) => preview.prNumber)).toEqual([120]);
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
  it('rejects an unauthenticated caller', async () => {
    await expect(qaMutations.submitQaVerdict(null, { input: validInput() }, anonCtx())).rejects.toThrow(
      'Authentication required',
    );
  });

  it('accepts a signed-in caller who is not a tester', async () => {
    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(PLAIN));
    expect(verdict).toMatchObject({ prNumber: 4792, verdict: 'approved' });
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
    getPullRequestMock.mockResolvedValue({ status: 'unavailable' });
    readOpenPullRequestsMock.mockResolvedValue({ pullRequests: [openPullRequest({ number: 5000 })], failed: false });

    await expect(qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER))).rejects.toThrow(
      'Pull request is not open',
    );
  });

  it('believes a PR closed on GitHub over a cache that still lists it as open', async () => {
    getPullRequestMock.mockResolvedValue({ status: 'closed' });
    // The list cache is up to three minutes stale, and a PR closed inside that
    // window must not still take a verdict (or a qa-approved label).
    readOpenPullRequestsMock.mockResolvedValue({ pullRequests: [openPullRequest()], failed: false });

    await expect(qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER))).rejects.toThrow(
      'Pull request is not open',
    );
    expect(readOpenPullRequestsMock).not.toHaveBeenCalled();
  });

  it('records the head the fresh read reports, not the one the cache still holds', async () => {
    getPullRequestMock.mockResolvedValue({
      status: 'open',
      pullRequest: openPullRequest({ headSha: 'freshsha0000000' }),
    });
    readOpenPullRequestsMock.mockResolvedValue({
      pullRequests: [openPullRequest({ headSha: 'stalesha0000000' })],
      failed: false,
    });

    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    expect(verdict.headSha).toBe('freshsha0000000');
    expect((await readVerdictRow(verdict.id)).head_sha).toBe('freshsha0000000');
    expect(getHeadCommitDateMock).toHaveBeenCalledWith('freshsha0000000');
  });

  it('falls back to the cached entry when the fresh read fails', async () => {
    getPullRequestMock.mockResolvedValue({ status: 'unavailable' });
    readOpenPullRequestsMock.mockResolvedValue({
      pullRequests: [openPullRequest({ headSha: 'cachedsha000000' })],
      failed: false,
    });

    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    expect(verdict.headSha).toBe('cachedsha000000');
  });

  it('records the verdict without a head SHA when GitHub cannot be reached at all', async () => {
    // The row is the record and GitHub is the mirror, so an uninstalled App or
    // a spent anonymous rate limit must not be able to refuse a verdict: the
    // sheet a tester files it from is the one that takes them back off the
    // preview, and rejecting the write left them stuck on the PR they were
    // testing. A null head SHA is the runbook's "revision never verified".
    getPullRequestMock.mockResolvedValue({ status: 'unavailable' });
    readOpenPullRequestsMock.mockResolvedValue({ pullRequests: [], failed: true });

    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    expect(verdict.headSha).toBeNull();
    expect((await readVerdictRow(verdict.id)).head_sha).toBeNull();
    // Nothing to look up, so no GitHub call is spent asking.
    expect(getHeadCommitDateMock).not.toHaveBeenCalled();
  });

  it('never mirrors a verdict GitHub never confirmed a PR for', async () => {
    // `prNumber` is client-supplied and both reads failed, so it need not be an
    // open PR — or a PR at all. The comment goes through the issues API, which
    // answers for any number, and `qa-approved` gates a merge on a public repo,
    // so the mirror must not fire on GitHub recovering between read and write.
    getPullRequestMock.mockResolvedValue({ status: 'unavailable' });
    readOpenPullRequestsMock.mockResolvedValue({ pullRequests: [], failed: true });

    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    // Nothing to wait on, so give the fire-and-forget block a turn to prove it
    // stays quiet rather than asserting before it could have run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postVerdictCommentMock).not.toHaveBeenCalled();
    expect(applyQaLabelMock).not.toHaveBeenCalled();
    expect((await readVerdictRow(verdict.id)).github_comment_id).toBeNull();
  });

  it('still says "not open" when the repo really has no open pull requests', async () => {
    getPullRequestMock.mockResolvedValue({ status: 'unavailable' });
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
    // The handset the tester ran, straight off the row.
    expect(body).toContain('| Device | iPhone 17 Pro (iOS 26.1) |');
    expect(body).not.toContain(`${TESTER}@test.com`);
    expect(body).not.toContain(TESTER);

    const row = await readVerdictRow(verdict.id);
    expect(row.device_model).toBe('iPhone 17 Pro');
    expect(row.os_version).toBe('26.1');
  });

  it('counts the other verdicts on this head and leaves the caller’s own out', async () => {
    const OTHER_APPROVER = 'qa-other-approver';
    const OTHER_DECLINER = 'qa-other-decliner';
    const OTHER_HEAD_TESTER = 'qa-other-head';
    await Promise.all([insertUser(OTHER_APPROVER), insertUser(OTHER_DECLINER), insertUser(OTHER_HEAD_TESTER)]);
    await Promise.all([
      insertExistingVerdict(OTHER_APPROVER, 'approved', 'abcdef1234567890'),
      insertExistingVerdict(OTHER_DECLINER, 'declined', 'abcdef1234567890'),
      // Same PR, superseded head: the PR author cares what the CURRENT revision
      // scored, so this one must not be counted.
      insertExistingVerdict(OTHER_HEAD_TESTER, 'approved', '0000000000000000'),
    ]);

    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    await vi.waitFor(() => {
      expect(postVerdictCommentMock).toHaveBeenCalledTimes(1);
    });
    const [, body] = postVerdictCommentMock.mock.calls[0];
    // One line proves three things: both other verdicts counted, the caller's
    // own row excluded (it would read 2 approved), and the stale head ignored.
    expect(body).toContain('Other verdicts on this head: 1 approved · 1 declined');
    expect(body).toContain(`<!-- boardsesh-qa-verdict:${verdict.id} -->`);
  });

  it('applies the label the newest row calls for, not the one this job carries', async () => {
    // Two verdicts filed seconds apart run independent fire-and-forget jobs
    // that can finish in either order. Parking this one on its comment post
    // lets a newer decline land first, exactly as a race would.
    const LATER_TESTER = 'qa-later-tester';
    await insertUser(LATER_TESTER);

    let releasePost: (() => void) | undefined;
    const postPending = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    postVerdictCommentMock.mockImplementation(async () => {
      await postPending;
      return { id: 556, htmlUrl: 'https://github.com/boardsesh/boardsesh/pull/4792#issuecomment-556' };
    });

    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));
    expect(verdict.verdict).toBe('approved');

    await vi.waitFor(() => {
      expect(postVerdictCommentMock).toHaveBeenCalledTimes(1);
    });
    await insertExistingVerdict(LATER_TESTER, 'declined', 'abcdef1234567890');
    releasePost?.();

    await vi.waitFor(() => {
      expect(applyQaLabelMock).toHaveBeenCalledWith(4792, 'declined');
    });
    expect(applyQaLabelMock).not.toHaveBeenCalledWith(4792, 'approved');
  });

  // The label gates a merge on a PUBLIC repo, so opening verdicts to everyone
  // must not open the label with them. Anyone can say what they found; only a
  // tester's word moves the label.
  it('posts a non-tester’s verdict to GitHub but does not move the label', async () => {
    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(PLAIN));

    await vi.waitFor(() => {
      expect(postVerdictCommentMock).toHaveBeenCalledTimes(1);
    });
    expect(applyQaLabelMock).not.toHaveBeenCalled();
    const [, body] = postVerdictCommentMock.mock.calls[0];
    expect(body).toContain(`<!-- boardsesh-qa-verdict:${verdict.id} -->`);
  });

  it('leaves a tester’s label standing when a non-tester declines afterwards', async () => {
    await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));
    await vi.waitFor(() => {
      expect(applyQaLabelMock).toHaveBeenCalledWith(4792, 'approved');
    });
    applyQaLabelMock.mockClear();

    await qaMutations.submitQaVerdict(
      null,
      { input: validInput({ verdict: 'declined', comment: 'Crashes when I open the queue' }) },
      authCtx(PLAIN),
    );

    await vi.waitFor(() => {
      expect(postVerdictCommentMock).toHaveBeenCalledTimes(2);
    });
    // The recompute still runs and re-applies the tester's own call — harmless,
    // since applyQaLabel is idempotent. What must never happen is the decline
    // reaching the label.
    expect(applyQaLabelMock).not.toHaveBeenCalledWith(4792, 'declined');
  });

  it('moves the label on a tester’s verdict even when a newer non-tester row exists', async () => {
    const LATER_PLAIN = 'qa-later-plain';
    await insertUser(LATER_PLAIN);
    await insertExistingVerdict(LATER_PLAIN, 'declined', 'abcdef1234567890', false);

    await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    await vi.waitFor(() => {
      expect(applyQaLabelMock).toHaveBeenCalledWith(4792, 'approved');
    });
    expect(applyQaLabelMock).not.toHaveBeenCalledWith(4792, 'declined');
  });

  it('fails the whole mutation when the role lookup errors, leaving no row behind', async () => {
    // `readTesterRole` is strict on purpose. Swallowing the error would store a
    // real tester's verdict as a non-tester one — invisible, and impossible to
    // repair from the row. Failing is what makes it retryable, and nothing may
    // be half-written: a verdict with the wrong by_tester is worse than none.
    testerRole.readFails = true;

    await expect(qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER))).rejects.toThrow(
      'community_roles read failed',
    );

    const rows = await db.execute(sql`SELECT count(*)::int AS total FROM qa_verdicts`);
    expect(Array.from(rows as Iterable<{ total: number }>)[0].total).toBe(0);
    expect(postVerdictCommentMock).not.toHaveBeenCalled();
    expect(applyQaLabelMock).not.toHaveBeenCalled();
  });

  it('records whether the author held the tester role when they filed', async () => {
    const mine = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));
    const theirs = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(PLAIN));

    expect(await readByTester(mine.id)).toBe(true);
    expect(await readByTester(theirs.id)).toBe(false);
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
    expect(row.device_model).toBeNull();
    expect(row.os_version).toBeNull();
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
    expect(body).toContain('| Device | unknown |');
    // No bundle date means nobody can say which revision ran — the comment has
    // to admit that rather than read like a verdict on the current head.
    expect(body).toContain('(❓ build not identified)');
  });

  it('stores the screenshot keys and links them from the mirrored comment', async () => {
    const keys = [
      'feedback-screenshots/11111111-2222-4333-8444-555555555555.jpg',
      'feedback-screenshots/66666666-7777-4888-8999-aaaaaaaaaaaa.png',
    ];

    const verdict = await qaMutations.submitQaVerdict(
      null,
      { input: validInput({ screenshotKeys: keys }) },
      authCtx(TESTER),
    );

    // Keys are what the row keeps; the URLs only ever exist in the GitHub
    // comment, derived at mirror time so a CDN domain change strands nothing.
    // The verdict returned to the app carries neither — nothing renders them.
    expect((await readVerdictRow(verdict.id)).screenshot_keys).toEqual(keys);
    expect(verdict).not.toHaveProperty('screenshotUrls');

    await vi.waitFor(() => {
      expect(postVerdictCommentMock).toHaveBeenCalledTimes(1);
    });
    const [, body] = postVerdictCommentMock.mock.calls[0];
    expect(body).toContain('## Screenshots');
    expect(body).toContain(
      '<img src="https://media.boardsesh.com/feedback-screenshots/11111111-2222-4333-8444-555555555555.jpg" width="300">',
    );
  });

  it('leaves the row and the comment clean when no screenshots were attached', async () => {
    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    expect((await readVerdictRow(verdict.id)).screenshot_keys).toBeNull();

    await vi.waitFor(() => {
      expect(postVerdictCommentMock).toHaveBeenCalledTimes(1);
    });
    expect(postVerdictCommentMock.mock.calls[0][1]).not.toContain('## Screenshots');
  });

  it('refuses a key this system could not have minted', async () => {
    // The comment is public. A key we did not mint must never reach an
    // `<img src>`, and a verdict hard-rejects rather than degrades.
    await expect(
      qaMutations.submitQaVerdict(
        null,
        { input: validInput({ screenshotKeys: ['feedback-screenshots/../../etc/passwd'] }) },
        authCtx(TESTER),
      ),
    ).rejects.toThrow('Invalid input');

    await expect(
      qaMutations.submitQaVerdict(
        null,
        {
          input: validInput({
            screenshotKeys: Array.from(
              { length: 5 },
              (_, index) => `feedback-screenshots/1111111${index}-2222-4333-8444-555555555555.jpg`,
            ),
          }),
        },
        authCtx(TESTER),
      ),
    ).rejects.toThrow('Invalid input');
  });

  it('returns createdAt as an instant the app can parse', async () => {
    const verdict = await qaMutations.submitQaVerdict(null, { input: validInput() }, authCtx(TESTER));

    expect(verdict.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/);
    expect(Math.abs(Date.now() - Date.parse(verdict.createdAt))).toBeLessThan(60_000);
  });
});
