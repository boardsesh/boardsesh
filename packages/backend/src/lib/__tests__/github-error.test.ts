/**
 * The body a failed GitHub call is allowed to remember.
 *
 * Two things are load-bearing and pull against each other. GitHub's own
 * `message` is the only thing that ever explained the 403 that ate three QA
 * verdicts, so it has to survive. And GitHub echoes the request back in some
 * error shapes, so an installation token can ride along in that same body —
 * which is why it used to be dropped whole. Every test here is one side of
 * that trade.
 */

import { describe, it, expect } from 'vite-plus/test';
import {
  GithubRequestError,
  formatGithubErrorDetail,
  githubErrorDetailOf,
  readGithubErrorDetail,
  redactGithubErrorBody,
} from '../github-error';

describe('redactGithubErrorBody', () => {
  it('keeps the part that explains the failure', () => {
    const redacted = redactGithubErrorBody(
      JSON.stringify({ message: 'Resource not accessible by integration', documentation_url: 'https://docs.gh/rest' }),
    );

    expect(redacted).toContain('Resource not accessible by integration');
    expect(redacted).toContain('docs.gh/rest');
  });

  // Assembled rather than written out. GitHub's push protection recognises the
  // `v1.<40 hex>` installation-token shape and blocks a push carrying one, even
  // as an obviously fake fixture — the literal never appears in this file.
  const legacyInstallationToken = ['v1', 'a'.repeat(40)].join('.');

  it.each([
    ['installation token', 'ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5'],
    ['personal access token', 'ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'],
    ['fine-grained PAT', 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuV'],
    ['legacy installation token', legacyInstallationToken],
  ])('strips an echoed %s', (_label, credential) => {
    const redacted = redactGithubErrorBody(`{"message":"Bad credentials","token":"${credential}"}`);

    expect(redacted).not.toContain(credential);
    expect(redacted).toContain('[redacted credential]');
    expect(redacted).toContain('Bad credentials');
  });

  it('strips an echoed Authorization header and the App JWT that signed the mint', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NSJ9.c2lnbmF0dXJlLWhlcmU';
    const redacted = redactGithubErrorBody(`{"headers":{"Authorization":"Bearer ${jwt}"}}`);

    expect(redacted).not.toContain(jwt);
    expect(redacted).toContain('[redacted credential]');
  });

  // Exact output, not `toContain`. A scheme pattern layered on top of a prefix
  // pattern re-redacts the placeholder the first one wrote, and a shared
  // callback renders the match offset as the scheme — both produce a string
  // that still "contains" the placeholder while reading as garbage.
  it('replaces an Authorization header exactly once, keeping the scheme', () => {
    expect(
      redactGithubErrorBody(
        '{"message":"Bad credentials","headers":{"Authorization":"Bearer ghs_A1b2C3d4E5f6G7h8I9j0K1"}}',
      ),
    ).toBe('{"message":"Bad credentials","headers":{"Authorization":"Bearer [redacted credential]"}}');
  });

  it('caps a pathological body instead of flooding a log line', () => {
    const redacted = redactGithubErrorBody('x'.repeat(5000));

    expect(redacted.length).toBeLessThan(700);
    expect(redacted.endsWith('...')).toBe(true);
  });

  it('reports an empty body as such rather than as an empty string', () => {
    expect(redactGithubErrorBody('   \n  ')).toBe('<empty body>');
  });
});

describe('readGithubErrorDetail', () => {
  it('captures status, request id and the rate-limit pair', async () => {
    const response = new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
      status: 403,
      headers: {
        'x-github-request-id': 'C4E0:1F2A:9B',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1757340000',
      },
    });

    const detail = await readGithubErrorDetail(response);

    expect(detail).toMatchObject({
      status: 403,
      requestId: 'C4E0:1F2A:9B',
      rateLimitRemaining: '0',
      rateLimitReset: '1757340000',
    });
    expect(detail.body).toContain('API rate limit exceeded');
  });

  it('degrades to a marker when the body cannot be read', async () => {
    const response = new Response('once', { status: 500 });
    await response.text();

    const detail = await readGithubErrorDetail(response);

    expect(detail.status).toBe(500);
    expect(detail.body).toBe('<empty body>');
  });
});

describe('githubErrorDetailOf', () => {
  it('finds the detail through a wrapping cause chain', () => {
    const inner = new GithubRequestError('POST', '/repos/o/r/issues', {
      status: 404,
      body: '{"message":"Not Found"}',
      requestId: 'AA11',
      rateLimitRemaining: null,
      rateLimitReset: null,
    });
    const wrapped = new Error('mirror failed', { cause: new Error('while posting', { cause: inner }) });

    expect(githubErrorDetailOf(wrapped)?.status).toBe(404);
    expect(githubErrorDetailOf(new Error('unrelated'))).toBeNull();
    expect(githubErrorDetailOf(undefined)).toBeNull();
  });

  it('survives a self-referential cause chain', () => {
    const looping = new Error('loop') as Error & { cause?: unknown };
    looping.cause = looping;

    expect(githubErrorDetailOf(looping)).toBeNull();
  });
});

describe('formatGithubErrorDetail', () => {
  it('renders one greppable line', () => {
    expect(
      formatGithubErrorDetail({
        status: 403,
        body: 'Resource not accessible by integration',
        requestId: 'C4E0',
        rateLimitRemaining: '4998',
        rateLimitReset: null,
      }),
    ).toBe('status=403 request_id=C4E0 rate_limit_remaining=4998 body=Resource not accessible by integration');
  });
});
