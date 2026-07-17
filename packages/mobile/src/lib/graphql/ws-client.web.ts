import { createGraphQLClient, type Client } from '@boardsesh/graphql-client';
import { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } from '../auth-store.web';
import { ensureFreshToken, recoverAuthRejection, type WebAuthRejectionResult } from '../auth-interceptor.web';
import { reportHandledError } from '../error-reporting';
import { BACKEND_URL } from '../env';

function getWsUrl(): string {
  const configuredUrl = process.env.EXPO_PUBLIC_WS_URL;
  if (configuredUrl) return configuredUrl;
  return BACKEND_URL.replace(/^http(s?):\/\//, 'ws$1://') + '/graphql';
}

const AUTH_REJECTED_CLOSE_CODE = 4401;
// graphql-ws marks 4401 as fatal before it asks shouldRetry. 4403 is retryable,
// so remapping at the socket boundary preserves active operations and lets the
// existing singleton reconnect and resubscribe after refreshing credentials.
const AUTH_REFRESH_RETRY_CLOSE_CODE = 4403;

let authRecovery: { generation: number; promise: Promise<WebAuthRejectionResult> } | null = null;

function recoverRejectedAuthentication(generation: number): Promise<WebAuthRejectionResult> {
  if (!isAuthCredentialGenerationCurrent(generation)) return Promise.resolve('superseded');
  if (authRecovery?.generation === generation) return authRecovery.promise;

  const recoveryPromise = (async () => {
    try {
      const result = await recoverAuthRejection();
      return isAuthCredentialGenerationCurrent(generation) ? result : 'superseded';
    } catch (error) {
      reportHandledError(error);
      return isAuthCredentialGenerationCurrent(generation) ? 'unavailable' : 'superseded';
    }
  })();

  authRecovery = { generation, promise: recoveryPromise };
  void recoveryPromise.finally(() => {
    if (authRecovery?.promise === recoveryPromise) authRecovery = null;
  });
  return recoveryPromise;
}

function retryableAuthCloseEvent(closeEvent: CloseEvent): CloseEvent {
  return {
    code: AUTH_REFRESH_RETRY_CLOSE_CODE,
    reason: closeEvent.reason,
    wasClean: closeEvent.wasClean,
  } as CloseEvent;
}

class BrowserAuthWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = BrowserAuthWebSocket.CONNECTING;
  readonly OPEN = BrowserAuthWebSocket.OPEN;
  readonly CLOSING = BrowserAuthWebSocket.CLOSING;
  readonly CLOSED = BrowserAuthWebSocket.CLOSED;

  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onerror: WebSocket['onerror'] = null;
  onclose: WebSocket['onclose'] = null;

  private readonly socket: WebSocket;
  private credentialGeneration = captureAuthCredentialGeneration();

  constructor(url: string | URL, protocols?: string | string[]) {
    this.socket = new WebSocket(url, protocols);
    this.socket.onopen = (event) => {
      this.credentialGeneration = captureAuthCredentialGeneration();
      this.onopen?.call(this as unknown as WebSocket, event);
    };
    this.socket.onmessage = (event) => this.onmessage?.call(this as unknown as WebSocket, event);
    this.socket.onerror = (event) => this.onerror?.call(this as unknown as WebSocket, event);
    this.socket.onclose = (event) => {
      if (event.code !== AUTH_REJECTED_CLOSE_CODE) {
        this.onclose?.call(this as unknown as WebSocket, event);
        return;
      }
      const rejectedGeneration = this.credentialGeneration;
      void recoverRejectedAuthentication(rejectedGeneration).then((recoveryResult) => {
        // Keep the ownership check and close delivery in one synchronous
        // continuation. A login queued at recovery completion must not turn an
        // old socket's fatal close into a retry under the new account.
        const canRetry = recoveryResult === 'authenticated' || recoveryResult === 'unavailable';
        const deliveredEvent =
          canRetry && isAuthCredentialGenerationCurrent(rejectedGeneration) ? retryableAuthCloseEvent(event) : event;
        this.onclose?.call(this as unknown as WebSocket, deliveredEvent);
      });
    };
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get url(): string {
    return this.socket.url;
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  get extensions(): string {
    return this.socket.extensions;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  get binaryType(): BinaryType {
    return this.socket.binaryType;
  }

  set binaryType(binaryType: BinaryType) {
    this.socket.binaryType = binaryType;
  }

  send(data: Parameters<WebSocket['send']>[0]): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

let wsClient: Client | null = null;

export function getWsClient(): Client {
  if (!wsClient) {
    wsClient = createGraphQLClient({
      url: getWsUrl(),
      // Browsers only support the standard two-argument WebSocket constructor.
      // The native client has a separate fork that suppresses its Origin header.
      webSocketImpl: BrowserAuthWebSocket as unknown as typeof WebSocket,
      connectionParams: async () => {
        const credentialGeneration = captureAuthCredentialGeneration();
        if (authRecovery?.generation === credentialGeneration) await authRecovery.promise;
        if (!isAuthCredentialGenerationCurrent(credentialGeneration)) {
          throw new Error('Authentication session changed before the WebSocket handshake');
        }
        await ensureFreshToken();
        if (!isAuthCredentialGenerationCurrent(credentialGeneration)) {
          throw new Error('Authentication session changed before the WebSocket handshake');
        }
        const token = await getAuthToken();
        if (!isAuthCredentialGenerationCurrent(credentialGeneration)) {
          throw new Error('Authentication session changed before the WebSocket handshake');
        }
        return token ? { authToken: token } : {};
      },
    });
  }
  return wsClient;
}

export function disposeWsClient(): void {
  if (!wsClient) return;
  void wsClient.dispose();
  wsClient = null;
}
