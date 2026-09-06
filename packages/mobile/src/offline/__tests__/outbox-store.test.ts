// @vitest-environment jsdom
// The live outbox gauge behind the connectivity banner (issue #4862). What is
// worth pinning here is the read POLICY, not the arithmetic: read only while
// something is subscribed, coalesce a drain burst into one read, and answer
// "unknown" rather than "zero" when the read fails.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const getOutboxSummaryMock = vi.hoisted(() => vi.fn());
vi.mock('@boardsesh/offline-sync', () => ({ getOutboxSummary: getOutboxSummaryMock }));

// Captured so a test can fire a drain acknowledgement the way the drainer does.
const deliveryControl = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  unsubscribeCalls: 0,
}));
vi.mock('../offline-sync-adapter', () => ({
  subscribeMutationDelivery: (listener: () => void) => {
    deliveryControl.listeners.add(listener);
    return () => {
      deliveryControl.unsubscribeCalls += 1;
      deliveryControl.listeners.delete(listener);
    };
  },
}));

import type { SqlExecutor } from '@boardsesh/offline-sync';
import { notifyOutboxChanged, useOutboxSummary, __resetOutboxStoreForTests } from '../outbox-store';

const db = {} as SqlExecutor;

// Matches REFRESH_DEBOUNCE_MS in the store; a read is only due once this passes.
const DEBOUNCE_MS = 150;

function summary(pendingCount: number, deadLetterCount = 0) {
  return { pendingCount, deadLetterCount, oldestPendingAt: null, oldestDeadLetterAt: null };
}

/** Let the debounce elapse and the awaited read resolve. */
async function settleRefresh(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
    // Three microtask turns: the timer callback starts the read, the mocked
    // query resolves, and `publish` notifies. `act` flushes React in between.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function fireDelivery(): void {
  for (const listener of deliveryControl.listeners) listener();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  deliveryControl.listeners.clear();
  deliveryControl.unsubscribeCalls = 0;
  __resetOutboxStoreForTests();
  getOutboxSummaryMock.mockResolvedValue(summary(0));
});

afterEach(() => {
  __resetOutboxStoreForTests();
  vi.useRealTimers();
});

describe('useOutboxSummary', () => {
  it('starts unknown and publishes the counts once the first read lands', async () => {
    getOutboxSummaryMock.mockResolvedValue(summary(3, 1));
    const { result } = renderHook(() => useOutboxSummary(db));

    expect(result.current).toBeNull();

    await settleRefresh();

    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ pendingCount: 3, deadLetterCount: 1 });
  });

  it('never reads with a null handle', async () => {
    renderHook(() => useOutboxSummary(null));
    notifyOutboxChanged();
    await settleRefresh();

    expect(getOutboxSummaryMock).not.toHaveBeenCalled();
  });

  it('drops the counts when the handle changes, rather than showing another database', async () => {
    getOutboxSummaryMock.mockResolvedValue(summary(2));
    const { result, rerender } = renderHook(({ handle }: { handle: SqlExecutor | null }) => useOutboxSummary(handle), {
      initialProps: { handle: db as SqlExecutor | null },
    });
    await settleRefresh();
    expect(result.current).toEqual({ pendingCount: 2, deadLetterCount: 0 });

    // Sign-out clears the handle; the counts it produced no longer describe
    // anything the app can read.
    rerender({ handle: null });
    expect(result.current).toBeNull();
  });

  it('re-reads rather than doing arithmetic, so a count can only come from the table', async () => {
    getOutboxSummaryMock.mockResolvedValue(summary(4));
    const { result } = renderHook(() => useOutboxSummary(db));
    await settleRefresh();
    expect(result.current).toEqual({ pendingCount: 4, deadLetterCount: 0 });

    // Something drained two rows while we were not looking — the next read is the
    // only thing that decides the number.
    getOutboxSummaryMock.mockResolvedValue(summary(2));
    notifyOutboxChanged();
    await settleRefresh();

    expect(result.current).toEqual({ pendingCount: 2, deadLetterCount: 0 });
  });

  it('coalesces a burst of drain acknowledgements into one read', async () => {
    renderHook(() => useOutboxSummary(db));
    await settleRefresh();
    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(1);

    getOutboxSummaryMock.mockResolvedValue(summary(1));
    fireDelivery();
    fireDelivery();
    fireDelivery();
    notifyOutboxChanged();
    await settleRefresh();

    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(2);
  });

  it('re-reads when a mutation is delivered', async () => {
    renderHook(() => useOutboxSummary(db));
    await settleRefresh();

    getOutboxSummaryMock.mockResolvedValue(summary(0, 2));
    fireDelivery();
    await settleRefresh();

    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(2);
  });

  it('re-reads on notifyOutboxChanged — the foreground hook calls this on resume', async () => {
    // The store deliberately holds no AppState listener (a static react-native
    // import here would leak Flow source into the hooks barrel's test graph);
    // use-connectivity-banner.ts calls notifyOutboxChanged() when the app
    // becomes active, so this is the seam a resume goes through.
    const { result } = renderHook(() => useOutboxSummary(db));
    await settleRefresh();
    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(1);

    getOutboxSummaryMock.mockResolvedValue(summary(5));
    notifyOutboxChanged();
    await settleRefresh();

    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ pendingCount: 5, deadLetterCount: 0 });
  });

  it('reports unknown, never zero, when the read fails', async () => {
    getOutboxSummaryMock.mockResolvedValue(summary(3));
    const { result } = renderHook(() => useOutboxSummary(db));
    await settleRefresh();
    expect(result.current).toEqual({ pendingCount: 3, deadLetterCount: 0 });

    // The schema is created lazily, so a query can land before the table exists.
    getOutboxSummaryMock.mockRejectedValue(new Error('no such table: pending_mutations'));
    notifyOutboxChanged();
    await settleRefresh();

    expect(result.current).toBeNull();
  });

  it('keeps the same snapshot object when the counts are unchanged', async () => {
    getOutboxSummaryMock.mockResolvedValue(summary(2, 1));
    const { result } = renderHook(() => useOutboxSummary(db));
    await settleRefresh();
    const first = result.current;

    notifyOutboxChanged();
    await settleRefresh();

    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(first);
  });

  it('stops watching once the last consumer unmounts, and reads nothing after', async () => {
    const { unmount } = renderHook(() => useOutboxSummary(db));
    await settleRefresh();
    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(1);

    unmount();

    expect(deliveryControl.unsubscribeCalls).toBe(1);

    notifyOutboxChanged();
    await settleRefresh();

    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(1);
  });
});

describe('notifyOutboxChanged', () => {
  it('is a no-op with nobody subscribed', async () => {
    notifyOutboxChanged();
    notifyOutboxChanged();
    await settleRefresh();

    expect(getOutboxSummaryMock).not.toHaveBeenCalled();
  });
});
