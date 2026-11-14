import {
  BROWSER_COORDINATOR_PROTOCOL_VERSION,
  browserCoordinatorCancelSchema,
  browserCoordinatorCommandSchema,
  browserCoordinatorConnectedSchema,
  browserCoordinatorConnectSchema,
  browserCoordinatorReplySchema,
  browserCoordinatorRequestSchema,
  compareBrowserBindingCursor,
  requireCoordinatorOrigin,
  type BrowserBindingCursor,
  type BrowserCoordinatorCommand,
  type BrowserCoordinatorResult,
} from './browser-coordinator-v1';
import type { CoordinatorTimer } from './browser-coordinator-runner';

/** Platform adapters wrap MessagePort without exporting DOM or persistent I/O. */
export interface CoordinatorPort {
  post(message: unknown): void;
  listen(message: (input: unknown) => void, disconnected: () => void): () => void;
  close(): void;
}
export interface CoordinatorConnectEvent {
  readonly origin: string;
  readonly source: object | null;
  readonly message: unknown;
  readonly ports: readonly CoordinatorPort[];
}
export interface CoordinatorClientPlatform {
  readonly createChannel: () => { readonly local: CoordinatorPort; readonly remote: unknown };
  readonly postConnect: (target: object, exactOrigin: string, message: unknown, remote: unknown) => void;
  readonly newId: () => string;
  readonly schedule: CoordinatorTimer;
}
export interface BrowserCoordinatorClient {
  request(command: BrowserCoordinatorCommand, signal?: AbortSignal): Promise<BrowserCoordinatorResult>;
  /** Metadata only; never use it as authenticated identity. */
  cursor(): BrowserBindingCursor | null;
  /** A closed/exhausted connection requires a new handshake and primary read. */
  isClosed(): boolean;
  close(): void;
}
const unavailable = (): BrowserCoordinatorResult => ({ status: 'unavailable' });
function closePort(port: CoordinatorPort) {
  try {
    port.close();
  } catch {
    /* Peer teardown cannot authorize a result. */
  }
}

/** Both www and app use this same client. The only recipient of the transferred
 * port is the exact configured canonical window at the exact HTTPS origin. */
export function connectBrowserCoordinatorClient(options: {
  readonly canonicalOrigin: string;
  readonly target: object;
  readonly platform: CoordinatorClientPlatform;
  readonly timeoutMs: number;
}): Promise<BrowserCoordinatorClient> {
  const canonicalOrigin = requireCoordinatorOrigin(options.canonicalOrigin);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000)
    throw new Error('COORDINATOR_DEADLINE_INVALID');
  const { target, platform, timeoutMs } = options;
  const connectionId = platform.newId();
  const connect = browserCoordinatorConnectSchema.parse({
    protocolVersion: BROWSER_COORDINATOR_PROTOCOL_VERSION,
    type: 'connect',
    connectionId,
  });
  const { local, remote } = platform.createChannel();
  return new Promise((resolve, reject) => {
    let connected = false;
    let closed = false;
    let currentCursor: BrowserBindingCursor | null = null;
    const issued = new Set<string>();
    const pending = new Map<
      string,
      {
        readonly operation: BrowserCoordinatorCommand['operation'];
        readonly expectedCursor?: BrowserBindingCursor;
        readonly finish: (result: BrowserCoordinatorResult) => void;
      }
    >();
    let stopListening = () => {};
    let cancelConnectionTimeout = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      cancelConnectionTimeout();
      stopListening();
      for (const [requestId, request] of pending) {
        try {
          local.post({ ...connect, type: 'cancel', requestId });
        } catch {
          /* The server has its own deadline. */
        }
        request.finish(unavailable());
      }
      closePort(local);
      if (!connected) reject(new Error('COORDINATOR_UNAVAILABLE'));
    };
    const client: BrowserCoordinatorClient = {
      cursor: () => (currentCursor ? { ...currentCursor } : null),
      close,
      isClosed: () => closed,
      request(input, signal) {
        if (closed || signal?.aborted) return Promise.resolve(unavailable());
        const command = browserCoordinatorCommandSchema.parse(input);
        const requestId = platform.newId();
        const message = browserCoordinatorRequestSchema.parse({ ...connect, type: 'request', requestId, command });
        // IDs cannot be reused while another request owns its completion.
        if (issued.has(requestId) || issued.size >= 256) {
          close();
          return Promise.resolve(unavailable());
        }
        issued.add(requestId);
        return new Promise<BrowserCoordinatorResult>((finish) => {
          let settled = false;
          let cancelTimeout = () => {};
          const abort = () => {
            try {
              local.post({ ...connect, type: 'cancel', requestId });
            } catch {
              /* The server has its own deadline. */
            }
            complete(unavailable());
          };
          const complete = (result: BrowserCoordinatorResult) => {
            if (settled) return;
            settled = true;
            cancelTimeout();
            signal?.removeEventListener('abort', abort);
            pending.delete(requestId);
            finish(result);
          };
          pending.set(requestId, {
            operation: command.operation,
            ...(command.operation === 'read' ? {} : { expectedCursor: Object.freeze({ ...command.expectedCursor }) }),
            finish: complete,
          });
          signal?.addEventListener('abort', abort, { once: true });
          cancelTimeout = platform.schedule(abort, timeoutMs);
          try {
            local.post(message);
          } catch {
            complete(unavailable());
          }
        });
      },
    };
    stopListening = local.listen((input) => {
      if (closed) return;
      if (!connected) {
        const greeting = browserCoordinatorConnectedSchema.safeParse(input);
        if (!greeting.success || greeting.data.connectionId !== connectionId) {
          close();
          return;
        }
        connected = true;
        cancelConnectionTimeout();
        resolve(client);
        return;
      }
      const reply = browserCoordinatorReplySchema.safeParse(input);
      if (!reply.success || reply.data.connectionId !== connectionId) {
        close();
        return;
      }
      const request = pending.get(reply.data.requestId);
      if (!request) return; // Cancelled/late results never publish metadata.
      if (request.operation !== reply.data.operation) {
        close();
        return;
      }
      const result = reply.data.result;
      if (result.status === 'ready') {
        if (
          request.expectedCursor &&
          (request.expectedCursor.bindingId !== result.cursor.bindingId ||
            (request.expectedCursor.version !== result.cursor.version &&
              !(request.operation === 'renew' && result.cursor.version === request.expectedCursor.version + 1)))
        ) {
          request.finish({ status: 'conflict' });
          return;
        }
        if (compareBrowserBindingCursor(currentCursor, result.cursor) !== 'current') {
          request.finish({ status: 'conflict' });
          return;
        }
        currentCursor = Object.freeze({ ...result.cursor });
      }
      request.finish(result);
    }, close);
    cancelConnectionTimeout = platform.schedule(close, timeoutMs);
    try {
      platform.postConnect(target, canonicalOrigin, connect, remote);
    } catch {
      close();
    }
  });
}

export interface BrowserCoordinatorEndpointOptions {
  readonly peers: readonly { readonly origin: string; readonly source: object }[];
  readonly run: (command: BrowserCoordinatorCommand, signal: AbortSignal) => Promise<BrowserCoordinatorResult>;
  readonly maxConnections?: number;
}

/** Unmounted canonical endpoint. Its caller supplies the actual window listener
 * and lock-owning transport. No backend URL or public bootstrap is selected. */
export function createBrowserCoordinatorEndpoint(options: BrowserCoordinatorEndpointOptions) {
  const peers = options.peers.map((peer) => ({ origin: requireCoordinatorOrigin(peer.origin), source: peer.source }));
  const run = options.run;
  const maxConnections = options.maxConnections ?? 16;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 64)
    throw new Error('COORDINATOR_CONNECTION_LIMIT_INVALID');
  const connections = new Set<() => void>();
  let disposed = false;
  return {
    receive(event: CoordinatorConnectEvent): void {
      const greeting = browserCoordinatorConnectSchema.safeParse(event.message);
      if (
        disposed ||
        !peers.some((peer) => peer.origin === event.origin && peer.source === event.source) ||
        !greeting.success ||
        event.ports.length !== 1 ||
        connections.size >= maxConnections
      ) {
        for (const port of event.ports) closePort(port);
        return;
      }
      const port = event.ports[0];
      const connectionId = greeting.data.connectionId;
      const seen = new Set<string>();
      const active = new Map<string, AbortController>();
      let closed = false;
      let stopListening = () => {};
      const close = () => {
        if (closed) return;
        closed = true;
        stopListening();
        for (const controller of active.values()) controller.abort();
        connections.delete(close);
        closePort(port);
      };
      connections.add(close);
      stopListening = port.listen((input) => {
        if (closed) return;
        const cancellation = browserCoordinatorCancelSchema.safeParse(input);
        if (cancellation.success && cancellation.data.connectionId === connectionId) {
          active.get(cancellation.data.requestId)?.abort();
          return;
        }
        const request = browserCoordinatorRequestSchema.safeParse(input);
        if (!request.success || request.data.connectionId !== connectionId) {
          close();
          return;
        }
        const { requestId, command } = request.data;
        // Bounded per-port replay history and concurrency, never unbounded work.
        if (seen.has(requestId) || seen.size >= 256 || active.size >= 8) {
          close();
          return;
        }
        seen.add(requestId);
        const controller = new AbortController();
        active.set(requestId, controller);
        void (async () => {
          let result: BrowserCoordinatorResult;
          try {
            result = await run(command, controller.signal);
          } catch {
            result = unavailable();
          }
          active.delete(requestId);
          if (closed || controller.signal.aborted) return;
          const reply = browserCoordinatorReplySchema.safeParse({
            ...greeting.data,
            type: 'result',
            requestId,
            operation: command.operation,
            result,
          });
          // Transport objects never cross the port unless the strict metadata
          // schema accepts them. A credential/profile field fails closed.
          try {
            port.post(
              reply.success
                ? reply.data
                : {
                    ...greeting.data,
                    type: 'result',
                    requestId,
                    operation: command.operation,
                    result: unavailable(),
                  },
            );
          } catch {
            close();
          }
        })();
      }, close);
      try {
        port.post({ ...greeting.data, type: 'connected' });
      } catch {
        close();
      }
    },
    close() {
      disposed = true;
      for (const close of connections) close();
    },
  };
}
