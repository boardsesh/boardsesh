import { createGraphQLClient, type Client } from '@boardsesh/graphql-client';
import { reportHandledError } from '../error-reporting';
import { BACKEND_URL } from '../env';
import type { AuthRejectionResult } from '../auth-rejection-result';

/**
 * Platform seam for the GraphQL-WS transport. Native and web differ only in how
 * the underlying socket is constructed (React Native suppresses its Origin
 * header) and which auth-store / auth-interceptor fork supplies these
 * credential helpers. Everything else — the 4401→4403 remap, single-flight
 * credential recovery, the connection_init gate, and the singleton lifecycle —
 * lives in `createWsClientModule` so a fix to the security-sensitive recovery
 * path lands once.
 */
export type WsClientDeps = {
  createSocket: (url: string | URL, protocols?: string | string[]) => WebSocket;
  captureAuthCredentialGeneration: () => number;
  getAuthToken: () => Promise<string | null>;
  isAuthCredentialGenerationCurrent: (generation: number) => boolean;
  ensureFreshToken: () => Promise<boolean>;
  recoverAuthRejection: () => Promise<AuthRejectionResult>;
};

export type WsClientModule = {
  getWsClient: () => Client;
  disposeWsClient: () => void;
};

export function createWsClientModule(deps: WsClientDeps): WsClientModule {
  const {
    createSocket,
    captureAuthCredentialGeneration,
    getAuthToken,
    isAuthCredentialGenerationCurrent,
    ensureFreshToken,
    recoverAuthRejection,
  } = deps;

  function getWsUrl(): string {
    const configuredUrl = process.env.EXPO_PUBLIC_WS_URL;
    if (configuredUrl) return configuredUrl;

    return BACKEND_URL.replace(/^http(s?):\/\//, 'ws$1://') + '/graphql';
  }

  const AUTH_REJECTED_CLOSE_CODE = 4401;
  // graphql-ws treats 4401 as fatal before invoking shouldRetry. 4403 is not in
  // its fatal-code list, so exposing the rejected handshake as 4403 lets active
  // operations run through graphql-ws' normal reconnect and resubscribe loop.
  const AUTH_REFRESH_RETRY_CLOSE_CODE = 4403;

  let authRecovery: { generation: number; promise: Promise<AuthRejectionResult> } | null = null;

  function recoverRejectedAuthentication(generation: number): Promise<AuthRejectionResult> {
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
   * Translates rejected-auth closes at the transport boundary. Composition is
   * intentional: graphql-ws owns the public handlers, while the underlying
   * socket (built by the platform's `createSocket`) always routes through ours.
   */
  class AuthAwareWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly CONNECTING = AuthAwareWebSocket.CONNECTING;
    readonly OPEN = AuthAwareWebSocket.OPEN;
    readonly CLOSING = AuthAwareWebSocket.CLOSING;
    readonly CLOSED = AuthAwareWebSocket.CLOSED;

    onopen: WebSocket['onopen'] = null;
    onmessage: WebSocket['onmessage'] = null;
    onerror: WebSocket['onerror'] = null;
    onclose: WebSocket['onclose'] = null;

    private readonly socket: WebSocket;
    private credentialGeneration = captureAuthCredentialGeneration();

    constructor(url: string | URL, protocols?: string | string[]) {
      this.socket = createSocket(url, protocols);
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
          const canRetry =
            recoveryResult === 'refreshed' || recoveryResult === 'authenticated' || recoveryResult === 'unavailable';
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

  function getWsClient(): Client {
    if (!wsClient) {
      wsClient = createGraphQLClient({
        url: getWsUrl(),
        webSocketImpl: AuthAwareWebSocket as unknown as typeof WebSocket,
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

  function disposeWsClient(): void {
    if (!wsClient) return;
    void wsClient.dispose();
    wsClient = null;
  }

  return { getWsClient, disposeWsClient };
}
