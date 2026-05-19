import { describe, it, expect } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEventProcessor } from '../hooks/use-event-processor';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import type { Climb } from '@/app/lib/types';
import type { SubscriptionQueueEvent } from '@boardsesh/shared-schema';

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
    lastReceivedSequenceRef: { current: null as number | null },
    triggerResyncRef: { current: null as (() => void) | null },
    lastCorruptionResyncRef: { current: 0 },
    isFilteringCorruptedItemsRef: { current: false },
    queueEventSubscribersRef: { current: new Set<(event: SubscriptionQueueEvent) => void>() },
    sessionEventSubscribersRef: { current: new Set() } as never,
    offlineBufferRef: { current: offlineBuffer },
    activeSessionRef: { current: null } as never,
    setActiveSessionSharedPlaylistEnabledRef: { current: null } as never,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useEventProcessor - offline FullSync merge', () => {
  it('FullSync with no offline buffer behaves normally', () => {
    const refs = createRefs([]);
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    const serverItem = createItem('server-1');

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: {
          queue: [serverItem as never],
          currentClimbQueueItem: null,
          stateHash: 'hash-1',
          sequence: 5,
        },
      });
    });

    expect(result.current.queue).toEqual([serverItem]);
    expect(result.current.lastReceivedStateHash).toBe('hash-1');
  });

  it('FullSync merges offline buffer items into server queue', () => {
    const offlineItem = createItem('offline-1');
    const refs = createRefs([offlineItem]);
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    const serverItem = createItem('server-1');

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: {
          queue: [serverItem as never],
          currentClimbQueueItem: null,
          stateHash: 'hash-1',
          sequence: 5,
        },
      });
    });

    // Server item first, offline item appended
    expect(result.current.queue).toHaveLength(2);
    expect(result.current.queue[0]).toEqual(serverItem);
    expect(result.current.queue[1]).toEqual(offlineItem);
  });

  it('FullSync does not duplicate items with same UUID', () => {
    const sharedItem = createItem('shared-1');
    const refs = createRefs([sharedItem]);
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: {
          queue: [sharedItem as never],
          currentClimbQueueItem: null,
          stateHash: 'hash-1',
          sequence: 5,
        },
      });
    });

    // Should not duplicate - item already in server queue
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0]).toEqual(sharedItem);
  });

  it('FullSync still filters null/corrupted items with merge', () => {
    const offlineItem = createItem('offline-1');
    const refs = createRefs([offlineItem]);
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    const serverItem = createItem('server-1');

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: {
          queue: [serverItem as never, null as never, undefined as never],
          currentClimbQueueItem: null,
          stateHash: 'hash-1',
          sequence: 5,
        },
      });
    });

    // null/undefined items filtered, offline item appended
    expect(result.current.queue).toHaveLength(2);
    expect(result.current.queue[0]).toEqual(serverItem);
    expect(result.current.queue[1]).toEqual(offlineItem);
  });

  it('non-FullSync events still work normally', () => {
    const refs = createRefs([]);
    refs.lastReceivedSequenceRef.current = 4;
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    const addedItem = createItem('added-1');

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'QueueItemAdded',
        sequence: 5,
        stateHash: 'hash-2',
        addedItem,
        position: undefined,
      } as SubscriptionQueueEvent);
    });

    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0]).toEqual(addedItem);
    expect(result.current.lastReceivedStateHash).toBe('hash-2');
  });

  it('QueueItemRemoved clears current climb and advances state hash', () => {
    const refs = createRefs([]);
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });
    const removedItem = createItem('removed-1');
    const keptItem = createItem('kept-1');

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: {
          queue: [removedItem as never, keptItem as never],
          currentClimbQueueItem: removedItem as never,
          stateHash: 'hash-1',
          sequence: 5,
        },
      });
      result.current.handleQueueEvent({
        __typename: 'QueueItemRemoved',
        sequence: 6,
        stateHash: 'hash-2',
        uuid: removedItem.uuid,
      });
    });

    expect(result.current.queue).toEqual([keptItem]);
    expect(result.current.currentClimbQueueItem).toBeNull();
    expect(result.current.lastReceivedStateHash).toBe('hash-2');
  });

  it('ClimbMirrored updates both queue item and current climb', () => {
    const refs = createRefs([]);
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });
    const item = createItem('mirror-1');

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: {
          queue: [item as never],
          currentClimbQueueItem: item as never,
          stateHash: 'hash-1',
          sequence: 5,
        },
      });
      result.current.handleQueueEvent({
        __typename: 'ClimbMirrored',
        sequence: 6,
        stateHash: 'hash-2',
        mirroredUuid: item.uuid,
        mirrored: true,
      });
    });

    expect(result.current.queue[0]?.climb.mirrored).toBe(true);
    expect(result.current.currentClimbQueueItem?.climb.mirrored).toBe(true);
    expect(result.current.lastReceivedStateHash).toBe('hash-2');
  });
});
