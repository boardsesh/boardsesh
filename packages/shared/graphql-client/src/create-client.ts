import { type Client, createClient, type FormattedExecutionResult, type Sink, type SubscribePayload } from 'graphql-ws';
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  BACKOFF_MULTIPLIER,
  KEEP_ALIVE_MS,
  RECONNECT_JITTER_RATIO,
} from './constants';

export type ExtendedClient = {
  onReconnect?: (callback: () => void) => void;
} & Client;

export type BaseClientOptions = {
  url: string;
  /** Called once after the second `connected` event (i.e. on every reconnect). */
  onReconnect?: () => void;
  /** Debug tag used in console logs. */
  connectionName?: string;
  /**
   * Platform-specific WebSocket implementation. Web passes a wrapped
   * `SafeWebSocket` to swallow native error events; mobile/node can omit
   * this and graphql-ws will use the global `WebSocket`.
   */
  webSocketImpl?: typeof WebSocket;
  /**
   * Custom retry predicate. When provided, overrides the default `() => true`.
   */
  shouldRetry?: (errOrCloseEvent: unknown) => boolean;
  /**
   * How long the lazy client keeps an idle socket open after its last operation
   * settles, in ms. Unset means graphql-ws's default: close at once.
   *
   * A caller that runs one operation and then starts the next one from its
   * result (JOIN_SESSION, then the session streams or a session mutation) needs
   * this: with an immediate close the follow-up lands on a fresh connection that
   * never saw the first operation. Setting it also turns on the guard against
   * graphql-ws's stale lazy-close timer (see `guardStaleLazyClose`).
   */
  lazyCloseTimeoutMs?: number;
  /**
   * Hook fired immediately after the client is constructed, before it's
   * returned. Web uses this to register with `connectionManager` and to
   * wrap `client.dispose` to suppress non-fatal teardown rejections.
   * Receives `unregister`-capable client; callers may return a cleanup
   * function that runs inside the wrapped `dispose`.
   */
  onClientCreated?: (client: ExtendedClient) => (() => void) | void;
};

/**
 * Provide auth via a static token OR an async provider — not both.
 * The union enforces mutual exclusivity at the type level.
 */
export type CreateGraphQLClientOptions = BaseClientOptions &
  (
    | { authToken?: string | null; connectionParams?: never }
    | { authToken?: never; connectionParams: () => Promise<Record<string, unknown>> }
  );

const NORMAL_CLOSURE = 1000;

/**
 * graphql-ws 6 arms one lazy-close timer per released operation but stores only
 * the last handle, and the next operation's `connect()` clears only that one
 * (`dist/client.js`, the `released.then` inside `connect()`). Release two
 * operations in one tick, as a caller dropping both of its streams does, then
 * subscribe again, and the first timer is left armed: it closes the socket
 * under the new operation `lazyCloseTimeout` ms later. That close is code 1000,
 * so graphql-ws does not reconnect once its operations are released.
 *
 * The subclass refuses a 1000 close while any operation counted by
 * `createGraphQLClient` is still live. A legitimate lazy close only ever fires
 * with none live, because any new operation clears the stored timer. A dispose
 * closes with the same code, so `isDisposing` lets it through.
 */
function guardStaleLazyClose(
  socketImpl: typeof WebSocket,
  hasLiveOperations: () => boolean,
  isDisposing: () => boolean,
): typeof WebSocket {
  return class StaleLazyCloseGuardedSocket extends socketImpl {
    close(code?: number, reason?: string): void {
      if (code === NORMAL_CLOSURE && !isDisposing() && hasLiveOperations()) return;
      super.close(code, reason);
    }
  };
}

/**
 * Creates a graphql-ws Client with sane retry/backoff defaults. Exposes
 * `webSocketImpl` and `onClientCreated` hooks so platform-specific concerns
 * (DOM-event suppression, connection-manager registration) stay outside
 * this shared module.
 */
export function createGraphQLClient(options: CreateGraphQLClientOptions): ExtendedClient {
  const {
    url,
    authToken,
    connectionParams: connectionParamsProvider,
    onReconnect: onReconnectCallback,
    webSocketImpl,
    shouldRetry,
    lazyCloseTimeoutMs,
    onClientCreated,
  } = options;

  let hasConnectedOnce = false;

  // Only counted when the guard is on; see `guardStaleLazyClose`.
  let liveOperations = 0;
  let disposing = false;
  const baseSocketImpl = webSocketImpl ?? (typeof WebSocket === 'undefined' ? undefined : WebSocket);
  const guardLazyClose = lazyCloseTimeoutMs !== undefined && lazyCloseTimeoutMs > 0 && baseSocketImpl !== undefined;
  const socketImpl =
    guardLazyClose && baseSocketImpl
      ? guardStaleLazyClose(
          baseSocketImpl,
          () => liveOperations > 0,
          () => disposing,
        )
      : webSocketImpl;

  const resolvedConnectionParams = connectionParamsProvider
    ? connectionParamsProvider
    : authToken
      ? { authToken }
      : undefined;

  const client = createClient({
    url,
    ...(socketImpl ? { webSocketImpl: socketImpl } : {}),
    retryAttempts: 10,
    shouldRetry: shouldRetry ?? (() => true),
    retryWait: async (retryCount) => {
      // Exponential backoff with jitter. Without the jitter, a fleet that all
      // dropped at once (backend restart) reconnects in lockstep and re-trips
      // the per-user rate limiter in synchronized waves; spreading each attempt
      // over [0.5·delay, delay] de-syncs the herd (#2655).
      const base = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryCount), MAX_RETRY_DELAY_MS);
      const delay = base - Math.random() * RECONNECT_JITTER_RATIO * base;
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
    lazy: true,
    ...(lazyCloseTimeoutMs !== undefined ? { lazyCloseTimeout: lazyCloseTimeoutMs } : {}),
    keepAlive: KEEP_ALIVE_MS,
    connectionParams: resolvedConnectionParams,
    on: {
      connected: () => {
        if (hasConnectedOnce && onReconnectCallback) {
          onReconnectCallback();
        }
        hasConnectedOnce = true;
      },
    },
  }) as ExtendedClient;

  if (guardLazyClose) {
    // Every operation the app starts goes through `subscribe` (`execute` and the
    // `subscribe` helper both call it). An operation stops counting at its first
    // `error`, `complete` or caller release. `iterate()` calls graphql-ws's
    // internal subscribe and is not counted; nothing in the apps uses it.
    const rawSubscribe = client.subscribe.bind(client) as Client['subscribe'];
    const countedSubscribe = <Data = Record<string, unknown>, Extensions = unknown>(
      payload: SubscribePayload,
      sink: Sink<FormattedExecutionResult<Data, Extensions>>,
    ): (() => void) => {
      liveOperations += 1;
      let counted = true;
      const stopCounting = () => {
        if (!counted) return;
        counted = false;
        liveOperations -= 1;
      };
      let release: () => void;
      try {
        release = rawSubscribe<Data, Extensions>(payload, {
          next: (value) => sink.next(value),
          error: (error) => {
            stopCounting();
            sink.error(error);
          },
          complete: () => {
            stopCounting();
            sink.complete();
          },
        });
      } catch (error) {
        // A count that never comes down would keep every idle socket open.
        stopCounting();
        throw error;
      }
      return () => {
        stopCounting();
        release();
      };
    };
    client.subscribe = countedSubscribe;
  }

  const cleanup = onClientCreated?.(client);
  if (cleanup || guardLazyClose) {
    const originalDispose = client.dispose.bind(client);
    client.dispose = async () => {
      // Lets dispose's own 1000 close past the stale-timer guard. graphql-ws
      // issues that close before `originalDispose` resolves, so the flag drops
      // again afterwards: a caller that still starts an operation on a disposed
      // client (graphql-ws opens a new socket for it) keeps the guard.
      disposing = true;
      cleanup?.();
      try {
        await originalDispose();
      } catch {
        // Suppress: dispose errors are non-fatal. The socket is being torn down
        // and these rejections carry no actionable information.
      } finally {
        disposing = false;
      }
    };
  }

  return client;
}
