import { isNativeApp, getPlatform } from '../ble/capacitor-utils';

interface NativeWebSocketConnectOptions {
  serverUrl: string;
  sessionId: string;
  authToken?: string | null;
  wsUrl?: string;
}

interface NativeWebSocketPlugin {
  connect(options: NativeWebSocketConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  sendOperation(options: { query: string; variables?: string; operationId: string }): Promise<void>;
  subscribe(options: { query: string; variables?: string; subscriptionId: string }): Promise<void>;
  unsubscribe(options: { subscriptionId: string }): Promise<void>;
  updateAuthToken(options: { token: string }): Promise<void>;
  setWebviewActive(options: { active: boolean }): Promise<void>;
  flushBuffer(): Promise<void>;
  getConnectionState(): Promise<{ connected: boolean; reconnectAttempt: number }>;
  addListener(
    event: string,
    callback: (data: Record<string, unknown>) => void,
  ): { remove: () => void } | Promise<{ remove: () => void }>;
}

/**
 * Returns the NativeWebSocket Capacitor plugin if running on iOS native.
 * Returns null on web or Android.
 */
export function getNativeWebSocketPlugin(): NativeWebSocketPlugin | null {
  if (!isNativeApp() || getPlatform() !== 'ios') return null;
  const plugins = window.Capacitor?.Plugins;
  if (!plugins) return null;
  return (plugins.NativeWebSocket as NativeWebSocketPlugin | undefined) ?? null;
}

/**
 * Returns true if the native WebSocket plugin is available (iOS native app only).
 */
export function isNativeWebSocketAvailable(): boolean {
  return isNativeApp() && getPlatform() === 'ios';
}

export type { NativeWebSocketConnectOptions, NativeWebSocketPlugin };
