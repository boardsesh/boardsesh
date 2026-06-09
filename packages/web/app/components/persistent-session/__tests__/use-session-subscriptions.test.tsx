import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';

// Force the watchdog into a permanent mismatch: the local hash never equals the
// server hash below, so every 60s tick sees drift and would resync forever
// without the convergence guard (issue #2359).
vi.mock('@/app/utils/hash', () => ({ computeQueueStateHash: () => 'local-hash' }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));

import { useSessionSubscriptions } from '../hooks/use-session-subscriptions';

type SubscriptionsArgs = Parameters<typeof useSessionSubscriptions>[0];

describe('useSessionSubscriptions — watchdog convergence (issue #2359)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('backs off auto-resync after the loop threshold for an unchanging server hash', () => {
    const triggerResync = vi.fn();
    const refs = {
      triggerResyncRef: { current: triggerResync },
      lastCorruptionResyncRef: { current: 0 },
      isFilteringCorruptedItemsRef: { current: false },
      queueEventSubscribersRef: { current: new Set() },
      sessionEventSubscribersRef: { current: new Set() },
      offlineBufferRef: { current: [] },
    } as unknown as SubscriptionsArgs['refs'];

    renderHook(() =>
      useSessionSubscriptions({
        session: { id: 'session-1' } as SubscriptionsArgs['session'],
        // Non-empty, null-free queue: the corruption effect stays quiet and the
        // watchdog effect actually arms its interval.
        queue: [{ uuid: 'climb-a' }] as unknown as SubscriptionsArgs['queue'],
        // Null current climb: the "current not in queue" defensive check returns
        // early, so the only thing that can call triggerResync is the watchdog.
        currentClimbQueueItem: null,
        lastReceivedStateHash: 'server-hash',
        setQueueState: vi.fn(),
        refs,
      }),
    );

    // Six watchdog ticks. With RESYNC_LOOP_THRESHOLD = 3 the resync fires on the
    // first three ticks, then the guard suppresses it — it must not keep firing
    // every minute against a server hash that never changes.
    for (let tick = 0; tick < 6; tick++) {
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
    }

    expect(triggerResync).toHaveBeenCalledTimes(3);
  });
});
