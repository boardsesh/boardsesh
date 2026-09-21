import { beforeEach, describe, expect, it, vi } from 'vitest';

const webBluetooth = vi.hoisted(() => ({ available: false }));
vi.mock('../web-adapter', () => ({
  isWebBluetoothAvailable: () => webBluetooth.available,
}));

import { requestBleRuntimePermissionStatus } from '../use-ble-permissions.web';

// #5654: a browser with no Web Bluetooth (Safari, Firefox, every iOS browser)
// read as 'denied', so the /boards quickstart asked the climber to allow a
// permission the browser can't grant, with a Scan again that looped.
describe('requestBleRuntimePermissionStatus on Expo web', () => {
  beforeEach(() => {
    webBluetooth.available = false;
  });

  it('is unsupported, not denied, in a browser with no Web Bluetooth', async () => {
    await expect(requestBleRuntimePermissionStatus()).resolves.toBe('unsupported');
  });

  it('is granted where the browser has Web Bluetooth; its chooser is the consent', async () => {
    webBluetooth.available = true;
    await expect(requestBleRuntimePermissionStatus()).resolves.toBe('granted');
  });
});
