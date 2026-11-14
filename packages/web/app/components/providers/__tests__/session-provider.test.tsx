import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Session } from 'next-auth';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionProviderWrapper from '../session-provider';
import {
  beginWebSessionIntent,
  requestWebSessionRefresh,
  signInWithSessionIntent,
} from '@/app/lib/auth/web-session-events';

const LOCK_INSTALLATION_KEY = Symbol.for('boardsesh.nextauth-cookie-fetch-lock.state-v1');
const coordinator = vi.hoisted(() => ({ ready: false, read: vi.fn<() => Promise<void>>() }));
vi.mock('@/app/lib/auth/browser-coordinator-readiness', () => ({
  publicBrowserCoordinatorReady: () => coordinator.ready,
}));
vi.mock('@/app/lib/auth/browser-coordinator-client', () => ({ readCanonicalBrowserCoordinator: coordinator.read }));

function clearLockInstallation(): void {
  delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[LOCK_INSTALLATION_KEY];
}

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly close = vi.fn();
  readonly name: string;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  addEventListener(_eventName: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_eventName: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) listener(new MessageEvent('message', { data: message }));
  }
}

function createNamedFifoLockRequest() {
  const queues = new Map<string, Promise<void>>();
  const request = <Result,>(
    name: string,
    _options: LockOptions,
    operation: (lock: Lock | null) => PromiseLike<Result> | Result,
  ): Promise<Result> => {
    const priorOperation = queues.get(name) ?? Promise.resolve();
    const runOperation = () => operation({ name, mode: 'exclusive' } as Lock);
    const result = priorOperation.then(runOperation, runOperation);
    queues.set(
      name,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };
  return vi.fn(request);
}

function session(userId: string, authSessionId: string): Session {
  return {
    user: { id: userId },
    authSessionId,
    expires: '2099-01-01T00:00:00.000Z',
  };
}

function SessionState() {
  const { data, status } = useSession();
  return <output>{`${status}:${data?.user.id ?? 'none'}:${data?.authSessionId ?? 'none'}`}</output>;
}

let serverSession: Session | null;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  coordinator.ready = false;
  coordinator.read.mockReset().mockResolvedValue(undefined);
  window.history.replaceState({}, '', '/');
  clearLockInstallation();
  MockBroadcastChannel.instances = [];
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  serverSession = null;
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(serverSession ?? {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  window.localStorage.clear();
});

describe('canonical coordinator session preflight', () => {
  it('waits for coordination before the independent primary session request', async () => {
    coordinator.ready = true;
    let release!: () => void;
    coordinator.read.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    serverSession = session('owner-A', 'original-SID');
    render(
      <SessionProviderWrapper canonicalBrowserOrigin="https://www.boardsesh.test">
        <SessionState />
      </SessionProviderWrapper>,
    );
    await waitFor(() => expect(coordinator.read).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('loading:none:none')).toBeDefined();
    await act(async () => release());
    await screen.findByText('authenticated:owner-A:original-SID');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', expect.objectContaining({ cache: 'no-store' }));
  });
  it('keeps initial identity unknown when coordination is unavailable', async () => {
    coordinator.ready = true;
    coordinator.read.mockRejectedValue(new Error('COORDINATOR_UNAVAILABLE'));
    render(
      <SessionProviderWrapper canonicalBrowserOrigin="https://www.boardsesh.test">
        <SessionState />
      </SessionProviderWrapper>,
    );
    await waitFor(() => expect(coordinator.read).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('loading:none:none')).toBeDefined();
  });
  it('does not recursively coordinate or fetch a session in the utility frame', async () => {
    coordinator.ready = true;
    window.history.replaceState({}, '', '/auth/browser-coordinator');
    render(
      <SessionProviderWrapper canonicalBrowserOrigin="https://www.boardsesh.test">
        <SessionState />
      </SessionProviderWrapper>,
    );
    await act(async () => {});
    expect(coordinator.read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  clearLockInstallation();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function advanceSessionClock(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function renderInitialSession() {
  return render(
    <SessionProviderWrapper>
      <SessionState />
    </SessionProviderWrapper>,
  );
}

describe('initial session read recovery', () => {
  it.each([
    ['authenticated', session('user-b', 'login-b'), 'authenticated:user-b:login-b'],
    ['anonymous', null, 'unauthenticated:none:none'],
  ] as const)(
    'automatically recovers to %s without online or focus events, then stops polling',
    async (_label, recoveredSession, expectedState) => {
      vi.useFakeTimers();
      serverSession = recoveredSession;
      fetchMock.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
      renderInitialSession();
      await advanceSessionClock(0);
      expect(screen.getByText('loading:none:none')).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await advanceSessionClock(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advanceSessionClock(1);
      expect(screen.getByText(expectedState)).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchMock.mock.calls.every(([, options]) => options?.method === undefined)).toBe(true);

      await advanceSessionClock(120_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('backs off from one second to a thirty-second cap during a long outage and recovers', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => Response.json({ error: 'unavailable' }, { status: 503 }));
    renderInitialSession();
    await advanceSessionClock(0);
    let expectedReads = 1;
    for (const interval of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      expect(vi.getTimerCount()).toBe(1);
      await advanceSessionClock(interval - 1);
      expect(fetchMock).toHaveBeenCalledTimes(expectedReads);
      await advanceSessionClock(1);
      expect(fetchMock).toHaveBeenCalledTimes(++expectedReads);
      expect(screen.getByText('loading:none:none')).toBeTruthy();
    }
    fetchMock.mockImplementation(async () => Response.json(session('user-b', 'login-b')));
    await advanceSessionClock(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(expectedReads);
    await advanceSessionClock(1);
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(expectedReads + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers when a timed-out body ignores abort and discards its late anonymous result', async () => {
    vi.useFakeTimers();
    let releaseBody!: (body: unknown) => void;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        new Promise<unknown>((resolve) => {
          releaseBody = resolve;
        }),
    } as Response);
    serverSession = session('user-b', 'login-b');
    renderInitialSession();
    await advanceSessionClock(0);
    expect(releaseBody).toBeTypeOf('function');
    await advanceSessionClock(15_000);
    expect(screen.getByText('loading:none:none')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    await advanceSessionClock(1000);
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
    await act(async () => {
      releaseBody({});
    });
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    'cancels an actual hanging response stream before retrying (pending cancellation: %s)',
    async (cancelRemainsPending) => {
      vi.useFakeTimers();
      const cancelBody = vi.fn(() => (cancelRemainsPending ? new Promise<void>(() => {}) : undefined));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"user":'));
        },
        cancel: cancelBody,
      });
      fetchMock.mockResolvedValueOnce(new Response(body));
      serverSession = session('user-b', 'login-b');
      renderInitialSession();
      await advanceSessionClock(0);
      expect(body.locked).toBe(true);
      await advanceSessionClock(15_000);
      expect(cancelBody).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(screen.getByText('loading:none:none')).toBeTruthy();
      expect(vi.getTimerCount()).toBe(1);
      await advanceSessionClock(1000);
      expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
      expect(vi.getTimerCount()).toBe(0);
      await advanceSessionClock(120_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cancelBody).toHaveBeenCalledOnce();
    },
  );

  it('treats an owned body arriving after abort as unavailable rather than successful anonymous', async () => {
    vi.useFakeTimers();
    let releaseBody!: (body: unknown) => void;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        new Promise<unknown>((resolve) => {
          releaseBody = resolve;
        }),
    } as Response);
    serverSession = session('user-b', 'login-b');
    renderInitialSession();
    await advanceSessionClock(0);
    await advanceSessionClock(15_000);
    await act(async () => {
      releaseBody({});
    });
    expect(screen.getByText('loading:none:none')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    await advanceSessionClock(1000);
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['new update', 'unmount'])('cancels the active response body immediately on %s', async (action) => {
    vi.useFakeTimers();
    const cancelBody = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"user":'));
      },
      cancel: cancelBody,
    });
    fetchMock.mockResolvedValueOnce(new Response(body));
    const { unmount } = renderInitialSession();
    await advanceSessionClock(0);
    expect(body.locked).toBe(true);
    if (action === 'unmount') {
      unmount();
    } else {
      serverSession = session('user-b', 'login-b');
      act(() => requestWebSessionRefresh());
    }
    await advanceSessionClock(0);
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    if (action === 'new update') expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
    await advanceSessionClock(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(action === 'unmount' ? 1 : 2);
  });

  it('cancels a pending retry on a new update and never replays its POST payload', async () => {
    vi.useFakeTimers();
    let updateSession!: (payload?: unknown) => Promise<Session | null>;
    function SessionUpdater() {
      updateSession = useSession().update;
      return <SessionState />;
    }
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    render(
      <SessionProviderWrapper>
        <SessionUpdater />
      </SessionProviderWrapper>,
    );
    await advanceSessionClock(0);
    await advanceSessionClock(500);
    fetchMock.mockResolvedValueOnce(Response.json({ csrfToken: 'fixture-csrf' }));
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    await act(async () => {
      await updateSession({ name: 'fixture update' });
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    await advanceSessionClock(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    serverSession = session('user-b', 'login-b');
    await advanceSessionClock(1500);
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the retry timer on unmount', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    const { unmount } = renderInitialSession();
    await advanceSessionClock(0);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advanceSessionClock(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a retry from an old intent read or override the replacement login', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    renderInitialSession();
    await advanceSessionClock(0);
    act(() => {
      beginWebSessionIntent();
    });
    await advanceSessionClock(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    serverSession = session('user-b', 'login-b');
    act(() => requestWebSessionRefresh());
    await advanceSessionClock(0);
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores an old initial error after B settles and preserves B through later outages', async () => {
    vi.useFakeTimers();
    let rejectBody!: (cause: Error) => void;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectBody = reject;
        }),
    } as Response);
    serverSession = session('user-b', 'login-b');
    renderInitialSession();
    await advanceSessionClock(0);
    act(() => {
      beginWebSessionIntent();
      requestWebSessionRefresh();
    });
    await advanceSessionClock(0);
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
    await act(async () => {
      rejectBody(new Error('old unavailable read'));
    });
    expect(vi.getTimerCount()).toBe(0);
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    act(() => requestWebSessionRefresh());
    await advanceSessionClock(0);
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    await advanceSessionClock(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not schedule a late initial error from an old intent before the new read starts', async () => {
    vi.useFakeTimers();
    let rejectBody!: (cause: Error) => void;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectBody = reject;
        }),
    } as Response);
    renderInitialSession();
    await advanceSessionClock(0);
    act(() => {
      beginWebSessionIntent();
    });
    await act(async () => {
      rejectBody(new Error('old unavailable read'));
    });
    expect(screen.getByText('loading:none:none')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    await advanceSessionClock(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    serverSession = session('user-b', 'login-b');
    act(() => requestWebSessionRefresh());
    await advanceSessionClock(0);
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
  });
});

async function renderSettledSession(expectedState: string) {
  const rendered = render(
    <SessionProviderWrapper enableExpoAuthBridge>
      <SessionState />
    </SessionProviderWrapper>,
  );
  await waitFor(() => expect(screen.getByText(expectedState)).toBeTruthy());
  await waitFor(() => expect(MockBroadcastChannel.instances).toHaveLength(1));
  return rendered;
}

describe('SessionProviderWrapper auth bridge', () => {
  it('does not mount the Expo bridge when the rollout flag is disabled', async () => {
    serverSession = session('user-a', 'login-a');

    render(
      <SessionProviderWrapper>
        <SessionState />
      </SessionProviderWrapper>,
    );

    await waitFor(() => expect(screen.getByText('authenticated:user-a:login-a')).toBeTruthy());
    expect(MockBroadcastChannel.instances).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits for the shared cookie lock before refreshing the local NextAuth session', async () => {
    const requestLock = createNamedFifoLockRequest();
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    serverSession = session('user-a', 'login-a');
    await renderSettledSession('authenticated:user-a:login-a');
    const channel = MockBroadcastChannel.instances[0];
    let releaseCookieMutation!: () => void;
    const cookieMutation = requestLock(
      'boardsesh-nextauth-cookie-v1',
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseCookieMutation = resolve;
        }),
    );
    await vi.waitFor(() => expect(releaseCookieMutation).toBeTypeOf('function'));
    const fetchCountBeforeRefresh = fetchMock.mock.calls.length;
    const lockRequestCountBeforeRefresh = requestLock.mock.calls.length;

    serverSession = session('user-b', 'login-b');
    act(() => channel?.emit({ type: 'auth-token-cleared', sourceId: 'expo-tab-b' }));

    await vi.waitFor(() => expect(requestLock.mock.calls.length).toBeGreaterThan(lockRequestCountBeforeRefresh));
    expect(fetchMock).toHaveBeenCalledTimes(fetchCountBeforeRefresh);

    releaseCookieMutation();
    await cookieMutation;
    await waitFor(() => expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy());
    expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchCountBeforeRefresh);
  });

  it('refreshes the local NextAuth provider from anonymous to the new Expo login', async () => {
    const { unmount } = await renderSettledSession('unauthenticated:none:none');
    const channel = MockBroadcastChannel.instances[0];
    expect(channel?.name).toBe('boardsesh-expo-web-auth-v1');

    serverSession = session('user-b', 'login-b');
    act(() => channel?.emit({ type: 'auth-token-cleared', sourceId: 'expo-tab-b' }));

    await waitFor(() => expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalled();

    unmount();
    expect(channel?.close).toHaveBeenCalledOnce();
    expect(channel?.listeners.size).toBe(0);
  });

  it('refreshes the local NextAuth provider from the prior login to anonymous', async () => {
    serverSession = session('user-a', 'login-a');
    const { unmount } = await renderSettledSession('authenticated:user-a:login-a');
    const channel = MockBroadcastChannel.instances[0];

    serverSession = null;
    act(() => channel?.emit({ type: 'auth-token-cleared', sourceId: 'expo-tab-a' }));

    await waitFor(() => expect(screen.getByText('unauthenticated:none:none')).toBeTruthy());

    unmount();
    expect(channel?.close).toHaveBeenCalledOnce();
    expect(channel?.listeners.size).toBe(0);
  });

  it('ignores malformed and unrelated Expo messages', async () => {
    serverSession = session('user-a', 'login-a');
    await renderSettledSession('authenticated:user-a:login-a');
    const channel = MockBroadcastChannel.instances[0];
    const fetchCountBeforeMessages = fetchMock.mock.calls.length;

    act(() => {
      channel?.emit({ type: 'auth-token-cleared' });
      channel?.emit({ type: 'other', sourceId: 'tab-a' });
      channel?.emit('auth-token-cleared');
    });

    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(fetchCountBeforeMessages);
    expect(screen.getByText('authenticated:user-a:login-a')).toBeTruthy();
  });
});

describe('owned session response acceptance', () => {
  it('preserves the accepted owner on authority outage or malformed body', async () => {
    serverSession = session('user-b', 'login-b');
    await renderSettledSession('authenticated:user-b:login-b');
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    act(() => requestWebSessionRefresh());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
    fetchMock.mockResolvedValueOnce(Response.json(null));
    act(() => requestWebSessionRefresh());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
  });

  it('discards a delayed empty A body after a real public-client B sign-in', async () => {
    serverSession = session('user-a', 'login-a');
    await renderSettledSession('authenticated:user-a:login-a');
    let releaseOldBody!: (body: unknown) => void;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        new Promise<unknown>((resolve) => {
          releaseOldBody = resolve;
        }),
    } as Response);
    act(() => requestWebSessionRefresh());
    await vi.waitFor(() => expect(releaseOldBody).toBeTypeOf('function'));
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const endpoint = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (endpoint.endsWith('/providers'))
        return Response.json({
          credentials: { id: 'credentials', type: 'credentials', name: 'Credentials', signinUrl: '', callbackUrl: '' },
        });
      if (endpoint.endsWith('/csrf')) return Response.json({ csrfToken: 'fixture-csrf' });
      if (endpoint.endsWith('/callback/credentials')) return Response.json({ url: 'http://localhost:3000/' });
      return Response.json(session('user-b', 'login-b'));
    });
    let loginResult: Awaited<ReturnType<typeof signInWithSessionIntent>>;
    await act(async () => {
      loginResult = await signInWithSessionIntent('credentials', {
        redirect: false,
        email: 'fixture@example.invalid',
        password: 'fixture-only',
      });
    });
    expect(loginResult?.ok).toBe(true);
    await waitFor(() => expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy());
    await act(async () => {
      releaseOldBody({});
    });
    expect(screen.getByText('authenticated:user-b:login-b')).toBeTruthy();
  });
});
