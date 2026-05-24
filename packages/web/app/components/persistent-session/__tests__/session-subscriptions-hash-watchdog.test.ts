import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import type { SubscriptionQueueEvent, SessionEvent } from '@boardsesh/shared-schema';
import type { Climb } from '@/app/lib/types';

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
}));

vi.mock('@/app/utils/hash', () => ({
  computeQueueStateHash: vi.fn(),
}));

import * as Sentry from '@sentry/nextjs';
import { computeQueueStateHash } from '@/app/utils/hash';
import { useSessionSubscriptions } from '../hooks/use-session-subscriptions';

const mockClimb: Climb = {
  uuid: 'climb-1',
  setter_username: 'setter1',
  name: 'Test Climb',
  description: '',
  frames: '',
  angle: 40,
  ascensionist_count: 5,
  difficulty: '7',
  quality_average: '3.5',
  stars: 3,
  difficulty_error: '',
  mirrored: false,
  benchmark_difficulty: null,
  userAscents: 0,
  userAttempts: 0,
};

function createItem(uuid: string): LocalClimbQueueItem {
  return {
    uuid,
    climb: { ...mockClimb, uuid: `climb-${uuid}` },
    addedBy: 'user-1',
    suggested: false,
  };
}

function createRefs(offlineBuffer: LocalClimbQueueItem[] = []) {
  return {
    triggerResyncRef: { current: vi.fn() as (() => void) | null },
    lastCorruptionResyncRef: { current: 0 },
    isFilteringCorruptedItemsRef: { current: false },
    queueEventSubscribersRef: { current: new Set<(event: SubscriptionQueueEvent) => void>() },
    sessionEventSubscribersRef: { current: new Set<(event: SessionEvent) => void>() },
    offlineBufferRef: { current: offlineBuffer },
  };
}

const INTERVAL_MS = 60_000;

describe('useSessionSubscriptions - hash watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(computeQueueStateHash).mockReset();
    vi.mocked(Sentry.captureMessage).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips hash verification when offline buffer has pending items', () => {
    const offlineItem = createItem('offline-1');
    const refs = createRefs([offlineItem]);
    const queue = [createItem('item-1')];

    vi.mocked(computeQueueStateHash).mockReturnValue('local-hash');

    renderHook(() =>
      useSessionSubscriptions({
        session: { id: 'session-1' } as never,
        queue,
        currentClimbQueueItem: null,
        lastReceivedStateHash: 'server-hash',
        setQueueState: vi.fn(),
        refs,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS);
    });

    expect(computeQueueStateHash).not.toHaveBeenCalled();
    expect(refs.triggerResyncRef.current).not.toHaveBeenCalled();
  });

  it('triggers resync on hash mismatch when offline buffer is empty', () => {
    const refs = createRefs([]);
    const queue = [createItem('item-1')];

    vi.mocked(computeQueueStateHash).mockReturnValue('different-hash');

    renderHook(() =>
      useSessionSubscriptions({
        session: { id: 'session-1' } as never,
        queue,
        currentClimbQueueItem: null,
        lastReceivedStateHash: 'server-hash',
        setQueueState: vi.fn(),
        refs,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS);
    });

    expect(computeQueueStateHash).toHaveBeenCalled();
    expect(refs.triggerResyncRef.current).toHaveBeenCalledTimes(1);
  });

  it('does not trigger resync when hashes match', () => {
    const refs = createRefs([]);
    const queue = [createItem('item-1')];

    vi.mocked(computeQueueStateHash).mockReturnValue('server-hash');

    renderHook(() =>
      useSessionSubscriptions({
        session: { id: 'session-1' } as never,
        queue,
        currentClimbQueueItem: null,
        lastReceivedStateHash: 'server-hash',
        setQueueState: vi.fn(),
        refs,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS);
    });

    expect(refs.triggerResyncRef.current).not.toHaveBeenCalled();
  });

  it('stops triggering resyncs after RESYNC_LOOP_THRESHOLD consecutive failures', () => {
    const refs = createRefs([]);
    const queue = [createItem('item-1')];
    const triggerResync = vi.fn();
    refs.triggerResyncRef.current = triggerResync;

    vi.mocked(computeQueueStateHash).mockReturnValue('different-hash');

    renderHook(() =>
      useSessionSubscriptions({
        session: { id: 'session-1' } as never,
        queue,
        currentClimbQueueItem: null,
        lastReceivedStateHash: 'server-hash',
        setQueueState: vi.fn(),
        refs,
      }),
    );

    // Tick 1-3: resync fires (threshold=3, guard is <=)
    for (let tick = 1; tick <= 3; tick++) {
      act(() => {
        vi.advanceTimersByTime(INTERVAL_MS);
      });
    }
    expect(triggerResync).toHaveBeenCalledTimes(3);

    // Tick 4: resync suppressed (count=4, 4 > threshold)
    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS);
    });
    expect(triggerResync).toHaveBeenCalledTimes(3);

    // Tick 5: still suppressed
    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS);
    });
    expect(triggerResync).toHaveBeenCalledTimes(3);
  });

  it('reports to Sentry at the threshold with offline buffer length', () => {
    const refs = createRefs([]);
    const queue = [createItem('item-1')];

    vi.mocked(computeQueueStateHash).mockReturnValue('different-hash');

    renderHook(() =>
      useSessionSubscriptions({
        session: { id: 'session-1' } as never,
        queue,
        currentClimbQueueItem: null,
        lastReceivedStateHash: 'server-hash',
        setQueueState: vi.fn(),
        refs,
      }),
    );

    // Advance through 3 ticks to hit the threshold
    for (let tick = 1; tick <= 3; tick++) {
      act(() => {
        vi.advanceTimersByTime(INTERVAL_MS);
      });
    }

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'Resync loop: client keeps disagreeing with server hash',
      expect.objectContaining({
        extra: expect.objectContaining({
          offlineBufferLength: 0,
          serverHash: 'server-hash',
          localHash: 'different-hash',
        }),
      }),
    );
  });
});
