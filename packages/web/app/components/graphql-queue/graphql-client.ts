import { createClient, Client, Sink } from 'graphql-ws';
import { connectionManager, KEEP_ALIVE_MS } from '../connection-manager/websocket-connection-manager';

export type { Client };

const DEBUG = process.env.NODE_ENV === 'development';
const MUTATION_TIMEOUT_MS = 30_000; // 30 second timeout for mutations

import { INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, BACKOFF_MULTIPLIER } from './retry-constants';

let clientCounter = 0;

// Cache for parsed operation names to avoid regex on every call
const operationNameCache = new WeakMap<{ query: string }, string>();

function getOperationName(operation: { query: string }, type: 'mutation' | 'query' | 'subscription'): string {
  const cached = operationNameCache.get(operation);
  if (cached) return cached;

  const pattern = type === 'subscription'
    ? /subscription\s+(\w+)/
    : /(?:mutation|query)\s+(\w+)/;
  const match = operation.query.match(pattern);
  const name = match ? match[1] : 'unknown';
  operationNameCache.set(operation, name);
  return name;
}

export interface ExtendedClient extends Client {
  onReconnect?: (callback: () => void) => void;
}

export interface GraphQLClientOptions {
  url: string;
  authToken?: string | null;
  onReconnect?: () => void;
  connectionName?: string;
}

/**
 * Creates a GraphQL-WS client for connecting to the Boardsesh backend
 * @param options - Client configuration including URL and optional auth token
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
  // Handle both signatures for backwards compatibility
  const options: GraphQLClientOptions = typeof urlOrOptions === 'string'
    ? { url: urlOrOptions, onReconnect }
    : urlOrOptions;

  const { url, authToken, onReconnect: onReconnectCallback, connectionName } = options;
  const managerConnectionName = connectionName ?? 'primary';

  const clientId = ++clientCounter;

  if (DEBUG) console.log(`[GraphQL] Creating client #${clientId} for ${url} (authenticated: ${!!authToken})`);

  let hasConnectedOnce = false;

  // Wrap WebSocket to prevent native error events from leaking as unhandled
  // promise rejections. graphql-ws uses promises internally for connection
  // management, and on some code paths (retry, dispose) the native WebSocket
  // error Event can escape as an unhandled rejection. The noop listener
  // ensures the event is always "handled" at the source.
  class SafeWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('error', (event) => {
        if (DEBUG) console.log(`[GraphQL] Client #${clientId} WebSocket native error suppressed`, event);
      });
    }
  }

  const client = createClient({
    url,
    webSocketImpl: SafeWebSocket,
    retryAttempts: 10, // More attempts with exponential backoff
    shouldRetry: () => true,
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
    retryWait: async (retryCount) => {
      const delay = Math.min(
        INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryCount),
        MAX_RETRY_DELAY_MS,
      );
      if (DEBUG) console.log(`[GraphQL] Client #${clientId} retry #${retryCount + 1}, waiting ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
    // Lazy connection - only connects when first subscription/mutation is made
    lazy: true,
    // Keep alive to detect disconnections
    keepAlive: KEEP_ALIVE_MS,
    // Pass auth token in connection params for backend validation
    connectionParams: authToken ? { authToken } : undefined,
    on: {
      connected: () => {
        if (DEBUG) console.log(`[GraphQL] Client #${clientId} connected (first: ${!hasConnectedOnce})`);
        if (hasConnectedOnce && onReconnectCallback) {
          if (DEBUG) console.log(`[GraphQL] Client #${clientId} reconnected, calling onReconnect`);
          onReconnectCallback();
        }
        hasConnectedOnce = true;
      },
      closed: (event) => {
        if (DEBUG) console.log(`[GraphQL] Client #${clientId} closed`, event);
      },
      error: (error) => {
        if (DEBUG) console.log(`[GraphQL] Client #${clientId} error`, error);
      },
    },
  }) as ExtendedClient;

  // Register with the centralized connection manager for proactive reconnection/health checks
  if (typeof window !== 'undefined') {
    const unregister = connectionManager.registerClient(client, managerConnectionName);
    const originalDispose = client.dispose.bind(client);
    // graphql-ws v6 dispose() is async — it awaits the in-flight `connecting` Promise
    // and rejects if that connection attempt fails (e.g. with the plain object
    // { code: 1000, reason: "All Subscriptions Gone" }).  Dropping the returned
    // Promise without a .catch() produces an unhandled rejection that Sentry
    // captures as "Object captured as promise rejection with keys: code, reason".
    client.dispose = () => {
      unregister();
      // Wrap in Promise.resolve() because the type is `void | Promise<void>`.
      Promise.resolve(originalDispose()).catch((err: unknown) => {
        if (DEBUG) console.log(`[GraphQL] Client #${clientId} dispose error suppressed:`, err);
      });
    };
  }

  return client;
}

/**
 * Execute a GraphQL mutation and return the result as a promise
 * Includes automatic cleanup and timeout handling
 */
export function execute<TData = unknown, TVariables = Record<string, unknown>>(
  client: Client,
  operation: { query: string; variables?: TVariables },
  timeoutMs: number = MUTATION_TIMEOUT_MS,
): Promise<TData> {
  const opName = getOperationName(operation, 'mutation');

  if (DEBUG) console.log(`[GraphQL] execute START: ${opName}`);

  // Hoist these so both the timeout and the sink callbacks share the same state.
  // unsubscribe is initialised to a no-op so the timeout can safely call it in
  // the (impossible in practice) window before the Promise constructor assigns it.
  // hasResolved is set to true by whichever path wins the race — timeout, error,
  // or complete — so the other paths see the flag and skip redundant work.
  let unsubscribe: () => void = () => {};
  let hasResolved = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const executionPromise = new Promise<TData>((resolve, reject) => {
    let result: TData | undefined;

    unsubscribe = client.subscribe<TData>(
      { query: operation.query, variables: operation.variables as Record<string, unknown> },
      {
        next: (data) => {
          if (DEBUG) console.log(`[GraphQL] execute NEXT: ${opName}`, data.data ? 'has data' : 'no data', data.errors ? 'has errors' : 'no errors');
          // GraphQL can return null data values; keep the latest payload when present.
          if ('data' in data) {
            result = data.data as TData;
          }
          if (data.errors) {
            if (!hasResolved) {
              hasResolved = true;
              unsubscribe();
              reject(new Error(data.errors.map((e) => e.message).join(', ')));
            }
          }
        },
        error: (err) => {
          if (DEBUG) console.log(`[GraphQL] execute ERROR: ${opName}`, err);
          if (!hasResolved) {
            hasResolved = true;
            unsubscribe();
            // graphql-ws can pass non-Error values as sink errors:
            //   - Raw DOM Events (ErrorEvent/CloseEvent) when the WebSocket fails
            //   - Plain objects { code, reason } when the connection is closed
            // Rejecting with these causes Sentry to report
            // "Event `Event` (type=error) captured as promise rejection" or
            // "Object captured as promise rejection with keys: code, reason".
            // Always reject with a proper Error so callers get a catchable value.
            let errorValue: Error;
            if (err instanceof Error) {
              errorValue = err;
            } else if (typeof err === 'object' && err !== null && typeof (err as Record<string, unknown>).reason === 'string') {
              errorValue = new Error((err as { reason: string }).reason);
            } else {
              errorValue = new Error(String(err));
            }
            reject(errorValue);
          }
        },
        complete: () => {
          if (DEBUG) console.log(`[GraphQL] execute COMPLETE: ${opName}`);
          if (!hasResolved) {
            hasResolved = true;
            unsubscribe();
            if (result === undefined) {
              reject(new Error(`GraphQL operation '${opName}' completed without data`));
              return;
            }
            resolve(result);
          }
        },
      },
    );
  });

  // Add timeout to prevent mutations from hanging forever.
  // Cancel the underlying subscription on timeout so the graphql-ws lock is
  // released promptly instead of waiting for the next retry cycle.
  // hasResolved is set before unsubscribe() so that the complete/error callbacks
  // fired synchronously by graphql-ws during teardown see the flag and exit early.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      hasResolved = true;
      unsubscribe();
      reject(new Error(`GraphQL mutation '${opName}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([executionPromise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * Subscribe to a GraphQL subscription and receive events via callback
 * Returns an unsubscribe function
 */
export function subscribe<TData = unknown, TVariables = Record<string, unknown>>(
  client: Client,
  operation: { query: string; variables?: TVariables },
  sink: Sink<TData>,
): () => void {
  const opName = getOperationName(operation, 'subscription');

  if (DEBUG) console.log(`[GraphQL] subscribe START: ${opName}`);

  return client.subscribe<TData>(
    { query: operation.query, variables: operation.variables as Record<string, unknown> },
    {
      next: (data) => {
        if (DEBUG) console.log(`[GraphQL] subscribe NEXT: ${opName}`);
        if (data.data) {
          sink.next?.(data.data);
        }
        if (data.errors) {
          sink.error?.(new Error(data.errors.map((e) => e.message).join(', ')));
        }
      },
      error: (error) => {
        if (DEBUG) console.log(`[GraphQL] subscribe ERROR: ${opName}`, error);
        sink.error?.(error);
      },
      complete: () => {
        if (DEBUG) console.log(`[GraphQL] subscribe COMPLETE: ${opName}`);
        sink.complete?.();
      },
    },
  );
}
