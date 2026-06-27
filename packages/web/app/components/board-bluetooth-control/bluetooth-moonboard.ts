// Re-export all protocol logic from the shared BLE protocol package.
export {
  isMoonboardDeviceName,
  getMoonboardSerialPosition,
  getMoonboardBluetoothPacket,
  type MoonboardPacketResult,
} from '@boardsesh/ble-protocol/moonboard';

import { REDBEARLAB_SERVICE_UUID, UART_SERVICE_UUID } from '@boardsesh/ble-protocol/transport';
import { MOONBOARD_DEVICE_NAME_PREFIXES } from '@boardsesh/board-constants/moonboard';

// Newer controllers advertise the Nordic UART service; the original RedBearLab
// LED box advertises the RedBearLab service. List both so a board advertising
// either is discoverable, and so getPrimaryService can reach either after
// connect (Web Bluetooth blocks access to services not in optionalServices).
export const MOONBOARD_SCAN_SERVICE_UUIDS = [UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID] as const;
export const MOONBOARD_OPTIONAL_SERVICE_UUIDS = [UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID] as const;

export const MOONBOARD_REQUEST_DEVICE_OPTIONS: RequestDeviceOptions = {
  filters: [
    ...MOONBOARD_SCAN_SERVICE_UUIDS.map((service) => ({ services: [service] })),
    ...MOONBOARD_DEVICE_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
  ],
  optionalServices: [...MOONBOARD_OPTIONAL_SERVICE_UUIDS],
};
