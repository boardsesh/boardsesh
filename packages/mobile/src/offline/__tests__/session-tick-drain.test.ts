// The pre-END_SESSION wait for a session's queued ticks (#6903): it polls the
// outbox (a drain promise proves nothing while another drain holds the latch),
// returns early when nothing is queued, skips the wait offline, and gives up at
// the cap.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  db: {} as object | null,
  online: true,
  hasQueuedTicksForSession: vi.fn<(sessionId: string) => Promise<boolean>>(),
  drainMutationQueue: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../db', () => ({ getDatabaseHandle: () => mocks.db }));
vi.mock('../../lib/graphql/client', () => ({ getOfflineSyncHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../offline-sync-adapter', () => ({
  drainMutationQueue: mocks.drainMutationQueue,
  isOnline: () => mocks.online,
}));
vi.mock('../pending-tick', () => ({ hasQueuedTicksForSession: mocks.hasQueuedTicksForSession }));

import { SESSION_TICK_SYNC_TIMEOUT_MS, waitForSessionTicksToSync } from '../session-tick-drain';

const queryClient = new QueryClient();

beforeEach(() => {
  vi.useFakeTimers();
  mocks.db = {};
  mocks.online = true;
  mocks.hasQueuedTicksForSession.mockReset();
  mocks.drainMutationQueue.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForSessionTicksToSync', () => {
  it('returns at once, without a drain, when nothing of the session is queued', async () => {
    mocks.hasQueuedTicksForSession.mockResolvedValue(false);
    await expect(waitForSessionTicksToSync('session-1', queryClient)).resolves.toBe('none');
    expect(mocks.drainMutationQueue).not.toHaveBeenCalled();
    expect(mocks.hasQueuedTicksForSession).toHaveBeenCalledTimes(1);
  });

  it('returns at once when there is no local database', async () => {
    mocks.db = null;
    await expect(waitForSessionTicksToSync('session-1', queryClient)).resolves.toBe('none');
    expect(mocks.hasQueuedTicksForSession).not.toHaveBeenCalled();
  });

  it('skips the wait offline, and does not start a drain', async () => {
    mocks.online = false;
    mocks.hasQueuedTicksForSession.mockResolvedValue(true);
    await expect(waitForSessionTicksToSync('session-1', queryClient)).resolves.toBe('offline');
    expect(mocks.drainMutationQueue).not.toHaveBeenCalled();
    expect(mocks.hasQueuedTicksForSession).not.toHaveBeenCalled();
  });

  it('starts a drain and returns once the queued ticks are gone', async () => {
    // Queued on the first two reads, then landed.
    mocks.hasQueuedTicksForSession.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const result = waitForSessionTicksToSync('session-1', queryClient, { pollMs: 100 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(result).resolves.toBe('synced');
    expect(mocks.drainMutationQueue).toHaveBeenCalledTimes(1);
    expect(mocks.hasQueuedTicksForSession).toHaveBeenCalledWith('session-1');
  });

  it('gives up at the 3 s cap while the ticks stay queued', async () => {
    mocks.hasQueuedTicksForSession.mockResolvedValue(true);
    let settled = false;
    const result = waitForSessionTicksToSync('session-1', queryClient).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(SESSION_TICK_SYNC_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('timedOut');
    // The poll stops with the cap: no reads keep running after it.
    const readsAtCap = mocks.hasQueuedTicksForSession.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.hasQueuedTicksForSession.mock.calls.length).toBe(readsAtCap);
  });

  it('gives up at the cap even when the first outbox read hangs', async () => {
    mocks.hasQueuedTicksForSession.mockImplementation(() => new Promise<boolean>(() => undefined));
    const result = waitForSessionTicksToSync('session-1', queryClient);
    await vi.advanceTimersByTimeAsync(SESSION_TICK_SYNC_TIMEOUT_MS);
    await expect(result).resolves.toBe('timedOut');
  });

  it('gives up at the cap even when a later outbox read hangs', async () => {
    mocks.hasQueuedTicksForSession
      .mockResolvedValueOnce(true)
      .mockImplementation(() => new Promise<boolean>(() => undefined));
    const result = waitForSessionTicksToSync('session-1', queryClient);
    await vi.advanceTimersByTimeAsync(SESSION_TICK_SYNC_TIMEOUT_MS);
    await expect(result).resolves.toBe('timedOut');
  });
});
