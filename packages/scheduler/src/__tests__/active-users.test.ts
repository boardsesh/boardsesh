import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PURGE_EXPIRED_USER_ACTIVITY_MUTATION,
  purgeUserActivity,
  SNAPSHOT_ACTIVE_USERS_MUTATION,
  snapshotActiveUsers,
} from '../jobs/active-users';
import { loadSchedulerConfig } from '../config';

/**
 * The scheduler half of the first-party active-user count (#2644). The counting
 * and the deleting run in the backend and are asserted against a real database
 * in `packages/backend/src/__tests__/active-users-snapshot.test.ts`; what is
 * testable here is the HTTP contract each job owns.
 */

const snapshotResult = {
  day: '2026-10-08',
  dailyActiveUsers: 120,
  weeklyActiveUsers: 410,
  monthlyActiveUsers: 980,
  captured: true,
  durationMs: 35,
  platforms: [{ platform: 'ios', dailyActiveUsers: 70, weeklyActiveUsers: 200, monthlyActiveUsers: 500 }],
};
const purgeResult = { rowsDeleted: 113, cutoffDay: '2025-09-08', durationMs: 12 };

function jobContext() {
  return {
    config: loadSchedulerConfig({
      CRON_SECRET: 'test-secret',
      BOARDSESH_BACKEND_GRAPHQL_URL: 'https://backend.test/graphql',
    }),
    timeoutMs: 60_000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('snapshot-active-users job', () => {
  it('posts the mutation with the cron credentials and returns the counts', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ data: { snapshotActiveUsers: snapshotResult } }));

    expect(await snapshotActiveUsers(jobContext())).toMatchObject({
      day: '2026-10-08',
      monthlyActiveUsers: 980,
      captured: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret' }),
        body: JSON.stringify({ query: SNAPSHOT_ACTIVE_USERS_MUTATION }),
      }),
    );
  });

  it('refuses a 200 that carries GraphQL errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ errors: [{ message: 'nope' }], data: null }));
    await expect(snapshotActiveUsers(jobContext())).rejects.toThrow('GraphQL errors');
  });

  it('refuses a result with a missing or negative count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: { snapshotActiveUsers: { ...snapshotResult, monthlyActiveUsers: -1 } } }),
    );
    await expect(snapshotActiveUsers(jobContext())).rejects.toThrow('invalid result');
  });

  it('warns, without failing, when the backend counted but did not send', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: { snapshotActiveUsers: { ...snapshotResult, captured: false } } }),
    );
    const context = jobContext();

    await expect(snapshotActiveUsers(context)).resolves.toMatchObject({ captured: false });
    expect(context.logger.warn).toHaveBeenCalledWith('active users snapshot was not sent to PostHog', {
      day: '2026-10-08',
    });
  });

  it.each([401, 409, 500, 504])('fails without retrying HTTP %s', async (status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status }));
    await expect(snapshotActiveUsers(jobContext())).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503])('retries HTTP %s once, the signature of a deploy in flight', async (status) => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status }))
      .mockResolvedValueOnce(jsonResponse({ data: { snapshotActiveUsers: snapshotResult } }));
    expect(await snapshotActiveUsers(jobContext())).toMatchObject({ dailyActiveUsers: 120 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('purge-user-activity job', () => {
  it('posts the purge mutation and returns what it deleted', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ data: { purgeExpiredUserActivity: purgeResult } }));

    expect(await purgeUserActivity(jobContext())).toEqual(purgeResult);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/graphql',
      expect.objectContaining({ body: JSON.stringify({ query: PURGE_EXPIRED_USER_ACTIVITY_MUTATION }) }),
    );
  });

  it('refuses a result without a cutoff day', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: { purgeExpiredUserActivity: { rowsDeleted: 1, durationMs: 3 } } }),
    );
    await expect(purgeUserActivity(jobContext())).rejects.toThrow('invalid result');
  });
});
