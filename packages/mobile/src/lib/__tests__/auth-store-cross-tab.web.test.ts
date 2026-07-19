import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The sign-out fetches here hit www's auth endpoints cross-origin, so
// `webApiUrl` resolves them to the absolute web origin (WEB_BASE_URL default).
// The stubbed window origin below isn't www, so the absolute form always wins.
const WEB = 'https://www.boardsesh.com';

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
  // Simulate the www-mounted export (experiments.baseUrl '/app'), mirroring
  // auth.web.test.ts: appCallbackUrl() derives the NextAuth callback from
  // EXPO_BASE_URL, and the sign-out flow below compares the returned url
  // against it.
  vi.stubEnv('EXPO_BASE_URL', '/app');
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    location: { origin: 'https://qa.boardsesh.test' },
  });
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
    expect(MockBroadcastChannel.channels[0]?.sentMessages[0]).toMatchObject({
      type: 'auth-token-cleared',
      reason: 'credential-rotation',
    });
    expect(MockBroadcastChannel.channels[1]?.sentMessages).toHaveLength(0);
  });

  it('broadcasts a recovery rotation without changing the sending tab generation', async () => {
    const sendingTab = await import('../auth-store.web');
    const sendingGeneration = sendingTab.captureAuthCredentialGeneration();
    const sendingListener = vi.fn();
    sendingTab.subscribeAuthTokenChanges(sendingListener);

    vi.resetModules();
    const remoteTab = await import('../auth-store.web');
    const remoteGeneration = remoteTab.captureAuthCredentialGeneration();
    const remoteListener = vi.fn();
    remoteTab.subscribeAuthTokenChanges(remoteListener);

    sendingTab.broadcastCredentialRotation();

    expect(sendingListener).not.toHaveBeenCalled();
    expect(sendingTab.captureAuthCredentialGeneration()).toBe(sendingGeneration);
    expect(remoteListener).toHaveBeenCalledWith(null, 'remote');
    expect(remoteTab.captureAuthCredentialGeneration()).toBe(remoteGeneration + 1);
    expect(MockBroadcastChannel.channels[0]?.sentMessages[0]).toMatchObject({
      type: 'auth-token-cleared',
      reason: 'credential-rotation',
    });
  });

  it('isolates a signing-out tab without cancelling the same logout in its peer', async () => {
    const firstTab = await import('../auth-store.web');
    const firstTabListener = vi.fn();
    firstTab.subscribeAuthTokenChanges(firstTabListener);

    vi.resetModules();
    const secondTab = await import('../auth-store.web');
    const secondTabListener = vi.fn();
    secondTab.subscribeAuthTokenChanges(secondTabListener);
    const secondTabGeneration = secondTab.captureAuthCredentialGeneration();

    await firstTab.isolateTokensForSignOut();

    expect(firstTabListener).toHaveBeenCalledWith(null, 'local');
    expect(secondTabListener).not.toHaveBeenCalled();
    expect(secondTab.captureAuthCredentialGeneration()).toBe(secondTabGeneration);
    expect(MockBroadcastChannel.channels[0]?.sentMessages).toHaveLength(0);
  });

  it('lets one of two simultaneous same-login sign-outs durably delete the cookie', async () => {
    let lockQueue: Promise<void> = Promise.resolve();
    const requestLock = vi.fn(
      <Result>(_name: string, _options: LockOptions, operation: () => Promise<Result>): Promise<Result> => {
        const result = lockQueue.then(operation, operation);
        lockQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    vi.stubGlobal('navigator', { locks: { request: requestLock } });

    const firstTabStore = await import('../auth-store.web');
    const firstTabAuth = await import('../auth.web');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('first-tab-jwe'));
    await firstTabStore.synchronizeWebSession();

    vi.resetModules();
    const secondTabStore = await import('../auth-store.web');
    const secondTabAuth = await import('../auth.web');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('second-tab-jwe'));
    await secondTabStore.synchronizeWebSession();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/app' }))
      .mockResolvedValueOnce(jsonResponse({}));

    const signOutResults = await Promise.all([
      firstTabAuth.signOutForGeneration(firstTabStore.captureAuthCredentialGeneration()),
      secondTabAuth.signOutForGeneration(secondTabStore.captureAuthCredentialGeneration()),
    ]);

    expect(signOutResults.some(Boolean)).toBe(true);
    const requestedUrls = fetchMock.mock.calls.map(([url]) => url);
    // Browser delivery of the started signal may cancel the peer before or
    // after it begins its ownership read. It must never reach CSRF or a second
    // durable sign-out mutation.
    const ownershipReadCount = requestedUrls.filter((url) => url === `${WEB}/api/auth/session`).length;
    expect(ownershipReadCount).toBeGreaterThanOrEqual(1);
    expect(ownershipReadCount).toBeLessThanOrEqual(2);
    expect(requestedUrls.filter((url) => url === `${WEB}/api/auth/csrf`)).toHaveLength(1);
    expect(requestedUrls.filter((url) => url === `${WEB}/api/auth/signout`)).toHaveLength(1);
    await expect(firstTabStore.getAuthToken()).resolves.toBeNull();
    await expect(secondTabStore.getAuthToken()).resolves.toBeNull();
  });

  it('distinguishes a confirmed durable sign-out from a credential rotation', async () => {
    const signingOutTab = await import('../auth-store.web');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('signing-out-jwe'));
    await signingOutTab.synchronizeWebSession();

    vi.resetModules();
    const remoteTab = await import('../auth-store.web');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('remote-jwe'));
    await remoteTab.synchronizeWebSession();
    const remoteListener = vi.fn();
    remoteTab.subscribeAuthTokenChanges(remoteListener);
    const remoteGeneration = remoteTab.captureAuthCredentialGeneration();

    signingOutTab.broadcastConfirmedSignOut();

    expect(remoteListener).toHaveBeenCalledOnce();
    expect(remoteListener).toHaveBeenCalledWith(null, 'remote-signout');
    expect(remoteTab.captureAuthCredentialGeneration()).toBe(remoteGeneration + 1);
    expect(MockBroadcastChannel.channels[0]?.sentMessages[0]).toMatchObject({
      type: 'auth-token-cleared',
      reason: 'confirmed-signout',
      identity: { userId: 'user-1', authSessionId: 'login-1' },
    });
  });

  it('fences a same-login peer during sign-out while returning its in-flight response', async () => {
    const signingOutTab = await import('../auth-store.web');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('signing-out-jwe'));
    await signingOutTab.synchronizeWebSession();

    vi.resetModules();
    const remoteTab = await import('../auth-store.web');
    const remoteAuthInterceptor = await import('../auth-interceptor.web');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('remote-jwe'));
    await remoteTab.synchronizeWebSession();
    const remoteListener = vi.fn();
    remoteTab.subscribeAuthTokenChanges(remoteListener);
    const remoteGeneration = remoteTab.captureAuthCredentialGeneration();
    let resolveOldRequest!: (response: Response) => void;
    fetchMock.mockReset();
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveOldRequest = resolve;
      }),
    );
    const oldRequest = remoteAuthInterceptor.authenticatedFetch('/graphql');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    signingOutTab.broadcastSignOutStarted({ userId: 'user-1', authSessionId: 'login-1' });

    expect(remoteListener).toHaveBeenCalledWith(null, 'remote');
    expect(remoteTab.captureAuthCredentialGeneration()).toBe(remoteGeneration + 1);
    await expect(remoteTab.getAuthToken()).resolves.toBeNull();
    expect(MockBroadcastChannel.channels[0]?.sentMessages[0]).toMatchObject({
      type: 'auth-token-cleared',
      reason: 'signout-started',
      identity: { userId: 'user-1', authSessionId: 'login-1' },
    });
    resolveOldRequest(jsonResponse({ data: { privateForOldLogin: true } }));
    await expect(oldRequest).resolves.toEqual(expect.objectContaining({ status: 200 }));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('restored-jwe'));
    await expect(remoteTab.synchronizeWebSession()).resolves.toMatchObject({
      status: 'authenticated',
      token: 'restored-jwe',
    });
  });

  it('broadcasts a recovery rotation when owned sign-out fails after fencing peers', async () => {
    const signingOutTab = await import('../auth-store.web');
    const signingOutAuth = await import('../auth.web');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('signing-out-jwe'));
    await signingOutTab.synchronizeWebSession();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    await expect(signingOutAuth.signOutForGeneration(signingOutTab.captureAuthCredentialGeneration())).rejects.toThrow(
      'Could not start sign-out',
    );

    expect(MockBroadcastChannel.channels[0]?.sentMessages).toEqual([
      expect.objectContaining({ reason: 'signout-started' }),
      expect.objectContaining({ reason: 'credential-rotation' }),
    ]);
    await expect(signingOutTab.getAuthToken()).resolves.toBeNull();
  });

  it('keeps a newly confirmed owner when an old login sign-out arrives late', async () => {
    const oldOwnerTab = await import('../auth-store.web');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-a' }, authSessionId: 'login-a' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('old-owner-jwe', 'user-a', 'login-a'));
    await oldOwnerTab.synchronizeWebSession();

    vi.resetModules();
    const newOwnerTab = await import('../auth-store.web');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-b' }, authSessionId: 'login-b' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-owner-jwe', 'user-b', 'login-b'));
    await newOwnerTab.synchronizeWebSession();
    const newOwnerListener = vi.fn();
    newOwnerTab.subscribeAuthTokenChanges(newOwnerListener);
    const newOwnerGeneration = newOwnerTab.captureAuthCredentialGeneration();

    oldOwnerTab.broadcastConfirmedSignOut();

    expect(newOwnerListener).toHaveBeenCalledOnce();
    expect(newOwnerListener).toHaveBeenCalledWith('new-owner-jwe', 'hint');
    expect(newOwnerTab.captureAuthCredentialGeneration()).toBe(newOwnerGeneration);
    await expect(newOwnerTab.getAuthToken()).resolves.toBe('new-owner-jwe');
    expect(MockBroadcastChannel.channels[0]?.sentMessages[0]).toMatchObject({
      type: 'auth-token-cleared',
      reason: 'confirmed-signout',
      identity: { userId: 'user-a', authSessionId: 'login-a' },
    });
  });

  it('accepts a legacy v1 clear without a reason as credential rotation', async () => {
    const currentTab = await import('../auth-store.web');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('current-jwe'));
    await currentTab.synchronizeWebSession();
    const currentListener = vi.fn();
    currentTab.subscribeAuthTokenChanges(currentListener);
    const currentGeneration = currentTab.captureAuthCredentialGeneration();
    const legacyTab = new MockBroadcastChannel('boardsesh-expo-web-auth-v1');

    legacyTab.postMessage({
      type: 'auth-token-cleared',
      sourceId: 'legacy-v1-tab',
    });

    expect(currentListener).toHaveBeenCalledOnce();
    expect(currentListener).toHaveBeenCalledWith(null, 'remote');
    expect(currentTab.captureAuthCredentialGeneration()).toBe(currentGeneration + 1);
    await expect(currentTab.getAuthToken()).resolves.toBeNull();
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
