import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MessageListener = (event: MessageEvent<unknown>) => void;

class MockBroadcastChannel {
  static channels: MockBroadcastChannel[] = [];

  readonly sentMessages: unknown[] = [];
  private readonly messageListeners = new Set<MessageListener>();

  constructor(readonly name: string) {
    MockBroadcastChannel.channels.push(this);
  }

  addEventListener(type: string, listener: MessageListener): void {
    if (type === 'message') this.messageListeners.add(listener);
  }

  postMessage(message: unknown): void {
    this.sentMessages.push(message);
    for (const channel of MockBroadcastChannel.channels) {
      if (channel !== this && channel.name === this.name) channel.dispatchMessage(message);
    }
  }

  private dispatchMessage(message: unknown): void {
    const event = { data: message } as MessageEvent<unknown>;
    for (const listener of this.messageListeners) listener(event);
  }
}

const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authenticatedBridgeResponse(token: string, userId = 'user-1', authSessionId = 'login-1'): Response {
  return jsonResponse({ authenticated: true, token, userId, authSessionId });
}

beforeEach(() => {
  vi.resetModules();
  MockBroadcastChannel.channels = [];
  fetchMock.mockReset();
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('auth-store web cross-tab invalidation', () => {
  it('notifies the clearing tab and every remote tab exactly once without rebroadcasting', async () => {
    const firstTab = await import('../auth-store.web');
    const firstTabListener = vi.fn();
    firstTab.subscribeAuthTokenChanges(firstTabListener);
    const firstTabGeneration = firstTab.captureAuthCredentialGeneration();

    // Resetting Vitest's module registry models a second browser realm: it gets
    // independent module memory while the first imported module remains live.
    vi.resetModules();
    const secondTab = await import('../auth-store.web');
    const secondTabListener = vi.fn();
    secondTab.subscribeAuthTokenChanges(secondTabListener);
    const secondTabGeneration = secondTab.captureAuthCredentialGeneration();

    await firstTab.clearTokens();

    expect(firstTabListener).toHaveBeenCalledOnce();
    expect(firstTabListener).toHaveBeenCalledWith(null, 'local');
    expect(secondTabListener).toHaveBeenCalledOnce();
    expect(secondTabListener).toHaveBeenCalledWith(null, 'remote');
    expect(firstTab.captureAuthCredentialGeneration()).toBe(firstTabGeneration + 1);
    expect(secondTab.captureAuthCredentialGeneration()).toBe(secondTabGeneration + 1);

    expect(MockBroadcastChannel.channels).toHaveLength(2);
    expect(MockBroadcastChannel.channels[0]?.sentMessages).toHaveLength(1);
    expect(MockBroadcastChannel.channels[1]?.sentMessages).toHaveLength(0);
  });

  it('keeps a remote clear from restoring an in-flight bridge token', async () => {
    const clearingTab = await import('../auth-store.web');
    vi.resetModules();
    const synchronizingTab = await import('../auth-store.web');

    let resolveTokenBridge!: (response: Response) => void;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveTokenBridge = resolve;
        }),
      );

    const synchronization = synchronizingTab.synchronizeWebSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await clearingTab.clearTokens();
    resolveTokenBridge(authenticatedBridgeResponse('stale-jwe'));

    await expect(synchronization).resolves.toEqual({ status: 'superseded' });
    await expect(synchronizingTab.getAuthToken()).resolves.toBeNull();
  });

  it('lets a remote tab rehydrate its memory token after a sign-in broadcast', async () => {
    const signingInTab = await import('../auth-store.web');
    vi.resetModules();
    const remoteTab = await import('../auth-store.web');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-2' }, authSessionId: 'login-2' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-backend-jwe', 'user-2', 'login-2'));
    let remoteRevalidation: Promise<unknown> | null = null;
    remoteTab.subscribeAuthTokenChanges((_token, source) => {
      if (source === 'remote') remoteRevalidation = remoteTab.synchronizeWebSession();
    });

    await signingInTab.clearTokens();

    await expect(remoteRevalidation).resolves.toEqual({
      status: 'authenticated',
      token: 'new-backend-jwe',
      userId: 'user-2',
      authSessionId: 'login-2',
    });
    await expect(remoteTab.getAuthToken()).resolves.toBe('new-backend-jwe');
  });

  it('keeps local invalidation working when BroadcastChannel construction is rejected', async () => {
    class RejectingBroadcastChannel {
      constructor() {
        throw new Error('BroadcastChannel unavailable');
      }
    }
    vi.stubGlobal('BroadcastChannel', RejectingBroadcastChannel);
    vi.resetModules();
    const authStore = await import('../auth-store.web');
    const listener = vi.fn();
    authStore.subscribeAuthTokenChanges(listener);

    await expect(authStore.clearTokens()).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(null, 'local');
  });
});
