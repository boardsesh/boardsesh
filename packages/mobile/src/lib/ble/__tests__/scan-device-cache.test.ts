import { describe, it, expect } from 'vitest';
import { upsertDiscoveredDevice } from '../scan-device-cache';
import type { DiscoveredDevice } from '../types';

// The map key is the cache's own business (name for a serial-named box, id
// otherwise); assert on the rows the picker would see.
function storedDevice(devices: Map<string, DiscoveredDevice>, deviceId: string): DiscoveredDevice | undefined {
  return [...devices.values()].find((device) => device.deviceId === deviceId);
}

describe('upsertDiscoveredDevice', () => {
  it('returns true and stores a first-seen device', () => {
    const devices = new Map<string, DiscoveredDevice>();
    expect(upsertDiscoveredDevice(devices, { deviceId: 'a', name: 'Kilter Board', rssi: -50 })).toBe(true);
    expect(storedDevice(devices, 'a')?.deviceId).toBe('a');
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
    expect(storedDevice(devices, 'a')?.manufacturerData).toBe('4c000215');
    expect(storedDevice(devices, 'a')?.serviceData).toEqual({ 'uuid-1': '0102' });
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

    const stored = storedDevice(devices, 'a');
    expect(stored?.manufacturerData).toBe('aabb');
    expect(stored?.serviceData).toEqual({ 'uuid-1': '01', 'uuid-2': '02' });
  });

  it('keeps two bare-name boxes with different ids as two rows (#5601)', () => {
    // Kilter-built boxes advertise a bare "Kilter Board" with no serial, so two
    // walls in one gym share a name. Both must stay pickable.
    const devices = new Map<string, DiscoveredDevice>();
    expect(upsertDiscoveredDevice(devices, { deviceId: 'wall-a', name: 'Kilter Board', rssi: -50 })).toBe(true);
    expect(upsertDiscoveredDevice(devices, { deviceId: 'wall-b', name: 'Kilter Board', rssi: -70 })).toBe(true);

    expect([...devices.values()].map((device) => device.deviceId)).toEqual(['wall-a', 'wall-b']);
  });

  it('keeps two MoonBoards sharing an advertised name as two rows', () => {
    const devices = new Map<string, DiscoveredDevice>();
    upsertDiscoveredDevice(devices, { deviceId: 'moon-a', name: 'MoonBoard A', rssi: -50 });
    upsertDiscoveredDevice(devices, { deviceId: 'moon-b', name: 'MoonBoard A', rssi: -60 });

    expect([...devices.values()].map((device) => device.deviceId)).toEqual(['moon-a', 'moon-b']);
  });

  it('still folds one serial-named box that reappears under a new peripheral id into one row', () => {
    const devices = new Map<string, DiscoveredDevice>();
    upsertDiscoveredDevice(devices, { deviceId: 'first-id', name: 'Kilter Board#751737@3', rssi: -50 });
    upsertDiscoveredDevice(devices, { deviceId: 'second-id', name: 'Kilter Board#751737@3', rssi: -45 });

    expect([...devices.values()].map((device) => device.deviceId)).toEqual(['second-id']);
  });

  it('drops the unnamed row when the same box later advertises its name', () => {
    const devices = new Map<string, DiscoveredDevice>();
    upsertDiscoveredDevice(devices, { deviceId: 'a', rssi: -50 });
    expect(upsertDiscoveredDevice(devices, { deviceId: 'a', name: 'Kilter Board#751737@3', rssi: -50 })).toBe(true);
    expect([...devices.values()]).toEqual([{ deviceId: 'a', name: 'Kilter Board#751737@3', rssi: -50 }]);

    const bareNamed = new Map<string, DiscoveredDevice>();
    upsertDiscoveredDevice(bareNamed, { deviceId: 'b', rssi: -50 });
    expect(upsertDiscoveredDevice(bareNamed, { deviceId: 'b', name: 'Kilter Board', rssi: -50 })).toBe(true);
    expect([...bareNamed.values()]).toEqual([{ deviceId: 'b', name: 'Kilter Board', rssi: -50 }]);
  });
});
