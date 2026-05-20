import { type Client, type Sink, createClient } from 'graphql-ws';
import { connectionManager, KEEP_ALIVE_MS } from '../connection-manager/websocket-connection-manager';
import { INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, BACKOFF_MULTIPLIER } from './retry-constants';

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

/**
 * Strict shape for the `extensions` blob the backend attaches to GraphQL
 * errors. Always carries an optional string `code`; payload fields for
 * known codes are unioned in so call-sites that narrow via the
 * `isClimbDuplicateExtension` guard below get strongly-typed payloads.
 *
 * Unknown codes (older clients hitting newer servers, codes we haven't
 * typed yet) flow through with `unknown` payload — callers can still
 * read `code` to switch on, and must explicitly cast to access anything
 * else.
 */
export type GraphQLErrorExtensions = {
  code?: string;
  existingClimbUuid?: string | null;
  existingClimbName?: string | null;
  [key: string]: unknown;
};

/**
 * Type guard for the CLIMB_IS_DUPLICATE extension shape. Narrows
 * `extensions` to the variant where `existingClimbUuid` and
 * `existingClimbName` are typed `string | null | undefined` rather than
 * `unknown`, so call-sites don't need ad-hoc `typeof` guards.
 */
export function isClimbDuplicateExtension(
  extensions: GraphQLErrorExtensions | null | undefined,
): extensions is GraphQLErrorExtensions & {
  code: 'CLIMB_IS_DUPLICATE';
  existingClimbUuid?: string | null;
  existingClimbName?: string | null;
} {
  return extensions?.code === 'CLIMB_IS_DUPLICATE';
}

/**
 * Error subclass that preserves GraphQL error extensions. Callers can inspect
 * `extensions.code` (or any other extension keys) to branch on a typed error
 * — e.g. CLIMB_IS_DUPLICATE — without resorting to message-string matching.
 *
 * `extensions` resolves to the first error that actually carries a `code`,
 * falling back to the first error's extensions otherwise. This matters when
 * the server emits multiple errors and the typed one isn't first — picking
 * blindly by index would silently drop the gate's CLIMB_IS_DUPLICATE code.
 */
export class GraphQLOperationError extends Error {
  readonly extensions: GraphQLErrorExtensions | null;
  readonly graphqlErrors: ReadonlyArray<{ message: string; extensions?: GraphQLErrorExtensions }>;

  constructor(graphqlErrors: ReadonlyArray<{ message: string; extensions?: GraphQLErrorExtensions }>) {
    const message = graphqlErrors.map((err) => err.message).join(', ');
    super(message);
    this.name = 'GraphQLOperationError';
    this.graphqlErrors = graphqlErrors;
    const coded = graphqlErrors.find((err) => err.extensions && typeof err.extensions.code === 'string');
    this.extensions = coded?.extensions ?? graphqlErrors[0]?.extensions ?? null;
  }
}

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
    // Plus up to 30% jitter on each delay so N thousands of clients
    // reconnecting after a rolling deploy don't thunder onto the new
    // instance in lockstep (TLS handshakes + subscribe-frame replay are
    // the actual bottleneck — see PR #2218 scalability review).
    retryWait: async (retryCount) => {
      const base = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryCount), MAX_RETRY_DELAY_MS);
      const jitter = base * 0.3 * Math.random();
      const delay = base + jitter;
      if (DEBUG) console.info(`[GraphQL] Client #${clientId} retry #${retryCount + 1}, waiting ${delay.toFixed(0)}ms`);
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
 * Execute a GraphQL mutation and return the result as a promise
 * Includes automatic cleanup and timeout handling
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
              reject(new GraphQLOperationError(data.errors));
            }
          }
        },
        error: (err) => {
          if (DEBUG) console.info(`[GraphQL] execute ERROR: ${opName}`, err);
          if (!hasResolved) {
            hasResolved = true;
            unsubscribe();
            // graphql-ws also reports server-emitted GraphQL errors through the
            // error callback when the server closes the stream with them (e.g.
            // single-error mutation rejects). Preserve extensions in that path
            // too, otherwise fall back to a generic Error.
            if (Array.isArray(err) && err.length > 0 && typeof err[0]?.message === 'string') {
              reject(new GraphQLOperationError(err));
            } else if (err instanceof Error) {
              reject(err);
            } else {
              reject(new Error(String(err)));
            }
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
        sink.error?.(error instanceof Error ? error : new Error(String(error)));
      },
      complete: () => {
        if (DEBUG) console.info(`[GraphQL] subscribe COMPLETE: ${opName}`);
        sink.complete?.();
      },
    },
  );
}
