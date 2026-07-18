// Re-export all protocol logic from the shared BLE protocol package.
export {
  type LedPlacements,
  type LedColorOverrides,
  type BluetoothPacketResult,
  checksum,
  wrapBytes,
  parseApiLevel,
  parseSerialNumber,
  parseBoardTypeFromDeviceName,
  encodePositionV3,
  encodeColorV3,
  encodePositionAndColorV3,
  computeV2Scale,
  scaledColorV2,
  encodePositionAndColorV2,
  getAuroraBluetoothPacket,
} from '@boardsesh/ble-protocol/aurora';

import { AURORA_ADVERTISED_SERVICE_UUID, UART_SERVICE_UUID } from '@boardsesh/ble-protocol/transport';

// The request-device options live in the shared ble-protocol package (shared
// with the Expo-web mobile adapter); re-export so web consumers keep resolving.
export { AURORA_REQUEST_DEVICE_OPTIONS } from '@boardsesh/ble-protocol/web-transport';

// --- Web-only scan constants (consumed by the LE-scan hook + native adapters) ---

export const AURORA_SCAN_SERVICE_UUIDS = [AURORA_ADVERTISED_SERVICE_UUID] as const;
export const AURORA_OPTIONAL_SERVICE_UUIDS = [UART_SERVICE_UUID] as const;
