import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createObsAuthentication,
  ObsWebSocketClient,
  type ObsWebSocketClientOptions,
  ObsWebSocketRequestError,
} from '../obs-websocket-client';

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static OPEN = 1;
  static last: FakeWebSocket | null = null;

  readyState = 0;
  closeCount = 0;
  sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.last = this;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open', {});
    });
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.closeCount += 1;
    this.readyState = 3;
    this.emit('close', {});
  }

  emitMessage(payload: unknown) {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  emitClose() {
    this.readyState = 3;
    this.emit('close', {});
  }

  emitError() {
    this.emit('error', {});
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const createClient = (password?: string, options: Omit<ObsWebSocketClientOptions, 'WebSocketCtor'> = {}) =>
  new ObsWebSocketClient('ws://127.0.0.1:4455', password, {
    WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    ...options,
  });

const connectClient = async (password?: string, options?: Omit<ObsWebSocketClientOptions, 'WebSocketCtor'>) => {
  const client = createClient(password, options);

  const connectPromise = client.connect();
  await flush();
  FakeWebSocket.last?.emitMessage({ op: 0, d: { rpcVersion: 1 } });
  await flush();
  FakeWebSocket.last?.emitMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });
  await connectPromise;

  return client;
};

const getExpectedAuthentication = (password: string, salt: string, challenge: string) => {
  const secret = createHash('sha256').update(`${password}${salt}`).digest('base64');
  return createHash('sha256').update(`${secret}${challenge}`).digest('base64');
};

describe('ObsWebSocketClient', () => {
  beforeEach(() => {
    FakeWebSocket.last = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('identifies with OBS after the hello message', async () => {
    const client = await connectClient();

    expect(client.isConnected).toBe(true);
    expect(FakeWebSocket.last?.url).toBe('ws://127.0.0.1:4455');
    expect(FakeWebSocket.last?.sent[0]).toEqual({
      op: 1,
      d: {
        rpcVersion: 1,
        eventSubscriptions: 64,
      },
    });
  });

  it('includes OBS authentication when the server challenges the connection', async () => {
    const client = createClient('password');
    const connectPromise = client.connect();

    await flush();
    FakeWebSocket.last?.emitMessage({
      op: 0,
      d: {
        rpcVersion: 1,
        authentication: {
          salt: 'salt',
          challenge: 'challenge',
        },
      },
    });
    await flush();
    await flush();
    await flush();

    expect(FakeWebSocket.last?.sent[0]).toEqual({
      op: 1,
      d: {
        rpcVersion: 1,
        authentication: getExpectedAuthentication('password', 'salt', 'challenge'),
        eventSubscriptions: 64,
      },
    });

    FakeWebSocket.last?.emitMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });
    await connectPromise;
    expect(client.isConnected).toBe(true);
  });

  it('sends requests and resolves responses by request id', async () => {
    const client = await connectClient();

    const startPromise = client.startRecording();
    const startRequest = FakeWebSocket.last?.sent[1] as {
      op: number;
      d: { requestType: string; requestId: string };
    };

    expect(startRequest.op).toBe(6);
    expect(startRequest.d.requestType).toBe('StartRecord');

    FakeWebSocket.last?.emitMessage({
      op: 7,
      d: {
        requestType: 'StartRecord',
        requestId: startRequest.d.requestId,
        requestStatus: { result: true, code: 100 },
        responseData: {},
      },
    });
    await expect(startPromise).resolves.toEqual({});

    const stopPromise = client.stopRecording();
    const stopRequest = FakeWebSocket.last?.sent[2] as {
      d: { requestType: string; requestId: string };
    };

    expect(stopRequest.d.requestType).toBe('StopRecord');

    FakeWebSocket.last?.emitMessage({
      op: 7,
      d: {
        requestType: 'StopRecord',
        requestId: stopRequest.d.requestId,
        requestStatus: { result: true, code: 100 },
        responseData: { outputPath: '/videos/climb.mp4' },
      },
    });

    await expect(stopPromise).resolves.toEqual({ outputPath: '/videos/climb.mp4' });
  });

  it('serializes text-source settings updates as SetInputSettings requests', async () => {
    const client = await connectClient();

    const settingsPromise = client.setInputSettings('Boardsesh Climb Overlay', { text: 'Moon Ladder' }, true);
    const settingsRequest = FakeWebSocket.last?.sent[1] as {
      op: number;
      d: {
        requestType: string;
        requestId: string;
        requestData: {
          inputName: string;
          inputSettings: { text: string };
          overlay: boolean;
        };
      };
    };

    expect(settingsRequest).toMatchObject({
      op: 6,
      d: {
        requestType: 'SetInputSettings',
        requestData: {
          inputName: 'Boardsesh Climb Overlay',
          inputSettings: { text: 'Moon Ladder' },
          overlay: true,
        },
      },
    });

    FakeWebSocket.last?.emitMessage({
      op: 7,
      d: {
        requestType: 'SetInputSettings',
        requestId: settingsRequest.d.requestId,
        requestStatus: { result: true, code: 100 },
        responseData: {},
      },
    });
    await expect(settingsPromise).resolves.toEqual({});
  });

  it('rejects failed request responses with the OBS comment and code', async () => {
    const client = await connectClient();

    const startPromise = client.startRecording();
    const startRequest = FakeWebSocket.last?.sent[1] as {
      d: { requestType: string; requestId: string };
    };

    FakeWebSocket.last?.emitMessage({
      op: 7,
      d: {
        requestType: 'StartRecord',
        requestId: startRequest.d.requestId,
        requestStatus: { result: false, code: 601, comment: 'Already recording' },
      },
    });

    await expect(startPromise).rejects.toMatchObject({
      name: 'ObsWebSocketRequestError',
      message: 'Already recording',
      requestType: 'StartRecord',
      code: 601,
    } satisfies Partial<ObsWebSocketRequestError>);
  });

  it('rejects pending requests when the socket closes', async () => {
    const client = await connectClient();

    const stopPromise = client.stopRecording();
    FakeWebSocket.last?.emitClose();

    await expect(stopPromise).rejects.toThrow('OBS websocket closed');
    expect(client.isConnected).toBe(false);
  });

  it('reports inactive recording state when the socket closes unexpectedly', async () => {
    const onRecordStateChanged = vi.fn();
    const onDisconnected = vi.fn();
    const client = await connectClient(undefined, { onRecordStateChanged, onDisconnected });

    FakeWebSocket.last?.emitClose();

    expect(client.isConnected).toBe(false);
    expect(onRecordStateChanged).toHaveBeenCalledWith({ outputActive: false });
    expect(onDisconnected).toHaveBeenCalled();
  });

  it('cleans up the socket when OBS emits an error', async () => {
    const onRecordStateChanged = vi.fn();
    const onDisconnected = vi.fn();
    const client = await connectClient(undefined, { onRecordStateChanged, onDisconnected });

    FakeWebSocket.last?.emitError();

    expect(client.isConnected).toBe(false);
    expect(FakeWebSocket.last?.closeCount).toBe(1);
    expect(onRecordStateChanged).toHaveBeenCalledWith({ outputActive: false });
    expect(onDisconnected).toHaveBeenCalled();
  });

  it('forwards RecordStateChanged events', async () => {
    const onRecordStateChanged = vi.fn();
    await connectClient(undefined, { onRecordStateChanged });

    FakeWebSocket.last?.emitMessage({
      op: 5,
      d: {
        eventType: 'RecordStateChanged',
        eventData: {
          outputActive: true,
          outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
        },
      },
    });

    expect(onRecordStateChanged).toHaveBeenCalledWith({
      outputActive: true,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
    });
  });

  it('rejects requests that do not receive a response before the timeout', async () => {
    const client = await connectClient(undefined, { timeoutMs: 25 });

    vi.useFakeTimers();
    const startPromise = client.startRecording();
    vi.advanceTimersByTime(25);

    await expect(startPromise).rejects.toThrow('StartRecord timed out');
  });

  it('closes the socket when identify times out', async () => {
    vi.useFakeTimers();
    const client = createClient(undefined, { timeoutMs: 25 });

    const connectPromise = client.connect();
    await Promise.resolve();
    FakeWebSocket.last?.emitMessage({ op: 0, d: { rpcVersion: 1 } });
    await Promise.resolve();

    vi.advanceTimersByTime(25);

    await expect(connectPromise).rejects.toThrow('Timed out identifying with OBS websocket');
    expect(FakeWebSocket.last?.closeCount).toBe(1);
    expect(client.isConnected).toBe(false);
  });

  it('matches the obs-websocket authentication hash', async () => {
    await expect(createObsAuthentication('password', 'salt', 'challenge')).resolves.toBe(
      getExpectedAuthentication('password', 'salt', 'challenge'),
    );
  });
});
