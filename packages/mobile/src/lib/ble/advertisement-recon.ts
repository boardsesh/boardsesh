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

  // Accumulate per device across the whole window and emit once at the end. BLE
  // splits the advertisement across packets (ADV_IND vs SCAN_RSP), so the name,
  // manufacturer data, and service data can land in separate callbacks — emitting
  // on the first board-matching packet would miss whatever arrives later.
  type ReconEntry = {
    name?: string;
    serviceUuids: Set<string>;
    manufacturerData?: string;
    serviceData?: Record<string, string>;
    rssi?: number;
  };
  const entries = new Map<string, ReconEntry>();

  return new Promise<number>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      void bleManager.stopDeviceScan();
      for (const entry of entries.values()) {
        track(SHARED_EVENTS.BleAdvertisementRecon, {
          reconCorrelationId,
          family: classifyFamily(entry.name, [...entry.serviceUuids]),
          deviceName: entry.name ?? undefined,
          deviceNamePresent: !!entry.name,
          parsedSerial: parseSerialNumber(entry.name) ?? undefined,
          apiLevelFromName: parseApiLevel(entry.name),
          rssi: entry.rssi ?? undefined,
          serviceUuids: entry.serviceUuids.size > 0 ? JSON.stringify([...entry.serviceUuids]) : undefined,
          bleManufacturerData: entry.manufacturerData,
          bleManufacturerCompanyId: manufacturerCompanyId(entry.manufacturerData),
          bleServiceData: entry.serviceData ? JSON.stringify(entry.serviceData) : undefined,
        });
      }
      resolve(entries.size);
    };

    void bleManager.startDeviceScan(null, null, (error, device) => {
      if (error || settled) {
        finish();
        return;
      }
      if (!device) return;

      const name = device.localName ?? device.name ?? undefined;
      const serviceUuids = [...(device.serviceUUIDs ?? []), ...(device.overflowServiceUUIDs ?? [])];
      // Only keep board-like peripherals so unrelated BLE devices never reach
      // analytics. Classify on this packet's fields plus anything already merged.
      const existing = entries.get(device.id);
      if (!existing && entries.size >= MAX_RECON_DEVICES) return;
      const mergedName = name ?? existing?.name;
      const mergedServiceUuids = new Set([...(existing?.serviceUuids ?? []), ...serviceUuids]);
      if (!classifyFamily(mergedName, [...mergedServiceUuids])) return;

      const entry: ReconEntry = existing ?? { serviceUuids: new Set() };
      entry.name = mergedName;
      entry.serviceUuids = mergedServiceUuids;
      entry.manufacturerData = base64ToHex(device.manufacturerData) ?? entry.manufacturerData;
      const serviceData = serviceDataToHex(device.serviceData);
      if (serviceData) entry.serviceData = { ...entry.serviceData, ...serviceData };
      if (device.rssi != null) entry.rssi = device.rssi;
      entries.set(device.id, entry);
    });

    timeoutId = setTimeout(finish, RECON_SCAN_MS);
  });
}
