import { getNativeWebSocketPlugin, isNativeWebSocketAvailable } from '@/app/lib/native-ws/native-ws-plugin';
import { connectionManager } from '../connection-manager/websocket-connection-manager';

const DEBUG = process.env.NODE_ENV === 'development';
const MUTATION_TIMEOUT_MS = 30_000;

interface Sink<T> {
  next: (value: T) => void;
  error: (error: unknown) => void;
  complete: () => void;
}

interface GQLWsMessage {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
}

type MessageHandler = {
  next: (payload: Record<string, unknown>) => void;
  error: (error: unknown) => void;
  complete: () => void;
};

export class NativeWSClient {
  private handlers = new Map<string, MessageHandler>();
  private listenerHandle: { remove: () => void } | null = null;
  private connectionListenerHandle: { remove: () => void } | null = null;
  /** Promises from async addListener calls — tracked so dispose() can clean them up. */
  private pendingListenerPromises: Promise<void>[] = [];
  private connectionState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' = 'disconnected';
  private onReconnectCallback: (() => void) | null = null;
  private hasConnectedOnce = false;
  private disposed = false;

  constructor(private options: { onReconnect?: () => void }) {
    this.onReconnectCallback = options.onReconnect ?? null;
    this.setupListeners();
  }

  private setupListeners() {
    const plugin = getNativeWebSocketPlugin();
    if (!plugin) {
      if (DEBUG) console.log('[NativeWS] setupListeners: plugin not available');
      return;
    }
    if (DEBUG) console.log('[NativeWS] setupListeners: registering wsMessage and connectionStateChanged listeners');

    // Listen for raw WebSocket messages
    const handle = plugin.addListener('wsMessage', (data: Record<string, unknown>) => {
      const raw = typeof data.raw === 'string' ? data.raw : undefined;
      if (!raw) return;
      if (DEBUG) console.log('[NativeWS] wsMessage received:', raw.slice(0, 200));
      this.handleRawMessage(raw);
    });
    this.storeListenerHandle(handle, (h) => { this.listenerHandle = h; });

    // Listen for connection state changes
    const connHandle = plugin.addListener('connectionStateChanged', (data: Record<string, unknown>) => {
      const newState = typeof data.state === 'string' ? data.state : undefined;
      if (!newState) return;
      if (DEBUG) console.log('[NativeWS] connectionStateChanged:', newState);
      this.connectionState = newState as typeof this.connectionState;

      if (newState === 'connected') {
        if (this.hasConnectedOnce && this.onReconnectCallback) {
          this.onReconnectCallback();
        }
        this.hasConnectedOnce = true;
      }

      connectionManager.updateNativeState(newState as 'connected' | 'connecting' | 'reconnecting' | 'disconnected');
    });
    this.storeListenerHandle(connHandle, (h) => { this.connectionListenerHandle = h; });
  }

  /**
   * Handles both sync and async addListener return values (Capacitor version compat).
   * When the handle is a Promise, tracks it so dispose() can clean up even if it
   * resolves after disposal.
   */
  private storeListenerHandle(
    handle: { remove: () => void } | Promise<{ remove: () => void }>,
    setter: (h: { remove: () => void }) => void,
  ) {
    if (handle && typeof (handle as { remove?: () => void }).remove === 'function') {
      setter(handle as { remove: () => void });
    } else if (handle && typeof (handle as Promise<{ remove: () => void }>).then === 'function') {
      const promise = (handle as Promise<{ remove: () => void }>).then((h) => {
        if (this.disposed) {
          h.remove();
        } else {
          setter(h);
        }
      });
      this.pendingListenerPromises.push(promise);
    }
  }

  private handleRawMessage(raw: string) {
    let msg: GQLWsMessage;
    try {
      msg = JSON.parse(raw) as GQLWsMessage;
    } catch {
      if (DEBUG) console.log('[NativeWS] handleRawMessage: failed to parse JSON');
      return;
    }

    // Handle synthetic resync_needed message from native buffering
    if (msg.type === 'resync_needed') {
      if (DEBUG) console.log('[NativeWS] resync_needed received');
      if (this.onReconnectCallback) {
        this.onReconnectCallback();
      }
      return;
    }

    const { type, id, payload } = msg;
    if (!id) {
      if (DEBUG) console.log('[NativeWS] message without id (type=%s), skipping routing', type);
      return;
    }

    const handler = this.handlers.get(id);
    if (!handler) {
      if (DEBUG) console.log('[NativeWS] no handler for id=%s type=%s (registered: %s)', id, type, Array.from(this.handlers.keys()).join(', '));
      return;
    }

    if (DEBUG) console.log('[NativeWS] routing message id=%s type=%s to handler', id, type);

    switch (type) {
      case 'next':
        handler.next(payload ?? {});
        break;
      case 'error':
        handler.error(payload ?? { message: 'Unknown error' });
        break;
      case 'complete':
        handler.complete();
        this.handlers.delete(id);
        break;
    }
  }

  /**
   * Subscribe to a GraphQL subscription. Returns an unsubscribe function.
   * Events are routed to the sink callbacks.
   */
  subscribe<TData>(
    operation: { query: string; variables?: Record<string, unknown> },
    sink: Sink<TData>,
  ): () => void {
    const subscriptionId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const plugin = getNativeWebSocketPlugin();

    if (DEBUG) console.log('[NativeWS] subscribe id=%s query=%s', subscriptionId, operation.query.slice(0, 80));

    if (!plugin) {
      if (DEBUG) console.log('[NativeWS] subscribe: plugin not available');
      sink.error(new Error('Native WebSocket plugin not available'));
      return () => {};
    }

    // Register handler BEFORE sending subscribe to avoid race condition
    this.handlers.set(subscriptionId, {
      next: (payload) => {
        // Extract data from the graphql-ws payload
        const data = (payload as { data?: unknown }).data as TData | undefined;
        if (data) {
          sink.next(data);
        }
        const errors = (payload as { errors?: Array<{ message: string }> }).errors;
        if (errors) {
          sink.error(new Error(errors.map((e) => e.message).join(', ')));
        }
      },
      error: (err) => sink.error(err),
      complete: () => sink.complete(),
    });

    // Send subscribe via native
    plugin
      .subscribe({
        query: operation.query,
        variables: operation.variables ? JSON.stringify(operation.variables) : undefined,
        subscriptionId,
      })
      .catch((err) => {
        if (DEBUG) console.log('[NativeWS] subscribe failed:', err);
        sink.error(err);
        this.handlers.delete(subscriptionId);
      });

    // Return unsubscribe function
    return () => {
      this.handlers.delete(subscriptionId);
      plugin.unsubscribe({ subscriptionId }).catch((err) => {
        if (DEBUG) console.log('[NativeWS] unsubscribe failed:', err);
      });
    };
  }

  /**
   * Execute a GraphQL mutation. Returns a promise with the result.
   */
  execute<TData>(
    operation: { query: string; variables?: Record<string, unknown> },
    timeoutMs: number = MUTATION_TIMEOUT_MS,
  ): Promise<TData> {
    const operationId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const plugin = getNativeWebSocketPlugin();

    if (DEBUG) console.log('[NativeWS] execute id=%s query=%s', operationId, operation.query.slice(0, 80));

    if (!plugin) {
      if (DEBUG) console.log('[NativeWS] execute: plugin not available');
      return Promise.reject(new Error('Native WebSocket plugin not available'));
    }

    const executionPromise = new Promise<TData>((resolve, reject) => {
      let result: TData | undefined;
      let hasResolved = false;

      this.handlers.set(operationId, {
        next: (payload) => {
          const data = (payload as { data?: unknown }).data as TData | undefined;
          if (data !== undefined) {
            result = data;
          }
          const errors = (payload as { errors?: Array<{ message: string }> }).errors;
          if (errors && !hasResolved) {
            hasResolved = true;
            this.handlers.delete(operationId);
            reject(new Error(errors.map((e) => e.message).join(', ')));
          }
        },
        error: (err) => {
          if (!hasResolved) {
            hasResolved = true;
            this.handlers.delete(operationId);
            reject(err);
          }
        },
        complete: () => {
          if (!hasResolved) {
            hasResolved = true;
            this.handlers.delete(operationId);
            if (result === undefined) {
              reject(new Error('Operation completed without data'));
            } else {
              resolve(result);
            }
          }
        },
      });

      // Send via native
      plugin
        .sendOperation({
          query: operation.query,
          variables: operation.variables ? JSON.stringify(operation.variables) : undefined,
          operationId,
        })
        .catch((err) => {
          if (!hasResolved) {
            hasResolved = true;
            this.handlers.delete(operationId);
            reject(err);
          }
        });
    });

    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        this.handlers.delete(operationId);
        reject(new Error(`Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // Note: if the timeout fires but the mutation already succeeded server-side,
    // the result is silently discarded. Callers should treat timeout as "unknown
    // outcome" rather than "definitely failed".
    return Promise.race([executionPromise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  getConnectionState(): string {
    return this.connectionState;
  }

  dispose() {
    this.disposed = true;
    this.handlers.clear();
    this.listenerHandle?.remove();
    this.connectionListenerHandle?.remove();
    this.listenerHandle = null;
    this.connectionListenerHandle = null;
    // Any in-flight async addListener promises will check this.disposed
    // when they resolve and call h.remove() — see storeListenerHandle().
    this.pendingListenerPromises = [];

    connectionManager.clearNativeState();

    const plugin = getNativeWebSocketPlugin();
    plugin?.disconnect().catch(() => {});
  }
}

/**
 * Check if native WebSocket is available on this platform.
 */
export { isNativeWebSocketAvailable };

/**
 * Create a NativeWSClient instance. Only works on iOS native.
 */
export function createNativeWSClient(options: { onReconnect?: () => void } = {}): NativeWSClient {
  return new NativeWSClient(options);
}
