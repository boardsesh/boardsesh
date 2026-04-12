export interface BleConnection {
  deviceId: string;
  deviceName?: string;
}

/** A BLE device discovered during scanning. */
export interface DiscoveredDevice {
  deviceId: string;
  name?: string;
  rssi: number;
}

/**
 * Function provided by the React layer to display a custom device picker.
 * Called with a `subscribe` function that the picker uses to receive
 * live device list updates. Must resolve with a deviceId when the user
 * selects a device, or reject/throw to cancel.
 */
export type DevicePickerFn = (
  subscribe: (onUpdate: (devices: DiscoveredDevice[]) => void) => void,
) => Promise<string>;

export interface BluetoothAdapter {
  /** Check if BLE is available and enabled */
  isAvailable(): Promise<boolean>;

  /** Scan for and connect to a board. Shows platform-appropriate device picker. */
  requestAndConnect(): Promise<BleConnection>;

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
}
