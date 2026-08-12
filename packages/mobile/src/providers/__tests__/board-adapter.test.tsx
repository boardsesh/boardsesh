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

const reportHandledErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({
  reportHandledError: reportHandledErrorMock,
}));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({ track: trackMock }));

const isOnlineMock = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../offline/offline-sync-adapter', () => ({
  drainMutationQueue: vi.fn(async () => {}),
  subscribeMutationDelivery: vi.fn(() => () => {}),
  isOnline: isOnlineMock,
}));

const writeTickLocalMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../hooks/use-offline-mutations', () => ({
  writeTickLocal: writeTickLocalMock,
}));

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { BoardAdapterWrapper } from '../board-adapter';

beforeEach(() => {
  vi.clearAllMocks();
  offlineEnabled = false;
  capturedAdapter = undefined;
  isOnlineMock.mockReturnValue(true);
  writeTickLocalMock.mockResolvedValue(undefined);
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
});

// Issue #4315. When the local write throws, saveTickOffline returns null and
// useSaveTick falls through to a direct network save. Online that still lands;
// OFFLINE the network save fails and the tick is gone. Nothing in the old
// report distinguished those two, so the Sentry count could not tell us how
// many ticks were actually lost.
describe('BoardAdapterWrapper tick-local-write telemetry', () => {
  async function saveTickWithLocalWriteError(error: unknown) {
    offlineEnabled = true;
    writeTickLocalMock.mockRejectedValue(error);
    render(<BoardAdapterWrapper>{null}</BoardAdapterWrapper>);
    const queryClient = { invalidateQueries: vi.fn() };
    return capturedAdapter?.saveTickOffline?.(
      { input: { climbUuid: 'climb-1', angle: 40 } } as never,
      { queryClient, executeHttp: vi.fn() } as never,
    );
  }

  it('keeps returning null so the network fall-through is unchanged', async () => {
    await expect(saveTickWithLocalWriteError(new Error('disk I/O error'))).resolves.toBeNull();
  });

  it.each([
    ['a lock error while offline', new Error('database is locked'), false, true, true],
    ['a lock error while online', new Error('database is locked'), true, false, true],
    ['a non-lock error while offline', new Error('disk I/O error'), false, true, false],
    ['a non-lock error while online', new Error('disk I/O error'), true, false, false],
  ])('tags %s', async (_label, error, online, expectedWasOffline, expectedIsLockError) => {
    isOnlineMock.mockReturnValue(online);

    await saveTickWithLocalWriteError(error);

    expect(reportHandledErrorMock).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: {
          source: 'offline-sync',
          // Unchanged so the existing 90-day Sentry trend stays comparable.
          kind: 'tick-local-write',
          was_offline: expectedWasOffline,
          is_lock_error: expectedIsLockError,
        },
      }),
    );
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineTickLocalWriteFailed, {
      isLockError: expectedIsLockError,
      wasOffline: expectedWasOffline,
      error: expect.any(String),
    });
  });

  it('emits nothing when the local write succeeds', async () => {
    offlineEnabled = true;
    render(<BoardAdapterWrapper>{null}</BoardAdapterWrapper>);

    await capturedAdapter?.saveTickOffline?.(
      { input: { climbUuid: 'climb-1', angle: 40 } } as never,
      { queryClient: { invalidateQueries: vi.fn() }, executeHttp: vi.fn() } as never,
    );

    expect(reportHandledErrorMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });
});
