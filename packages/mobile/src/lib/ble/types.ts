export type BleConnection = {
  deviceId: string;
  deviceName?: string;
};

export type DiscoveredDevice = {
  deviceId: string;
  name?: string;
  rssi: number;
};

export type DevicePickerFn = (
  subscribe: (onUpdate: (devices: DiscoveredDevice[]) => void) => void,
  registerExternalReject?: (reject: (error: Error) => void) => void,
) => Promise<string>;

export type BluetoothAdapter = {
  isAvailable(): Promise<boolean>;
  requestAndConnect(targetSerial?: string): Promise<BleConnection>;
  disconnect(): Promise<void>;
  write(data: Uint8Array, signal?: AbortSignal): Promise<void>;
  onDisconnect(callback: () => void): () => void;
};
