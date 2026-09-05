/**
 * Crowdsourced QA's GitHub half. Two things are load-bearing here:
 *
 * 1. The comment is PUBLIC. It must name the tester by display name and must
 *    never carry their email or user id, and free text must be redacted.
 * 2. Nothing may throw. A GitHub outage costs the mirror, never the verdict.
 *
 * `fetch` is stubbed throughout — no test in this file touches the network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';

// The token is minted from the GitHub App now, not read from the environment.
// Stub the mint rather than the env so these tests stay about the QA logic;
// `lib/__tests__/github-app-auth.test.ts` owns the minting itself.
// `undefined` is the unconfigured deploy, where reads go anonymous.
let installationToken: string | undefined = 'qa-token';
vi.mock('../../lib/github-app-auth', () => ({
  getInstallationAccessToken: async () => installationToken,
}));

import {
  applyQaLabel,
  buildQaPreview,
  buildVerdictComment,
  getHeadCommitDate,
  getHeadCommitDates,
  getOpenPullRequests,
  getPullRequest,
  postVerdictComment,
  readOpenPullRequests,
  resetGithubQaCaches,
  type QaPullRequest,
  type VerdictCommentPayload,
} from '../github-qa';
import { logger } from '../../utils/logger';

const PR_BODY = [
  '## Summary',
  '',
  'Grows the tick note field.',
  '',
  '## Test plan',
  '',
  '1. You tab → Log a tick → the note field grows to 8 lines',
  '2. Type 300 characters → the counter turns red at 250',
  '',
  '## Risk',
  '',
  'Risk: 2/5 — isolated UI, covered by tests',
].join('\n');

const pullRequest = (overrides: Partial<QaPullRequest> = {}): QaPullRequest => ({
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

const commentPayload = (overrides: Partial<VerdictCommentPayload> = {}): VerdictCommentPayload => ({
  verdictId: 17,
  verdict: 'approved',
  displayName: 'Nic',
  comment: null,
  platform: 'ios',
  appVersion: '2.3.1',
  updateId: 'update-abc',
  runtimeVersion: 'fingerprint-1',
  bundleCreatedAt: null,
  headSha: 'abcdef1234567890',
  headCommittedAt: null,
  otherApproved: 0,
  otherDeclined: 0,
  ...overrides,
});

const githubPull = (overrides: Record<string, unknown> = {}) => ({
  number: 4792,
  title: 'Grow the tick note field',
  body: PR_BODY,
  html_url: 'https://github.com/boardsesh/boardsesh/pull/4792',
  draft: false,
  updated_at: '2026-08-26T10:00:00Z',
  user: { login: 'marcodejongh' },
  head: { sha: 'abcdef1234567890' },
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;
let originalRepo: string | undefined;
let originalFeedbackRepo: string | undefined;

beforeEach(() => {
  resetGithubQaCaches();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  installationToken = 'qa-token';
  originalRepo = process.env.QA_GITHUB_REPO;
  originalFeedbackRepo = process.env.FEEDBACK_GITHUB_REPO;
  delete process.env.FEEDBACK_GITHUB_REPO;
  process.env.QA_GITHUB_REPO = 'boardsesh/boardsesh';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalRepo === undefined) delete process.env.QA_GITHUB_REPO;
  else process.env.QA_GITHUB_REPO = originalRepo;
  if (originalFeedbackRepo === undefined) delete process.env.FEEDBACK_GITHUB_REPO;
  else process.env.FEEDBACK_GITHUB_REPO = originalFeedbackRepo;
});

describe('buildQaPreview', () => {
  it('reads the test plan steps and the risk score out of the PR body', () => {
    const preview = buildQaPreview(pullRequest(), null, '2026-08-26T09:00:00Z');

    expect(preview.branch).toBe('pr-4792');
    expect(preview.testPlanSteps).toEqual([
      'You tab → Log a tick → the note field grows to 8 lines',
      'Type 300 characters → the counter turns red at 250',
    ]);
    expect(preview.testPlan).toContain('the counter turns red at 250');
    expect(preview.risk).toBe(2);
    expect(preview.riskReason).toBe('isolated UI, covered by tests');
    expect(preview.headCommittedAt).toBe('2026-08-26T09:00:00Z');
    expect(preview.myLatestVerdict).toBeNull();
  });

  it('degrades to no plan and no risk for a body that predates the rule', () => {
    const preview = buildQaPreview(pullRequest({ body: 'Just a fix.' }), null);

    expect(preview.testPlan).toBeNull();
    expect(preview.testPlanSteps).toEqual([]);
    expect(preview.risk).toBeNull();
    expect(preview.riskReason).toBeNull();
    expect(preview.headCommittedAt).toBeNull();
  });

  it('carries the caller’s latest verdict through unchanged', () => {
    const verdict = {
      id: '9',
      prNumber: 4792,
      branch: 'pr-4792',
      verdict: 'declined' as const,
      comment: 'crashes on open',
      headSha: 'abcdef1234567890',
      createdAt: '2026-08-26T11:00:00Z',
      githubCommentUrl: null,
    };

    expect(buildQaPreview(pullRequest(), verdict).myLatestVerdict).toEqual(verdict);
  });
});

describe('buildVerdictComment', () => {
  it('leads with the row marker and names the tester', () => {
    const body = buildVerdictComment(commentPayload());

    expect(body.split('\n')[0]).toBe('<!-- boardsesh-qa-verdict:17 -->');
    expect(body).toContain('### ✅ QA approved by Nic');
    // Deliberately not `#17`: that would cross-link issue 17 on every verdict.
    expect(body).toContain('| Verdict id | qa_verdicts.id 17 |');
    expect(body).not.toContain('qa_verdicts #17');
    expect(body).toContain('| Head SHA at verdict | abcdef1 |');
    expect(body).toContain('_No notes._');
  });

  it('marks a decline and quotes the notes', () => {
    const body = buildVerdictComment(
      commentPayload({ verdict: 'declined', comment: 'Board never lights up\nsecond line' }),
    );

    expect(body).toContain('### ❌ QA declined by Nic');
    expect(body).toContain('> Board never lights up');
    expect(body).toContain('> second line');
  });

  it('falls back to a generic name when the tester has none', () => {
    expect(buildVerdictComment(commentPayload({ displayName: null }))).toContain('QA approved by a Boardsesh user');
    expect(buildVerdictComment(commentPayload({ displayName: '   ' }))).toContain('QA approved by a Boardsesh user');
  });

  it('redacts free text and never prints an email or a user id', () => {
    const body = buildVerdictComment(
      commentPayload({ verdict: 'declined', comment: 'ping me at tester@example.com about this' }),
    );

    expect(body).toContain('[redacted email]');
    expect(body).not.toContain('tester@example.com');
    expect(body).not.toContain('@example.com');
  });

  it('keeps a hostile comment from breaking the structure or pinging anyone', () => {
    const hostile = [
      '<!-- swallow the table',
      'ping @marcodejongh and see #1',
      '| a | b |',
      '# shouty heading',
      '```js',
      'const x = 1;',
      '```',
      'still --> here',
    ].join('\n');
    const body = buildVerdictComment(commentPayload({ verdict: 'declined', comment: hostile }));
    const lines = body.split('\n');

    // The HTML comment never opens, so everything after it still renders.
    expect(body).not.toContain('<!-- swallow');
    expect(body).toContain('&lt;!-- swallow');
    // No live mention and no issue cross-reference.
    expect(body).not.toMatch(/(^|[^`\w])@marcodejongh/);
    expect(body).toContain('`@marcodejongh`');
    expect(body).toContain('`#1`');
    // Every line of the note stays inside the blockquote…
    expect(lines.filter((line) => line.includes('swallow the table'))[0]).toMatch(/^> /);
    expect(lines.filter((line) => line.includes('shouty heading'))[0]).toMatch(/^> /);
    // …and the device table is still intact underneath it.
    expect(body).toContain('| Field | Value |');
    expect(body).toContain('| Platform | ios |');
  });

  it('escapes a pipe in the notes instead of forging a table row', () => {
    const body = buildVerdictComment(commentPayload({ verdict: 'declined', comment: 'columns | like | this' }));

    expect(body).toContain('> columns | like | this');
    expect(body).toContain('| Field | Value |');
  });

  it('neutralises both halves of adjacent tokens', () => {
    // Only the first token sits at a boundary in the source; wrapping it is
    // what puts the second one right after a backtick, where GitHub would
    // linkify it. Both have to end up inert.
    const body = buildVerdictComment(
      commentPayload({ verdict: 'declined', comment: 'cc @alice@bob about #1#2 please' }),
    );

    expect(body).toContain('`@alice@bob`');
    expect(body).toContain('`#1#2`');
    expect(body).not.toMatch(/(^|[^`\w])@bob/);
    expect(body).not.toMatch(/(^|[^`\w])#2/);
  });

  it('leaves a redacted email readable instead of mangling it further', () => {
    const body = buildVerdictComment(
      commentPayload({ verdict: 'declined', comment: 'mail a@b.com or tester@example.com' }),
    );

    // Upstream redaction already took both; neutralising must not chew on what
    // is left, and must not wrap the sigil of an address it did not catch.
    expect(body).toContain('[redacted email]');
    expect(body).not.toContain('tester@example.com');
    expect(body).not.toContain('`[redacted');
  });

  it('leaves the anchor of a pasted URL clickable', () => {
    const body = buildVerdictComment(
      commentPayload({
        verdict: 'declined',
        comment: 'see https://github.com/boardsesh/boardsesh/pull/4792#issuecomment-555 for context',
      }),
    );

    expect(body).toContain('/pull/4792#issuecomment-555');
    expect(body).not.toContain('`#issuecomment-555`');
  });

  it('will not let a display name break the heading or ping a maintainer', () => {
    const body = buildVerdictComment(commentPayload({ displayName: 'Nic\n\n### Fake heading\n@marcodejongh <!-- x' }));
    const heading = body.split('\n').find((line) => line.startsWith('### '));

    expect(heading).toBe('### ✅ QA approved by Nic ### Fake heading `@marcodejongh` &lt;!-- x');
    expect(body.split('\n').filter((line) => line.startsWith('### '))).toHaveLength(1);
  });

  it('falls back to the anonymous name when the display name is an email', () => {
    const body = buildVerdictComment(commentPayload({ displayName: 'tester@example.com' }));

    expect(body).toContain('QA approved by a Boardsesh user');
    expect(body).not.toContain('tester@example.com');
    expect(body).not.toContain('[redacted');
  });

  it('warns when the tested bundle predates the current head commit', () => {
    const stale = buildVerdictComment(
      commentPayload({ bundleCreatedAt: '2026-08-26T08:00:00Z', headCommittedAt: '2026-08-26T09:00:00Z' }),
    );
    const current = buildVerdictComment(
      commentPayload({ bundleCreatedAt: '2026-08-26T09:30:00Z', headCommittedAt: '2026-08-26T09:00:00Z' }),
    );

    expect(stale).toContain('⚠️ Tested an older revision');
    expect(current).not.toContain('Tested an older revision');
  });

  it('reports other verdicts on the same head, and omits the line when there are none', () => {
    expect(buildVerdictComment(commentPayload({ otherApproved: 2, otherDeclined: 1 }))).toContain(
      'Other verdicts on this head: 2 approved · 1 declined',
    );
    expect(buildVerdictComment(commentPayload())).not.toContain('Other verdicts on this head');
  });

  it('stays short enough to read on a PR', () => {
    const body = buildVerdictComment(
      commentPayload({
        comment: 'works',
        bundleCreatedAt: '2026-01-01T00:00:00Z',
        headCommittedAt: '2026-02-01T00:00:00Z',
        otherApproved: 1,
      }),
    );

    expect(body.split('\n').length).toBeLessThanOrEqual(30);
  });
});

describe('getOpenPullRequests', () => {
  it('normalizes the GitHub payload and serves the cache within the TTL', async () => {
    fetchMock.mockResolvedValue(jsonResponse([githubPull()]));

    const first = await getOpenPullRequests(1_000);
    const second = await getOpenPullRequests(1_000 + 60_000);

    expect(first).toEqual([
      {
        number: 4792,
        title: 'Grow the tick note field',
        body: PR_BODY,
        htmlUrl: 'https://github.com/boardsesh/boardsesh/pull/4792',
        isDraft: false,
        updatedAt: '2026-08-26T10:00:00Z',
        author: 'marcodejongh',
        headSha: 'abcdef1234567890',
        labels: [],
      },
    ]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refills once the 3-minute TTL has passed', async () => {
    fetchMock.mockResolvedValue(jsonResponse([githubPull()]));

    await getOpenPullRequests(1_000);
    await getOpenPullRequests(1_000 + 3 * 60 * 1000 + 1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetches a second page only when the first one is full', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => githubPull({ number: 1000 + index }));
    fetchMock.mockResolvedValueOnce(jsonResponse(fullPage)).mockResolvedValueOnce(jsonResponse([githubPull()]));

    const pullRequests = await getOpenPullRequests(1_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('page=2');
    expect(pullRequests).toHaveLength(101);
  });

  it('negative-caches a GitHub failure for 30 seconds, then retries', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'rate limited' }, 403));

    await expect(getOpenPullRequests(1_000)).rejects.toThrow('responded 403');
    // Inside the negative-cache window: served from cache, no second call.
    await expect(getOpenPullRequests(1_000 + 10_000)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(jsonResponse([githubPull()]));
    await expect(getOpenPullRequests(1_000 + 31_000)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('de-dupes concurrent refills onto one request', async () => {
    fetchMock.mockResolvedValue(jsonResponse([githubPull()]));

    await Promise.all([getOpenPullRequests(1_000), getOpenPullRequests(1_000), getOpenPullRequests(1_000)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('joins a caller that arrives while the first fetch is still pending', async () => {
    // The cache is only written once the fetch settles, so the second caller
    // lands in the window where there is nothing to serve and a request is
    // already out. It must join that request, not start its own.
    let releaseFetch: (() => void) | undefined;
    const fetchPending = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    fetchMock.mockImplementation(async () => {
      await fetchPending;
      return jsonResponse([githubPull()]);
    });

    const firstCall = getOpenPullRequests(1_000);
    // Yield until the first call has actually reached its await on fetch. A
    // fixed number of ticks would have to be re-counted every time an await is
    // added upstream of the request — minting the App token added one.
    for (let tick = 0; tick < 50 && fetchMock.mock.calls.length === 0; tick += 1) {
      await Promise.resolve();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const secondCall = getOpenPullRequests(1_000);
    releaseFetch?.();
    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('reads anonymously when the GitHub App is not configured', async () => {
    installationToken = undefined;
    fetchMock.mockResolvedValue(jsonResponse([githubPull()]));

    await getOpenPullRequests(1_000);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['User-Agent']).toBe('boardsesh-backend');
  });

  it('falls back to the feedback repo when the QA one is set but empty', async () => {
    // `.env.development` ships the QA vars blank, and a deploy dashboard hands
    // back '' for a cleared variable — neither may shadow the fallback, or the
    // reader ends up asking GitHub for /repos//pulls.
    process.env.QA_GITHUB_REPO = '';
    process.env.FEEDBACK_GITHUB_REPO = 'someone/fork';
    fetchMock.mockResolvedValue(jsonResponse([githubPull()]));

    await getOpenPullRequests(1_000);

    expect(fetchMock.mock.calls[0][0]).toContain('/repos/someone/fork/pulls');
  });

  it('sends the installation token as a bearer', async () => {
    fetchMock.mockResolvedValue(jsonResponse([githubPull()]));

    await getOpenPullRequests(1_000);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer qa-token');
  });
});

describe('readOpenPullRequests', () => {
  it('reports a real empty repo as a success, not a failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await expect(readOpenPullRequests(1_000)).resolves.toEqual({ pullRequests: [], failed: false });
  });

  it('flags the first failure instead of throwing it at the caller', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    fetchMock.mockResolvedValue(jsonResponse({ message: 'rate limited' }, 403));

    await expect(readOpenPullRequests(1_000)).resolves.toEqual({ pullRequests: [], failed: true });
  });

  it('flags the negative-cached window the same way as the failure that filled it', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    fetchMock.mockResolvedValue(jsonResponse({ message: 'rate limited' }, 403));

    await readOpenPullRequests(1_000);
    // Served from the 30s negative cache: no second call, still flagged failed.
    await expect(readOpenPullRequests(1_000 + 10_000)).resolves.toEqual({ pullRequests: [], failed: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears the flag once GitHub answers again', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    fetchMock.mockResolvedValue(jsonResponse({ message: 'rate limited' }, 403));
    await readOpenPullRequests(1_000);

    fetchMock.mockResolvedValue(jsonResponse([githubPull()]));
    const read = await readOpenPullRequests(1_000 + 31_000);

    expect(read.failed).toBe(false);
    expect(read.pullRequests).toHaveLength(1);
  });
});

describe('getPullRequest', () => {
  it('reads the PR straight from GitHub, with no cache in the way', async () => {
    fetchMock.mockResolvedValue(jsonResponse(githubPull({ state: 'open', head: { sha: 'freshsha0000000' } })));

    const lookup = await getPullRequest(4792);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/boardsesh/boardsesh/pulls/4792');
    expect(lookup).toEqual({
      status: 'open',
      pullRequest: expect.objectContaining({ number: 4792, headSha: 'freshsha0000000' }),
    });
  });

  it('reports a closed PR as closed', async () => {
    fetchMock.mockResolvedValue(jsonResponse(githubPull({ state: 'closed' })));

    await expect(getPullRequest(4792)).resolves.toEqual({ status: 'closed' });
  });

  it('reports unavailable, not closed, when GitHub will not answer', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    fetchMock.mockResolvedValue(jsonResponse({ message: 'rate limited' }, 403));

    await expect(getPullRequest(4792)).resolves.toEqual({ status: 'unavailable' });
  });

  it('sends the token when one is configured', async () => {
    fetchMock.mockResolvedValue(jsonResponse(githubPull({ state: 'open' })));

    await getPullRequest(4792);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer qa-token');
  });
});

describe('getHeadCommitDates', () => {
  it('looks each distinct SHA up once and returns them all', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse({ commit: { committer: { date: `2026-08-26T09:00:00Z#${url.slice(-3)}` } } }),
    );

    const dates = await getHeadCommitDates(['sha-a', 'sha-b', 'sha-a']);

    expect([...dates.keys()]).toEqual(['sha-a', 'sha-b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never has more than five lookups in flight at once', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    fetchMock.mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return jsonResponse({ commit: { committer: { date: '2026-08-26T09:00:00Z' } } });
    });

    const shas = Array.from({ length: 25 }, (_, index) => `sha-${index}`);
    const dates = await getHeadCommitDates(shas);

    expect(dates.size).toBe(25);
    expect(fetchMock).toHaveBeenCalledTimes(25);
    expect(peakInFlight).toBeLessThanOrEqual(5);
  });
});

describe('getHeadCommitDate', () => {
  it('returns the committer date and caches it per SHA', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ commit: { committer: { date: '2026-08-26T09:00:00Z' } } }));

    await expect(getHeadCommitDate('abc123')).resolves.toBe('2026-08-26T09:00:00Z');
    await expect(getHeadCommitDate('abc123')).resolves.toBe('2026-08-26T09:00:00Z');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the lookup fails, without throwing', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    fetchMock.mockResolvedValue(jsonResponse({ message: 'not found' }, 404));

    await expect(getHeadCommitDate('missing')).resolves.toBeNull();
  });
});

describe('postVerdictComment', () => {
  it('posts to the PR issue-comments endpoint and returns the created comment', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 987, html_url: 'https://github.com/boardsesh/boardsesh/pull/4792#issuecomment-987' }),
    );

    await expect(postVerdictComment(4792, 'body')).resolves.toEqual({
      id: 987,
      htmlUrl: 'https://github.com/boardsesh/boardsesh/pull/4792#issuecomment-987',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/boardsesh/boardsesh/issues/4792/comments');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('makes no request at all when no token is configured', async () => {
    installationToken = undefined;
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    await expect(postVerdictComment(4792, 'body')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when GitHub rejects the write', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => logger);
    fetchMock.mockResolvedValue(jsonResponse({ message: 'forbidden' }, 403));

    await expect(postVerdictComment(4792, 'body')).resolves.toBeNull();
  });
});

describe('applyQaLabel', () => {
  it('ensures both labels, adds the winner, then removes the loser', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await applyQaLabel(4792, 'approved');

    const calls = fetchMock.mock.calls.map(([url, init]) => [
      url as string,
      (init as RequestInit | undefined)?.method ?? 'GET',
    ]);
    expect(calls).toEqual([
      ['https://api.github.com/repos/boardsesh/boardsesh/labels', 'POST'],
      ['https://api.github.com/repos/boardsesh/boardsesh/labels', 'POST'],
      ['https://api.github.com/repos/boardsesh/boardsesh/issues/4792/labels', 'POST'],
      ['https://api.github.com/repos/boardsesh/boardsesh/issues/4792/labels/qa-declined', 'DELETE'],
    ]);
  });

  it('removes qa-approved when the latest verdict is a decline', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await applyQaLabel(4792, 'declined');

    const addBody = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(addBody).toEqual({ labels: ['qa-declined'] });
    expect(fetchMock.mock.calls[3][0]).toContain('/labels/qa-approved');
  });

  it('tolerates a 404 on the removal', async () => {
    vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? jsonResponse({ message: 'label not found' }, 404) : jsonResponse({}),
    );

    await expect(applyQaLabel(4792, 'approved')).resolves.toBeUndefined();
  });

  it('makes no request at all when no token is configured', async () => {
    installationToken = undefined;
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    await applyQaLabel(4792, 'approved');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
