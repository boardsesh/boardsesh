import { act, render, screen, waitFor } from '@testing-library/react';
import type { Session } from 'next-auth';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionProviderWrapper from '../session-provider';

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderSettledSession(expectedState: string) {
  const rendered = render(
    <SessionProviderWrapper>
      <SessionState />
    </SessionProviderWrapper>,
  );
  await waitFor(() => expect(screen.getByText(expectedState)).toBeTruthy());
  await waitFor(() => expect(MockBroadcastChannel.instances).toHaveLength(1));
  return rendered;
}

describe('SessionProviderWrapper auth bridge', () => {
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
