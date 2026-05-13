const OBS_RPC_VERSION = 1;
const OP_HELLO = 0;
const OP_IDENTIFY = 1;
const OP_IDENTIFIED = 2;
const OP_EVENT = 5;
const OP_REQUEST = 6;
const OP_REQUEST_RESPONSE = 7;
const DEFAULT_TIMEOUT_MS = 10000;
const OBS_EVENT_SUBSCRIPTION_OUTPUTS = 1 << 6;

type ObsWebSocketMessage<T = unknown> = {
  op: number;
  d?: T;
};

type ObsHelloData = {
  rpcVersion?: number;
  authentication?: {
    challenge: string;
    salt: string;
  };
};

type ObsRequestStatus = {
  result: boolean;
  code?: number;
  comment?: string;
};

type ObsRequestResponse<T = unknown> = {
  requestType: string;
  requestId: string;
  requestStatus: ObsRequestStatus;
  responseData?: T;
};

type ObsEventData = {
  eventType?: string;
  eventData?: Record<string, unknown>;
};

export type ObsRecordStateChangedEvent = {
  outputActive?: boolean;
  outputState?: string;
};

type PendingRequest = {
  requestType: string;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type ObsWebSocketConstructor = {
  new (url: string): WebSocket;
  readonly OPEN: number;
};

export type ObsWebSocketClientErrorCode =
  | 'base64Unavailable'
  | 'webCryptoUnavailable'
  | 'websocketUnavailable'
  | 'connectTimeout'
  | 'connectFailed'
  | 'websocketClosed'
  | 'disconnected'
  | 'identifyTimeout'
  | 'connectionFailed'
  | 'websocketError'
  | 'unsupportedMessage'
  | 'invalidJson'
  | 'notConnected'
  | 'notOpen'
  | 'requestTimeout';

export type ObsWebSocketClientOptions = {
  WebSocketCtor?: ObsWebSocketConstructor;
  timeoutMs?: number;
  onRecordStateChanged?: (event: ObsRecordStateChangedEvent) => void;
  onDisconnected?: () => void;
};

export type StopRecordingResponse = {
  outputPath?: string;
};

export class ObsWebSocketClientError extends Error {
  constructor(
    readonly code: ObsWebSocketClientErrorCode,
    message: string,
    readonly requestType?: string,
  ) {
    super(message);
    this.name = 'ObsWebSocketClientError';
  }
}

export class ObsWebSocketRequestError extends Error {
  constructor(
    message: string,
    readonly requestType: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'ObsWebSocketRequestError';
  }
}

const bytesToBase64 = (bytes: Uint8Array) => {
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  const maybeBuffer = (
    globalThis as typeof globalThis & {
      Buffer?: { from: (input: Uint8Array) => { toString: (encoding: 'base64') => string } };
    }
  ).Buffer;

  if (maybeBuffer) {
    return maybeBuffer.from(bytes).toString('base64');
  }

  throw new ObsWebSocketClientError('base64Unavailable', 'Base64 encoding is not available in this browser');
};

const sha256Base64 = async (value: string) => {
  if (!globalThis.crypto?.subtle) {
    throw new ObsWebSocketClientError(
      'webCryptoUnavailable',
      'OBS password authentication requires Web Crypto support',
    );
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(digest));
};

export const createObsAuthentication = async (password: string, salt: string, challenge: string) => {
  const secret = await sha256Base64(`${password}${salt}`);
  return sha256Base64(`${secret}${challenge}`);
};

const createRequestId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `boardsesh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export class ObsWebSocketClient {
  private readonly WebSocketCtor: ObsWebSocketConstructor;
  private readonly timeoutMs: number;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private identified = false;
  private identifyResolve: (() => void) | null = null;
  private identifyReject: ((reason?: unknown) => void) | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();

  constructor(
    private readonly url: string,
    private readonly password?: string | null,
    private readonly options: ObsWebSocketClientOptions = {},
  ) {
    const WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new ObsWebSocketClientError('websocketUnavailable', 'WebSocket is not available in this browser');
    }
    this.WebSocketCtor = WebSocketCtor;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get isConnected() {
    return this.identified && this.socket?.readyState === this.WebSocketCtor.OPEN;
  }

  async connect() {
    if (this.isConnected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.openAndIdentify().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  disconnect() {
    this.identified = false;
    this.identifyReject?.(new ObsWebSocketClientError('disconnected', 'Disconnected from OBS'));
    this.identifyResolve = null;
    this.identifyReject = null;
    this.rejectPendingRequests(new ObsWebSocketClientError('disconnected', 'Disconnected from OBS'));
    this.cleanupSocket(this.socket);
  }

  startRecording() {
    return this.request('StartRecord');
  }

  stopRecording() {
    return this.request<StopRecordingResponse>('StopRecord');
  }

  setInputSettings(inputName: string, inputSettings: Record<string, unknown>, overlay = true) {
    return this.request('SetInputSettings', {
      inputName,
      inputSettings,
      overlay,
    });
  }

  private async openAndIdentify() {
    this.identified = false;

    const socket = new this.WebSocketCtor(this.url);
    this.socket = socket;
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
    socket.addEventListener('error', this.handleError);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          cleanup();
          reject(new ObsWebSocketClientError('connectTimeout', 'Timed out connecting to OBS websocket'));
        }, this.timeoutMs);
        const handleOpen = () => {
          cleanup();
          resolve();
        };
        const handleError = () => {
          cleanup();
          reject(new ObsWebSocketClientError('connectFailed', 'Could not connect to OBS websocket'));
        };
        const handleClose = () => {
          cleanup();
          reject(new ObsWebSocketClientError('websocketClosed', 'OBS websocket closed'));
        };
        const cleanup = () => {
          clearTimeout(timeoutId);
          socket.removeEventListener('open', handleOpen);
          socket.removeEventListener('error', handleError);
          socket.removeEventListener('close', handleClose);
        };

        socket.addEventListener('open', handleOpen);
        socket.addEventListener('error', handleError);
        socket.addEventListener('close', handleClose);
      });

      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.identifyResolve = null;
          this.identifyReject = null;
          this.cleanupSocket(socket);
          reject(new ObsWebSocketClientError('identifyTimeout', 'Timed out identifying with OBS websocket'));
        }, this.timeoutMs);

        this.identifyResolve = () => {
          clearTimeout(timeoutId);
          resolve();
        };
        this.identifyReject = (reason?: unknown) => {
          clearTimeout(timeoutId);
          reject(reason);
        };
      });
    } catch (error) {
      this.identified = false;
      this.identifyResolve = null;
      this.identifyReject = null;
      this.rejectPendingRequests(
        error instanceof Error
          ? error
          : new ObsWebSocketClientError('connectionFailed', 'OBS websocket connection failed'),
      );
      this.cleanupSocket(socket);
      throw error;
    }
  }

  private cleanupSocket(socket: WebSocket | null) {
    if (!socket) return;

    if (this.socket === socket) {
      this.socket = null;
    }

    socket.removeEventListener('message', this.handleMessage);
    socket.removeEventListener('close', this.handleClose);
    socket.removeEventListener('error', this.handleError);
    if (socket.readyState < 2) {
      socket.close();
    }
  }

  private readonly handleMessage = (event: MessageEvent) => {
    void this.handleMessageData(event.data).catch((error) => {
      this.identifyReject?.(error);
      this.rejectPendingRequests(error);
    });
  };

  private readonly handleClose = () => {
    const socket = this.socket;
    const error = new ObsWebSocketClientError('websocketClosed', 'OBS websocket closed');
    this.identified = false;
    this.identifyReject?.(error);
    this.identifyResolve = null;
    this.identifyReject = null;
    this.rejectPendingRequests(error);
    this.options.onRecordStateChanged?.({ outputActive: false });
    this.options.onDisconnected?.();
    this.cleanupSocket(socket);
  };

  private readonly handleError = () => {
    const error = new ObsWebSocketClientError('websocketError', 'OBS websocket error');
    this.identifyReject?.(error);
    this.identifyResolve = null;
    this.identifyReject = null;
    this.rejectPendingRequests(error);
    this.options.onRecordStateChanged?.({ outputActive: false });
    this.options.onDisconnected?.();
    this.cleanupSocket(this.socket);
  };

  private async handleMessageData(data: unknown) {
    const message = this.parseMessage(data);

    if (message.op === OP_HELLO) {
      await this.identify(message.d as ObsHelloData | undefined);
      return;
    }

    if (message.op === OP_IDENTIFIED) {
      this.identified = true;
      this.identifyResolve?.();
      this.identifyResolve = null;
      this.identifyReject = null;
      return;
    }

    if (message.op === OP_REQUEST_RESPONSE) {
      this.handleRequestResponse(message.d as ObsRequestResponse | undefined);
      return;
    }

    if (message.op === OP_EVENT) {
      this.handleEvent(message.d as ObsEventData | undefined);
    }
  }

  private parseMessage(data: unknown): ObsWebSocketMessage {
    if (typeof data !== 'string') {
      throw new ObsWebSocketClientError('unsupportedMessage', 'OBS websocket sent an unsupported message');
    }

    try {
      return JSON.parse(data) as ObsWebSocketMessage;
    } catch {
      throw new ObsWebSocketClientError('invalidJson', 'OBS websocket sent invalid JSON');
    }
  }

  private async identify(hello?: ObsHelloData) {
    const authentication = hello?.authentication
      ? await createObsAuthentication(this.password ?? '', hello.authentication.salt, hello.authentication.challenge)
      : undefined;

    this.send({
      op: OP_IDENTIFY,
      d: {
        rpcVersion: OBS_RPC_VERSION,
        authentication,
        eventSubscriptions: OBS_EVENT_SUBSCRIPTION_OUTPUTS,
      },
    });
  }

  private request<T = unknown>(requestType: string, requestData?: Record<string, unknown>) {
    if (!this.isConnected) {
      return Promise.reject(new ObsWebSocketClientError('notConnected', 'OBS is not connected'));
    }

    const requestId = createRequestId();

    const promise = new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new ObsWebSocketClientError('requestTimeout', `${requestType} timed out`, requestType));
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, {
        requestType,
        timeoutId,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });

    try {
      this.send({
        op: OP_REQUEST,
        d: {
          requestType,
          requestId,
          requestData,
        },
      });
    } catch (error) {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(requestId);
        pending.reject(error);
      }
    }

    return promise;
  }

  private handleRequestResponse(response?: ObsRequestResponse) {
    if (!response?.requestId) return;

    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) return;

    this.pendingRequests.delete(response.requestId);
    clearTimeout(pending.timeoutId);

    if (!response.requestStatus?.result) {
      pending.reject(
        new ObsWebSocketRequestError(
          response.requestStatus?.comment || `${pending.requestType} failed`,
          pending.requestType,
          response.requestStatus?.code,
        ),
      );
      return;
    }

    pending.resolve(response.responseData ?? {});
  }

  private handleEvent(event?: ObsEventData) {
    if (event?.eventType !== 'RecordStateChanged') return;

    this.options.onRecordStateChanged?.({
      outputActive: typeof event.eventData?.outputActive === 'boolean' ? event.eventData.outputActive : undefined,
      outputState: typeof event.eventData?.outputState === 'string' ? event.eventData.outputState : undefined,
    });
  }

  private send(message: ObsWebSocketMessage) {
    if (!this.socket || this.socket.readyState !== this.WebSocketCtor.OPEN) {
      throw new ObsWebSocketClientError('notOpen', 'OBS websocket is not open');
    }

    this.socket.send(JSON.stringify(message));
  }

  private rejectPendingRequests(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

export const getObsErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return '';
};
