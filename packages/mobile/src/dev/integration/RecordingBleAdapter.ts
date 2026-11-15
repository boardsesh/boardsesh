/** Dev-only simulator transport for recording ordinary application interactions. */
import type {
  BleAdapterOptions,
  BleConnection,
  BleDisconnectInfo,
  BluetoothAdapter,
  BoardScanFamily,
} from '../../lib/ble/types';

export const RECORDING_BLE_DEVICE_ID = 'screenshot-fake-board';

/**
 * The advertised name a real controller for this board would carry.
 *
 * Aurora names end in `@3` so `parseApiLevel` picks the v3 encoder (the v2
 * power ladder can refuse dense climbs as a dark wall). There is deliberately
 * no `#serial`: a serial would be recorded against the board and remembered for
 * reconnects, and no real controller owns it. Without one, board presence binds
 * by config, exactly as it does for a real bare-name box.
 */
export function recordingDeviceName(scanFamily: BoardScanFamily, boardName?: string): string {
  if (boardName === 'moonboard' || (!boardName && scanFamily === 'moonboard')) return 'MoonBoard';
  if (boardName === 'woods') return 'Woods Board';
  const brand = boardName ? `${boardName.charAt(0).toUpperCase()}${boardName.slice(1)}` : 'Kilter';
  return `${brand} Board@3`;
}

const NO_SUBSCRIPTION = (): void => {};

export class RecordingBleAdapter implements BluetoothAdapter {
  readonly persistConnection = false;
  private connected = false;
  private readonly deviceName: string;

  constructor(scanFamily: BoardScanFamily, options?: BleAdapterOptions) {
    this.deviceName = recordingDeviceName(scanFamily, options?.boardName);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  // The picker is skipped, and a remembered board's serial or device id is
  // ignored: the pretend board is always the one in range.
  async requestAndConnect(_targetSerial?: string, _targetDeviceId?: string): Promise<BleConnection> {
    this.connected = true;
    return { deviceId: RECORDING_BLE_DEVICE_ID, deviceName: this.deviceName };
  }

  // A deliberate disconnect never reports a drop, same as the real adapters.
  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async write(_data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Write aborted', 'AbortError');
    if (!this.connected) throw new Error('Not connected to a board');
  }

  // The fake link never drops on its own, so there is nothing to report.
  onDisconnect(_callback: (info?: BleDisconnectInfo) => void): () => void {
    return NO_SUBSCRIPTION;
  }
}
