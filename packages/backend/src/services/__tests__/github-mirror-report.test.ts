/**
 * The regression net for #5294: when a GitHub mirror fails, the drop must not be
 * silent and the cause must not be unrecoverable.
 *
 * Both halves are asserted on the POSITIVE artifact — the Sentry event that gets
 * filed and the fields on it — never on "no log line was missing". A negative
 * assertion here would pass vacuously the moment the reporter were gated behind
 * anything (a sampler, a one-shot warn like `warnMissingTokenOnce`), which is
 * exactly the failure mode being fixed.
 *
 * The failures are driven through the real `postVerdictComment` /
 * `createFeedbackGithubIssue` against a stubbed `fetch`, so the test covers the
 * whole path a dropped mirror actually travels: GitHub's response → the typed
 * error → the resolver's outcome → the reported event.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';

const captureExceptionMock = vi.fn();
const scopeRecord = {
  user: null as { id: string } | null,
  tags: {} as Record<string, unknown>,
  contexts: {} as Record<string, unknown>,
};

vi.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  withScope: (callback: (scope: unknown) => void) =>
    callback({
      setUser: (user: { id: string }) => {
        scopeRecord.user = user;
      },
      setTag: (key: string, value: unknown) => {
        scopeRecord.tags[key] = value;
      },
      setContext: (key: string, value: unknown) => {
        scopeRecord.contexts[key] = value;
      },
    }),
}));

// The QA service mints its token from the App; stub the mint, not the env.
let installationToken: string | undefined = 'qa-token';
vi.mock('../../lib/github-app-auth', () => ({
  getInstallationAccessToken: async () => installationToken,
}));

import { reportGithubMirrorDrop } from '../github-mirror-report';
import { postVerdictComment, resetGithubQaCaches } from '../github-qa';
import { createFeedbackGithubIssue } from '../github-feedback';
import { githubErrorDetailOf, readGithubErrorDetail } from '../../lib/github-error';
import { logger } from '../../utils/logger';

/**
 * A GitHub error response, headers and all — the request id is part of the fix.
 *
 * Handed to `fetch` as a FACTORY, never as one shared object: a body is a stream
 * that can be read once, and `createFeedbackGithubIssue` calls `ensureLabels`
 * before the issue POST. Reusing a single Response makes the second read come
 * back empty and turns this suite into a test of its own stub.
 */
const errorResponse =
  (body: unknown, status: number, headers: Record<string, string> = {}) =>
  (): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

let fetchMock: ReturnType<typeof vi.fn>;
/** Every `[github-mirror]` line the reporter emitted during one test. */
let loggedErrors: string[];

beforeEach(() => {
  installationToken = 'qa-token';
  captureExceptionMock.mockClear();
  scopeRecord.user = null;
  scopeRecord.tags = {};
  scopeRecord.contexts = {};
  resetGithubQaCaches();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  loggedErrors = [];
  vi.spyOn(logger, 'error').mockImplementation((message: unknown) => {
    loggedErrors.push(String(message));
    return logger;
  });
  vi.spyOn(logger, 'warn').mockImplementation(() => logger);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mirrorContext = (): Record<string, unknown> => scopeRecord.contexts.github_mirror as Record<string, unknown>;

describe('a rejected QA verdict mirror', () => {
  it('carries GitHub status, request id and message back to the caller', async () => {
    fetchMock.mockImplementation(
      errorResponse(
        { message: 'Resource not accessible by integration', documentation_url: 'https://docs.github.com/rest' },
        403,
        { 'x-github-request-id': 'C4E0:1F2A:9B', 'x-ratelimit-remaining': '4998' },
      ),
    );

    const outcome = await postVerdictComment(4872, 'verdict body');

    expect(outcome.status).toBe('rejected');
    const detail = githubErrorDetailOf(outcome.status === 'rejected' ? outcome.cause : null);
    expect(detail).not.toBeNull();
    expect(detail?.status).toBe(403);
    expect(detail?.requestId).toBe('C4E0:1F2A:9B');
    expect(detail?.rateLimitRemaining).toBe('4998');
    expect(detail?.body).toContain('Resource not accessible by integration');
  });

  it('files a Sentry event naming the verdict row, the PR and the tester', async () => {
    fetchMock.mockImplementation(
      errorResponse({ message: 'Resource not accessible by integration' }, 403, {
        'x-github-request-id': 'C4E0:1F2A:9B',
      }),
    );

    const outcome = await postVerdictComment(4872, 'verdict body');
    reportGithubMirrorDrop({
      operation: 'qa-verdict-comment',
      record: { table: 'qa_verdicts', id: '3f1c9d2e-0000-4000-8000-000000000001' },
      repo: 'boardsesh/boardsesh',
      prNumber: 4872,
      userId: 'tester-user-id',
      outcome,
    });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [captured] = captureExceptionMock.mock.calls[0] as [Error];
    expect(captured.message).toBe('GitHub mirror dropped qa-verdict-comment (rejected, 403)');

    // Whose write was lost — the backend files no `setUser` anywhere else, which
    // is why BOARDSESH-GV's "users impacted" was a count of Cloudflare edge IPs.
    expect(scopeRecord.user).toEqual({ id: 'tester-user-id' });
    expect(scopeRecord.tags).toMatchObject({
      'github_mirror.operation': 'qa-verdict-comment',
      'github_mirror.reason': 'rejected',
      'github_mirror.status': '403',
      'github_mirror.record_table': 'qa_verdicts',
    });

    // What was lost, and how to get it back.
    expect(mirrorContext()).toMatchObject({
      recordTable: 'qa_verdicts',
      recordId: '3f1c9d2e-0000-4000-8000-000000000001',
      prNumber: 4872,
      repo: 'boardsesh/boardsesh',
      status: 403,
      requestId: 'C4E0:1F2A:9B',
    });
    expect(String(mirrorContext().responseBody)).toContain('Resource not accessible by integration');
    expect(String(mirrorContext().replay)).toContain('qa_verdicts');
  });

  it('logs a [github-mirror] line naming the row that still holds the verdict', async () => {
    fetchMock.mockImplementation(errorResponse({ message: 'forbidden' }, 403));

    const outcome = await postVerdictComment(4872, 'verdict body');
    reportGithubMirrorDrop({
      operation: 'qa-verdict-comment',
      record: { table: 'qa_verdicts', id: 'verdict-row-1' },
      repo: 'boardsesh/boardsesh',
      prNumber: 5107,
      userId: 'tester-user-id',
      outcome,
    });

    const logged = loggedErrors.join('\n');
    expect(logged).toContain('[github-mirror]');
    expect(logged).toContain('qa_verdicts verdict-row-1');
    expect(logged).toContain('PR #5107');
    expect(logged).toContain('status 403');
    expect(logged).toContain('forbidden');
  });
});

describe('an unconfigured mirror', () => {
  it('reports the drop even though the missing-token warning is one-shot', async () => {
    installationToken = undefined;

    // Two verdicts, one process: `warnMissingTokenOnce` speaks for the first
    // only. The drop report must not inherit that ceiling, or the second lost
    // verdict is exactly as invisible as before.
    for (const prNumber of [4872, 5107]) {
      const outcome = await postVerdictComment(prNumber, 'verdict body');
      expect(outcome.status).toBe('unconfigured');
      reportGithubMirrorDrop({
        operation: 'qa-verdict-comment',
        record: { table: 'qa_verdicts', id: `verdict-${prNumber}` },
        repo: 'boardsesh/boardsesh',
        prNumber,
        userId: 'tester-user-id',
        outcome,
      });
    }

    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a dropped bug report', () => {
  it('names the app_feedback row that filed no issue', async () => {
    fetchMock.mockImplementation(errorResponse({ message: 'Not Found' }, 404));

    const outcome = await createFeedbackGithubIssue({
      feedbackId: 4211,
      rating: null,
      comment: 'board art renders blank',
      platform: 'ios',
      appVersion: '2.4.0',
      source: 'shake-bug',
    });

    expect(outcome.status).toBe('rejected');
    reportGithubMirrorDrop({
      operation: 'feedback-issue',
      record: { table: 'app_feedback', id: '4211' },
      repo: 'boardsesh/boardsesh',
      userId: 'reporter-user-id',
      outcome,
    });

    expect(mirrorContext()).toMatchObject({ recordTable: 'app_feedback', recordId: '4211', status: 404 });
    expect(String(mirrorContext().replay)).toContain('app_feedback');
    expect(String(mirrorContext().responseBody)).toContain('Not Found');
  });

  it('reports the unconfigured App rather than returning quietly', async () => {
    installationToken = undefined;

    const outcome = await createFeedbackGithubIssue({
      feedbackId: 4212,
      rating: null,
      comment: 'crash on open',
      platform: 'android',
      appVersion: '2.4.0',
      source: 'drawer-bug',
    });

    expect(outcome.status).toBe('unconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the response body it keeps', () => {
  it('redacts an installation token GitHub echoed back', async () => {
    fetchMock.mockImplementation(
      errorResponse(
        {
          message: 'Bad credentials',
          request: { headers: { Authorization: 'Bearer ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5' } },
        },
        401,
      ),
    );

    const outcome = await postVerdictComment(4872, 'verdict body');
    reportGithubMirrorDrop({
      operation: 'qa-verdict-comment',
      record: { table: 'qa_verdicts', id: 'verdict-row-1' },
      repo: 'boardsesh/boardsesh',
      prNumber: 4872,
      outcome,
    });

    const body = String(mirrorContext().responseBody);
    expect(body).toContain('Bad credentials');
    expect(body).not.toContain('ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5');
    expect(body).toContain('[redacted credential]');

    const logged = loggedErrors.join('\n');
    expect(logged).not.toContain('ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5');
  });
});

/**
 * The regression CI caught on the first push of this branch.
 *
 * The reporter runs inside the same fire-and-forget block that writes the GitHub
 * id back onto the row. Dereferencing an outcome that turned out to be
 * `undefined` threw a TypeError there, the block's outer catch swallowed it, and
 * the write-back never ran — a mirror-drop reporter that itself throws is worse
 * than the silent drop it was written to end, because it takes a healthy write
 * down with it.
 *
 * So: every one of these must produce a record, and none of them may throw.
 */
describe('an outcome the reporter cannot read', () => {
  const unreadable: Array<[string, unknown]> = [
    ['undefined (a partially mocked module boundary)', undefined],
    ['null (a caller still on the pre-#5294 contract)', null],
    ['an object with no status at all', { id: 555, htmlUrl: 'https://github.com/x' }],
    ['a status that is not one of ours', { status: 'weird' }],
    ['a non-object', 42],
  ];

  it.each(unreadable)('still files a diagnosable record for %s', (_label, outcome) => {
    expect(() =>
      reportGithubMirrorDrop({
        operation: 'qa-verdict-comment',
        record: { table: 'qa_verdicts', id: 'verdict-row-9' },
        repo: 'boardsesh/boardsesh',
        prNumber: 4872,
        userId: 'tester-user-id',
        outcome,
      }),
    ).not.toThrow();

    // The positive artifact, not "it didn't crash": an unreadable outcome is
    // still a lost verdict, and it still has to name the row that holds it.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(scopeRecord.tags['github_mirror.reason']).toBe('unexpected-response');
    expect(mirrorContext()).toMatchObject({
      recordTable: 'qa_verdicts',
      recordId: 'verdict-row-9',
      prNumber: 4872,
    });
    expect(loggedErrors.join('\n')).toContain('qa_verdicts verdict-row-9');
  });

  it('keeps the caller alive when the record itself is missing', () => {
    expect(() =>
      reportGithubMirrorDrop({
        operation: 'feedback-issue',
        record: undefined as unknown as { table: 'app_feedback'; id: string },
        repo: 'boardsesh/boardsesh',
        outcome: undefined,
      }),
    ).not.toThrow();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The other half of the same rule: the detail reader runs on the failure path
 * too, so a response missing the pieces it wants must degrade rather than throw
 * a second error on top of the first.
 */
describe('a response the detail reader cannot fully read', () => {
  const partialResponses: Array<[string, Partial<Response> | null | undefined]> = [
    ['absent', undefined],
    ['null', null],
    ['no status and no headers', { text: async (): Promise<string> => '{"message":"nope"}' }],
    ['no text method', { status: 500 }],
    ['a text() that throws', { status: 502, text: (): Promise<string> => Promise.reject(new Error('socket gone')) }],
  ];

  it.each(partialResponses)('reads a detail from a response that is %s', async (_label, response) => {
    const detail = await readGithubErrorDetail(response);

    expect(typeof detail.status).toBe('number');
    expect(typeof detail.body).toBe('string');
    expect(detail.requestId).toBeNull();
  });

  it('keeps the body when only the headers are missing', async () => {
    const detail = await readGithubErrorDetail({
      status: 404,
      text: async () => '{"message":"Not Found"}',
    } as Partial<Response>);

    expect(detail.status).toBe(404);
    expect(detail.body).toContain('Not Found');
    expect(detail.requestId).toBeNull();
  });
});
