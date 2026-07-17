import type { BleManager } from 'react-native-ble-plx';

const noopSubscription = { remove: () => {} };
const unavailable = () => Promise.reject(new Error('Bluetooth is not available on web yet'));

export const bleManager = {
  state: () => Promise.resolve('PoweredOff'),
  onStateChange: () => noopSubscription,
  startDeviceScan: () => {},
  stopDeviceScan: () => {},
  connectToDevice: unavailable,
  cancelDeviceConnection: unavailable,
  onDeviceDisconnected: () => noopSubscription,
  destroy: () => {},
} as unknown as BleManager;
