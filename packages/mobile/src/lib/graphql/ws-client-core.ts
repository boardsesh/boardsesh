import { createGraphQLClient, type Client } from '@boardsesh/graphql-client';
import { reportHandledError } from '../error-reporting';
import { BACKEND_URL } from '../env';
import { BackendUnavailableError } from '../connectivity/backend-unavailable-error';
import type { AuthRejectionResult } from '../auth-rejection-result';
import { AUTH_REFRESH_RETRY_CLOSE_CODE, AUTH_REJECTED_CLOSE_CODE } from './ws-close-codes';

/**
 * An async iterator that rejects on the first pull. `iterate()` is the pull-based
 * twin of `subscribe()`, and the inert client has to answer both the same way.
 * Written as a plain object rather than an `async function*` so it needs no
 * unreachable `yield` to satisfy the linter.
 */
function createOfflineModeIterator(): AsyncIterableIterator<never> {
  const iterator: AsyncIterableIterator<never> = {
    [Symbol.asyncIterator]: () => iterator,
    next: () => Promise.reject(new BackendUnavailableError('offline_mode')),
  };
  return iterator;
}

/**
 * The client `getWsClient()` hands out while the climber's offline-mode switch
 * is on (issue #4862) — a `Client`-shaped object that opens no socket and holds
 * no state.
 *
 * This is what makes "offline mode talks to no server" true for the WebSocket
 * half. `ConnectivityBridge`'s `disposeWsClient()` is a CUT: it drops the cached
 * client, but the next `getWsClient()` would build a fresh one, and plenty of
 * callers reach the socket without a connectivity gate of their own — the
 * drawer host restoring a stored active board on a cold launch, the BLE
 * auto-connect bind, a party-queue mutation. Gating the FACTORY catches all of
 * them at once, so no caller has to remember.
 *
 * Every operation fails the way PR-A's HTTP chokepoint already does: a fresh
 * `BackendUnavailableError('offline_mode')`, which the shared classifier reads
 * as a transport-class stop (drainer-safe: no `retry_count` strike), which
 * `reportHandledError` drops, and which React Query refuses to retry. Fresh per
 * call so each rejection carries its own stack.
 *
 * Stateless, so ONE instance is enough — and it is deliberately never assigned
 * to `wsClient`, or turning offline mode back off would hand out a dead client
 * for the rest of the launch.
 */
const OFFLINE_MODE_CLIENT: Client = {
  on: () => () => {},
  subscribe: (_payload, sink) => {
    sink.error(new BackendUnavailableError('offline_mode'));
    return () => {};
  },
  iterate: () => createOfflineModeIterator(),
  terminate: () => {},
  dispose: () => {},
};

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
  /**
   * Is the climber's deliberate offline-mode switch on? Read per call, never
   * captured, so the answer follows the store rather than the launch.
   *
   * `offlineMode` ONLY — not `effectiveOffline`. A tunnel or a backend blip must
   * keep graphql-ws's own retry ladder, which recovers a live subscription
   * without anyone re-subscribing; swapping in the inert client there would kill
   * the party session on every lift. Offline mode is deliberate and sticky, and
   * the climber asked for exactly this.
   *
   * Native reads the connectivity store; Expo web has no offline-mode surface
   * and passes `() => false`.
   */
  isOfflineModeOn: () => boolean;
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
    isOfflineModeOn,
  } = deps;

  function getWsUrl(): string {
    const configuredUrl = process.env.EXPO_PUBLIC_WS_URL;
    if (configuredUrl) return configuredUrl;

    return BACKEND_URL.replace(/^http(s?):\/\//, 'ws$1://') + '/graphql';
  }

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

    // graphql-ws drives this socket exclusively through the on* handlers above,
    // so nothing calls these EventTarget methods today. Forward them to the
    // underlying socket anyway: a future graphql-ws that switched to
    // addEventListener would otherwise silently lose every event on this shim.
    // The 4401→4403 remap lives only on the `onclose` property path — a 'close'
    // listener registered here sees the underlying socket's raw code (a
    // deliberate, documented tradeoff, since graphql-ws does not use this path).
    addEventListener(...args: Parameters<WebSocket['addEventListener']>): void {
      this.socket.addEventListener(...args);
    }

    removeEventListener(...args: Parameters<WebSocket['removeEventListener']>): void {
      this.socket.removeEventListener(...args);
    }
  }

  let wsClient: Client | null = null;

  function getWsClient(): Client {
    // The one chokepoint. Handing back the inert client — rather than building
    // or reusing the real one — is what stops a socket being opened by a caller
    // that has no offline gate of its own. Checked on every call and never
    // cached, so the first call after the switch goes off gets a real client.
    if (isOfflineModeOn()) return OFFLINE_MODE_CLIENT;
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
    const client = wsClient;
    wsClient = null;
    void (async () => {
      try {
        await client.dispose();
      } catch {
        // Suppress: dispose errors are non-fatal. The socket is being torn down
        // and these rejections carry no actionable information (graphql-ws
        // rejects with the raw closing Event/CloseEvent, not an Error).
      }
    })();
  }

  return { getWsClient, disposeWsClient };
}
