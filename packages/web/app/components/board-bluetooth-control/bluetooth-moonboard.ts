// Re-export all protocol logic from the shared BLE protocol package.
export {
  isMoonboardDeviceName,
  getMoonboardSerialPosition,
  getMoonboardBluetoothPacket,
  type MoonboardPacketResult,
} from '@boardsesh/ble-protocol/moonboard';

import { REDBEARLAB_SERVICE_UUID, UART_SERVICE_UUID } from '@boardsesh/ble-protocol/transport';

// The request-device options live in the shared ble-protocol package (shared
// with the Expo-web mobile adapter); re-export so web consumers keep resolving.
export { MOONBOARD_REQUEST_DEVICE_OPTIONS } from '@boardsesh/ble-protocol/web-transport';

// Newer controllers advertise the Nordic UART service; the original RedBearLab
// LED box advertises the RedBearLab service. Web-only scan constants consumed by
// the LE-scan hook + native adapters.
export const MOONBOARD_SCAN_SERVICE_UUIDS = [UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID] as const;
export const MOONBOARD_OPTIONAL_SERVICE_UUIDS = [UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID] as const;
