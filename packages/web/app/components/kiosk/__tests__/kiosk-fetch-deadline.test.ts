// @vitest-environment node

// A gym TV is the surface with the least chance of a human hitting reload, so
// `fetchGymKiosk` hanging on a stalled backend is the worst version of this
// bug: an indefinitely blank screen on a wall. The fetch already maps every
// failure to 'error' (→ KioskRetryScreen, which self-heals); these pin that a
// stall reaches that path within the SSR deadline.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/client', () => ({
  getGraphQLHttpUrl: () => 'http://backend.test/graphql',
}));

import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import { fetchGymKiosk } from '../kiosk-page-renderer';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// `fetchGymKiosk` is React `cache()`-wrapped, so every test needs a fresh slug.
let slugCounter = 0;
function nextGymSlug(): string {
  slugCounter += 1;
  return `gym-${slugCounter}`;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchGymKiosk — the kiosk config read is deadlined', () => {
  it('passes the AbortSignal built from SSR_BACKEND_FETCH_TIMEOUT_MS to fetch', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { gymKiosk: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await fetchGymKiosk(nextGymSlug(), null);

    expect(timeoutSpy).toHaveBeenCalledWith(SSR_BACKEND_FETCH_TIMEOUT_MS);
    const [, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit & { next?: unknown }];
    expect(requestInit.signal).toBe(timeoutSpy.mock.results[0].value);
    expect(requestInit.next).toEqual({ revalidate: 60 });
  });

  it('maps a fired deadline to error, so the TV shows the retry screen', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    expect(await fetchGymKiosk(nextGymSlug(), null)).toEqual({ status: 'error' });
  });

  it('still distinguishes a genuine missing kiosk from a stall', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { gymKiosk: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(await fetchGymKiosk(nextGymSlug(), null)).toEqual({ status: 'ok', kiosk: null });
  });
});
