// Pure BLE transport constants and utilities.
// Platform-agnostic — no Web Bluetooth DOM types.

export const MAX_BLUETOOTH_MESSAGE_SIZE = 20;
export const MESSAGE_BODY_MAX_LENGTH = 255;

export const AURORA_ADVERTISED_SERVICE_UUID = '4488b571-7806-4df6-bcff-a2897e4953ff';
export const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const UART_WRITE_CHARACTERISTIC_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

// Original MoonBoard LED box (RedBearLab BLE Shield) — the first-generation
// controller the official Moon app still drives. Its data service is the
// RedBearLab UUID family and LED commands are written to 713d0003, which
// advertises only `.write` (no write-without-response). Newer MoonBoard
// controllers use the Nordic UART service above. See
// docs/MOONBOARD_BLUETOOTH_PROTOCOL_SPEC.md §2.1.
export const REDBEARLAB_SERVICE_UUID = '713d0000-503e-4c75-ba94-3148f18d941e';
export const REDBEARLAB_WRITE_CHARACTERISTIC_UUID = '713d0003-503e-4c75-ba94-3148f18d941e';

export const INTER_CHUNK_DELAY_MS = 5;

export const splitMessages = (buffer: Uint8Array) =>
  Array.from({ length: Math.ceil(buffer.length / MAX_BLUETOOTH_MESSAGE_SIZE) }, (_, i) =>
    buffer.slice(i * MAX_BLUETOOTH_MESSAGE_SIZE, (i + 1) * MAX_BLUETOOTH_MESSAGE_SIZE),
  );
