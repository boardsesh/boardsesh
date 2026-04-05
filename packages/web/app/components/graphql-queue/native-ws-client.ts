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
    if (!plugin) return;

    // Listen for raw WebSocket messages
    const handle = plugin.addListener('wsMessage', (data: Record<string, unknown>) => {
      const raw = data.raw as string;
      if (!raw) return;
      this.handleRawMessage(raw);
    });

    // Handle both sync and async listener registration (Capacitor version compat)
    if (handle && typeof (handle as { remove?: () => void }).remove === 'function') {
      this.listenerHandle = handle as { remove: () => void };
    } else if (handle && typeof (handle as Promise<{ remove: () => void }>).then === 'function') {
      (handle as Promise<{ remove: () => void }>).then((h) => {
        if (this.disposed) {
          h.remove();
        } else {
          this.listenerHandle = h;
        }
      });
    }

    // Listen for connection state changes
    const connHandle = plugin.addListener('connectionStateChanged', (data: Record<string, unknown>) => {
      const newState = data.state as string;
      this.connectionState = newState as typeof this.connectionState;

      if (newState === 'connected') {
        if (this.hasConnectedOnce && this.onReconnectCallback) {
          this.onReconnectCallback();
        }
        this.hasConnectedOnce = true;
      }

      // Update connection manager
      connectionManager.updateNativeState(newState as 'connected' | 'connecting' | 'reconnecting' | 'disconnected');
    });

    if (connHandle && typeof (connHandle as { remove?: () => void }).remove === 'function') {
      this.connectionListenerHandle = connHandle as { remove: () => void };
    } else if (connHandle && typeof (connHandle as Promise<{ remove: () => void }>).then === 'function') {
      (connHandle as Promise<{ remove: () => void }>).then((h) => {
        if (this.disposed) {
          h.remove();
        } else {
          this.connectionListenerHandle = h;
        }
      });
    }
  }

  private handleRawMessage(raw: string) {
    let msg: GQLWsMessage;
    try {
      msg = JSON.parse(raw) as GQLWsMessage;
    } catch {
      return;
    }

    // Handle synthetic resync_needed message from native buffering
    if (msg.type === 'resync_needed') {
      if (this.onReconnectCallback) {
        this.onReconnectCallback();
      }
      return;
    }

    const { type, id, payload } = msg;
    if (!id) return; // connection-level messages (ping/pong/ack) don't need routing

    const handler = this.handlers.get(id);
    if (!handler) return;

    switch (type) {
      case 'next':
        handler.next(payload ?? {});
        break;
      case 'error':
        handler.error(payload ?? { message: 'Unknown error' });
        // Don't remove handler on error for subscriptions - they may continue
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

    if (!plugin) {
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

    if (!plugin) {
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
