'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export type Esp32SocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type Esp32Hello = {
  type: 'hello';
  fwVersion: string;
  board: string;
  serial: string;
  apiLevel: number;
  mdnsHost?: string;
};

export type Esp32BleWrite = { type: 'ble-write'; ts: number; hex: string };
export type Esp32BleConn = { type: 'ble-connected' | 'ble-disconnected' };
export type Esp32ConfigAck = { type: 'config-ack'; config: { board: string; serial: string; apiLevel: number } };
export type Esp32ErrorMsg = { type: 'error'; message: string };

export type Esp32Message = Esp32Hello | Esp32BleWrite | Esp32BleConn | Esp32ConfigAck | Esp32ErrorMsg;

export type Esp32Config = {
  board: string;
  serial: string;
  apiLevel: 2 | 3;
};

export type Esp32SocketState = {
  status: Esp32SocketStatus;
  hello: Esp32Hello | null;
  bleConnected: boolean;
  /** Last error message (transport or server-emitted). */
  errorMessage: string | null;
};

export type Esp32SocketHandle = Esp32SocketState & {
  /** Send a config update to the ESP32 (re-advertises BLE with new name). */
  sendConfig: (cfg: Esp32Config) => void;
  /** Manually trigger a reconnect — useful when the user changes IP. */
  reconnect: () => void;
};

type UseEsp32SocketOpts = {
  ip: string;
  onBleWrite?: (hex: string) => void;
};

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 5_000;

// Hosts a single WebSocket connection to one ESP32 emulator on ws://<ip>:81/.
// Auto-reconnects with backoff and surfaces hello/config-ack/ble events.
export function useEsp32Socket({ ip, onBleWrite }: UseEsp32SocketOpts): Esp32SocketHandle {
  const [state, setState] = useState<Esp32SocketState>({
    status: 'idle',
    hello: null,
    bleConnected: false,
    errorMessage: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef<number>(RECONNECT_MIN_MS);
  const onBleWriteRef = useRef(onBleWrite);
  // Keep the latest callback without forcing reconnects when the parent
  // re-creates the function each render.
  onBleWriteRef.current = onBleWrite;

  const closeQuietly = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    wsRef.current = null;
    try {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
    } catch {
      // Already closed — fine.
    }
  }, []);

  const connect = useCallback(() => {
    if (!ip) {
      setState((s) => ({ ...s, status: 'idle', errorMessage: null }));
      return;
    }

    closeQuietly();
    setState((s) => ({ ...s, status: s.status === 'idle' ? 'connecting' : 'reconnecting' }));

    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${ip}:81/`);
    } catch (e) {
      setState((s) => ({ ...s, status: 'error', errorMessage: e instanceof Error ? e.message : 'invalid url' }));
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelayRef.current = RECONNECT_MIN_MS;
      setState((s) => ({ ...s, status: 'connected', errorMessage: null }));
    };

    ws.onmessage = (ev) => {
      let msg: Esp32Message;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as Esp32Message;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'hello':
          setState((s) => ({ ...s, hello: msg }));
          break;
        case 'ble-write':
          onBleWriteRef.current?.(msg.hex);
          break;
        case 'ble-connected':
          setState((s) => ({ ...s, bleConnected: true }));
          break;
        case 'ble-disconnected':
          setState((s) => ({ ...s, bleConnected: false }));
          break;
        case 'config-ack':
          // hello broadcast follows config-ack from the firmware, so no extra
          // handling needed here — it's mostly a debugging echo.
          break;
        case 'error':
          setState((s) => ({ ...s, errorMessage: msg.message }));
          break;
        default:
          break;
      }
    };

    ws.onerror = () => {
      setState((s) => ({ ...s, status: 'error', errorMessage: 'websocket error' }));
    };

    ws.onclose = () => {
      wsRef.current = null;
      setState((s) => ({ ...s, status: 'reconnecting', bleConnected: false }));
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  }, [ip, closeQuietly]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      closeQuietly();
    };
    // Reconnect whenever the target IP changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ip]);

  const sendConfig = useCallback((cfg: Esp32Config) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'set-config', ...cfg }));
  }, []);

  const reconnect = useCallback(() => {
    reconnectDelayRef.current = RECONNECT_MIN_MS;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    connect();
  }, [connect]);

  return { ...state, sendConfig, reconnect };
}
