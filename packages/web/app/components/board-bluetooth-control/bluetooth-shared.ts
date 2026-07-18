// Re-export pure transport constants from the shared BLE protocol package.
export {
  MAX_BLUETOOTH_MESSAGE_SIZE,
  MESSAGE_BODY_MAX_LENGTH,
  AURORA_ADVERTISED_SERVICE_UUID,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  REDBEARLAB_SERVICE_UUID,
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
  splitMessages,
} from '@boardsesh/ble-protocol/transport';

// The Web Bluetooth transport (characteristic probing + chunked write series)
// now lives in the shared, renderer-agnostic ble-protocol package so the web
// app and the Expo-web mobile adapter share one implementation. Re-exported
// here (with the historical `requestBluetoothDevice` name) so existing web
// imports keep resolving.
export {
  getUartCharacteristic,
  getMoonboardWriteCharacteristic,
  writeCharacteristicSeries,
  requestWebBluetoothDevice as requestBluetoothDevice,
} from '@boardsesh/ble-protocol/web-transport';
