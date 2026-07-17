import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CreateGraphQLClientOptions, ExtendedClient } from '@boardsesh/graphql-client';
import { createClient as createRawGraphQLWsClient } from 'graphql-ws';

type WebAuthRecoveryResult = 'authenticated' | 'anonymous' | 'unavailable' | 'superseded';

let capturedOptions: CreateGraphQLClientOptions | null = null;
const disposeSpy = vi.fn();
const singletonClient = { dispose: disposeSpy } as unknown as ExtendedClient;

vi.mock('@boardsesh/graphql-client', () => ({
  createGraphQLClient: (options: CreateGraphQLClientOptions) => {
    capturedOptions = options;
    return singletonClient;
  },
}));

vi.mock('../../auth-store.web', () => ({
  captureAuthCredentialGeneration: vi.fn().mockReturnValue(1),
  getAuthToken: vi.fn().mockResolvedValue('browser-jwe'),
  isAuthCredentialGenerationCurrent: vi.fn().mockReturnValue(true),
}));

vi.mock('../../auth-interceptor.web', () => ({
  ensureFreshToken: vi.fn().mockResolvedValue(true),
  recoverAuthRejection: vi.fn().mockResolvedValue('authenticated'),
}));

vi.mock('../../error-reporting', () => ({
  reportHandledError: vi.fn(),
}));

vi.mock('../../env', () => ({ BACKEND_URL: 'https://api.test' }));

class BrowserSocketStub {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: BrowserSocketStub[] = [];

  readonly CONNECTING = BrowserSocketStub.CONNECTING;
  readonly OPEN = BrowserSocketStub.OPEN;
  readonly CLOSING = BrowserSocketStub.CLOSING;
  readonly CLOSED = BrowserSocketStub.CLOSED;
  readonly url: string;
  readonly protocol = 'graphql-transport-ws';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  readonly protocols: string | string[] | undefined;
  readonly sentMessages: string[] = [];

  readyState = BrowserSocketStub.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onerror: WebSocket['onerror'] = null;
  onclose: WebSocket['onclose'] = null;

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = url.toString();
    this.protocols = protocols;
    BrowserSocketStub.instances.push(this);
  }

  open(): void {
    this.readyState = BrowserSocketStub.OPEN;
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
    this.readyState = BrowserSocketStub.CLOSED;
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
    if (this.readyState === BrowserSocketStub.CLOSED) return;
    this.serverClose(code, reason);
  }
}

vi.stubGlobal('WebSocket', BrowserSocketStub);

import { disposeWsClient, getWsClient } from '../ws-client.web';
import { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } from '../../auth-store.web';
import { ensureFreshToken, recoverAuthRejection } from '../../auth-interceptor.web';

const getAuthTokenMock = getAuthToken as Mock;
const captureAuthCredentialGenerationMock = captureAuthCredentialGeneration as Mock;
const isAuthCredentialGenerationCurrentMock = isAuthCredentialGenerationCurrent as Mock;
const recoverAuthRejectionMock = recoverAuthRejection as Mock;
const ensureFreshTokenMock = ensureFreshToken as Mock;

function connectionParams(): () => Promise<Record<string, unknown>> {
  if (!capturedOptions?.connectionParams) throw new Error('connectionParams not captured');
  return capturedOptions.connectionParams;
}

function browserWebSocketImplementation(): typeof WebSocket {
  if (!capturedOptions?.webSocketImpl) throw new Error('webSocketImpl not captured');
  return capturedOptions.webSocketImpl;
}

function parsedMessages(socket: BrowserSocketStub): Array<Record<string, unknown>> {
  return socket.sentMessages.map((message) => JSON.parse(message) as Record<string, unknown>);
}

function messagesOfType(socket: BrowserSocketStub, type: string): Array<Record<string, unknown>> {
  return parsedMessages(socket).filter((message) => message.type === type);
}

beforeEach(() => {
  disposeWsClient();
  vi.clearAllMocks();
  vi.stubGlobal('WebSocket', BrowserSocketStub);
  BrowserSocketStub.instances = [];
  capturedOptions = null;
  getAuthTokenMock.mockResolvedValue('browser-jwe');
  captureAuthCredentialGenerationMock.mockReturnValue(1);
  isAuthCredentialGenerationCurrentMock.mockReturnValue(true);
  ensureFreshTokenMock.mockResolvedValue(true);
  recoverAuthRejectionMock.mockResolvedValue('authenticated');
});

describe('Expo web GraphQL WebSocket auth', () => {
  it('uses the standard two-argument browser WebSocket and memory-only connection params', async () => {
    getWsClient();
    const BrowserAuthWebSocket = browserWebSocketImplementation();

    new BrowserAuthWebSocket('wss://api.test/graphql', 'graphql-transport-ws');

    expect(BrowserSocketStub.instances[0]?.protocols).toBe('graphql-transport-ws');
    await expect(connectionParams()()).resolves.toEqual({ authToken: 'browser-jwe' });
    expect(ensureFreshTokenMock).toHaveBeenCalledTimes(1);
    expect(getAuthTokenMock).toHaveBeenCalledTimes(1);
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
    let releaseRefresh!: (result: WebAuthRecoveryResult) => void;
    recoverAuthRejectionMock.mockReturnValueOnce(
      new Promise<WebAuthRecoveryResult>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    const client = getWsClient();
    const BrowserAuthWebSocket = browserWebSocketImplementation();
    const firstSocket = new BrowserAuthWebSocket('wss://api.test/graphql');
    const secondSocket = new BrowserAuthWebSocket('wss://api.test/graphql');
    const observedCloseCodes: number[] = [];
    firstSocket.onclose = (event) => observedCloseCodes.push(event.code);
    secondSocket.onclose = (event) => observedCloseCodes.push(event.code);

    BrowserSocketStub.instances[0]?.serverClose(4401, 'Unauthorized');
    BrowserSocketStub.instances[1]?.serverClose(4401, 'Unauthorized');

    expect(observedCloseCodes).toEqual([]);
    expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(1);
    expect(getWsClient()).toBe(client);
    expect(disposeSpy).not.toHaveBeenCalled();

    releaseRefresh('authenticated');
    await vi.waitFor(() => expect(observedCloseCodes).toEqual([4403, 4403]));
  });

  it('keeps 4401 recovery isolated between browser credential owners', async () => {
    let currentGeneration = 1;
    captureAuthCredentialGenerationMock.mockImplementation(() => currentGeneration);
    isAuthCredentialGenerationCurrentMock.mockImplementation((generation: number) => generation === currentGeneration);
    let releaseOldRecovery!: (recovered: WebAuthRecoveryResult) => void;
    recoverAuthRejectionMock.mockReturnValueOnce(
      new Promise<WebAuthRecoveryResult>((resolve) => {
        releaseOldRecovery = resolve;
      }),
    );
    getWsClient();
    const BrowserAuthWebSocket = browserWebSocketImplementation();
    const oldSocket = new BrowserAuthWebSocket('wss://api.test/graphql');
    const oldCloseCodes: number[] = [];
    oldSocket.onclose = (event) => oldCloseCodes.push(event.code);
    BrowserSocketStub.instances[0]?.open();
    BrowserSocketStub.instances[0]?.serverClose(4401, 'Unauthorized');
    await vi.waitFor(() => expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(1));

    currentGeneration = 2;
    const newSocket = new BrowserAuthWebSocket('wss://api.test/graphql');
    const newCloseCodes: number[] = [];
    newSocket.onclose = (event) => newCloseCodes.push(event.code);
    BrowserSocketStub.instances[1]?.open();
    BrowserSocketStub.instances[1]?.serverClose(4401, 'Unauthorized');

    await vi.waitFor(() => expect(newCloseCodes).toEqual([4403]));
    expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(2);
    expect(oldCloseCodes).toEqual([]);

    releaseOldRecovery('authenticated');
    await vi.waitFor(() => expect(oldCloseCodes).toEqual([4401]));
  });

  it('rechecks browser credential ownership in the close-delivery continuation', async () => {
    let currentGeneration = 1;
    captureAuthCredentialGenerationMock.mockImplementation(() => currentGeneration);
    isAuthCredentialGenerationCurrentMock.mockImplementation((generation: number) => generation === currentGeneration);
    let releaseRecovery!: (recovered: WebAuthRecoveryResult) => void;
    const pendingRecovery = new Promise<WebAuthRecoveryResult>((resolve) => {
      releaseRecovery = resolve;
    });
    recoverAuthRejectionMock.mockReturnValueOnce(pendingRecovery);
    getWsClient();
    const BrowserAuthWebSocket = browserWebSocketImplementation();
    const socket = new BrowserAuthWebSocket('wss://api.test/graphql');
    const closeCodes: number[] = [];
    socket.onclose = (event) => closeCodes.push(event.code);
    BrowserSocketStub.instances[0]?.open();
    BrowserSocketStub.instances[0]?.serverClose(4401, 'Unauthorized');
    await vi.waitFor(() => expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(1));

    // This reaction runs after the recovery helper resumes, but before its
    // resolved result is delivered to the socket's close continuation.
    void pendingRecovery.then(() => {
      currentGeneration = 2;
    });
    releaseRecovery('authenticated');

    await vi.waitFor(() => expect(closeCodes).toEqual([4401]));
  });

  it('reconnects and resubscribes an active operation after refreshing a rejected token', async () => {
    let releaseRefresh!: (result: WebAuthRecoveryResult) => void;
    recoverAuthRejectionMock.mockReturnValueOnce(
      new Promise<WebAuthRecoveryResult>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    getAuthTokenMock.mockResolvedValueOnce('rejected-jwe').mockResolvedValue('fresh-jwe');
    const singletonBeforeReconnect = getWsClient();

    const subscriptionErrors: unknown[] = [];
    const rawClient = createRawGraphQLWsClient({
      url: 'wss://api.test/graphql',
      webSocketImpl: browserWebSocketImplementation(),
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

    await vi.waitFor(() => expect(BrowserSocketStub.instances).toHaveLength(1));
    const firstSocket = BrowserSocketStub.instances[0];
    if (!firstSocket) throw new Error('first socket was not created');
    firstSocket.open();
    await vi.waitFor(() => expect(messagesOfType(firstSocket, 'connection_init')).toHaveLength(1));
    expect(messagesOfType(firstSocket, 'connection_init')[0]?.payload).toEqual({ authToken: 'rejected-jwe' });
    firstSocket.receive({ type: 'connection_ack' });
    await vi.waitFor(() => expect(messagesOfType(firstSocket, 'subscribe')).toHaveLength(1));

    firstSocket.serverClose(4401, 'Unauthorized');
    await vi.waitFor(() => expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(1));
    expect(BrowserSocketStub.instances).toHaveLength(1);

    releaseRefresh('authenticated');
    await vi.waitFor(() => expect(BrowserSocketStub.instances).toHaveLength(2));
    const secondSocket = BrowserSocketStub.instances[1];
    if (!secondSocket) throw new Error('retry socket was not created');
    secondSocket.open();

    await vi.waitFor(() => expect(messagesOfType(secondSocket, 'connection_init')).toHaveLength(1));
    expect(messagesOfType(secondSocket, 'connection_init')[0]?.payload).toEqual({ authToken: 'fresh-jwe' });
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

  it('keeps a confirmed anonymous 4401 recovery fatal instead of reconnecting', async () => {
    recoverAuthRejectionMock.mockResolvedValueOnce('anonymous');
    getWsClient();
    const rawClient = createRawGraphQLWsClient({
      url: 'wss://api.test/graphql',
      webSocketImpl: browserWebSocketImplementation(),
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

    await vi.waitFor(() => expect(BrowserSocketStub.instances).toHaveLength(1));
    const socket = BrowserSocketStub.instances[0];
    if (!socket) throw new Error('socket was not created');
    socket.open();
    await vi.waitFor(() => expect(messagesOfType(socket, 'connection_init')).toHaveLength(1));
    socket.receive({ type: 'connection_ack' });
    await vi.waitFor(() => expect(messagesOfType(socket, 'subscribe')).toHaveLength(1));

    socket.serverClose(4401, 'Unauthorized');

    await vi.waitFor(() => expect(subscriptionErrors).toHaveLength(1));
    expect(recoverAuthRejectionMock).toHaveBeenCalledTimes(1);
    expect(BrowserSocketStub.instances).toHaveLength(1);
    expect(getAuthTokenMock).toHaveBeenCalledTimes(1);
    await rawClient.dispose();
  });

  it('keeps a 4401 retryable while browser session revalidation is unavailable', async () => {
    recoverAuthRejectionMock.mockResolvedValueOnce('unavailable');
    getWsClient();
    const BrowserAuthWebSocket = browserWebSocketImplementation();
    const socket = new BrowserAuthWebSocket('wss://api.test/graphql');
    const closeCodes: number[] = [];
    socket.onclose = (event) => closeCodes.push(event.code);

    BrowserSocketStub.instances[0]?.open();
    BrowserSocketStub.instances[0]?.serverClose(4401, 'Unauthorized');

    await vi.waitFor(() => expect(closeCodes).toEqual([4403]));
    expect(recoverAuthRejectionMock).toHaveBeenCalledOnce();
  });
});
