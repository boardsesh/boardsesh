import { afterEach, describe, expect, it, vi } from 'vitest';
import { KilterApiError } from './errors';
import { fetchCatalogDelta, fetchLayoutClimbs } from './kilter-rest';
import fixture from './__fixtures__/catalog-delta.json';

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

describe('timestamp catalog POST', () => {
  function respond(body: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads every retained delta variant beyond the requested limit', async () => {
    const fetchMock = respond(fixture.rows);
    const records = await fetchCatalogDelta('token', fixture.request);
    expect(records).toHaveLength(fixture.rows.length);
    expect(records.length).toBeGreaterThan(fixture.request.limit);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/climbs/climbdetails/productName/edges'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify(fixture.request) }),
    );
    expect(records[0].stat).toMatchObject({ angle: 20, ascentCount: 166 });
    expect(records[0].raw.angle).toBe(35);
    // Inline statistics were changed despite unchanged 2018 climb metadata.
    expect(records[0].climb.updatedAt).toBe('2018-06-25T22:21:09.191404Z');
    expect(records.some((record) => record.stat === null)).toBe(true);
    expect(records[0].raw).toEqual(fixture.rows[0]);
  });

  it('accepts metadata-only bootstrap and empty deltas', async () => {
    respond(fixture.bootstrapRows);
    const records = await fetchCatalogDelta('token', fixture.bootstrapRequest);
    expect(records[0]).toMatchObject({ stat: null, climb: { isDeleted: false, origin: null } });
    respond(fixture.emptyRows);
    await expect(fetchCatalogDelta('token', fixture.request)).resolves.toEqual([]);
  });

  it.each([
    { climbs: [] },
    [null],
    [{ ...fixture.rows[0], derivativeAngle: '20' }],
    [{ ...fixture.rows[0], ascentCount: -1 }],
    [{ ...fixture.rows[0], climbConcat: null }],
  ])('rejects malformed responses before returning any records (%j)', async (body) => {
    respond(body);
    await expect(fetchCatalogDelta('token', fixture.request)).rejects.toMatchObject({ code: 'unknown' });
  });

  it('stops an in-flight request with the caller cancellation reason', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );
    const pending = fetchCatalogDelta('token', fixture.request, controller.signal);
    const reason = new Error('worker attempt lost');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('stops during provider backoff without issuing another request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '2' } }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = fetchCatalogDelta('token', fixture.request, controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    const reason = new Error('cancelled during backoff');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies request timeout and unreadable JSON without returning partial rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('timeout', 'TimeoutError');
      }),
    );
    await expect(fetchCatalogDelta('token', fixture.request)).rejects.toMatchObject({ code: 'timeout' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[invalid')),
    );
    await expect(fetchCatalogDelta('token', fixture.request)).rejects.toMatchObject({ code: 'unknown' });
  });

  it('preserves authorization failures for the token-refresh wrapper', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    await expect(fetchCatalogDelta('token', fixture.request)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('preserves provider Retry-After and aborts during short backoff', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '3600' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchCatalogDelta('token', fixture.request)).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 3_600_000,
    });
    const controller = new AbortController();
    const reason = new Error('worker fence lost');
    controller.abort(reason);
    await expect(fetchCatalogDelta('token', fixture.request, controller.signal)).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
