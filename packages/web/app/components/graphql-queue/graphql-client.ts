import { createClient, Client, Sink } from 'graphql-ws';
import { connectionManager, KEEP_ALIVE_MS } from '../connection-manager/websocket-connection-manager';

export type { Client };

const DEBUG = process.env.NODE_ENV === 'development';
const MUTATION_TIMEOUT_MS = 30_000; // 30 second timeout for mutations

import { INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, BACKOFF_MULTIPLIER } from './retry-constants';

let clientCounter = 0;
const NON_RETRYABLE_CLOSE_CODES = new Set([4400, 4401, 4403, 4404, 1002, 1003, 1008]);

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

function shouldRetrySocket(errorOrCloseEvent: unknown): boolean {
  const eventWithCode = errorOrCloseEvent as { code?: number; reason?: string; message?: string };
  const code = eventWithCode?.code;
  if (typeof code === 'number' && NON_RETRYABLE_CLOSE_CODES.has(code)) {
    return false;
  }

  const message = `${eventWithCode?.reason ?? ''} ${eventWithCode?.message ?? ''}`.toLowerCase();
  if (
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('authentication') ||
    message.includes('invalid token')
  ) {
    return false;
  }

  return true;
}

export interface ExtendedClient extends Client {
  onReconnect?: (callback: () => void) => void;
}

export interface GraphQLClientOptions {
  url: string;
  authToken?: string | null;
  onReconnect?: () => void;
  onConnectionStateChange?: (connected: boolean, isReconnect: boolean) => void;
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

  const { url, authToken, onReconnect: onReconnectCallback, onConnectionStateChange, connectionName } = options;
  const managerConnectionName = connectionName ?? 'primary';

  const clientId = ++clientCounter;

  if (DEBUG) console.log(`[GraphQL] Creating client #${clientId} for ${url} (authenticated: ${!!authToken})`);

  let hasConnectedOnce = false;

  const client = createClient({
    url,
    retryAttempts: 10, // More attempts with exponential backoff
    shouldRetry: shouldRetrySocket,
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
        const isReconnect = hasConnectedOnce;
        if (DEBUG) console.log(`[GraphQL] Client #${clientId} connected (first: ${!hasConnectedOnce})`);
        hasConnectedOnce = true;
        onConnectionStateChange?.(true, isReconnect);
        if (isReconnect && onReconnectCallback) {
          if (DEBUG) console.log(`[GraphQL] Client #${clientId} reconnected, calling onReconnect`);
          onReconnectCallback();
        }
      },
      closed: (event) => {
        if (DEBUG) console.log(`[GraphQL] Client #${clientId} closed`, event);
        if (hasConnectedOnce) {
          onConnectionStateChange?.(false, true);
        }
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
    client.dispose = () => {
      unregister();
      originalDispose();
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

  let result: TData | undefined;
  let hasSettled = false;
  let timeoutId: ReturnType<typeof setTimeout>;
  let unsubscribe: (() => void) | null = null;

  const unsubscribeSafely = () => {
    if (!unsubscribe) return;
    const fn = unsubscribe;
    unsubscribe = null;
    fn();
  };

  const executionPromise = new Promise<TData>((resolve, reject) => {
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
            if (!hasSettled) {
              hasSettled = true;
              unsubscribeSafely();
              reject(new Error(data.errors.map((e) => e.message).join(', ')));
            }
          }
        },
        error: (err) => {
          if (DEBUG) console.log(`[GraphQL] execute ERROR: ${opName}`, err);
          if (!hasSettled) {
            hasSettled = true;
            unsubscribeSafely();
            reject(err);
          }
        },
        complete: () => {
          if (DEBUG) console.log(`[GraphQL] execute COMPLETE: ${opName}`);
          if (!hasSettled) {
            hasSettled = true;
            unsubscribeSafely();
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
    timeoutId = setTimeout(() => {
      if (hasSettled) return;
      hasSettled = true;
      unsubscribeSafely();
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
