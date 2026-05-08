import { type Client, type Sink, createClient } from 'graphql-ws';
import { connectionManager, KEEP_ALIVE_MS } from '../connection-manager/websocket-connection-manager';
import { INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, BACKOFF_MULTIPLIER } from './retry-constants';

export type { Client };

const DEBUG = process.env.NODE_ENV === 'development';
const MUTATION_TIMEOUT_MS = 30_000; // 30 second timeout for mutations

let clientCounter = 0;

// Cache for parsed operation names to avoid regex on every call
const operationNameCache = new WeakMap<{ query: string }, string>();

type NormalizedGraphQLError = Error & { transientTransportError?: boolean };

function getOperationName(operation: { query: string }, type: 'mutation' | 'query' | 'subscription'): string {
  const cached = operationNameCache.get(operation);
  if (cached) return cached;

  const pattern = type === 'subscription' ? /subscription\s+(\w+)/ : /(?:mutation|query)\s+(\w+)/;
  const match = operation.query.match(pattern);
  const name = match ? match[1] : 'unknown';
  operationNameCache.set(operation, name);
  return name;
}

function getObjectMessage(value: Record<string, unknown>): string | null {
  const message = value.message;
  if (typeof message === 'string' && message.trim()) return message;

  const reason = value.reason;
  if (typeof reason === 'string' && reason.trim()) return reason;

  return null;
}

function safeStringify(value: unknown): string | null {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (key, nestedValue) => {
      if (key === 'target' || key === 'currentTarget' || key === 'srcElement') {
        return undefined;
      }
      if (typeof nestedValue === 'object' && nestedValue !== null) {
        if (seen.has(nestedValue)) return '[Circular]';
        seen.add(nestedValue);
      }
      if (typeof nestedValue === 'function') return `[Function ${nestedValue.name || 'anonymous'}]`;
      return nestedValue;
    });
  } catch {
    return null;
  }
}

export function normalizeGraphQLWsError(error: unknown, context: string): NormalizedGraphQLError {
  if (error instanceof Error) return error;

  if (Array.isArray(error)) {
    const messages = error
      .map((entry) => (entry && typeof entry === 'object' ? getObjectMessage(entry as Record<string, unknown>) : null))
      .filter((message): message is string => !!message);
    if (messages.length > 0) {
      return new Error(`${context}: ${messages.join(', ')}`);
    }
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const objectMessage = getObjectMessage(record);
    if (objectMessage) {
      return new Error(`${context}: ${objectMessage}`);
    }

    const eventType = typeof record.type === 'string' ? record.type : null;
    const closeCode = typeof record.code === 'number' ? ` code=${record.code}` : '';
    const wasClean = typeof record.wasClean === 'boolean' ? ` wasClean=${record.wasClean}` : '';
    const constructorName =
      error.constructor?.name && error.constructor.name !== 'Object' ? error.constructor.name : null;
    const serialized = safeStringify(error);
    const detail = serialized && serialized !== '{}' ? ` ${serialized}` : '';
    const normalized = new Error(
      `${context}: ${constructorName ?? 'WebSocket'}${eventType ? ` ${eventType}` : ''} event${closeCode}${wasClean}${detail}`,
    ) as NormalizedGraphQLError;
    normalized.transientTransportError = true;
    return normalized;
  }

  return new Error(`${context}: ${String(error)}`);
}

export type ExtendedClient = {
  onReconnect?: (callback: () => void) => void;
} & Client;

export type GraphQLClientOptions = {
  url: string;
  authToken?: string | null;
  onReconnect?: () => void;
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

  const { url, authToken, onReconnect: onReconnectCallback, connectionName } = options;
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

/**
 * Execute a GraphQL mutation and return the result as a promise.
 *
 * Why over WebSocket and not HTTP: session-scoped mutations
 * (ADD_QUEUE_ITEM, SET_CURRENT_CLIMB, MIRROR_CURRENT_CLIMB,
 * LEAVE_SESSION, etc.) need to ride the same connection as the
 * subscriptions so the backend can fan them out to peers in the same
 * party room via the connection's `connectionParams`/`ConnectionContext`.
 * Sending them over HTTP would lose that room context. graphql-ws
 * supports queries/mutations as well as subscriptions on a single
 * socket — the server (Yoga + useServer) accepts all three operation
 * types over WS without filtering. Stateless queries and mutations
 * that don't need session routing should still go through the HTTP
 * client in `app/lib/graphql/client.ts`.
 *
 * Includes automatic cleanup and a 30s timeout so a wedged socket
 * can't hang a mutation forever.
 */
export function execute<TData = unknown, TVariables = Record<string, unknown>>(
  client: Client,
  operation: { query: string; variables?: TVariables },
  timeoutMs: number = MUTATION_TIMEOUT_MS,
): Promise<TData> {
  const opName = getOperationName(operation, 'mutation');

  if (DEBUG) console.info(`[GraphQL] execute START: ${opName}`);

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
            reject(normalizeGraphQLWsError(err, `GraphQL mutation '${opName}' failed`));
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

  // Add timeout to prevent mutations from hanging forever
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`GraphQL mutation '${opName}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([executionPromise, timeoutPromise]);
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
          sink.error?.(new Error(data.errors.map((e) => e.message).join(', ')));
        }
      },
      error: (error) => {
        if (DEBUG) console.info(`[GraphQL] subscribe ERROR: ${opName}`, error);
        // graphql-ws passes raw DOM Events (ErrorEvent/CloseEvent) when the WebSocket
        // connection fails. Always forward a proper Error so callers and Sentry never
        // receive "Event `Event` (type=error) captured as promise rejection".
        sink.error?.(normalizeGraphQLWsError(error, `GraphQL subscription '${opName}' failed`));
      },
      complete: () => {
        if (DEBUG) console.info(`[GraphQL] subscribe COMPLETE: ${opName}`);
        sink.complete?.();
      },
    },
  );
}
