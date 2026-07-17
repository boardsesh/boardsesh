import { act, render, screen, waitFor } from '@testing-library/react';
import type { Session } from 'next-auth';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionProviderWrapper from '../session-provider';

const LOCK_INSTALLATION_KEY = Symbol.for('boardsesh.nextauth-cookie-fetch-lock.state-v1');

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

afterEach(() => {
  clearLockInstallation();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
