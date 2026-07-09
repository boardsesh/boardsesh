import { describe, it, expect } from 'vitest';
import { upsertDiscoveredDevice } from '../scan-device-cache';
import type { DiscoveredDevice } from '../types';

describe('upsertDiscoveredDevice', () => {
  it('returns true and stores a first-seen device', () => {
    const devices = new Map<string, DiscoveredDevice>();
    expect(upsertDiscoveredDevice(devices, { deviceId: 'a', name: 'Kilter Board', rssi: -50 })).toBe(true);
    expect(devices.get('Kilter Board')?.deviceId).toBe('a');
  });

  it('enriches the stored record with recon data that arrives in a later packet', () => {
    // BLE splits the advertisement across packets: the name lands first, the
    // manufacturer/service data in a later callback with the same identity.
    const devices = new Map<string, DiscoveredDevice>();
    upsertDiscoveredDevice(devices, { deviceId: 'a', name: 'Kilter Board', rssi: -50 });

    const pushedAgain = upsertDiscoveredDevice(devices, {
      deviceId: 'a',
      name: 'Kilter Board',
      rssi: -50,
      manufacturerData: '4c000215',
      serviceData: { 'uuid-1': '0102' },
    });

    // No picker re-push (identity unchanged) but the payload must be retained.
    expect(pushedAgain).toBe(false);
    expect(devices.get('Kilter Board')?.manufacturerData).toBe('4c000215');
    expect(devices.get('Kilter Board')?.serviceData).toEqual({ 'uuid-1': '0102' });
  });

  it('merges service-data entries across packets and does not clobber existing manufacturer data', () => {
    const devices = new Map<string, DiscoveredDevice>();
    upsertDiscoveredDevice(devices, {
      deviceId: 'a',
      name: 'Board',
      rssi: -50,
      manufacturerData: 'aabb',
      serviceData: { 'uuid-1': '01' },
    });
    upsertDiscoveredDevice(devices, {
      deviceId: 'a',
      name: 'Board',
      rssi: -50,
      serviceData: { 'uuid-2': '02' },
    });

    const stored = devices.get('Board');
    expect(stored?.manufacturerData).toBe('aabb');
    expect(stored?.serviceData).toEqual({ 'uuid-1': '01', 'uuid-2': '02' });
  });
});
