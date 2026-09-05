import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshGymActivityStats, REFRESH_GYM_ACTIVITY_STATS_MUTATION } from '../jobs/refresh-gym-activity-stats';
import { loadSchedulerConfig } from '../config';

const result = {
  gymCount: 90,
  previousGymCount: 100,
  forced: false,
  scanDurationMs: 40,
  writeDurationMs: 200,
  durationMs: 255,
  timestamp: '2026-09-05T06:30:00.000Z',
};
const context = {
  config: loadSchedulerConfig({
    CRON_SECRET: 'test-secret',
    BOARDSESH_BACKEND_GRAPHQL_URL: 'https://backend.test/graphql',
  }),
  timeoutMs: 60_000,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
};
const success = () => new Response(JSON.stringify({ data: { refreshGymActivityStats: result } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('gym activity GraphQL scheduler job', () => {
  it('posts the mutation and cron credentials directly to the backend', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(success());
    expect(await refreshGymActivityStats(context)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query: REFRESH_GYM_ACTIVITY_STATS_MUTATION }),
      }),
    );
  });

  it.each([401, 409, 500, 504])('fails without retrying HTTP %s', async (status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status }));
    await expect(refreshGymActivityStats(context)).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503])('retries HTTP %s once', async (status) => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status }))
      .mockResolvedValueOnce(success());
    expect(await refreshGymActivityStats(context)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a persistently unavailable backend indefinitely', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }));
    await expect(refreshGymActivityStats(context)).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { errors: [{ message: 'locked' }] },
    { data: { refreshGymActivityStats: result }, errors: [{ message: 'partial error' }] },
    { data: { refreshGymActivityStats: null } },
    { data: { refreshGymActivityStats: { gymCount: 1 } } },
    {},
  ])('rejects GraphQL errors or missing results even with HTTP 200: %j', async (payload) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload)));
    await expect(refreshGymActivityStats(context)).rejects.toThrow(/GraphQL errors|invalid/);
  });

  it('rejects non-JSON success bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>gateway</html>'));
    await expect(refreshGymActivityStats(context)).rejects.toThrow();
  });

  it('aborts an in-flight request on its deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        }),
    );
    const assertion = expect(refreshGymActivityStats({ ...context, timeoutMs: 100 })).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a request after shutdown', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const shutdown = new AbortController();
    shutdown.abort(new Error('stopping'));
    await expect(refreshGymActivityStats({ ...context, shutdownSignal: shutdown.signal })).rejects.toThrow('stopping');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts the retry wait on shutdown', async () => {
    const shutdown = new AbortController();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const assertion = expect(
      refreshGymActivityStats({ ...context, shutdownSignal: shutdown.signal }),
    ).rejects.toThrow();
    shutdown.abort(new Error('stopping'));
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
