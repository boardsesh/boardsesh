import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseApiLevel, parseBoardTypeFromDeviceName, parseSerialNumber } from '@boardsesh/ble-protocol';

const mockBleManager = vi.hoisted(() => ({
  state: vi.fn(async () => 'Unsupported'),
  onStateChange: vi.fn(),
}));

vi.mock('react-native-ble-plx', () => ({
  State: {
    PoweredOn: 'PoweredOn',
    PoweredOff: 'PoweredOff',
    Unknown: 'Unknown',
    Resetting: 'Resetting',
    Unauthorized: 'Unauthorized',
    Unsupported: 'Unsupported',
  },
}));
vi.mock('../ble-manager', () => ({ bleManager: mockBleManager }));

import {
  SCREENSHOT_FAKE_BLE_DEVICE_ID,
  ScreenshotFakeBleAdapter,
  screenshotFakeDeviceName,
} from '../screenshot-fake-adapter';
import { waitForBlePoweredOn } from '../availability';

afterEach(() => {
  vi.unstubAllEnvs();
  mockBleManager.state.mockClear();
});

describe('ScreenshotFakeBleAdapter', () => {
  it('is available and connects without opening the device picker', async () => {
    const adapter = new ScreenshotFakeBleAdapter('aurora', { boardName: 'kilter' });

    expect(await adapter.isAvailable()).toBe(true);
    expect(await adapter.requestAndConnect('751737')).toEqual({
      deviceId: SCREENSHOT_FAKE_BLE_DEVICE_ID,
      deviceName: 'Kilter Board@3',
    });
  });

  it('accepts writes only while connected', async () => {
    const adapter = new ScreenshotFakeBleAdapter('aurora', { boardName: 'kilter' });
    const frame = new Uint8Array([1, 2, 3]);

    await expect(adapter.write(frame)).rejects.toThrow('Not connected');
    await adapter.requestAndConnect();
    await expect(adapter.write(frame)).resolves.toBeUndefined();
    await adapter.disconnect();
    await expect(adapter.write(frame)).rejects.toThrow('Not connected');
  });

  it('rejects an already-aborted write the way the real adapters do', async () => {
    const adapter = new ScreenshotFakeBleAdapter('aurora', { boardName: 'kilter' });
    await adapter.requestAndConnect();
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.write(new Uint8Array([1]), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('never reports a drop, including on a deliberate disconnect', async () => {
    const adapter = new ScreenshotFakeBleAdapter('aurora', { boardName: 'kilter' });
    const onDrop = vi.fn();
    const unsubscribe = adapter.onDisconnect(onDrop);
    await adapter.requestAndConnect();
    await adapter.disconnect();

    expect(onDrop).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('screenshotFakeDeviceName', () => {
  it('names an Aurora board the way its controller would, on the v3 protocol and with no serial', () => {
    for (const boardName of ['kilter', 'tension']) {
      const deviceName = screenshotFakeDeviceName('aurora', boardName);
      expect(parseBoardTypeFromDeviceName(deviceName)).toBe(boardName);
      expect(parseApiLevel(deviceName)).toBe(3);
      expect(parseSerialNumber(deviceName)).toBeUndefined();
    }
    expect(screenshotFakeDeviceName('aurora', 'kilter')).toBe('Kilter Board@3');
  });

  it('names a MoonBoard with its advertised prefix', () => {
    expect(screenshotFakeDeviceName('moonboard', 'moonboard')).toBe('MoonBoard');
    expect(screenshotFakeDeviceName('moonboard')).toBe('MoonBoard');
  });
});

describe('waitForBlePoweredOn under fake Bluetooth', () => {
  it('reads the real radio unless both screenshot flags are 1', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
    expect(await waitForBlePoweredOn()).toBe(false);
    expect(mockBleManager.state).toHaveBeenCalledTimes(1);
  });

  it('reports a powered-on radio without touching it when both flags are 1', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
    expect(await waitForBlePoweredOn()).toBe(true);
    expect(mockBleManager.state).not.toHaveBeenCalled();
  });
});
