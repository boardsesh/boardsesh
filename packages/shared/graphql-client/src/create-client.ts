import { type Client, createClient } from 'graphql-ws';
import { INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, BACKOFF_MULTIPLIER, KEEP_ALIVE_MS } from './constants';

export type ExtendedClient = {
  onReconnect?: (callback: () => void) => void;
} & Client;

export type CreateGraphQLClientOptions = {
  url: string;
  authToken?: string | null;
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
   * Hook fired immediately after the client is constructed, before it's
   * returned. Web uses this to register with `connectionManager` and to
   * wrap `client.dispose` to suppress non-fatal teardown rejections.
   * Receives `unregister`-capable client; callers may return a cleanup
   * function that runs inside the wrapped `dispose`.
   */
  onClientCreated?: (client: ExtendedClient) => (() => void) | void;
};

/**
 * Creates a graphql-ws Client with sane retry/backoff defaults. Exposes
 * `webSocketImpl` and `onClientCreated` hooks so platform-specific concerns
 * (DOM-event suppression, connection-manager registration) stay outside
 * this shared module.
 */
export function createGraphQLClient(options: CreateGraphQLClientOptions): ExtendedClient {
  const { url, authToken, onReconnect: onReconnectCallback, webSocketImpl, onClientCreated } = options;

  let hasConnectedOnce = false;

  const client = createClient({
    url,
    ...(webSocketImpl ? { webSocketImpl } : {}),
    retryAttempts: 10,
    shouldRetry: () => true,
    retryWait: async (retryCount) => {
      const delay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryCount), MAX_RETRY_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
    lazy: true,
    keepAlive: KEEP_ALIVE_MS,
    connectionParams: authToken ? { authToken } : undefined,
    on: {
      connected: () => {
        if (hasConnectedOnce && onReconnectCallback) {
          onReconnectCallback();
        }
        hasConnectedOnce = true;
      },
    },
  }) as ExtendedClient;

  const cleanup = onClientCreated?.(client);
  if (cleanup) {
    const originalDispose = client.dispose.bind(client);
    client.dispose = async () => {
      cleanup();
      try {
        await originalDispose();
      } catch {
        // Suppress: dispose errors are non-fatal. The socket is being torn down
        // and these rejections carry no actionable information.
      }
    };
  }

  return client;
}
