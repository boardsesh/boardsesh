/**
 * Finite state machine for WebSocket connection lifecycle.
 *
 * Replaces scattered boolean state variables (isConnecting, hasConnected,
 * isWebSocketConnected, isReconnectingRef) with explicit states and transitions.
 *
 * States:
 *   IDLE → CONNECTING → CONNECTED → RECONNECTING → CONNECTED
 *                  ↘ FAILED → IDLE
 */

export type ConnectionState =
  | 'IDLE'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'FAILED';

export type ConnectionStateListener = (state: ConnectionState, prev: ConnectionState) => void;

/**
 * Derived boolean flags for React consumers.
 * These match the existing PersistentSessionContext interface.
 */
export interface ConnectionFlags {
  isConnecting: boolean;
  hasConnected: boolean;
  isWebSocketConnected: boolean;
  isReconnecting: boolean;
}

// Valid state transitions
const VALID_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
  IDLE: ['CONNECTING'],
  CONNECTING: ['CONNECTED', 'FAILED', 'IDLE'],
  CONNECTED: ['RECONNECTING', 'IDLE'],
  RECONNECTING: ['CONNECTED', 'FAILED', 'IDLE'],
  FAILED: ['CONNECTING', 'IDLE'],
};

export class ConnectionStateMachine {
  private _state: ConnectionState = 'IDLE';
  private _hasEverConnected = false;
  private _listeners = new Set<ConnectionStateListener>();

  get state(): ConnectionState {
    return this._state;
  }

  get hasEverConnected(): boolean {
    return this._hasEverConnected;
  }

  /**
   * Derive the boolean flags that the React context expects.
   */
  get flags(): ConnectionFlags {
    return {
      isConnecting: this._state === 'CONNECTING',
      hasConnected: this._hasEverConnected,
      isWebSocketConnected: this._state === 'CONNECTED',
      isReconnecting: this._state === 'RECONNECTING',
    };
  }

  /**
   * Transition to a new state. Throws if the transition is invalid.
   */
  transition(to: ConnectionState): void {
    const from = this._state;
    if (from === to) return;

    if (!VALID_TRANSITIONS[from].includes(to)) {
      console.warn(
        `[ConnectionStateMachine] Invalid transition: ${from} → ${to}. Allowed: ${VALID_TRANSITIONS[from].join(', ')}`,
      );
      return;
    }

    this._state = to;

    if (to === 'CONNECTED') {
      this._hasEverConnected = true;
    }

    for (const listener of this._listeners) {
      listener(to, from);
    }
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   */
  onStateChange(listener: ConnectionStateListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Reset the state machine to IDLE (e.g. on disconnect or dispose).
   * Does not trigger listeners if already IDLE.
   */
  reset(): void {
    const from = this._state;
    if (from === 'IDLE') return;

    this._state = 'IDLE';
    this._hasEverConnected = false;
    for (const listener of this._listeners) {
      listener('IDLE', from);
    }
  }

  /**
   * Remove all listeners (for cleanup).
   */
  dispose(): void {
    this._listeners.clear();
  }
}
