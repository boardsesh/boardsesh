import {
  createGraphQLClient as createSharedGraphQLClient,
  type BaseClientOptions,
  type ExtendedClient,
} from '@boardsesh/graphql-client';
import { CLIENT_PLATFORM_CONNECTION_PARAM } from '@boardsesh/shared-schema';
import type { FormattedExecutionResult, Sink, SubscribePayload } from 'graphql-ws';
import {
  browserSubscriptionReplayPolicy,
  createBrowserBackendSocketController,
} from '@boardsesh/auth-protocol/browser-backend-socket-controller';
import { parse } from 'graphql';
import { browserBackendClient } from '@/app/lib/auth/browser-backend-client';
import { captureBrowserBackendRequestScope } from '@/app/lib/auth/browser-backend-graphql';
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
  const scope = captureBrowserBackendRequestScope(authToken);
  let createdClient: ExtendedClient | undefined;
  const selectedController = scope
    ? createBrowserBackendSocketController({
        Socket: SafeWebSocket,
        authority: {
          isCurrent: () => browserBackendClient.isCurrent(scope),
          assertCurrent: (lease) => browserBackendClient.assertCurrent(scope, lease),
          acquire: () => browserBackendClient.acquireScope(scope),
          invalidate: () => browserBackendClient.invalidate(scope),
        },
        closeEvent: (code, reason, wasClean) => new CloseEvent('close', { code, reason, wasClean }),
        schedule(callback, milliseconds) {
          const timer = setTimeout(callback, milliseconds);
          return () => clearTimeout(timer);
        },
        terminate: () => createdClient?.terminate(),
      })
    : undefined;

  const client = createSharedGraphQLClient({
    ...baseOptions,
    // A cancelled pre-handshake operation releases before its internal close
    // race is observed. Give that release a turn before the lazy socket closes.
    ...(scope ? { lazyCloseTimeoutMs: baseOptions.lazyCloseTimeoutMs ?? 3000 } : {}),
    // Always a provider (rather than the shared client's static `authToken`)
    // so the handshake also carries the client identity. Browsers cannot set
    // headers on the upgrade, so connectionParams is the only channel.
    // `clientPlatform` puts a signed-in socket's day in `user_activity_days`
    // under `web`, as HTTP requests already are (docs/analytics-consent.md).
    connectionParams: async () => {
      let currentToken = authToken;
      if (selectedController) currentToken = await selectedController.connectionToken();
      return {
        ...(currentToken ? { authToken: currentToken } : {}),
        ...webClientIdentityConnectionParams(),
        [CLIENT_PLATFORM_CONNECTION_PARAM]: 'web',
      };
    },
    webSocketImpl: selectedController?.Socket ?? SafeWebSocket,
    onClientCreated: (client) => {
      createdClient = client;
      if (!scope && typeof window === 'undefined') return;
      // graphql-ws dispose() is async and can reject with a raw DOM Event (ErrorEvent)
      // when the WebSocket was mid-connection or retrying at teardown time. All call
      // sites use fire-and-forget (no await), so an unhandled rejection with a DOM
      // Event would escape to window.onunhandledrejection — exactly what Sentry
      // captures as "Event `Event` (type=error) captured as promise rejection" on
      // iOS WKWebView. The shared `createGraphQLClient` wraps dispose() to suppress
      // these once `onClientCreated` returns a cleanup function.
      const unregister =
        typeof window === 'undefined' ? undefined : connectionManager.registerClient(client, managerConnectionName);
      const unsubscribeOwner = scope
        ? browserBackendClient.subscribe(() => {
            if (!browserBackendClient.isCurrent(scope)) void client.dispose();
          })
        : undefined;
      return () => {
        selectedController?.dispose();
        unsubscribeOwner?.();
        unregister?.();
      };
    },
  });
  if (selectedController) {
    const subscribe = client.subscribe.bind(client);
    client.subscribe = <Data = Record<string, unknown>, Extensions = unknown>(
      payload: SubscribePayload,
      sink: Sink<FormattedExecutionResult<Data, Extensions>>,
    ) => {
      const { query, operationName, variables, extensions } = payload;
      const bufferedPayload = Object.freeze({ query, operationName, variables, extensions });
      let replay: 'never' | 'subscription' = 'never';
      try {
        replay = browserSubscriptionReplayPolicy(parse(bufferedPayload.query), bufferedPayload.operationName);
      } catch {
        // Malformed/ambiguous documents never opt into transport replay.
      }
      return selectedController.subscribe((guarded) => subscribe<Data, Extensions>(bufferedPayload, guarded), sink, {
        replay,
      });
    };
  }
  return client;
}

type SharedRealtimeClient = { key: string; client: ExtendedClient; holders: number };
let sharedRealtimeClient: SharedRealtimeClient | null = null;

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
  const key = `${url}\n${authToken ?? ''}`;
  if (sharedRealtimeClient?.key !== key) {
    sharedRealtimeClient = { key, client: createGraphQLClient({ url, authToken }), holders: 0 };
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
