/**
 * The GitHub error path.
 *
 * A failed call has to say *why* it failed: the crowdsourced-QA mirror spent a
 * week posting nothing because `responded 403` reads identically whether the
 * token is missing a permission or the hour's rate limit is gone. The other
 * half of the contract is what must never come out — the response body is not
 * logged whole, because some GitHub error shapes echo the request back.
 *
 * `fetch` is stubbed throughout; nothing here touches the network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { githubRequest } from '../github-client';

const errorResponse = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  ({
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError('Unexpected token');
      return body;
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('githubRequest failures', () => {
  it('names the permission a fine-grained token is missing', async () => {
    fetchMock.mockResolvedValue(
      errorResponse({ message: 'Resource not accessible by personal access token' }, 403, {
        'x-accepted-github-permissions': 'pull_requests=write',
      }),
    );

    await expect(githubRequest('/repos/o/r/issues/1/comments', { method: 'POST' }, 'tok')).rejects.toThrow(
      'GitHub POST /repos/o/r/issues/1/comments responded 403 (Resource not accessible by personal access token; token needs pull_requests=write)',
    );
  });

  it('separates an exhausted rate limit from a permission problem', async () => {
    fetchMock.mockResolvedValue(
      errorResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }),
    );

    await expect(githubRequest('/repos/o/r/pulls', undefined, 'tok')).rejects.toThrow(
      'GitHub GET /repos/o/r/pulls responded 403 (API rate limit exceeded; rate limit exhausted)',
    );
  });

  it('says only the status when the body carries no reason', async () => {
    fetchMock.mockResolvedValue(errorResponse('<html>502 Bad Gateway</html>', 502));

    await expect(githubRequest('/repos/o/r/pulls', undefined, 'tok')).rejects.toThrow(
      'GitHub GET /repos/o/r/pulls responded 502',
    );
  });

  it('leaves the rest of the body out, echoed credentials included', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(
        {
          message: 'Bad credentials',
          documentation_url: 'https://docs.github.com/rest',
          request: { headers: { authorization: 'Bearer ghp_supersecret' } },
        },
        401,
      ),
    );

    const failure = await githubRequest('/repos/o/r/pulls', undefined, 'ghp_supersecret').catch(
      (error: unknown) => error,
    );
    expect(String(failure)).toContain('Bad credentials');
    expect(String(failure)).not.toContain('ghp_supersecret');
    expect(String(failure)).not.toContain('documentation_url');
  });

  it('truncates a long message rather than pasting a whole page into the log', async () => {
    fetchMock.mockResolvedValue(errorResponse({ message: 'x'.repeat(5000) }, 422));

    const failure = await githubRequest('/repos/o/r/labels', { method: 'POST' }, 'tok').catch(
      (error: unknown) => error,
    );
    expect(String(failure)).toHaveLength('Error: GitHub POST /repos/o/r/labels responded 422 ()'.length + 200);
  });
});
