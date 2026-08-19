// Behavioural pins for the kiosk presence spine (#4408).
//
// The two things worth a test here are both invisible in a screenshot: the
// display hub must reach its WebSocket WITHOUT going through
// `/api/internal/ws-auth`, and the whole TV must open exactly ONE socket no
// matter how many boards it renders.
//
// Deliberately NOT wrapped in React.StrictMode: StrictMode double-invokes
// effects, which would make every call-count oracle below meaningless.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';

type SocketEvent = 'connected' | 'closed';

type FakeClient = {
  on: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  /** Fire what graphql-ws would have fired, so the supervisor can be driven. */
  emit: (event: SocketEvent) => void;
};

const createdClients: FakeClient[] = [];
const createGraphQLClientSpy = vi.fn(() => {
  const handlers: Record<SocketEvent, Array<() => void>> = { connected: [], closed: [] };
  const client: FakeClient = {
    on: vi.fn((event: SocketEvent, handler: () => void) => {
      handlers[event].push(handler);
      return () => {
        handlers[event] = handlers[event].filter((registered) => registered !== handler);
      };
    }),
    dispose: vi.fn(async () => {}),
    emit: (event: SocketEvent) => {
      // Hold the array reference: unsubscribing REPLACES handlers[event], so
      // an off() during dispatch can't mutate what we're iterating.
      const registered = handlers[event];
      for (const handler of registered) handler();
    },
  };
  createdClients.push(client);
  return client;
});

vi.mock('@/app/lib/realtime/graphql-client', () => ({
  createGraphQLClient: (...args: unknown[]) => createGraphQLClientSpy(...(args as [])),
  // The presence client's transport primitives. Present so the FULL client's
  // write path reaches the injected `getClient` (and fails there) instead of
  // dying on a missing export — otherwise the "viewer keeps writes" assertion
  // below would pass for the wrong reason.
  execute: vi.fn(async () => ({})),
  subscribe: vi.fn(() => () => {}),
}));

vi.mock('@/app/lib/backend-url', () => ({
  getBackendWsUrl: () => 'ws://backend.test/graphql',
}));

// Passthrough provider: the real one starts subscriptions and network I/O.
vi.mock('@boardsesh/board-presence-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-presence-react')>();
  return {
    ...actual,
    BoardPresenceProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

vi.mock('@/app/components/kiosk/kiosk-reliability', () => ({
  KioskBoardFeedBridge: () => null,
}));

const useWsAuthTokenSpy = vi.fn<() => { token: string | null; isLoading: boolean }>(() => ({
  token: null,
  isLoading: false,
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => useWsAuthTokenSpy(),
}));

import KioskPresenceHub, { PRESENCE_REBUILD_AFTER_MS } from '../kiosk-presence-hub';
import { ViewerKioskPresenceHub } from '../viewer-kiosk-presence-hub';

function optionsOfCall(callIndex: number): { authToken?: string | null; connectionName?: string } {
  const [options] = createGraphQLClientSpy.mock.calls[callIndex] as unknown as [
    { authToken?: string | null; connectionName?: string },
  ];
  return options;
}

describe('KioskPresenceHub (display routes)', () => {
  beforeEach(() => {
    createdClients.length = 0;
    createGraphQLClientSpy.mockClear();
    useWsAuthTokenSpy.mockClear();
    useWsAuthTokenSpy.mockReturnValue({ token: null, isLoading: false });
  });

  it('connects anonymously without consulting the ws-auth bridge', () => {
    render(
      <KioskPresenceHub boardIds={[7]}>
        <div>kiosk</div>
      </KioskPresenceHub>,
    );

    expect(useWsAuthTokenSpy).toHaveBeenCalledTimes(0);
    expect(createGraphQLClientSpy).toHaveBeenCalledTimes(1);
    expect(optionsOfCall(0).authToken ?? null).toBeNull();
    expect(optionsOfCall(0).connectionName).toBe('kiosk');
  });

  // Positive control for the assertion above: without this, "the ws-auth hook
  // was never called" would stay green even if the mock were wired to nothing.
  it('the viewer hub DOES consult the ws-auth bridge and forwards its token', () => {
    useWsAuthTokenSpy.mockReturnValue({ token: 'jwt-1', isLoading: false });

    render(
      <ViewerKioskPresenceHub boardIds={[7]}>
        <div>preview</div>
      </ViewerKioskPresenceHub>,
    );

    expect(useWsAuthTokenSpy.mock.calls.length).toBeGreaterThan(0);
    expect(createGraphQLClientSpy).toHaveBeenCalledTimes(1);
    expect(optionsOfCall(0).authToken).toBe('jwt-1');
  });

  it('opens exactly one WebSocket for the whole TV, across rerenders', () => {
    const { rerender } = render(
      <KioskPresenceHub boardIds={[1, 2, 3]}>
        <div>first</div>
      </KioskPresenceHub>,
    );

    // Fresh array literal + changed child: nothing here should rebuild the socket.
    rerender(
      <KioskPresenceHub boardIds={[1, 2, 3]}>
        <div>second</div>
      </KioskPresenceHub>,
    );

    expect(createGraphQLClientSpy).toHaveBeenCalledTimes(1);
    expect(createdClients).toHaveLength(1);
    expect(createdClients[0].dispose).not.toHaveBeenCalled();
  });

  it('holds the socket until the viewer auth lookup settles', () => {
    useWsAuthTokenSpy.mockReturnValue({ token: null, isLoading: true });

    const { rerender } = render(
      <ViewerKioskPresenceHub boardIds={[7]}>
        <div>preview</div>
      </ViewerKioskPresenceHub>,
    );

    expect(createGraphQLClientSpy).toHaveBeenCalledTimes(0);

    useWsAuthTokenSpy.mockReturnValue({ token: 'jwt-1', isLoading: false });
    act(() => {
      rerender(
        <ViewerKioskPresenceHub boardIds={[7]}>
          <div>preview</div>
        </ViewerKioskPresenceHub>,
      );
    });

    expect(createGraphQLClientSpy).toHaveBeenCalledTimes(1);
    expect(optionsOfCall(0).authToken).toBe('jwt-1');
  });
});

describe('read-only kiosk presence client', () => {
  it('rejects writes on the display hub but keeps them on the viewer hub', async () => {
    const { createReadOnlyWebBoardPresenceClient, createWebBoardPresenceClient, KioskReadOnlyPresenceError } =
      await import('@/app/lib/realtime/board-presence-client');

    const getClient = () => {
      throw new Error('transport should not be reached');
    };

    const readOnly = createReadOnlyWebBoardPresenceClient(getClient as never);
    await expect(readOnly.reportClimb(1, { uuid: 'c1' } as never, 40)).rejects.toBeInstanceOf(
      KioskReadOnlyPresenceError,
    );
    await expect(readOnly.reportDisconnect(1)).rejects.toBeInstanceOf(KioskReadOnlyPresenceError);
    // Reads are untouched — the kiosk lives on them.
    expect(typeof readOnly.subscribeNowPlaying).toBe('function');
    expect(typeof readOnly.fetchRecentClimbs).toBe('function');

    // The viewer client keeps the write path: it hits the transport, not a guard.
    const full = createWebBoardPresenceClient(getClient as never);
    await expect(full.reportClimb(1, { uuid: 'c1' } as never, 40)).rejects.toThrow('transport should not be reached');
  });
});

// The kiosk is unattended by definition: graphql-ws spends a finite retry
// budget (~90-180s) and never resets it, and `useBoardPresence` never
// re-subscribes — so without a supervisor a backend outage longer than that
// budget leaves a dark wall until the 04:00 reload. These two cases pull in
// opposite directions on purpose: no stub can satisfy both.
describe('KioskPresenceHub reconnect supervisor', () => {
  beforeEach(() => {
    createdClients.length = 0;
    createGraphQLClientSpy.mockClear();
    useWsAuthTokenSpy.mockReturnValue({ token: null, isLoading: false });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds the client when the socket stays down past the window', () => {
    render(
      <KioskPresenceHub boardIds={[7]}>
        <div>kiosk</div>
      </KioskPresenceHub>,
    );
    expect(createGraphQLClientSpy).toHaveBeenCalledTimes(1);

    act(() => {
      createdClients[0].emit('closed');
    });
    act(() => {
      vi.advanceTimersByTime(PRESENCE_REBUILD_AFTER_MS + 1_000);
    });

    expect(createdClients[0].dispose).toHaveBeenCalledTimes(1);
    expect(createGraphQLClientSpy).toHaveBeenCalledTimes(2);
  });

  it('leaves an ordinary blip alone once the socket comes back', () => {
    render(
      <KioskPresenceHub boardIds={[7]}>
        <div>kiosk</div>
      </KioskPresenceHub>,
    );

    act(() => {
      createdClients[0].emit('closed');
    });
    act(() => {
      vi.advanceTimersByTime(PRESENCE_REBUILD_AFTER_MS / 2);
    });
    act(() => {
      createdClients[0].emit('connected');
    });
    act(() => {
      vi.advanceTimersByTime(PRESENCE_REBUILD_AFTER_MS * 2);
    });

    expect(createGraphQLClientSpy).toHaveBeenCalledTimes(1);
    expect(createdClients[0].dispose).not.toHaveBeenCalled();
  });
});
