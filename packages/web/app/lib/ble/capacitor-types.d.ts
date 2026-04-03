interface CapacitorGeolocationPlugin {
  getCurrentPosition(options?: {
    enableHighAccuracy?: boolean;
    timeout?: number;
    maximumAge?: number;
  }): Promise<{
    coords: {
      latitude: number;
      longitude: number;
      accuracy: number;
      altitude: number | null;
      altitudeAccuracy: number | null;
      heading: number | null;
      speed: number | null;
    };
    timestamp: number;
  }>;
  checkPermissions(): Promise<{ location: 'prompt' | 'granted' | 'denied' }>;
  requestPermissions(): Promise<{ location: 'prompt' | 'granted' | 'denied' }>;
}

interface CapacitorKeepAwakePlugin {
  keepAwake(): Promise<void>;
  allowSleep(): Promise<void>;
  isSupported(): Promise<{ isSupported: boolean }>;
  isKeptAwake(): Promise<{ isKeptAwake: boolean }>;
}

interface CapacitorBrowserPlugin {
  open(options: { url: string; toolbarColor?: string }): Promise<void>;
  close(): Promise<void>;
}

interface CapacitorAppPlugin {
  addListener(
    eventName: 'appUrlOpen',
    listenerFunc: (event: { url: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

interface CapacitorGlobal {
  isNativePlatform(): boolean;
  getPlatform(): string;
  Plugins: {
    BluetoothLe?: unknown;
    Geolocation?: CapacitorGeolocationPlugin;
    KeepAwake?: CapacitorKeepAwakePlugin;
    Browser?: CapacitorBrowserPlugin;
    App?: CapacitorAppPlugin;
    [key: string]: unknown;
  };
}

declare global {
  interface Window {
    Capacitor?: CapacitorGlobal;
  }
}

export {};
