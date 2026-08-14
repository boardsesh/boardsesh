export type PluginListenerHandle = {
  remove(): Promise<void>;
};

/** Scan result from the Capacitor BLE plugin's requestLEScan callback. */
export type CapacitorScanResult = {
  device: { deviceId: string; name?: string };
  localName?: string;
  rssi: number;
};

export type BleConnection = {
  deviceId: string;
  deviceName?: string;
};

/** A BLE device discovered during scanning. */
export type DiscoveredDevice = {
  deviceId: string;
  name?: string;
  rssi: number;
};

/**
 * Function provided by the React layer to display a custom device picker.
 * Called with a `subscribe` function that the picker uses to receive
 * live device list updates. Must resolve with a deviceId when the user
 * selects a device, or reject/throw to cancel.
 */
export type DevicePickerFn = (subscribe: (onUpdate: (devices: DiscoveredDevice[]) => void) => void) => Promise<string>;

/** Minimal BLE plugin interface for scan-only consumers (e.g. discovery scroll). */
export type BleScanPlugin = {
  initialize(): Promise<void>;
  isEnabled(): Promise<{ value: boolean }>;
  requestLEScan?(options: { services?: string[] }): Promise<void>;
  stopLEScan?(): Promise<void>;
  addListener(eventName: string, callback: (data: Record<string, unknown>) => void): Promise<PluginListenerHandle>;
};

export type BluetoothAdapter = {
  /** Check if BLE is available and enabled */
  isAvailable(): Promise<boolean>;

  /**
   * Scan for and connect to a board. Shows platform-appropriate device picker.
   * If `targetSerial` is provided, auto-selects the device matching that serial
   * number instead of showing the picker (for quick-start flows).
   */
  requestAndConnect(targetSerial?: string): Promise<BleConnection>;

  /** Disconnect from the current device */
  disconnect(): Promise<void>;

  /**
   * Write a complete board payload to the UART characteristic.
   * The adapter handles transport-level chunking internally.
   *
   * If `signal` is provided and aborted, remaining chunks are skipped
   * and the method throws an `AbortError`.
   */
  write(data: Uint8Array, signal?: AbortSignal): Promise<void>;

  /** Register a callback for disconnection events. Returns an unsubscribe function. */
  onDisconnect(callback: () => void): () => void;

  /**
   * Optional native-only board configuration used for background BLE writes.
   * Existing adapters ignore this, which keeps older app shells compatible.
   */
  configureBoard?(options: {
    boardName: string;
    layoutId: number;
    sizeId: number;
    apiLevel?: number;
    deviceName?: string;
    colorOverrides?: Record<string, string>;
    /** MoonBoard "V2" additional-LED feature — see BoardBleConfiguration.swift. */
    lightAdjacentHolds?: boolean;
  }): Promise<void>;
};
