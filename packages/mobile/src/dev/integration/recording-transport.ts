import { installBluetoothTransport, type BluetoothTransportRuntime } from '../../lib/ble/transport-runtime';
import { RecordingBleAdapter } from './RecordingBleAdapter';
const recordingTransport: BluetoothTransportRuntime = {
  createAdapter: (_picker, family, options) => new RecordingBleAdapter(family, options),
  waitForPoweredOn: async () => true,
  requestPermissions: async () => 'granted',
  discovery: 'external',
  widgetCommandDelivery: 'javascript',
};
export function prepareRecordingTransport(): void {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE === '1') installBluetoothTransport(recordingTransport);
}
