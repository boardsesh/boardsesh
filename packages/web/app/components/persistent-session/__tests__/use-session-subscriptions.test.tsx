import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { createQueueSyncGate, CORRUPTION_RESYNC_COOLDOWN_MS } from '@boardsesh/queue-runtime';

// Force the watchdog into a permanent mismatch: the local hash never equals the
// server hash below, so every 60s tick sees drift and would resync forever
// without the convergence guard (issue #2359).
vi.mock('@/app/utils/hash', () => ({ computeQueueStateHash: () => 'local-hash' }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));

import { useSessionSubscriptions } from '../hooks/use-session-subscriptions';

type SubscriptionsArgs = Parameters<typeof useSessionSubscriptions>[0];

function createRefs(triggerResync: () => void) {
  return {
    triggerResyncRef: { current: triggerResync },
    queueEventSubscribersRef: { current: new Set() },
    sessionEventSubscribersRef: { current: new Set() },
  } as unknown as SubscriptionsArgs['refs'];
}

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
    const syncGate = createQueueSyncGate();
    // Seed the gate's server-hash tracking the way the event processor does
    // after applying a delta.
    syncGate.noteApplied({ __typename: 'QueueItemAdded', sequence: 1, stateHash: 'server-hash' });

    renderHook(() =>
      useSessionSubscriptions({
        session: { id: 'session-1' } as SubscriptionsArgs['session'],
        // Non-empty, null-free queue so the watchdog effect arms its interval.
        queue: [{ uuid: 'climb-a' }] as unknown as SubscriptionsArgs['queue'],
        // Null current climb: the "current not in queue" defensive check returns
        // early, so the only thing that can call triggerResync is the watchdog.
        currentClimbQueueItem: null,
        lastReceivedStateHash: 'server-hash',
        needsResync: false,
        clearResyncFlag: vi.fn(),
        syncGate,
        refs: createRefs(triggerResync),
      }),
    );

    // Six watchdog ticks. With RESYNC_LOOP_THRESHOLD = 3 the resync fires on the
    // first three ticks, then the gate's backoff verdict suppresses it — it must
    // not keep firing every minute against a server hash that never changes.
    for (let tick = 0; tick < 6; tick++) {
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
    }

    expect(triggerResync).toHaveBeenCalledTimes(3);
  });
});

describe('useSessionSubscriptions — reducer-flagged corruption resync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resyncs on needsResync, acknowledges the flag, and honours the gate cooldown', () => {
    const triggerResync = vi.fn();
    const clearResyncFlag = vi.fn();
    const clock = { now: 1_000_000 };
    const syncGate = createQueueSyncGate({ now: () => clock.now });

    const buildArgs = (needsResync: boolean): SubscriptionsArgs => ({
      session: { id: 'session-1' } as SubscriptionsArgs['session'],
      queue: [{ uuid: 'climb-a' }] as unknown as SubscriptionsArgs['queue'],
      currentClimbQueueItem: null,
      // Null hash keeps the 60s watchdog disarmed — this test only exercises
      // the corruption path.
      lastReceivedStateHash: null,
      needsResync,
      clearResyncFlag,
      syncGate,
      refs: createRefs(triggerResync),
    });

    const { rerender } = renderHook((args: SubscriptionsArgs) => useSessionSubscriptions(args), {
      initialProps: buildArgs(true),
    });

    // First corruption: acknowledged and resynced.
    expect(clearResyncFlag).toHaveBeenCalledTimes(1);
    expect(triggerResync).toHaveBeenCalledTimes(1);

    // Second corruption inside the cooldown window: acknowledged, but no
    // resync — the reducer already filtered the nulls out of local state, so
    // a resync storm gains nothing (KEEP the cooldown).
    rerender(buildArgs(false));
    rerender(buildArgs(true));
    expect(clearResyncFlag).toHaveBeenCalledTimes(2);
    expect(triggerResync).toHaveBeenCalledTimes(1);

    // After the cooldown elapses, a fresh corruption resyncs again.
    clock.now += CORRUPTION_RESYNC_COOLDOWN_MS + 1;
    rerender(buildArgs(false));
    rerender(buildArgs(true));
    expect(clearResyncFlag).toHaveBeenCalledTimes(3);
    expect(triggerResync).toHaveBeenCalledTimes(2);
  });

  it('leaves needsResync pending when there is no session (no silent acknowledgement)', () => {
    const triggerResync = vi.fn();
    const clearResyncFlag = vi.fn();
    const syncGate = createQueueSyncGate();

    renderHook(() =>
      useSessionSubscriptions({
        session: null,
        queue: [] as unknown as SubscriptionsArgs['queue'],
        currentClimbQueueItem: null,
        lastReceivedStateHash: null,
        needsResync: true,
        clearResyncFlag,
        syncGate,
        refs: createRefs(triggerResync),
      }),
    );

    // Without a session there is nothing to resync against; the flag stays
    // pending (the next connect()'s FullSync recomputes it) rather than being
    // acknowledged with no action taken.
    expect(clearResyncFlag).not.toHaveBeenCalled();
    expect(triggerResync).not.toHaveBeenCalled();
  });
});
