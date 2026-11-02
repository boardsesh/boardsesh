import { describe, it, expect, vi } from 'vitest';

// Stands in for ble-plx's constructor, whose native side creates a
// CBCentralManager: on iOS that is what shows the Bluetooth alert.
const bleManagerConstructor = vi.hoisted(() => vi.fn());

vi.mock('react-native-ble-plx', () => ({
  BleManager: class {
    constructor(options: unknown) {
      bleManagerConstructor(options);
    }
  },
}));

import { getBleManager } from '../ble-manager';

describe('getBleManager', () => {
  it('creates nothing at import, so launch never asks for Bluetooth', () => {
    expect(bleManagerConstructor).not.toHaveBeenCalled();
  });

  it('creates the manager on first use, once, with state restoration', () => {
    const first = getBleManager();
    const second = getBleManager();

    expect(first).toBe(second);
    expect(bleManagerConstructor).toHaveBeenCalledOnce();
    expect(bleManagerConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ restoreStateIdentifier: 'boardsesh-ble-restore' }),
    );
  });
});
