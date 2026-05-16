import { type Client, type Sink, createClient } from 'graphql-ws';
import { connectionManager, KEEP_ALIVE_MS } from '../connection-manager/websocket-connection-manager';
import { INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, BACKOFF_MULTIPLIER } from './retry-constants';
import {
  parseRateLimitError,
  emitRateLimited,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_WAIT_MS,
  RateLimitError,
} from './rate-limit-error';

export type { Client };

const DEBUG = process.env.NODE_ENV === 'development';
const MUTATION_TIMEOUT_MS = 30_000; // 30 second timeout for mutations

let clientCounter = 0;

// Cache for parsed operation names to avoid regex on every call
const operationNameCache = new WeakMap<{ query: string }, string>();

function getOperationName(operation: { query: string }, type: 'mutation' | 'query' | 'subscription'): string {
  const cached = operationNameCache.get(operation);
  if (cached) return cached;

  const pattern = type === 'subscription' ? /subscription\s+(\w+)/ : /(?:mutation|query)\s+(\w+)/;
  const match = operation.query.match(pattern);
  const name = match ? match[1] : 'unknown';
  operationNameCache.set(operation, name);
  return name;
}

export type ExtendedClient = {
  onReconnect?: (callback: () => void) => void;
} & Client;

export type GraphQLClientOptions = {
  url: string;
  authToken?: string | null;
  onReconnect?: () => void;
  onDisconnect?: () => void;
  connectionName?: string;
};

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
  const options: GraphQLClientOptions =
    typeof urlOrOptions === 'string' ? { url: urlOrOptions, onReconnect } : urlOrOptions;

  const {
    url,
    authToken,
    onReconnect: onReconnectCallback,
    onDisconnect: onDisconnectCallback,
    connectionName,
  } = options;
  const managerConnectionName = connectionName ?? 'primary';

  const clientId = ++clientCounter;

  if (DEBUG) console.info(`[GraphQL] Creating client #${clientId} for ${url} (authenticated: ${!!authToken})`);

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
        if (DEBUG) console.info(`[GraphQL] Client #${clientId} WebSocket native error suppressed`, event);
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
      const delay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryCount), MAX_RETRY_DELAY_MS);
      if (DEBUG) console.info(`[GraphQL] Client #${clientId} retry #${retryCount + 1}, waiting ${delay}ms`);
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
        if (DEBUG) console.info(`[GraphQL] Client #${clientId} connected (first: ${!hasConnectedOnce})`);
        if (hasConnectedOnce && onReconnectCallback) {
          if (DEBUG) console.info(`[GraphQL] Client #${clientId} reconnected, calling onReconnect`);
          onReconnectCallback();
        }
        hasConnectedOnce = true;
      },
      closed: (event) => {
        if (DEBUG) console.info(`[GraphQL] Client #${clientId} closed`, event);
        // Let consumers drop subscription handles before graphql-ws auto-replays
        // them on the next socket — replay races joinSession on the new connectionId.
        onDisconnectCallback?.();
      },
      error: (error) => {
        if (DEBUG) console.info(`[GraphQL] Client #${clientId} error`, error);
      },
    },
  }) as ExtendedClient;

  // Register with the centralized connection manager for proactive reconnection/health checks
  if (typeof window !== 'undefined') {
    const unregister = connectionManager.registerClient(client, managerConnectionName);
    const originalDispose = client.dispose.bind(client);
    // graphql-ws dispose() is async and can reject with a raw DOM Event (ErrorEvent)
    // when the WebSocket was mid-connection or retrying at teardown time. All call sites
    // use fire-and-forget (no await), so an unhandled rejection with a DOM Event would
    // escape to window.onunhandledrejection — exactly what Sentry captures as
    // "Event `Event` (type=error) captured as promise rejection" on iOS WKWebView.
    // Wrapping here silences the rejection at the source for all consumers.
    client.dispose = async () => {
      unregister();
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

function executeOnce<TData, TVariables>(
  client: Client,
  operation: { query: string; variables?: TVariables },
  opName: string,
  timeoutMs: number,
): Promise<TData> {
  const executionPromise = new Promise<TData>((resolve, reject) => {
    let result: TData | undefined;
    let hasResolved = false;

    const unsubscribe = client.subscribe<TData>(
      { query: operation.query, variables: operation.variables as Record<string, unknown> },
      {
        next: (data) => {
          if (DEBUG)
            console.info(
              `[GraphQL] execute NEXT: ${opName}`,
              data.data ? 'has data' : 'no data',
              data.errors ? 'has errors' : 'no errors',
            );
          // GraphQL can return null data values; keep the latest payload when present.
          if ('data' in data) {
            result = data.data as TData;
          }
          if (data.errors) {
            if (!hasResolved) {
              hasResolved = true;
              unsubscribe();
              const rateLimitError = parseRateLimitError(data.errors);
              if (rateLimitError) {
                reject(rateLimitError);
                return;
              }
              reject(new Error(data.errors.map((e) => e.message).join(', ')));
            }
          }
        },
        error: (err) => {
          if (DEBUG) console.info(`[GraphQL] execute ERROR: ${opName}`, err);
          if (!hasResolved) {
            hasResolved = true;
            unsubscribe();
            // graphql-ws can pass a raw DOM Event (ErrorEvent/CloseEvent) when the
            // WebSocket connection fails. Rejecting with a DOM Event causes Sentry to
            // report "Event `Event` (type=error) captured as promise rejection" and
            // prevents catch blocks from seeing a useful message. Always reject with
            // a proper Error so callers receive a catchable, inspectable value.
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
        complete: () => {
          if (DEBUG) console.info(`[GraphQL] execute COMPLETE: ${opName}`);
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

  // Per-attempt timeout: reset on each retry so a rate-limit wait can't trip the
  // mutation timeout. Otherwise a 30s wait + 5s execution would exceed a single
  // outer 30s timeout.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`GraphQL mutation '${opName}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([executionPromise, timeoutPromise]).finally(() => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  });
}

/**
 * Execute a GraphQL mutation and return the result as a promise.
 * Retries automatically on rate-limit errors (RateLimitError) up to
 * MAX_RATE_LIMIT_RETRIES, waiting `retryAfterSeconds` between attempts.
 */
export function execute<TData = unknown, TVariables = Record<string, unknown>>(
  client: Client,
  operation: { query: string; variables?: TVariables },
  timeoutMs: number = MUTATION_TIMEOUT_MS,
): Promise<TData> {
  const opName = getOperationName(operation, 'mutation');

  if (DEBUG) console.info(`[GraphQL] execute START: ${opName}`);

  return executeWithRateLimitRetry<TData, TVariables>(client, operation, opName, timeoutMs);
}

async function executeWithRateLimitRetry<TData, TVariables>(
  client: Client,
  operation: { query: string; variables?: TVariables },
  opName: string,
  timeoutMs: number,
): Promise<TData> {
  let attempt = 0;
  while (true) {
    try {
      return await executeOnce<TData, TVariables>(client, operation, opName, timeoutMs);
    } catch (err) {
      if (!(err instanceof RateLimitError) || attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw err;
      }
      attempt++;
      emitRateLimited(err, attempt);
      const waitMs = Math.min(err.retryAfterSeconds * 1000, MAX_RATE_LIMIT_WAIT_MS) + Math.floor(Math.random() * 250);
      if (DEBUG) console.info(`[GraphQL] execute RATE_LIMITED ${opName}, retry #${attempt} in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
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

  if (DEBUG) console.info(`[GraphQL] subscribe START: ${opName}`);

  return client.subscribe<TData>(
    { query: operation.query, variables: operation.variables as Record<string, unknown> },
    {
      next: (data) => {
        if (DEBUG) console.info(`[GraphQL] subscribe NEXT: ${opName}`);
        if (data.data) {
          sink.next?.(data.data);
        }
        if (data.errors) {
          const rateLimitError = parseRateLimitError(data.errors);
          sink.error?.(rateLimitError ?? new Error(data.errors.map((e) => e.message).join(', ')));
        }
      },
      error: (error) => {
        if (DEBUG) console.info(`[GraphQL] subscribe ERROR: ${opName}`, error);
        // graphql-ws passes raw DOM Events (ErrorEvent/CloseEvent) when the WebSocket
        // connection fails. Always forward a proper Error so callers and Sentry never
        // receive "Event `Event` (type=error) captured as promise rejection".
        sink.error?.(error instanceof Error ? error : new Error(String(error)));
      },
      complete: () => {
        if (DEBUG) console.info(`[GraphQL] subscribe COMPLETE: ${opName}`);
        sink.complete?.();
      },
    },
  );
}
