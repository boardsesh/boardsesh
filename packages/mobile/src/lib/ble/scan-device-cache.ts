import type { DiscoveredDevice } from './types';

function getDiscoveredDeviceKey(device: DiscoveredDevice): string {
  const trimmedName = device.name?.trim();
  return trimmedName ? trimmedName : device.deviceId;
}

export function upsertDiscoveredDevice(devices: Map<string, DiscoveredDevice>, device: DiscoveredDevice): boolean {
  const deviceKey = getDiscoveredDeviceKey(device);
  const existingDevice = devices.get(deviceKey);
  if (existingDevice?.deviceId === device.deviceId && existingDevice.name === device.name) {
    // Same board, unchanged identity — no picker re-push. But BLE splits the
    // advertisement across packets (ADV_IND vs SCAN_RSP), so manufacturer/service
    // data can arrive in a later callback than the name. Enrich the stored record
    // in place (the connect-time telemetry reads it back later) rather than
    // letting the first packet win and dropping a payload that showed up second.
    if (device.manufacturerData !== undefined) existingDevice.manufacturerData = device.manufacturerData;
    if (device.serviceData !== undefined) {
      existingDevice.serviceData = { ...existingDevice.serviceData, ...device.serviceData };
    }
    return false;
  }

  for (const [existingKey, existingDeviceForKey] of devices.entries()) {
    if (existingKey !== deviceKey && existingDeviceForKey.deviceId === device.deviceId) {
      devices.delete(existingKey);
    }
  }

  devices.set(deviceKey, device);
  return true;
}
