// Compatibility exports. Protocol constants and raw transport helpers have one owner.
export {
  MAX_BLUETOOTH_MESSAGE_SIZE,
  MAX_ATT_CHUNK_SIZE,
  INTER_CHUNK_DELAY_MS,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  effectiveChunkSizeForMtu,
  splitMessages,
  writeChunkSeries,
  type BleChunkSeriesOptions,
} from '@boardsesh/ble-core';
export { MESSAGE_BODY_MAX_LENGTH, AURORA_ADVERTISED_SERVICE_UUID } from '@boardsesh/aurora-ble-protocol';
export {
  MOONBOARD_REDBEARLAB_SERVICE_UUID as REDBEARLAB_SERVICE_UUID,
  MOONBOARD_REDBEARLAB_WRITE_CHARACTERISTIC_UUID as REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
} from '@boardsesh/moonboard-ble-protocol';
