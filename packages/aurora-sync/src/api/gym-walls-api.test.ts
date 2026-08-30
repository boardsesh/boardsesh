import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAuroraGymUser } from './gym-walls-api';
import { isAuroraRequestError } from './errors';

/**
 * The authenticated per-gym lookup that replaces the hardcoded default config.
 * Its failure behaviour is what keeps a crawl of several thousand gyms alive:
 * a missing gym must be survivable, everything else must stay distinguishable
 * so the caller can tell a rate limit (retry) from a broken response (don't).
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn(() => Promise.resolve(response as Response));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function okResponse(body: unknown): Partial<Response> {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) };
}

const WALL = {
  uuid: 'wall-1',
  name: 'Main Wall',
  user_id: 42,
  product_id: 5,
  is_adjustable: true,
  angle: 40,
  layout_id: 11,
  product_size_id: 6,
  hsm: 0,
  serial_number: '751737',
  set_ids: [12, 13],
  is_listed: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('fetchAuroraGymUser', () => {
  it('requests the gym by id with the session cookie', async () => {
    const fetchMock = mockFetch(okResponse({ users: [{ id: 42, walls: [WALL] }] }));

    await fetchAuroraGymUser('tension', 42, 'session-token');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://tensionboardapp2.com/users/42');
    expect((init.headers as Record<string, string>).Cookie).toBe('token=session-token');
  });

  it('returns the single user Aurora answers a one-id lookup with', async () => {
    mockFetch(okResponse({ users: [{ id: 42, walls: [WALL], gym: { user_id: 42, city: 'Sydney' } }] }));

    const user = await fetchAuroraGymUser('tension', 42, 'token');

    expect(user?.walls?.[0]).toMatchObject({ layout_id: 11, serial_number: '751737' });
    expect(user?.gym?.city).toBe('Sydney');
  });

  it('returns undefined for a 404 instead of throwing', async () => {
    // A pin can outlive the account it points at. One dead gym must not abort a
    // crawl of several thousand.
    mockFetch({ ok: false, status: 404, statusText: 'Not Found', json: () => Promise.resolve({}) });

    await expect(fetchAuroraGymUser('tension', 42, 'token')).resolves.toBeUndefined();
  });

  it('returns undefined when the user array is empty', async () => {
    // Same fact as a 404 — no such user — not a malformed response.
    mockFetch(okResponse({ users: [] }));

    await expect(fetchAuroraGymUser('tension', 42, 'token')).resolves.toBeUndefined();
  });

  it('throws a retryable error when Aurora rate limits', async () => {
    mockFetch({ ok: false, status: 429, statusText: 'Too Many Requests', json: () => Promise.resolve({}) });

    await expect(fetchAuroraGymUser('tension', 42, 'token')).rejects.toSatisfy(
      (error: unknown) => isAuroraRequestError(error) && error.code === 'rate_limited' && error.transient,
    );
  });

  it('throws a typed error for a response that is not a user list', async () => {
    // Classified `invalid_response`, which errors.ts treats as transient — an
    // Aurora endpoint that answers with garbage is usually mid-deploy, not
    // permanently broken, so the caller is allowed to retry it.
    mockFetch(okResponse({ nope: true }));

    await expect(fetchAuroraGymUser('tension', 42, 'token')).rejects.toSatisfy(
      (error: unknown) => isAuroraRequestError(error) && error.code === 'invalid_response',
    );
  });

  it('classifies a network failure as transient', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;

    await expect(fetchAuroraGymUser('tension', 42, 'token')).rejects.toSatisfy(
      (error: unknown) => isAuroraRequestError(error) && error.code === 'network' && error.transient,
    );
  });
});
