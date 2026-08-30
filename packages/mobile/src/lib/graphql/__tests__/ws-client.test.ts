import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CreateGraphQLClientOptions, ExtendedClient } from '@boardsesh/graphql-client';
import { createClient as createRawGraphQLWsClient } from 'graphql-ws';

let capturedOptions: CreateGraphQLClientOptions | null = null;
const disposeSpy = vi.fn();
const singletonClient = { dispose: disposeSpy } as unknown as ExtendedClient;

vi.mock('@boardsesh/graphql-client', () => ({
  createGraphQLClient: (options: CreateGraphQLClientOptions) => {
    capturedOptions = options;
    return singletonClient;
  },
}));

vi.mock('../../auth-store', () => ({
  captureAuthCredentialGeneration: vi.fn().mockReturnValue(1),
  getAuthToken: vi.fn().mockResolvedValue('jwt-token'),
  isAuthCredentialGenerationCurrent: vi.fn().mockReturnValue(true),
}));

vi.mock('../../auth-interceptor', () => ({
  ensureFreshToken: vi.fn().mockResolvedValue(true),
  recoverAuthRejection: vi.fn().mockResolvedValue('refreshed'),
}));

vi.mock('../../error-reporting', () => ({
  reportHandledError: vi.fn(),
}));

vi.mock('../../env', () => ({ BACKEND_URL: 'https://api.test' }));

type NativeSocketOptions = { headers?: Record<string, string> };

class NativeSocketStub {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: NativeSocketStub[] = [];

  readonly CONNECTING = NativeSocketStub.CONNECTING;
  readonly OPEN = NativeSocketStub.OPEN;
  readonly CLOSING = NativeSocketStub.CLOSING;
  readonly CLOSED = NativeSocketStub.CLOSED;
  readonly url: string;
  readonly protocol = 'graphql-transport-ws';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  readonly protocols: string | string[] | undefined;
  readonly options: NativeSocketOptions | undefined;
  readonly sentMessages: string[] = [];

  readyState = NativeSocketStub.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onerror: WebSocket['onerror'] = null;
  onclose: WebSocket['onclose'] = null;

  constructor(url: string | URL, protocols?: string | string[], options?: NativeSocketOptions) {
    this.url = url.toString();
    this.protocols = protocols;
    this.options = options;
    NativeSocketStub.instances.push(this);
  }

  open(): void {
    this.readyState = NativeSocketStub.OPEN;
    this.onopen?.call(this as unknown as WebSocket, {} as Event);
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.call(
      this as unknown as WebSocket,
      {
        data: JSON.stringify(message),
      } as MessageEvent,
    );
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = NativeSocketStub.CLOSED;
    this.onclose?.call(
      this as unknown as WebSocket,
      {
        code,
        reason,
        wasClean: true,
      } as CloseEvent,
    );
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== 'string') throw new Error('graphql-ws sent a non-string frame');
    this.sentMessages.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === NativeSocketStub.CLOSED) return;
    this.serverClose(code, reason);
  }
}

import { disposeWsClient, getWsClient } from '../ws-client';
import { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } from '../../auth-store';
import { ensureFreshToken, recoverAuthRejection } from '../../auth-interceptor';
import { NetworkPolicyBlockedError, setNetworkPolicy } from '../../network-policy';

const getAuthTokenMock = getAuthToken as Mock;
const captureAuthCredentialGenerationMock = captureAuthCredentialGeneration as Mock;
const isAuthCredentialGenerationCurrentMock = isAuthCredentialGenerationCurrent as Mock;
const recoverAuthRejectionMock = recoverAuthRejection as Mock;
const ensureFreshTokenMock = ensureFreshToken as Mock;

function connectionParams(): () => Promise<Record<string, unknown>> {
  if (!capturedOptions?.connectionParams) throw new Error('connectionParams not captured');
  return capturedOptions.connectionParams;
}

function nativeWebSocketImplementation(): typeof WebSocket {
  if (!capturedOptions?.webSocketImpl) throw new Error('webSocketImpl not captured');
  return capturedOptions.webSocketImpl;
}

function parsedMessages(socket: NativeSocketStub): Array<Record<string, unknown>> {
  return socket.sentMessages.map((message) => JSON.parse(message) as Record<string, unknown>);
}

function messagesOfType(socket: NativeSocketStub, type: string): Array<Record<string, unknown>> {
  return parsedMessages(socket).filter((message) => message.type === type);
}

beforeEach(() => {
  setNetworkPolicy('online');
  disposeWsClient();
  vi.clearAllMocks();
  vi.stubGlobal('WebSocket', NativeSocketStub);
  NativeSocketStub.instances = [];
  capturedOptions = null;
  getAuthTokenMock.mockResolvedValue('jwt-token');
  captureAuthCredentialGenerationMock.mockReturnValue(1);
  isAuthCredentialGenerationCurrentMock.mockReturnValue(true);
  ensureFreshTokenMock.mockResolvedValue(true);
  recoverAuthRejectionMock.mockResolvedValue('refreshed');
});

it('blocks client creation and disposes the singleton when backend traffic is disabled', () => {
  getWsClient();
  setNetworkPolicy('account-offline');

  expect(() => getWsClient()).toThrow(NetworkPolicyBlockedError);
  expect(disposeSpy).toHaveBeenCalledTimes(1);
});

describe('native GraphQL WebSocket transport', () => {
  it("drops React Native's Origin header and sends the fresh token", async () => {
    getWsClient();
    const NativeAppWebSocket = nativeWebSocketImplementation();

    new NativeAppWebSocket('wss://api.test/graphql', 'graphql-transport-ws');
    const params = await connectionParams()();

    expect(NativeSocketStub.instances[0]?.options).toEqual({ headers: { origin: '' } });
    expect(ensureFreshTokenMock).toHaveBeenCalledTimes(1);
    expect(ensureFreshTokenMock.mock.invocationCallOrder[0]).toBeLessThan(getAuthTokenMock.mock.invocationCallOrder[0]);
    expect(params).toEqual({ authToken: 'jwt-token' });
  });

  it('omits authToken when no token is stored', async () => {
    getAuthTokenMock.mockResolvedValue(null);
    getWsClient();

    await expect(connectionParams()()).resolves.toEqual({});
  });

  it('rejects a handshake superseded while its token is being prepared', async () => {
    let releaseFreshToken!: (fresh: boolean) => void;
    ensureFreshTokenMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseFreshToken = resolve;
      }),
    );
    getWsClient();

    const params = connectionParams()();
    const paramsExpectation = expect(params).rejects.toThrow('Authentication session changed');
    await vi.waitFor(() => expect(ensureFreshTokenMock).toHaveBeenCalledTimes(1));
    isAuthCredentialGenerationCurrentMock.mockReturnValue(false);
    releaseFreshToken(true);

    await paramsExpectation;
    expect(getAuthTokenMock).not.toHaveBeenCalled();
  });

  it('remaps a burst of 4401 closes, refreshes once, and keeps the singleton', async () => {
    let releaseRefresh!: (result: string) => void;
    recoverAuthRejectionMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    const client = getWsClient();
    const NativeAppWebSocket = nativeWebSocketImplementation();
    const firstSocket = new NativeAppWebSocket('wss://api.test/graphql');
    const secondSocket = new NativeAppWebSocket('wss://api.test/graphql');
    const observedCloseCodes: number[] = [];
    firstSocket.onclose = (event) => observedCloseCodes.push(event.code);
    secondSocket.onclose = (event) => observedCloseCodes.push(event.code);

    NativeSocketStub.instances[0]?.serverClose(4401, 'Unauthorized');
    NativeSocketStub.instances[1]?.serverClose(4401, 'Unauthorized');

    expect(observedCloseCodes).toEqual([]);
    expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(1);
    expect(getWsClient()).toBe(client);
    expect(disposeSpy).not.toHaveBeenCalled();

    releaseRefresh('refreshed');
    await vi.waitFor(() => expect(observedCloseCodes).toEqual([4403, 4403]));
  });

  it('keeps reconnecting after a transient auth refresh outage', async () => {
    recoverAuthRejectionMock.mockResolvedValueOnce('unavailable');
    getWsClient();
    const NativeAppWebSocket = nativeWebSocketImplementation();
    const socket = new NativeAppWebSocket('wss://api.test/graphql');
    const observedCloseCodes: number[] = [];
    socket.onclose = (event) => observedCloseCodes.push(event.code);

    NativeSocketStub.instances[0]?.serverClose(4401, 'Unauthorized');

    await vi.waitFor(() => expect(observedCloseCodes).toEqual([4403]));
  });

  it('keeps 4401 recovery isolated between native credential owners', async () => {
    let currentGeneration = 1;
    captureAuthCredentialGenerationMock.mockImplementation(() => currentGeneration);
    isAuthCredentialGenerationCurrentMock.mockImplementation((generation: number) => generation === currentGeneration);
    let releaseOldRecovery!: (result: string) => void;
    recoverAuthRejectionMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseOldRecovery = resolve;
      }),
    );
    getWsClient();
    const NativeAppWebSocket = nativeWebSocketImplementation();
    const oldSocket = new NativeAppWebSocket('wss://api.test/graphql');
    const oldCloseCodes: number[] = [];
    oldSocket.onclose = (event) => oldCloseCodes.push(event.code);
    NativeSocketStub.instances[0]?.open();
    NativeSocketStub.instances[0]?.serverClose(4401, 'Unauthorized');
    await vi.waitFor(() => expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(1));

    currentGeneration = 2;
    const newSocket = new NativeAppWebSocket('wss://api.test/graphql');
    const newCloseCodes: number[] = [];
    newSocket.onclose = (event) => newCloseCodes.push(event.code);
    NativeSocketStub.instances[1]?.open();
    NativeSocketStub.instances[1]?.serverClose(4401, 'Unauthorized');

    await vi.waitFor(() => expect(newCloseCodes).toEqual([4403]));
    expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(2);
    expect(oldCloseCodes).toEqual([]);

    releaseOldRecovery('refreshed');
    await vi.waitFor(() => expect(oldCloseCodes).toEqual([4401]));
  });

  it('rechecks native credential ownership in the close-delivery continuation', async () => {
    let currentGeneration = 1;
    captureAuthCredentialGenerationMock.mockImplementation(() => currentGeneration);
    isAuthCredentialGenerationCurrentMock.mockImplementation((generation: number) => generation === currentGeneration);
    let releaseRecovery!: (result: string) => void;
    const pendingRecovery = new Promise<string>((resolve) => {
      releaseRecovery = resolve;
    });
    recoverAuthRejectionMock.mockReturnValueOnce(pendingRecovery);
    getWsClient();
    const NativeAppWebSocket = nativeWebSocketImplementation();
    const socket = new NativeAppWebSocket('wss://api.test/graphql');
    const closeCodes: number[] = [];
    socket.onclose = (event) => closeCodes.push(event.code);
    NativeSocketStub.instances[0]?.open();
    NativeSocketStub.instances[0]?.serverClose(4401, 'Unauthorized');
    await vi.waitFor(() => expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(1));

    // This reaction runs after the recovery helper resumes, but before its
    // resolved result is delivered to the socket's close continuation.
    void pendingRecovery.then(() => {
      currentGeneration = 2;
    });
    releaseRecovery('refreshed');

    await vi.waitFor(() => expect(closeCodes).toEqual([4401]));
  });

  it('reconnects and resubscribes an active operation after refreshing a rejected token', async () => {
    let releaseRefresh!: (result: string) => void;
    recoverAuthRejectionMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    getAuthTokenMock.mockResolvedValueOnce('rejected-token').mockResolvedValue('fresh-token');
    const singletonBeforeReconnect = getWsClient();

    const subscriptionErrors: unknown[] = [];
    const rawClient = createRawGraphQLWsClient({
      url: 'wss://api.test/graphql',
      webSocketImpl: nativeWebSocketImplementation(),
      connectionParams: connectionParams(),
      lazy: true,
      retryAttempts: 2,
      retryWait: async () => {},
    });
    const unsubscribe = rawClient.subscribe(
      { query: 'subscription SessionEvents { sessionEvents { __typename } }' },
      {
        next: () => {},
        error: (error) => subscriptionErrors.push(error),
        complete: () => {},
      },
    );

    await vi.waitFor(() => expect(NativeSocketStub.instances).toHaveLength(1));
    const firstSocket = NativeSocketStub.instances[0];
    if (!firstSocket) throw new Error('first socket was not created');
    firstSocket.open();
    await vi.waitFor(() => expect(messagesOfType(firstSocket, 'connection_init')).toHaveLength(1));
    expect(messagesOfType(firstSocket, 'connection_init')[0]?.payload).toEqual({ authToken: 'rejected-token' });
    firstSocket.receive({ type: 'connection_ack' });
    await vi.waitFor(() => expect(messagesOfType(firstSocket, 'subscribe')).toHaveLength(1));

    firstSocket.serverClose(4401, 'Unauthorized');
    await vi.waitFor(() => expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(1));
    expect(NativeSocketStub.instances).toHaveLength(1);

    releaseRefresh('refreshed');
    await vi.waitFor(() => expect(NativeSocketStub.instances).toHaveLength(2));
    const secondSocket = NativeSocketStub.instances[1];
    if (!secondSocket) throw new Error('retry socket was not created');
    secondSocket.open();

    await vi.waitFor(() => expect(messagesOfType(secondSocket, 'connection_init')).toHaveLength(1));
    expect(messagesOfType(secondSocket, 'connection_init')[0]?.payload).toEqual({ authToken: 'fresh-token' });
    secondSocket.receive({ type: 'connection_ack' });
    await vi.waitFor(() => expect(messagesOfType(secondSocket, 'subscribe')).toHaveLength(1));

    expect(messagesOfType(secondSocket, 'subscribe')[0]?.payload).toEqual(
      messagesOfType(firstSocket, 'subscribe')[0]?.payload,
    );
    expect(subscriptionErrors).toEqual([]);
    expect(getWsClient()).toBe(singletonBeforeReconnect);
    expect(disposeSpy).not.toHaveBeenCalled();

    unsubscribe();
    await rawClient.dispose();
  });

  it('keeps a rejected 4401 recovery fatal instead of reconnecting with the rejected token', async () => {
    recoverAuthRejectionMock.mockResolvedValueOnce('rejected');
    getWsClient();
    const rawClient = createRawGraphQLWsClient({
      url: 'wss://api.test/graphql',
      webSocketImpl: nativeWebSocketImplementation(),
      connectionParams: connectionParams(),
      lazy: true,
      retryAttempts: 2,
      retryWait: async () => {},
    });
    const subscriptionErrors: unknown[] = [];
    rawClient.subscribe(
      { query: 'subscription SessionEvents { sessionEvents { __typename } }' },
      { next: () => {}, error: (error) => subscriptionErrors.push(error), complete: () => {} },
    );

    await vi.waitFor(() => expect(NativeSocketStub.instances).toHaveLength(1));
    const socket = NativeSocketStub.instances[0];
    if (!socket) throw new Error('socket was not created');
    socket.open();
    await vi.waitFor(() => expect(messagesOfType(socket, 'connection_init')).toHaveLength(1));
    socket.receive({ type: 'connection_ack' });
    await vi.waitFor(() => expect(messagesOfType(socket, 'subscribe')).toHaveLength(1));

    socket.serverClose(4401, 'Unauthorized');

    await vi.waitFor(() => expect(subscriptionErrors).toHaveLength(1));
    expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(1);
    expect(NativeSocketStub.instances).toHaveLength(1);
    expect(getAuthTokenMock).toHaveBeenCalledTimes(1);
    await rawClient.dispose();
  });

  // #4241: dispose() rejects with the raw closing Event/CloseEvent, not an
  // Error — `void wsClient.dispose()` with no rejection handler let that
  // escape as an unhandled rejection, which Hermes forwarded to Sentry as an
  // opaque object. disposeWsClient() must fire-and-forget through a try/catch
  // so the rejection never reaches the process.
  describe('disposeWsClient (rejection safety)', () => {
    it('swallows a dispose rejection without producing an unhandled rejection', async () => {
      getWsClient();
      const rawCloseEventLike = { type: 'close', code: 1001, reason: 'Stream end encountered', wasClean: false };
      // Deliberately NOT `disposeSpy.mockRejectedValueOnce(...)`: vitest attaches
      // its own settled-result handlers to whatever a `vi.fn()` returns, which
      // marks the promise handled and makes an unhandled-rejection assertion
      // vacuous — it passes even against the pre-fix `void wsClient.dispose()`.
      // A plain rejecting function leaves the promise genuinely unhandled unless
      // disposeWsClient() attaches a handler itself.
      let plainDisposeCalls = 0;
      const clientUnderTest = singletonClient as unknown as { dispose: () => Promise<void> };
      clientUnderTest.dispose = () => {
        plainDisposeCalls += 1;
        return Promise.reject(rawCloseEventLike);
      };

      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        disposeWsClient();
        await vi.waitFor(() => expect(plainDisposeCalls).toBe(1));
        // Node emits 'unhandledRejection' a turn after the microtask queue
        // drains, so flush past a macrotask before asserting.
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        clientUnderTest.dispose = disposeSpy;
      }

      expect(plainDisposeCalls).toBe(1);
      expect(unhandledRejections).toEqual([]);
    });

    it('is idempotent — a second immediate call does not dispose again', () => {
      getWsClient();
      disposeWsClient();
      expect(disposeSpy).toHaveBeenCalledTimes(1);

      disposeWsClient();
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('nulls the singleton synchronously, so getWsClient() after dispose starts a fresh client lifecycle', () => {
      getWsClient();
      disposeWsClient();
      expect(disposeSpy).toHaveBeenCalledTimes(1);

      getWsClient();
      disposeWsClient();
      expect(disposeSpy).toHaveBeenCalledTimes(2);
    });
  });
});
