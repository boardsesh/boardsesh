import { createGraphQLClient, type Client } from '@boardsesh/graphql-client';
import { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } from '../auth-store';
import { ensureFreshToken, recoverAuthRejection, type NativeAuthRejectionResult } from '../auth-interceptor';
import { reportHandledError } from '../error-reporting';
import { BACKEND_URL } from '../env';

function getWsUrl(): string {
  const wsUrl = process.env.EXPO_PUBLIC_WS_URL;
  if (wsUrl) return wsUrl;

  return BACKEND_URL.replace(/^http(s?):\/\//, 'ws$1://') + '/graphql';
}

// React Native's WebSocket derives an `Origin` header from the JS bundle
// URL (e.g. `http://localhost:8084` in dev). The backend's `verifyClient`
// (packages/backend/src/handlers/cors.ts:140-149) rejects any Origin not
// on the allowlist with HTTP 403, killing the upgrade before any GraphQL
// op can run. The same handler intentionally allows requests with no
// Origin header so native apps can connect — RN just doesn't take that
// branch by default. Pass an empty `origin` via RN's 3rd-arg options to
// drop the header. The DOM `WebSocket` type doesn't expose this arg, so
// cast through a local alias.
type RNWebSocketCtor = new (
  url: string | URL,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

const AUTH_REJECTED_CLOSE_CODE = 4401;
// graphql-ws treats 4401 as fatal before invoking shouldRetry. 4403 is not in
// its fatal-code list, so exposing the rejected handshake as 4403 lets active
// operations run through graphql-ws' normal reconnect and resubscribe loop.
const AUTH_REFRESH_RETRY_CLOSE_CODE = 4403;

let authRecovery: { generation: number; promise: Promise<NativeAuthRejectionResult> } | null = null;

function recoverRejectedAuthentication(generation: number): Promise<NativeAuthRejectionResult> {
  if (!isAuthCredentialGenerationCurrent(generation)) return Promise.resolve('superseded');
  if (authRecovery?.generation === generation) return authRecovery.promise;

  const recoveryPromise = (async () => {
    try {
      // The server may reject a revoked token that has not expired yet, so this
      // must bypass ensureFreshToken's expiry gate.
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

/**
 * Adds React Native's no-Origin option and translates rejected-auth closes at
 * the transport boundary. Composition is intentional: graphql-ws owns the
 * public handlers, while the underlying socket always routes through ours.
 */
class NativeAppWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = NativeAppWebSocket.CONNECTING;
  readonly OPEN = NativeAppWebSocket.OPEN;
  readonly CLOSING = NativeAppWebSocket.CLOSING;
  readonly CLOSED = NativeAppWebSocket.CLOSED;

  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onerror: WebSocket['onerror'] = null;
  onclose: WebSocket['onclose'] = null;

  private readonly socket: WebSocket;
  private credentialGeneration = captureAuthCredentialGeneration();

  constructor(url: string | URL, protocols?: string | string[]) {
    const ReactNativeWebSocket = WebSocket as unknown as RNWebSocketCtor;
    this.socket = new ReactNativeWebSocket(url, protocols, { headers: { origin: '' } });
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
        const canRetry = recoveryResult === 'refreshed' || recoveryResult === 'unavailable';
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
      webSocketImpl: NativeAppWebSocket as unknown as typeof WebSocket,
      connectionParams: async () => {
        const credentialGeneration = captureAuthCredentialGeneration();
        // A retry created by a 4401 can open before the token refresh finishes.
        // Hold connection_init until the forced refresh has settled so the
        // reconnect cannot present the rejected token again.
        if (authRecovery?.generation === credentialGeneration) await authRecovery.promise;
        if (!isAuthCredentialGenerationCurrent(credentialGeneration)) {
          throw new Error('Authentication session changed before the WebSocket handshake');
        }
        // Refresh a soon-to-expire token before the handshake, matching the
        // HTTP path's up-front ensureFreshToken() in authenticatedFetch.
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
  if (wsClient) {
    void wsClient.dispose();
    wsClient = null;
  }
}
