import { Client, Event as WsEvent, EventListener as WsEventListener } from 'graphql-ws';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stale' | 'error';

type ConnectionSnapshot = {
  name: string | null;
  state: ConnectionState;
  lastActivity: number | null;
  error?: Error | null;
};

type RegisteredClient = {
  id: symbol;
  name: string;
  client: Client;
  lastActivity: number;
  state: ConnectionState;
  error: Error | null;
  cleanup: (() => void)[];
};

const KEEP_ALIVE_MS = 5000;
const STALE_GRACE_MS = 10_000;
const HEALTH_CHECK_INTERVAL_MS = 1000;

class WebSocketConnectionManager {
  private clients: Map<symbol, RegisteredClient> = new Map();
  private primaryName: string | null = null;
  private listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
      this.startHealthCheck();
    }
  }

  registerClient(client: Client, name: string = 'primary'): () => void {
    // The graphql-ws client always supports `on`
    const id = Symbol('ws-client');
    const now = Date.now();
    const record: RegisteredClient = {
      id,
      name,
      client,
      lastActivity: now,
      state: 'connecting',
      error: null,
      cleanup: [],
    };

    if (!this.primaryName || name === 'session') {
      this.primaryName = name;
    }

    this.clients.set(id, record);
    this.notify();

    const attach = <E extends WsEvent>(event: E, handler: WsEventListener<E>) => {
      const off = client.on(event, handler);
      record.cleanup.push(off);
    };

    const markActivity = () => {
      record.lastActivity = Date.now();
    };

    attach('connecting', () => {
      record.state = 'connecting';
      markActivity();
      this.notify();
    });

    attach('connected', () => {
      record.state = 'connected';
      markActivity();
      this.notify();
    });

    attach('ping', (received: boolean) => {
      if (received) markActivity();
    });

    attach('pong', (received: boolean) => {
      if (received) {
        record.state = 'connected';
        markActivity();
        this.notify();
      }
    });

    attach('message', () => {
      markActivity();
    });

    attach('closed', () => {
      record.state = 'reconnecting';
      this.notify();
    });

    attach('error', (err: unknown) => {
      record.state = 'error';
      record.error = err instanceof Error ? err : new Error(String(err));
      this.notify();
    });

    const unregister = () => {
      record.cleanup.forEach((off) => off());
      this.clients.delete(id);
      if (this.clients.size === 0) {
        this.primaryName = null;
      }
      this.notify();
    };

    return unregister;
  }

  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    listener(this.getSnapshot());
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  forceReconnect(targetName?: string) {
    const target = this.getPrimary(targetName);
    if (target && typeof target.client.terminate === 'function') {
      target.state = 'reconnecting';
      this.notify();
      target.client.terminate();
    }
  }

  setPrimaryName(name: string) {
    this.primaryName = name;
    this.notify();
  }

  dispose() {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.stopHealthCheck();
  }

  // Health check to proactively terminate stale sockets on iOS Safari background kills.
  // Only runs while the tab is visible — paused on hide, resumed on visibility return.
  private startHealthCheck() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      const now = Date.now();
      this.clients.forEach((record) => {
        if (now - record.lastActivity > STALE_GRACE_MS && record.state !== 'reconnecting') {
          record.state = 'reconnecting';
          this.notify();
          if (typeof record.client.terminate === 'function') {
            record.client.terminate();
          }
        }
      });
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private handleVisibilityChange = () => {
    if (document.visibilityState !== 'visible') {
      // Tab hidden — pause the interval to avoid unnecessary CPU cycles
      this.stopHealthCheck();
      return;
    }

    // Tab visible — restart the health check interval
    this.startHealthCheck();

    // Immediately check if the primary connection went stale while hidden
    const primary = this.getPrimary();
    if (!primary) return;

    const now = Date.now();
    const isStale = now - primary.lastActivity > STALE_GRACE_MS;
    const isUnhealthy = primary.state === 'error' || primary.state === 'reconnecting';
    if (isStale || isUnhealthy) {
      this.forceReconnect(primary.name);
    }
  };

  private getPrimary(targetName?: string): RegisteredClient | undefined {
    const name = targetName || this.primaryName;
    if (name) {
      const byName = Array.from(this.clients.values()).find((c) => c.name === name);
      if (byName) return byName;
    }
    // Fallback to first client if primary not set
    return this.clients.values().next().value;
  }

  private notify() {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  // MARK: - Native WebSocket state tracking

  private nativeState: ConnectionState = 'idle';
  private nativeActive = false;

  /**
   * Update connection state from the native iOS WebSocket.
   * When the native WS is active, its state is used as the primary state
   * instead of graphql-ws client state.
   */
  updateNativeState(state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected') {
    this.nativeActive = true;
    const mapped: ConnectionState = state === 'disconnected' ? 'reconnecting' : state;
    this.nativeState = mapped;
    this.notify();
  }

  /**
   * Clear the native connection state (e.g., when disconnecting from native WS).
   */
  clearNativeState() {
    this.nativeActive = false;
    this.nativeState = 'idle';
    this.notify();
  }

  getSnapshot(): ConnectionSnapshot {
    // When native WS is active, use its state as the primary
    if (this.nativeActive) {
      return {
        name: 'native',
        state: this.nativeState,
        lastActivity: Date.now(),
        error: null,
      };
    }

    const primary = this.getPrimary();
    if (!primary) {
      return { name: null, state: 'idle', lastActivity: null, error: null };
    }

    return {
      name: primary.name,
      state: primary.state,
      lastActivity: primary.lastActivity,
      error: primary.error,
    };
  }

  /**
   * Testing utility – clears all registered clients and timers.
   */
  __resetForTests() {
    this.clients.clear();
    this.primaryName = null;
    this.nativeActive = false;
    this.nativeState = 'idle';
    this.listeners.clear();
    this.stopHealthCheck();

    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
      this.startHealthCheck();
    }
  }
}

export const connectionManager = typeof window !== 'undefined'
  ? new WebSocketConnectionManager()
  : // Provide a no-op shim for SSR
    {
      registerClient: () => () => {},
      subscribe: () => () => {},
      getSnapshot: (): ConnectionSnapshot => ({ name: null, state: 'idle', lastActivity: null, error: null }),
      forceReconnect: () => {},
      setPrimaryName: () => {},
      updateNativeState: () => {},
      clearNativeState: () => {},
      dispose: () => {},
      __resetForTests: () => {},
    } as unknown as WebSocketConnectionManager;

export { KEEP_ALIVE_MS, STALE_GRACE_MS, HEALTH_CHECK_INTERVAL_MS };
