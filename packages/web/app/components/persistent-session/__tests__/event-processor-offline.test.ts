import { describe, it, expect, vi } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createQueueSyncGate } from '@boardsesh/queue-runtime';
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

function createHarness(offlineBuffer: LocalClimbQueueItem[] = []) {
  const refs = {
    lastReceivedSequenceRef: { current: null as number | null },
    triggerResyncRef: { current: null as (() => void) | null },
    queueEventSubscribersRef: { current: new Set<(event: SubscriptionQueueEvent) => void>() },
    sessionEventSubscribersRef: { current: new Set() } as never,
    offlineBufferRef: { current: offlineBuffer },
  };
  return { refs, syncGate: createQueueSyncGate() };
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useEventProcessor - offline FullSync merge', () => {
  it('FullSync with no offline buffer behaves normally', () => {
    const { refs, syncGate } = createHarness([]);
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });

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
    expect(refs.lastReceivedSequenceRef.current).toBe(5);
  });

  it('FullSync merges offline buffer items into server queue', () => {
    const offlineItem = createItem('offline-1');
    const { refs, syncGate } = createHarness([offlineItem]);
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });

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
    const { refs, syncGate } = createHarness([sharedItem]);
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });

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

  it('FullSync still filters null/corrupted items with merge, and flags needsResync', () => {
    const offlineItem = createItem('offline-1');
    const { refs, syncGate } = createHarness([offlineItem]);
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });

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

    // null/undefined items filtered (by the reducer's INITIAL_QUEUE_DATA
    // filter), offline item appended
    expect(result.current.queue).toHaveLength(2);
    expect(result.current.queue[0]).toEqual(serverItem);
    expect(result.current.queue[1]).toEqual(offlineItem);
    // Reducer-side corruption detection is the resync mechanism now.
    expect(result.current.needsResync).toBe(true);
  });

  it('non-FullSync events still work normally', () => {
    const { refs, syncGate } = createHarness([]);
    // Seed the gate's sequence tracking (the gate owns it now, not the ref).
    syncGate.noteApplied({ __typename: 'QueueItemAdded', sequence: 4, stateHash: 'hash-1' });
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });

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
    expect(refs.lastReceivedSequenceRef.current).toBe(5);
  });

  it('QueueItemRemoved clears current climb and advances state hash', () => {
    const { refs, syncGate } = createHarness([]);
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });
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

  it('PlaybackStateChanged is exempt from the sequence dedup gate', () => {
    // Regression for #2232: the server stamps PlaybackStateChanged with the
    // current room sequence (no bump), so two consecutive events share the
    // same number. The dedup gate would otherwise mark the second as
    // ignore-stale and silently drop party-mode playback sync.
    const { refs, syncGate } = createHarness([]);
    const subscribers: SubscriptionQueueEvent[] = [];
    refs.queueEventSubscribersRef.current.add((event) => subscribers.push(event));
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: { queue: [], currentClimbQueueItem: null, stateHash: 'hash-1', sequence: 5 },
      });
      result.current.handleQueueEvent({
        __typename: 'PlaybackStateChanged',
        sequence: 5,
        climbUuid: 'c-1',
        frameIndex: 1,
        isPlaying: true,
        speed: 1,
        paceMs: 400,
        anchorTimestamp: '1700000000000',
        clientId: 'engine-a',
      } as unknown as SubscriptionQueueEvent);
      result.current.handleQueueEvent({
        __typename: 'PlaybackStateChanged',
        sequence: 5,
        climbUuid: 'c-1',
        frameIndex: 2,
        isPlaying: true,
        speed: 1,
        paceMs: 400,
        anchorTimestamp: '1700000000400',
        clientId: 'engine-a',
      } as unknown as SubscriptionQueueEvent);
    });

    const playback = subscribers.filter((event) => event.__typename === 'PlaybackStateChanged');
    expect(playback).toHaveLength(2);
    expect((playback[1] as unknown as { frameIndex: number }).frameIndex).toBe(2);
  });

  it('ClimbMirrored updates both queue item and current climb', () => {
    const { refs, syncGate } = createHarness([]);
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });
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

describe('useEventProcessor - sync gate at the root', () => {
  it('ignores stale events (sequence <= last received) without applying or notifying', () => {
    const { refs, syncGate } = createHarness([]);
    const subscribers: SubscriptionQueueEvent[] = [];
    refs.queueEventSubscribersRef.current.add((event) => subscribers.push(event));
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });

    const serverItem = createItem('server-1');
    const staleItem = createItem('stale-1');

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: { queue: [serverItem as never], currentClimbQueueItem: null, stateHash: 'hash-1', sequence: 5 },
      });
      // Duplicate of an already-applied sequence — must be dropped at the root.
      result.current.handleQueueEvent({
        __typename: 'QueueItemAdded',
        sequence: 5,
        stateHash: 'hash-stale',
        addedItem: staleItem,
        position: undefined,
      } as SubscriptionQueueEvent);
    });

    expect(result.current.queue).toEqual([serverItem]);
    expect(result.current.lastReceivedStateHash).toBe('hash-1');
    expect(subscribers.filter((event) => event.__typename === 'QueueItemAdded')).toHaveLength(0);
  });

  it('triggers resync on a sequence gap without applying the event', () => {
    const { refs, syncGate } = createHarness([]);
    const triggerResync = vi.fn();
    refs.triggerResyncRef.current = triggerResync;
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });

    const serverItem = createItem('server-1');
    const gapItem = createItem('gap-1');

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: { queue: [serverItem as never], currentClimbQueueItem: null, stateHash: 'hash-1', sequence: 5 },
      });
      // Sequence 8 after 5 — events 6 and 7 were lost.
      result.current.handleQueueEvent({
        __typename: 'QueueItemAdded',
        sequence: 8,
        stateHash: 'hash-8',
        addedItem: gapItem,
        position: undefined,
      } as SubscriptionQueueEvent);
    });

    expect(triggerResync).toHaveBeenCalledTimes(1);
    expect(result.current.queue).toEqual([serverItem]);
    expect(refs.lastReceivedSequenceRef.current).toBe(5);
  });

  it('QueueReordered with a mismatched item at oldIndex triggers resync instead of applying', () => {
    // The old hand-rolled switch clamped indices and moved whatever item it
    // found; order drift is invisible to the sorted-uuid state hash, so it
    // could diverge forever. The reducer-path pre-validation resyncs instead.
    const { refs, syncGate } = createHarness([]);
    const triggerResync = vi.fn();
    refs.triggerResyncRef.current = triggerResync;
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });

    const itemA = createItem('item-a');
    const itemB = createItem('item-b');

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: {
          queue: [itemA as never, itemB as never],
          currentClimbQueueItem: null,
          stateHash: 'hash-1',
          sequence: 5,
        },
      });
      // Server says item-b sits at index 0, but locally item-a is there:
      // local order has drifted from the server's.
      result.current.handleQueueEvent({
        __typename: 'QueueReordered',
        sequence: 6,
        stateHash: 'hash-2',
        uuid: itemB.uuid,
        oldIndex: 0,
        newIndex: 1,
      });
    });

    expect(triggerResync).toHaveBeenCalledTimes(1);
    // Order unchanged — the mismatched reorder was not applied.
    expect(result.current.queue.map((item) => item.uuid)).toEqual([itemA.uuid, itemB.uuid]);
    // Sequence tracking did not advance past the unapplied event.
    expect(refs.lastReceivedSequenceRef.current).toBe(5);
  });

  it('validates a reorder against the freshest state within a synchronous batch', () => {
    // Delta replay applies a whole batch in one task; React batches the
    // dispatches, so the reorder validation must read the post-add queue via
    // the synchronous mirror, not the stale render closure.
    const { refs, syncGate } = createHarness([]);
    const triggerResync = vi.fn();
    refs.triggerResyncRef.current = triggerResync;
    const { result } = renderHook(() => useEventProcessor({ syncGate, refs }), { wrapper: createWrapper() });

    const itemA = createItem('item-a');
    const itemB = createItem('item-b');

    act(() => {
      result.current.handleQueueEvent({
        __typename: 'FullSync',
        sequence: 5,
        state: { queue: [itemA as never], currentClimbQueueItem: null, stateHash: 'hash-1', sequence: 5 },
      });
      result.current.handleQueueEvent({
        __typename: 'QueueItemAdded',
        sequence: 6,
        stateHash: 'hash-2',
        addedItem: itemB,
        position: undefined,
      } as SubscriptionQueueEvent);
      // item-b was appended by the event above in the same tick; the reorder
      // must see it at index 1.
      result.current.handleQueueEvent({
        __typename: 'QueueReordered',
        sequence: 7,
        stateHash: 'hash-3',
        uuid: itemB.uuid,
        oldIndex: 1,
        newIndex: 0,
      });
    });

    expect(triggerResync).not.toHaveBeenCalled();
    expect(result.current.queue.map((item) => item.uuid)).toEqual([itemB.uuid, itemA.uuid]);
    expect(refs.lastReceivedSequenceRef.current).toBe(7);
  });
});
