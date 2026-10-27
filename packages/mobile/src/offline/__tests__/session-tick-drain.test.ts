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
  deliveryListeners: new Set<(event: { tableName: string }) => void>(),
}));

vi.mock('../../db', () => ({ getDatabaseHandle: () => mocks.db }));
vi.mock('../../lib/graphql/client', () => ({ getOfflineSyncHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../offline-sync-adapter', () => ({
  drainMutationQueue: mocks.drainMutationQueue,
  isOnline: () => mocks.online,
  subscribeMutationDelivery: (listener: (event: { tableName: string }) => void) => {
    mocks.deliveryListeners.add(listener);
    return () => mocks.deliveryListeners.delete(listener);
  },
}));
vi.mock('../pending-tick', () => ({ hasQueuedTicksForSession: mocks.hasQueuedTicksForSession }));

import {
  SESSION_TICK_SYNC_TIMEOUT_MS,
  SESSION_TICK_WATCH_LIFETIME_MS,
  refreshSessionWhenQueuedTicksLand,
  waitForSessionTicksToSync,
} from '../session-tick-drain';

const queryClient = new QueryClient();

beforeEach(() => {
  vi.useFakeTimers();
  mocks.db = {};
  mocks.online = true;
  mocks.hasQueuedTicksForSession.mockReset();
  mocks.drainMutationQueue.mockClear();
  mocks.deliveryListeners.clear();
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

  it('does not start a drain when the first read only answers after the cap', async () => {
    let answerFirstRead: (queued: boolean) => void = () => undefined;
    mocks.hasQueuedTicksForSession.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answerFirstRead = resolve;
        }),
    );
    const result = waitForSessionTicksToSync('session-1', queryClient);
    await vi.advanceTimersByTimeAsync(SESSION_TICK_SYNC_TIMEOUT_MS);
    await expect(result).resolves.toBe('timedOut');
    answerFirstRead(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.drainMutationQueue).not.toHaveBeenCalled();
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

describe('refreshSessionWhenQueuedTicksLand', () => {
  function deliver(tableName: string) {
    for (const listener of mocks.deliveryListeners) listener({ tableName });
  }

  it('refreshes the summary and detail once, when the last queued tick lands', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    // Still queued at start, still queued after the first delivery, then gone.
    mocks.hasQueuedTicksForSession.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);

    refreshSessionWhenQueuedTicksLand('session-1', client);
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidate).not.toHaveBeenCalled();

    deliver('boardsesh_ticks');
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidate).not.toHaveBeenCalled();

    deliver('boardsesh_ticks');
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessionSummary', 'session-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessionDetail', 'session-1'] });
    expect(invalidate).toHaveBeenCalledTimes(2);
    // Unsubscribed: later deliveries read nothing and refresh nothing.
    expect(mocks.deliveryListeners.size).toBe(0);
  });

  it('ignores deliveries for other tables', async () => {
    const client = new QueryClient();
    mocks.hasQueuedTicksForSession.mockResolvedValue(true);
    refreshSessionWhenQueuedTicksLand('session-1', client);
    await vi.advanceTimersByTimeAsync(0);
    const readsAfterStart = mocks.hasQueuedTicksForSession.mock.calls.length;
    deliver('user_favorites');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.hasQueuedTicksForSession.mock.calls.length).toBe(readsAfterStart);
  });

  it('refreshes at once when the ticks already landed between the cap and the end', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    mocks.hasQueuedTicksForSession.mockResolvedValue(false);
    refreshSessionWhenQueuedTicksLand('session-1', client);
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessionSummary', 'session-1'] });
    expect(mocks.deliveryListeners.size).toBe(0);
  });

  it('stops listening after its lifetime, refresh or not', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    mocks.hasQueuedTicksForSession.mockResolvedValue(true);
    refreshSessionWhenQueuedTicksLand('session-1', client);
    await vi.advanceTimersByTimeAsync(SESSION_TICK_WATCH_LIFETIME_MS);
    expect(mocks.deliveryListeners.size).toBe(0);
    mocks.hasQueuedTicksForSession.mockResolvedValue(false);
    deliver('boardsesh_ticks');
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
