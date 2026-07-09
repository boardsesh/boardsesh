// Consent-driven BLE advertisement reconnaissance. Runs only when a user submits
// a bug report with the "Bluetooth trouble" toggle on. Scans (without connecting)
// for in-range boards and ships each one's raw advertisement payload to PostHog,
// so we can find where newer bare-name Kilter boxes stash their serial / LED
// generation (in manufacturer data or service data) now that they've dropped the
// `#serial@apiLevel` name suffix. Parses nothing itself — capture only.
//
// Uses the ble-plx `bleManager` directly (scanning needs no native module and
// works on both platforms), scans UNFILTERED so bare-name and MoonBoard boxes
// surface, and only emits for peripherals that look like a board (by advertised
// service UUID or name) so unrelated BLE devices never reach analytics.

import { parseApiLevel, parseSerialNumber } from '@boardsesh/ble-protocol';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { bleManager } from './ble-manager';
import { waitForBlePoweredOn } from './availability';
import { requestBleRuntimePermissions } from './use-ble-permissions';
import { isLikelyBoardDevice } from './board-device-filter';
import { base64ToHex, serviceDataToHex } from './base64';
import { manufacturerCompanyId } from './advertisement';
import type { BoardScanFamily } from './types';

const RECON_SCAN_MS = 8_000;
const MAX_RECON_DEVICES = 30;

function classifyFamily(name: string | undefined, serviceUuids: string[]): BoardScanFamily | undefined {
  if (isLikelyBoardDevice({ name, serviceUuids, scanFamily: 'aurora' })) return 'aurora';
  if (isLikelyBoardDevice({ name, serviceUuids, scanFamily: 'moonboard' })) return 'moonboard';
  return undefined;
}

/**
 * Scan for in-range boards and emit one `BLE Advertisement Recon` event per
 * distinct board discovered, tagged with `reconCorrelationId` so the batch joins
 * to the bug report. Resolves with the number of boards captured. Never throws:
 * denied permission / powered-off Bluetooth resolves 0.
 */
export async function runBleAdvertisementRecon(reconCorrelationId: string): Promise<number> {
  const permissionsGranted = await requestBleRuntimePermissions();
  if (!permissionsGranted) return 0;
  const poweredOn = await waitForBlePoweredOn();
  if (!poweredOn) return 0;

  const seen = new Set<string>();
  return new Promise<number>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      bleManager.stopDeviceScan();
      resolve(seen.size);
    };

    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error || settled) {
        finish();
        return;
      }
      if (!device || seen.has(device.id)) return;

      const name = device.localName ?? device.name ?? undefined;
      const serviceUuids = [...(device.serviceUUIDs ?? []), ...(device.overflowServiceUUIDs ?? [])];
      const family = classifyFamily(name, serviceUuids);
      if (!family) return;

      seen.add(device.id);
      const serviceData = serviceDataToHex(device.serviceData);
      const manufacturerData = base64ToHex(device.manufacturerData);
      track(SHARED_EVENTS.BleAdvertisementRecon, {
        reconCorrelationId,
        family,
        deviceName: name ?? undefined,
        deviceNamePresent: !!name,
        parsedSerial: parseSerialNumber(name) ?? undefined,
        apiLevelFromName: parseApiLevel(name),
        rssi: device.rssi ?? undefined,
        serviceUuids: serviceUuids.length > 0 ? JSON.stringify(serviceUuids) : undefined,
        bleManufacturerData: manufacturerData,
        bleManufacturerCompanyId: manufacturerCompanyId(manufacturerData),
        bleServiceData: serviceData ? JSON.stringify(serviceData) : undefined,
      });

      if (seen.size >= MAX_RECON_DEVICES) finish();
    });

    timeoutId = setTimeout(finish, RECON_SCAN_MS);
  });
}
