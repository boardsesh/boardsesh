import { describe, it, expect, vi } from 'vitest';
import { ConnectionStateMachine } from '../connection-state-machine';

describe('ConnectionStateMachine', () => {
  it('starts in IDLE state', () => {
    const sm = new ConnectionStateMachine();
    expect(sm.state).toBe('IDLE');
    expect(sm.hasEverConnected).toBe(false);
  });

  it('derives correct flags for IDLE', () => {
    const sm = new ConnectionStateMachine();
    expect(sm.flags).toEqual({
      isConnecting: false,
      hasConnected: false,
      isWebSocketConnected: false,
      isReconnecting: false,
    });
  });

  describe('valid transitions', () => {
    it('IDLE -> CONNECTING', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      expect(sm.state).toBe('CONNECTING');
      expect(sm.flags.isConnecting).toBe(true);
    });

    it('CONNECTING -> CONNECTED', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('CONNECTED');
      expect(sm.state).toBe('CONNECTED');
      expect(sm.hasEverConnected).toBe(true);
      expect(sm.flags).toEqual({
        isConnecting: false,
        hasConnected: true,
        isWebSocketConnected: true,
        isReconnecting: false,
      });
    });

    it('CONNECTING -> FAILED', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('FAILED');
      expect(sm.state).toBe('FAILED');
    });

    it('CONNECTING -> IDLE (cancelled)', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('IDLE');
      expect(sm.state).toBe('IDLE');
    });

    it('CONNECTED -> RECONNECTING', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('CONNECTED');
      sm.transition('RECONNECTING');
      expect(sm.state).toBe('RECONNECTING');
      expect(sm.flags).toEqual({
        isConnecting: false,
        hasConnected: true,
        isWebSocketConnected: false,
        isReconnecting: true,
      });
    });

    it('CONNECTED -> IDLE (disconnect)', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('CONNECTED');
      sm.transition('IDLE');
      expect(sm.state).toBe('IDLE');
    });

    it('RECONNECTING -> CONNECTED', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('CONNECTED');
      sm.transition('RECONNECTING');
      sm.transition('CONNECTED');
      expect(sm.state).toBe('CONNECTED');
      expect(sm.flags.isReconnecting).toBe(false);
      expect(sm.flags.isWebSocketConnected).toBe(true);
    });

    it('RECONNECTING -> FAILED', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('CONNECTED');
      sm.transition('RECONNECTING');
      sm.transition('FAILED');
      expect(sm.state).toBe('FAILED');
    });

    it('FAILED -> CONNECTING (retry)', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('FAILED');
      sm.transition('CONNECTING');
      expect(sm.state).toBe('CONNECTING');
    });

    it('FAILED -> IDLE (give up)', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('FAILED');
      sm.transition('IDLE');
      expect(sm.state).toBe('IDLE');
    });
  });

  describe('invalid transitions', () => {
    it('IDLE -> CONNECTED is ignored', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTED');
      expect(sm.state).toBe('IDLE');
    });

    it('IDLE -> RECONNECTING is ignored', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('RECONNECTING');
      expect(sm.state).toBe('IDLE');
    });

    it('CONNECTED -> CONNECTING is ignored', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('CONNECTED');
      sm.transition('CONNECTING');
      expect(sm.state).toBe('CONNECTED');
    });
  });

  describe('same-state transitions', () => {
    it('does not fire listener for same-state transition', () => {
      const sm = new ConnectionStateMachine();
      const listener = vi.fn();
      sm.onStateChange(listener);
      sm.transition('IDLE'); // already IDLE
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('hasEverConnected', () => {
    it('stays true after reconnection', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('CONNECTED');
      expect(sm.hasEverConnected).toBe(true);

      sm.transition('RECONNECTING');
      expect(sm.hasEverConnected).toBe(true);

      sm.transition('CONNECTED');
      expect(sm.hasEverConnected).toBe(true);
    });

    it('is false after failed first connection', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('FAILED');
      expect(sm.hasEverConnected).toBe(false);
    });
  });

  describe('listeners', () => {
    it('notifies listeners on transition', () => {
      const sm = new ConnectionStateMachine();
      const listener = vi.fn();
      sm.onStateChange(listener);

      sm.transition('CONNECTING');
      expect(listener).toHaveBeenCalledWith('CONNECTING', 'IDLE');

      sm.transition('CONNECTED');
      expect(listener).toHaveBeenCalledWith('CONNECTED', 'CONNECTING');
    });

    it('unsubscribe stops notifications', () => {
      const sm = new ConnectionStateMachine();
      const listener = vi.fn();
      const unsubscribe = sm.onStateChange(listener);

      sm.transition('CONNECTING');
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      sm.transition('CONNECTED');
      expect(listener).toHaveBeenCalledTimes(1); // No additional call
    });

    it('supports multiple listeners', () => {
      const sm = new ConnectionStateMachine();
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      sm.onStateChange(listener1);
      sm.onStateChange(listener2);

      sm.transition('CONNECTING');
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('resets to IDLE and clears hasEverConnected', () => {
      const sm = new ConnectionStateMachine();
      sm.transition('CONNECTING');
      sm.transition('CONNECTED');
      expect(sm.hasEverConnected).toBe(true);

      sm.reset();
      expect(sm.state).toBe('IDLE');
      expect(sm.hasEverConnected).toBe(false);
    });

    it('fires listener on reset', () => {
      const sm = new ConnectionStateMachine();
      const listener = vi.fn();
      sm.transition('CONNECTING');
      sm.transition('CONNECTED');

      sm.onStateChange(listener);
      sm.reset();
      expect(listener).toHaveBeenCalledWith('IDLE', 'CONNECTED');
    });

    it('does not fire listener if already IDLE', () => {
      const sm = new ConnectionStateMachine();
      const listener = vi.fn();
      sm.onStateChange(listener);
      sm.reset();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('clears all listeners', () => {
      const sm = new ConnectionStateMachine();
      const listener = vi.fn();
      sm.onStateChange(listener);

      sm.dispose();
      sm.transition('CONNECTING');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('full lifecycle simulation', () => {
    it('handles connect -> disconnect -> reconnect -> connected', () => {
      const sm = new ConnectionStateMachine();
      const states: string[] = [];
      sm.onStateChange((state) => states.push(state));

      // Initial connection
      sm.transition('CONNECTING');
      sm.transition('CONNECTED');

      // Network drop
      sm.transition('RECONNECTING');

      // Reconnection succeeds
      sm.transition('CONNECTED');

      expect(states).toEqual(['CONNECTING', 'CONNECTED', 'RECONNECTING', 'CONNECTED']);
      expect(sm.flags).toEqual({
        isConnecting: false,
        hasConnected: true,
        isWebSocketConnected: true,
        isReconnecting: false,
      });
    });

    it('handles connect -> fail -> retry -> connect', () => {
      const sm = new ConnectionStateMachine();

      sm.transition('CONNECTING');
      sm.transition('FAILED');
      sm.transition('CONNECTING'); // retry
      sm.transition('CONNECTED');

      expect(sm.state).toBe('CONNECTED');
      expect(sm.hasEverConnected).toBe(true);
    });
  });
});
