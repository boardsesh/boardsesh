import type { DiscoveredDevice } from './types';

function getDiscoveredDeviceKey(device: DiscoveredDevice): string {
  const trimmedName = device.name?.trim();
  return trimmedName ? trimmedName : device.deviceId;
}

export function upsertDiscoveredDevice(devices: Map<string, DiscoveredDevice>, device: DiscoveredDevice): boolean {
  const deviceKey = getDiscoveredDeviceKey(device);
  const existingDevice = devices.get(deviceKey);
  if (existingDevice?.deviceId === device.deviceId && existingDevice.name === device.name) {
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
