// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { BoardAdapter } from '@boardsesh/board-react';

const wsMocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  on: vi.fn(() => vi.fn()),
  subscribe: vi.fn((_request: unknown, _handlers: { complete: () => void }) => vi.fn()),
}));
wsMocks.getClient.mockReturnValue({ on: wsMocks.on, subscribe: wsMocks.subscribe });

// Controllable connectivity store (#4862). `effectiveOffline` is read
// synchronously by the stats-subscription gate; `emit` changes the snapshot AND
// notifies subscribers, like a real snapshot change.
const connectivity = vi.hoisted(() => {
  let effectiveOffline = false;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({
      effectiveOffline,
      reason: effectiveOffline ? 'backend_unreachable' : null,
      backend: effectiveOffline ? 'unreachable' : 'reachable',
      device: 'online',
    }),
    /** Change the snapshot without notifying — models an outage starting while
     *  a retry timer is already armed. */
    setOffline: (next: boolean) => {
      effectiveOffline = next;
    },
    emit: (next: boolean) => {
      effectiveOffline = next;
      for (const listener of listeners) listener();
    },
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    listenerCount: () => listeners.size,
    reset: () => {
      effectiveOffline = false;
      listeners.clear();
    },
  };
});

// BoardAdapterWrapper is the mobile flag boundary for the tick dual-write:
// `saveTickOffline` must only exist on the adapter when the offline engine is
// on — the shared useSaveTick optional-chains it, so `undefined` IS the
// pre-offline direct network save.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Capture the adapter at the provider boundary instead of consuming the real
// context: the workspace's @boardsesh/board-react resolves its own React copy
// under vitest, so its useContext can't read a context created by this test's
// renderer. The wrapper's contract is the `value` it provides — asserting on
// the captured value covers exactly that.
let capturedAdapter: BoardAdapter | undefined;
vi.mock('@boardsesh/board-react', () => ({
  BoardAdapterProvider: ({ value, children }: { value: BoardAdapter; children: ReactNode }) => {
    capturedAdapter = value;
    return children;
  },
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'uuid-fixed',
}));

vi.mock('@boardsesh/graphql-client', () => ({
  execute: vi.fn(),
}));

vi.mock('../auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock('../queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: 'session-1' }),
}));

vi.mock('../toast-provider', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

let offlineEnabled = false;
vi.mock('../feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => offlineEnabled,
}));

vi.mock('../../db', () => ({
  getDatabaseHandle: () => ({ tag: 'db' }),
}));

vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: vi.fn() }),
}));

vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 7,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === 7,
}));

vi.mock('../../lib/graphql/ws-client', () => ({
  getWsClient: wsMocks.getClient,
}));

vi.mock('../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: connectivity.getSnapshot,
  subscribeConnectivity: connectivity.subscribe,
}));

const reportHandledErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({
  reportHandledError: reportHandledErrorMock,
}));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({ track: trackMock }));

const isOnlineMock = vi.hoisted(() => vi.fn(() => true));
const drainMutationQueueMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../offline/offline-sync-adapter', () => ({
  drainMutationQueue: drainMutationQueueMock,
  subscribeMutationDelivery: vi.fn(() => () => {}),
  isOnline: isOnlineMock,
}));

const writeTickLocalMock = vi.hoisted(() => vi.fn(async () => {}));
const enqueueTickOutboxOnlyMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../hooks/use-offline-mutations', () => ({
  writeTickLocal: writeTickLocalMock,
  enqueueTickOutboxOnly: enqueueTickOutboxOnlyMock,
}));

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { BoardAdapterWrapper } from '../board-adapter';

beforeEach(() => {
  vi.clearAllMocks();
  // vi.clearAllMocks() only clears the spy; the listener set and the offline
  // flag live outside it.
  connectivity.reset();
  offlineEnabled = false;
  capturedAdapter = undefined;
  isOnlineMock.mockReturnValue(true);
  writeTickLocalMock.mockResolvedValue(undefined);
  enqueueTickOutboxOnlyMock.mockResolvedValue(undefined);
});

describe('BoardAdapterWrapper offline gating', () => {
  it('provides saveTickOffline when the offline flag is on', () => {
    offlineEnabled = true;
    render(<BoardAdapterWrapper>{null}</BoardAdapterWrapper>);
    expect(typeof capturedAdapter?.saveTickOffline).toBe('function');
  });

  it('omits saveTickOffline when the offline flag is off, so useSaveTick falls through to the network', () => {
    offlineEnabled = false;
    render(<BoardAdapterWrapper>{null}</BoardAdapterWrapper>);
    expect(capturedAdapter).toBeDefined();
    expect(capturedAdapter?.saveTickOffline).toBeUndefined();
    // The rest of the adapter contract is unaffected by the gate.
    expect(capturedAdapter?.isAuthenticated).toBe(true);
    expect(typeof capturedAdapter?.executeHttp).toBe('function');
    expect(capturedAdapter?.supportsClimbStatsOptimism).toBe(true);
  });

  it('multiplexes live stats over the existing singleton WS client', () => {
    render(<BoardAdapterWrapper>{null}</BoardAdapterWrapper>);
    const handlers = { next: vi.fn(), connected: vi.fn(), error: vi.fn() };
    const unsubscribe = capturedAdapter?.subscribeClimbStats?.('kilter', 1, handlers);

    expect(wsMocks.getClient).toHaveBeenCalledTimes(1);
    expect(wsMocks.on).toHaveBeenCalledWith('connected', handlers.connected);
    expect(wsMocks.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { boardType: 'kilter', layoutId: 1 } }),
      expect.objectContaining({ error: expect.any(Function) }),
    );
    expect(typeof unsubscribe).toBe('function');
  });

  it('cancels a scheduled stats retry when disposed before the timer fires', () => {
    vi.useFakeTimers();
    try {
      render(<BoardAdapterWrapper>{null}</BoardAdapterWrapper>);
      const handlers = { next: vi.fn(), connected: vi.fn(), error: vi.fn() };
      const unsubscribe = capturedAdapter?.subscribeClimbStats?.('kilter', 1, handlers);
      const subscriptionHandlers = wsMocks.subscribe.mock.calls.at(-1)?.[1] as { complete: () => void } | undefined;

      expect(subscriptionHandlers).toBeDefined();
      subscriptionHandlers?.complete();
      unsubscribe?.();
      vi.advanceTimersByTime(1_000);

      expect(wsMocks.subscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Issue #4862. Live climb stats need a reachable backend: during an outage
  // the subscribe can only fail and the exponential ladder just wakes the
  // socket for nothing, so the subscription parks on the connectivity store
  // instead and resumes on the edge back to reachable.
  it('defers the initial stats subscribe during an outage and resumes on the edge', () => {
    connectivity.setOffline(true);
    render(<BoardAdapterWrapper>{null}</BoardAdapterWrapper>);
    const handlers = { next: vi.fn(), connected: vi.fn(), error: vi.fn() };

    const unsubscribe = capturedAdapter?.subscribeClimbStats?.('kilter', 1, handlers);

    expect(wsMocks.subscribe).not.toHaveBeenCalled();
    expect(connectivity.listenerCount()).toBe(1);

    connectivity.emit(false);
    expect(wsMocks.subscribe).toHaveBeenCalledTimes(1);

    // Cleanup drops the store listener, so a later flip cannot resurrect a
    // subscription for a disposed consumer.
    unsubscribe?.();
    expect(connectivity.listenerCount()).toBe(0);
    connectivity.emit(true);
    connectivity.emit(false);
    expect(wsMocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it('arms no stats retry timer while offline, and resubscribes exactly once when the backend returns', () => {
    vi.useFakeTimers();
    try {
      render(<BoardAdapterWrapper>{null}</BoardAdapterWrapper>);
      const handlers = { next: vi.fn(), connected: vi.fn(), error: vi.fn() };
      const unsubscribe = capturedAdapter?.subscribeClimbStats?.('kilter', 1, handlers);
      const subscriptionHandlers = wsMocks.subscribe.mock.calls.at(-1)?.[1] as { complete: () => void } | undefined;
      expect(wsMocks.subscribe).toHaveBeenCalledTimes(1);

      // The backend goes down, then the stream completes: no timer is armed, so
      // 60s pass without a single retry.
      connectivity.setOffline(true);
      subscriptionHandlers?.complete();
      vi.advanceTimersByTime(60_000);
      expect(wsMocks.subscribe).toHaveBeenCalledTimes(1);

      // One resubscribe on the edge back to reachable...
      connectivity.emit(false);
      expect(wsMocks.subscribe).toHaveBeenCalledTimes(2);
      // ...and no more from the store's other snapshot changes.
      connectivity.emit(false);
      expect(wsMocks.subscribe).toHaveBeenCalledTimes(2);

      unsubscribe?.();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Issue #4315. A local write that throws used to drop the send outright:
// saveTickOffline returned null, useSaveTick fell through to a direct network
// save, and offline that save failed. Now the catch tries the outbox row alone,
// so the send still reaches the server on the next drain — and every exit emits
// exactly one event saying which of the two happened.
describe('BoardAdapterWrapper tick degrade + telemetry', () => {
  function makeVariables() {
    return { input: { climbUuid: 'climb-1', angle: 40 } } as unknown as Parameters<
      NonNullable<BoardAdapter['saveTickOffline']>
    >[0];
  }

  async function saveTick(variables = makeVariables(), queryClient = { invalidateQueries: vi.fn() }) {
    offlineEnabled = true;
    render(<BoardAdapterWrapper>{null}</BoardAdapterWrapper>);
    const savedTick = await capturedAdapter?.saveTickOffline?.(variables, {
      queryClient,
      executeHttp: vi.fn(),
    } as never);
    return { savedTick, queryClient };
  }

  // The contract that stops one send being delivered twice: the local write, the
  // queued replay and useSaveTick's network fall-through all carry this uuid, and
  // the server's saveTick returns the existing row for a repeat.
  it('stamps input.uuid with the generated tick uuid before the write, on the success path', async () => {
    const variables = makeVariables();

    const { savedTick } = await saveTick(variables);

    expect(variables.input.uuid).toBe('uuid-fixed');
    expect(savedTick?.uuid).toBe('uuid-fixed');
    // Stamped BEFORE the write, not after it.
    expect(writeTickLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uuid: 'uuid-fixed' }),
      'uuid-fixed',
      expect.any(Number),
    );
  });

  it('stamps input.uuid on the failure path too, so the fall-through cannot double-deliver', async () => {
    writeTickLocalMock.mockRejectedValue(new Error('disk I/O error'));
    enqueueTickOutboxOnlyMock.mockRejectedValue(new Error('disk I/O error'));
    const variables = makeVariables();

    await saveTick(variables);

    expect(variables.input.uuid).toBe('uuid-fixed');
  });

  it('degrades to an outbox-only row and reports the tick as queued', async () => {
    writeTickLocalMock.mockRejectedValue(new Error('database is locked'));
    isOnlineMock.mockReturnValue(false);

    const { savedTick, queryClient } = await saveTick();

    expect(enqueueTickOutboxOnlyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uuid: 'uuid-fixed' }),
      'uuid-fixed',
      expect.any(Number),
    );
    // Same saved-tick shape as a clean offline save: useSaveTick treats it as
    // `delivery: 'queued'` and the delivery subscription keys on the same uuid.
    expect(savedTick).toMatchObject({ uuid: 'uuid-fixed', climbUuid: 'climb-1', angle: 40 });
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineTickLocalWriteFailed, {
      isLockError: true,
      wasOffline: true,
      error: expect.any(String),
      outcome: 'queued',
    });
    // No local tick row exists, so the badge query's JOIN returns 0 either way —
    // invalidating it would be a no-op that reads as intent.
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    // The queued row should not wait for the next app-driven drain trigger.
    expect(drainMutationQueueMock).toHaveBeenCalledTimes(1);
  });

  it('falls through to the network when the degrade also fails', async () => {
    writeTickLocalMock.mockRejectedValue(new Error('database is locked'));
    enqueueTickOutboxOnlyMock.mockRejectedValue(new Error('still locked'));
    isOnlineMock.mockReturnValue(false);

    const { savedTick } = await saveTick();

    expect(savedTick).toBeNull();
    // Nothing was queued, so there is nothing to drain.
    expect(drainMutationQueueMock).not.toHaveBeenCalled();
  });

  it('reports fell_through when the degrade also fails', async () => {
    writeTickLocalMock.mockRejectedValue(new Error('database is locked'));
    enqueueTickOutboxOnlyMock.mockRejectedValue(new Error('still locked'));
    isOnlineMock.mockReturnValue(false);

    const { savedTick } = await saveTick();

    expect(savedTick).toBeNull();
    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineTickLocalWriteFailed,
      expect.objectContaining({ outcome: 'fell_through' }),
    );
  });

  // The terminal-event invariant: one failed local write, one event, whichever
  // exit it takes. Anything else makes the loss rate unreadable.
  it.each([
    ['the degrade succeeds', undefined],
    ['the degrade fails', new Error('still locked')],
  ])('emits exactly one Offline Tick Local Write Failed when %s', async (_label, fallbackError) => {
    writeTickLocalMock.mockRejectedValue(new Error('database is locked'));
    if (fallbackError) enqueueTickOutboxOnlyMock.mockRejectedValue(fallbackError);

    await saveTick();

    const tickFailureEvents = trackMock.mock.calls.filter(
      ([eventName]) => eventName === SHARED_EVENTS.OfflineTickLocalWriteFailed,
    );
    expect(tickFailureEvents).toHaveLength(1);
  });

  it.each([
    ['a lock error while offline', new Error('database is locked'), false, true, true],
    ['a lock error while online', new Error('database is locked'), true, false, true],
    ['a non-lock error while offline', new Error('disk I/O error'), false, true, false],
    ['a non-lock error while online', new Error('disk I/O error'), true, false, false],
  ])('tags %s', async (_label, error, online, expectedWasOffline, expectedIsLockError) => {
    isOnlineMock.mockReturnValue(online);
    writeTickLocalMock.mockRejectedValue(error);

    await saveTick();

    expect(reportHandledErrorMock).toHaveBeenCalledWith(
      // The ORIGINAL error object by identity — the ladder rethrows without
      // wrapping, so the existing 90-day Sentry aggregate does not fork.
      error,
      expect.objectContaining({
        tags: {
          source: 'offline-sync',
          // Unchanged so the existing 90-day Sentry trend stays comparable.
          kind: 'tick-local-write',
          was_offline: expectedWasOffline,
          is_lock_error: expectedIsLockError,
          outcome: 'queued',
        },
      }),
    );
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineTickLocalWriteFailed, {
      isLockError: expectedIsLockError,
      wasOffline: expectedWasOffline,
      error: expect.any(String),
      outcome: 'queued',
    });
  });

  it('emits nothing when the local write succeeds', async () => {
    await saveTick();

    expect(reportHandledErrorMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
    expect(enqueueTickOutboxOnlyMock).not.toHaveBeenCalled();
  });
});
