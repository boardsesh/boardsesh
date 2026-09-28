import { afterEach, describe, expect, it, vi } from 'vitest';
import { KilterApiError } from './errors';
import { fetchLayoutClimbs } from './kilter-rest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('catalog GET on a 429', () => {
  it("hands a Retry-After longer than it may sleep to the caller, without retrying inside Kilter's window", async () => {
    const fetchMock = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } }));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await fetchLayoutClimbs('token', 'layout-1').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(KilterApiError);
    expect(failure).toMatchObject({ code: 'rate_limited', httpStatus: 429, retryAfterMs: 3_600_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits out a short Retry-After and retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const climbs = fetchLayoutClimbs('token', 'layout-1');
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(climbs).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
