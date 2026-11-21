import {
  createGraphQLClient as createSharedGraphQLClient,
  type BaseClientOptions,
  type ExtendedClient,
} from '@boardsesh/graphql-client';
import { CLIENT_PLATFORM_CONNECTION_PARAM } from '@boardsesh/shared-schema';
import { browserSessionGuard } from '@/app/lib/auth/session-guard';
import {
  SOCKET_REFUSED_CLOSE_CODE,
  isBrowserAccessToken,
  noteSocketClosed,
  socketConnectToken,
  socketCredentialHandle,
} from '@/app/lib/auth/browser-access-token';
import { webClientIdentityConnectionParams } from '@/app/lib/client-identity';
import { connectionManager } from './websocket-connection-manager';

const DEBUG = process.env.NODE_ENV === 'development';
let safeWsCounter = 0;

// Re-export shared primitives so every importer of this module keeps getting
// `execute`/`subscribe` and friends from one place. The `components/graphql-queue`
// tree that used to drive most of this went with W-16; the surviving consumers
// are `board-presence-client.ts`, `kiosk/presence/kiosk-presence-hub.tsx` and
// `social/comment-section.tsx`.
export {
  execute,
  subscribe,
  getOperationName,
  GraphQLOperationError,
  isClimbDuplicateExtension,
} from '@boardsesh/graphql-client';
export type { Client, ExtendedClient, GraphQLErrorExtensions } from '@boardsesh/graphql-client';

/**
 * Wrap WebSocket to prevent native error events from leaking as unhandled
 * promise rejections. graphql-ws uses promises internally for connection
 * management, and on some code paths (retry, dispose) the native WebSocket
 * error Event can escape as an unhandled rejection. The noop listener
 * ensures the event is always "handled" at the source.
 */
class SafeWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    const id = ++safeWsCounter;
    this.addEventListener('error', (event) => {
      if (DEBUG) console.info(`[GraphQL] SafeWebSocket #${id} native error suppressed`, event);
    });
  }
}

export type GraphQLClientOptions = Omit<BaseClientOptions, 'webSocketImpl' | 'onClientCreated'> & {
  authToken?: string | null;
};

/**
 * Web wrapper around the shared `createGraphQLClient`. Injects:
 *   - `SafeWebSocket` as `webSocketImpl` so native error events don't leak.
 *   - `connectionManager` registration so the centralized health monitor
 *     knows about every client and can drive reconnection.
 *   - `client.dispose` wrapping to suppress non-fatal teardown rejections.
 */
export function createGraphQLClient(options: GraphQLClientOptions): ExtendedClient;
/**
 * @deprecated Use options object instead. This signature will be removed in a future version.
 */
export function createGraphQLClient(url: string, onReconnect?: () => void): ExtendedClient;
export function createGraphQLClient(
  urlOrOptions: string | GraphQLClientOptions,
  onReconnect?: () => void,
): ExtendedClient {
  const options: GraphQLClientOptions =
    typeof urlOrOptions === 'string' ? { url: urlOrOptions, onReconnect } : urlOrOptions;

  const managerConnectionName = options.connectionName ?? 'primary';
  const { authToken, ...baseOptions } = options;
  // A 15-minute browser token (#7596 B3b) is replaced while the socket lives:
  // the socket holds the viewer's handle and reads the current token at each
  // (re)connect. Any other token (legacy mode) is its own handle and is sent as is.
  const socketHandle = authToken ? socketCredentialHandle(authToken) : null;
  const browserTokenSocket = socketHandle !== null && isBrowserAccessToken(socketHandle);

  return createSharedGraphQLClient({
    ...baseOptions,
    // Always a provider (rather than the shared client's static `authToken`)
    // so the handshake also carries the client identity. Browsers cannot set
    // headers on the upgrade, so connectionParams is the only channel.
    // `clientPlatform` puts a signed-in socket's day in `user_activity_days`
    // under `web`, as HTTP requests already are (docs/analytics/analytics-consent.md).
    connectionParams: async () => {
      const connectToken = socketHandle ? await socketConnectToken(socketHandle) : null;
      return {
        ...(connectToken ? { authToken: connectToken } : {}),
        ...webClientIdentityConnectionParams(),
        [CLIENT_PLATFORM_CONNECTION_PARAM]: 'web',
      };
    },
    // graphql-ws gives up on a 4401 before it asks `shouldRetry`. A browser
    // token's socket turns it into a retryable close after asking the next
    // connect for a new token, as the app's `ws-client-core.ts` does; graphql-ws
    // then reconnects and resubscribes. Any other socket closes on 4401 as before.
    webSocketImpl:
      browserTokenSocket && socketHandle !== null
        ? retryingRefusedToken(SafeWebSocket, () => noteSocketClosed(socketHandle, SOCKET_REFUSED_CLOSE_CODE))
        : SafeWebSocket,
    onClientCreated: (client) => {
      if (typeof window === 'undefined') return;
      // graphql-ws dispose() is async and can reject with a raw DOM Event (ErrorEvent)
      // when the WebSocket was mid-connection or retrying at teardown time. All call
      // sites use fire-and-forget (no await), so an unhandled rejection with a DOM
      // Event would escape to window.onunhandledrejection — exactly what Sentry
      // captures as "Event `Event` (type=error) captured as promise rejection" on
      // iOS WKWebView. The shared `createGraphQLClient` wraps dispose() to suppress
      // these once `onClientCreated` returns a cleanup function.
      return connectionManager.registerClient(client, managerConnectionName);
    },
  });
}

/** A close graphql-ws retries (Forbidden is not in its fatal list): what a refused browser token becomes. */
const REFRESH_AND_RETRY_CLOSE_CODE = 4403;

function prototypeAccessor(prototype: object | null, property: string): PropertyDescriptor | undefined {
  for (let level = prototype; level; level = Object.getPrototypeOf(level)) {
    const descriptor = Object.getOwnPropertyDescriptor(level, property);
    if (descriptor) return descriptor;
  }
  return undefined;
}

/**
 * The socket class for a browser-token connection: its `onclose` handler (the
 * one graphql-ws assigns) sees a 4401 as a retryable 4403, after `onRefused`
 * marked the token so the reconnect sends a new one.
 */
function retryingRefusedToken(base: typeof WebSocket, onRefused: () => void): typeof WebSocket {
  return class RefusedTokenRetryingSocket extends base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const accessor = prototypeAccessor(Object.getPrototypeOf(this), 'onclose');
      let assigned: WebSocket['onclose'] = null;
      Object.defineProperty(this, 'onclose', {
        configurable: true,
        enumerable: true,
        get: () => assigned,
        set: (handler: WebSocket['onclose']) => {
          assigned = handler;
          accessor?.set?.call(
            this,
            handler === null
              ? null
              : (event: CloseEvent) => {
                  if (event.code !== SOCKET_REFUSED_CLOSE_CODE) return handler.call(this, event);
                  onRefused();
                  const retryable = {
                    code: REFRESH_AND_RETRY_CLOSE_CODE,
                    reason: event.reason,
                    wasClean: event.wasClean,
                  };
                  return handler.call(this, retryable as unknown as CloseEvent);
                },
          );
        },
      });
    }
  };
}

type SharedRealtimeClient = { key: string; client: ExtendedClient; holders: number; generation: number };
let sharedRealtimeClient: SharedRealtimeClient | null = null;
let watchingSessionGeneration = false;

/** An account change closes the shared socket at once; holders reacquire with their new token. */
function closeSupersededRealtimeClient(): void {
  const entry = sharedRealtimeClient;
  if (!entry || browserSessionGuard().isCurrent(entry.generation)) return;
  sharedRealtimeClient = null;
  void entry.client.dispose();
}

/**
 * The tab's one authenticated realtime socket. graphql-ws multiplexes every
 * subscription over a single connection, so the privacy bridge and live
 * comment threads share it instead of each opening their own. Call `release`
 * when done; the socket is disposed when its last holder lets go. A different
 * token gets a fresh client, and the old one closes once its holders move on.
 */
export function acquireRealtimeClient({ url, authToken }: { url: string; authToken: string | null }): {
  client: ExtendedClient;
  release: () => void;
} {
  const guard = browserSessionGuard();
  if (!watchingSessionGeneration) {
    watchingSessionGeneration = true;
    guard.subscribe(closeSupersededRealtimeClient);
  }
  closeSupersededRealtimeClient();
  // Keyed by the socket handle, so a refreshed browser token keeps the socket.
  const key = `${url}\n${socketCredentialHandle(authToken) ?? ''}`;
  if (sharedRealtimeClient?.key !== key) {
    sharedRealtimeClient = {
      key,
      client: createGraphQLClient({ url, authToken }),
      holders: 0,
      generation: guard.capture(),
    };
  }
  const entry = sharedRealtimeClient;
  entry.holders += 1;
  let released = false;
  return {
    client: entry.client,
    release: () => {
      if (released) return;
      released = true;
      entry.holders -= 1;
      if (entry.holders > 0) return;
      if (sharedRealtimeClient === entry) sharedRealtimeClient = null;
      void entry.client.dispose();
    },
  };
}
