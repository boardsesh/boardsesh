import { parseSerialNumber } from '@boardsesh/ble-protocol';
import { classifyRssiStrength, isUsableRssi, type RssiStrength } from './rssi-strength';
import type { DiscoveredDevice } from './types';

// One picker row per physical controller. An Aurora name carries the box's
// serial (`Kilter Board#751737@3`), so it names exactly one box and we key on it:
// the same box can surface under a new peripheral id across scan callbacks, and
// the name folds those back into one row. A name without a serial does not name
// one box: every Kilter-built box advertises a bare `Kilter Board` and every
// MoonBoard the same prefix, so two of them in one gym would share a name key and
// the later advert would overwrite the earlier (#5601). Those key on the id.
function getDiscoveredDeviceKey(device: DiscoveredDevice): string {
  const trimmedName = device.name?.trim();
  return trimmedName && parseSerialNumber(trimmedName) ? trimmedName : device.deviceId;
}

// What a first advert stores when the platform had no usable RSSI for it.
const FALLBACK_RSSI = -100;

// A reading must clear a bucket edge by this much before the bars change, so a
// board hovering on -60 does not flip strong/good (and re-render and re-sort the
// picker) on every advert.
const BUCKET_HYSTERESIS_DB = 4;

// The bucket each stored record was last pushed to the picker with.
const pushedBucketByDevice = new WeakMap<DiscoveredDevice, RssiStrength>();

const BUCKET_RANK: Record<RssiStrength, number> = { weak: 0, good: 1, strong: 2 };

// The bars the picker shows for a scanned board: the bucket it was last pushed
// with, not its raw reading. In-bucket readings update `rssi` in place for the
// sort, so classifying `rssi` on an unrelated re-render would skip the
// hysteresis and leave the bars out of step with what the cache will push next.
export function signalStrengthOf(device: DiscoveredDevice): RssiStrength {
  return pushedBucketByDevice.get(device) ?? classifyRssiStrength(device.rssi);
}

function nextBucket(pushedBucket: RssiStrength, rssi: number): RssiStrength {
  const candidate = classifyRssiStrength(rssi);
  if (candidate === pushedBucket) return pushedBucket;
  // Move as far toward the reading as it clears with the margin: a jump from
  // -85 to -58 lands on good (it cleared -80 by 22 dB), not stuck on weak. The
  // margin is smaller than a bucket, so this never lands past the pushed bucket
  // the wrong way.
  const movingUp = BUCKET_RANK[candidate] > BUCKET_RANK[pushedBucket];
  return classifyRssiStrength(movingUp ? rssi - BUCKET_HYSTERESIS_DB : rssi + BUCKET_HYSTERESIS_DB);
}

function storeNewDevice(devices: Map<string, DiscoveredDevice>, deviceKey: string, device: DiscoveredDevice): void {
  const stored = isUsableRssi(device.rssi) ? device : { ...device, rssi: FALLBACK_RSSI };
  pushedBucketByDevice.set(stored, classifyRssiStrength(stored.rssi));
  devices.set(deviceKey, stored);
}

export function upsertDiscoveredDevice(devices: Map<string, DiscoveredDevice>, device: DiscoveredDevice): boolean {
  const deviceKey = getDiscoveredDeviceKey(device);
  const existingDevice = devices.get(deviceKey);
  if (existingDevice?.deviceId === device.deviceId && existingDevice.name === device.name) {
    // Same board, unchanged identity: no picker re-push unless the signal bars
    // change bucket (below). BLE splits the advertisement across packets
    // (ADV_IND vs SCAN_RSP), so manufacturer/service data can arrive in a later
    // callback than the name. Enrich the stored record in place (the connect-time
    // telemetry reads it back later) rather than letting the first packet win and
    // dropping a payload that showed up second.
    if (device.manufacturerData !== undefined) existingDevice.manufacturerData = device.manufacturerData;
    if (device.serviceData !== undefined) {
      existingDevice.serviceData = { ...existingDevice.serviceData, ...device.serviceData };
    }
    // Keep RSSI fresh so the sort and the bars follow the climber walking
    // toward a box. Only a bucket change (with hysteresis) re-pushes, so
    // duplicate adverts do not re-render the picker at advert rate. A new object
    // is stored then, because the memoized DeviceCard compares the device by
    // reference.
    if (isUsableRssi(device.rssi) && device.rssi !== existingDevice.rssi) {
      const pushedBucket = signalStrengthOf(existingDevice);
      const bucket = nextBucket(pushedBucket, device.rssi);
      if (bucket !== pushedBucket) {
        const refreshedDevice = { ...existingDevice, rssi: device.rssi };
        pushedBucketByDevice.set(refreshedDevice, bucket);
        devices.set(deviceKey, refreshedDevice);
        return true;
      }
      existingDevice.rssi = device.rssi;
    }
    return false;
  }

  for (const [existingKey, existingDeviceForKey] of devices.entries()) {
    if (existingKey !== deviceKey && existingDeviceForKey.deviceId === device.deviceId) {
      devices.delete(existingKey);
    }
  }

  storeNewDevice(devices, deviceKey, device);
  return true;
}
