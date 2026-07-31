import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook } from '@testing-library/react';
import type { SubscriptionQueueEvent } from '@boardsesh/shared-schema';

const { mockTrack } = vi.hoisted(() => ({ mockTrack: vi.fn() }));
vi.mock('@/app/lib/analytics', () => ({ track: mockTrack }));

import { usePeerBroadcastAnalytics } from '../hooks/use-peer-broadcast-analytics';

function createSubscribeToQueueEvents() {
  const subscribers = new Set<(event: SubscriptionQueueEvent) => void>();
  const subscribeToQueueEvents = vi.fn((callback: (event: SubscriptionQueueEvent) => void) => {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  });
  const emit = (event: SubscriptionQueueEvent) => {
    subscribers.forEach((callback) => callback(event));
  };
  return { subscribeToQueueEvents, emit };
}

const addedEvent: SubscriptionQueueEvent = {
  __typename: 'QueueItemAdded',
  sequence: 1,
  stateHash: 'hash-1',
  addedItem: { uuid: 'item-1' } as never,
  position: null,
};

const removedEvent: SubscriptionQueueEvent = {
  __typename: 'QueueItemRemoved',
  sequence: 2,
  stateHash: 'hash-2',
  uuid: 'item-1',
};

describe('usePeerBroadcastAnalytics', () => {
  beforeEach(() => {
    mockTrack.mockReset();
  });

  it('fires "Climb Added to Queue" for a peer QueueItemAdded event while on a board route', () => {
    const { subscribeToQueueEvents, emit } = createSubscribeToQueueEvents();
    renderHook(() =>
      usePeerBroadcastAnalytics({
        subscribeToQueueEvents,
        isOnBoardRoute: true,
        boardLayoutName: 'Original',
        queueRef: { current: new Array(2) },
        clientId: null,
      }),
    );

    emit(addedEvent);

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('Climb Added to Queue', {
      boardLayout: 'Original',
      addedFromTab: 'peer_broadcast',
      currentQueueLength: 3,
      partyMode: true,
    });
  });

  it('fires "Climb Removed from Queue" for a peer QueueItemRemoved event while on a board route', () => {
    const { subscribeToQueueEvents, emit } = createSubscribeToQueueEvents();
    renderHook(() =>
      usePeerBroadcastAnalytics({
        subscribeToQueueEvents,
        isOnBoardRoute: true,
        boardLayoutName: 'Original',
        queueRef: { current: new Array(2) },
        clientId: null,
      }),
    );

    emit(removedEvent);

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('Climb Removed from Queue', {
      boardLayout: 'Original',
      partyMode: true,
      removedBy: 'peer',
    });
  });

  // Strict parity with the deleted board-route hook this replaces: that hook
  // only ever ran inside GraphQLQueueProvider (board-route-scoped), so
  // off-board surfaces never fired this analytics. Since this now runs at the
  // always-mounted root, the gate is what restores that parity.
  it('does not fire analytics for the same events off a board route', () => {
    const { subscribeToQueueEvents, emit } = createSubscribeToQueueEvents();
    renderHook(() =>
      usePeerBroadcastAnalytics({
        subscribeToQueueEvents,
        isOnBoardRoute: false,
        boardLayoutName: null,
        queueRef: { current: new Array(0) },
        clientId: null,
      }),
    );

    emit(addedEvent);
    emit(removedEvent);

    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('lands exactly once per event — no double-fire on a single peer add', () => {
    const { subscribeToQueueEvents, emit } = createSubscribeToQueueEvents();
    renderHook(() =>
      usePeerBroadcastAnalytics({
        subscribeToQueueEvents,
        isOnBoardRoute: true,
        boardLayoutName: 'Original',
        queueRef: { current: new Array(0) },
        clientId: null,
      }),
    );

    emit(addedEvent);

    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it('skips a malformed QueueItemAdded (no item payload) — same gate as the reducer dispatch', () => {
    // The old board-route hook only fired analytics when the wire mapper
    // returned a dispatch; a QueueItemAdded with no item maps to 'ignore'
    // (no state change), so it never counted. Pin that parity here.
    const { subscribeToQueueEvents, emit } = createSubscribeToQueueEvents();
    renderHook(() =>
      usePeerBroadcastAnalytics({
        subscribeToQueueEvents,
        isOnBoardRoute: true,
        boardLayoutName: 'Original',
        queueRef: { current: new Array(0) },
        clientId: null,
      }),
    );

    emit({ ...addedEvent, addedItem: undefined as never });

    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('re-subscribes only when subscribeToQueueEvents identity changes, not on every isOnBoardRoute/boardLayoutName flip', () => {
    const { subscribeToQueueEvents } = createSubscribeToQueueEvents();
    // Stable ref identity across renders, matching production (`queueRef` is
    // a genuine `useRef` on the caller side, never a fresh object per render).
    const queueRef = { current: [] as unknown[] };
    const { rerender } = renderHook(
      (props: { isOnBoardRoute: boolean; boardLayoutName: string | null }) =>
        usePeerBroadcastAnalytics({
          subscribeToQueueEvents,
          isOnBoardRoute: props.isOnBoardRoute,
          boardLayoutName: props.boardLayoutName,
          queueRef,
          clientId: null,
        }),
      { initialProps: { isOnBoardRoute: true, boardLayoutName: 'Original' } },
    );

    expect(subscribeToQueueEvents).toHaveBeenCalledTimes(1);

    rerender({ isOnBoardRoute: false, boardLayoutName: 'Angled' });
    rerender({ isOnBoardRoute: true, boardLayoutName: 'Original' });

    // Still just the one subscription — route/board changes are read through
    // refs, not re-subscribed.
    expect(subscribeToQueueEvents).toHaveBeenCalledTimes(1);
  });

  // FIX 1 guard: the analytics reads `queueRef.current.length` LIVE at emit
  // time, so as long as the provider keeps the ref current (it assigns it
  // during render, not in a post-paint useEffect), a same-frame queue mutation
  // is reflected. If the hook ever captured the length at subscribe time, this
  // fails. A stale ref (assigned in a useEffect) would report the pre-event
  // length here.
  it('reads the queue length live from the ref at emit time', () => {
    const { subscribeToQueueEvents, emit } = createSubscribeToQueueEvents();
    const queueRef = { current: new Array(2) as unknown[] };
    renderHook(() =>
      usePeerBroadcastAnalytics({
        subscribeToQueueEvents,
        isOnBoardRoute: true,
        boardLayoutName: 'Original',
        queueRef,
        clientId: null,
      }),
    );

    emit(addedEvent);
    expect(mockTrack).toHaveBeenLastCalledWith(
      'Climb Added to Queue',
      expect.objectContaining({ currentQueueLength: 3 }),
    );

    // Provider advances the ref (render-body assignment) before the next event.
    queueRef.current = new Array(5);
    emit(addedEvent);
    expect(mockTrack).toHaveBeenLastCalledWith(
      'Climb Added to Queue',
      expect.objectContaining({ currentQueueLength: 6 }),
    );
  });

  it('picks up a mid-flight isOnBoardRoute flip via the ref without re-subscribing', () => {
    const { subscribeToQueueEvents, emit } = createSubscribeToQueueEvents();
    const { rerender } = renderHook(
      (props: { isOnBoardRoute: boolean }) =>
        usePeerBroadcastAnalytics({
          subscribeToQueueEvents,
          isOnBoardRoute: props.isOnBoardRoute,
          boardLayoutName: 'Original',
          queueRef: { current: new Array(0) },
          clientId: null,
        }),
      { initialProps: { isOnBoardRoute: false } },
    );

    emit(addedEvent);
    expect(mockTrack).not.toHaveBeenCalled();

    rerender({ isOnBoardRoute: true });
    emit(addedEvent);
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });
  // Issue #3382 — the server echoes our own remove back to us. The local
  // remove already tracked `removedBy: 'self'` in graphql-queue/QueueContext.tsx
  // (:693), so tracking the echo double counted every party-session
  // self-remove. QueueItemRemoved now carries the removing connection id.
  it('skips a QueueItemRemoved echoed back from this client', () => {
    const { subscribeToQueueEvents, emit } = createSubscribeToQueueEvents();
    renderHook(() =>
      usePeerBroadcastAnalytics({
        subscribeToQueueEvents,
        isOnBoardRoute: true,
        boardLayoutName: 'Original',
        queueRef: { current: new Array(2) },
        clientId: 'conn-self',
      }),
    );

    emit({ ...removedEvent, clientId: 'conn-self' });

    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("still fires 'peer' for a QueueItemRemoved from another client", () => {
    const { subscribeToQueueEvents, emit } = createSubscribeToQueueEvents();
    renderHook(() =>
      usePeerBroadcastAnalytics({
        subscribeToQueueEvents,
        isOnBoardRoute: true,
        boardLayoutName: 'Original',
        queueRef: { current: new Array(2) },
        clientId: 'conn-self',
      }),
    );

    emit({ ...removedEvent, clientId: 'conn-peer' });

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('Climb Removed from Queue', {
      boardLayout: 'Original',
      partyMode: true,
      removedBy: 'peer',
    });
  });

  // A pre-#3382 server sends no clientId; a solo/unjoined client has none of
  // its own. Both fall back to the historical 'peer' attribution rather than
  // silently dropping the event.
  it("falls back to 'peer' when either side has no clientId", () => {
    const { subscribeToQueueEvents, emit } = createSubscribeToQueueEvents();
    const { rerender } = renderHook(
      (props: { clientId: string | null }) =>
        usePeerBroadcastAnalytics({
          subscribeToQueueEvents,
          isOnBoardRoute: true,
          boardLayoutName: 'Original',
          queueRef: { current: new Array(2) },
          clientId: props.clientId,
        }),
      { initialProps: { clientId: 'conn-self' } as { clientId: string | null } },
    );

    // Legacy server: event carries no clientId.
    emit({ ...removedEvent, clientId: null });
    expect(mockTrack).toHaveBeenCalledTimes(1);

    // Unjoined client: we have no clientId of our own.
    rerender({ clientId: null });
    emit({ ...removedEvent, clientId: 'conn-peer' });
    expect(mockTrack).toHaveBeenCalledTimes(2);
    expect(mockTrack).toHaveBeenLastCalledWith(
      'Climb Removed from Queue',
      expect.objectContaining({ removedBy: 'peer' }),
    );
  });
});
