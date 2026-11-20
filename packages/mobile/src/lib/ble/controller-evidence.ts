// Diagnostic observations, never a manufacturer identity decoder. Raw handles
// and name-derived serials remain separate from any future verified identity.
import { base64ToHex, serviceDataToHex } from './base64';

export type BleEvidenceDevice = {
  deviceId: string;
  handleKind: 'android_address' | 'ios_uuid' | 'browser_origin' | 'unknown';
  localName?: string;
  cachedName?: string;
  serviceUuids: string[];
  manufacturerData?: string;
  serviceData?: Record<string, string>;
  rawScanRecords?: string[];
  rawScanRecordStatus: 'supported' | 'unsupported';
  observedAt?: string;
  advertisementStatus: 'observed' | 'cached' | 'not_observed';
  matchBasis: 'board_name' | 'board_service' | 'generic_transport' | 'selected' | 'unknown';
  truncated: boolean;
  originalLengths: Record<string, number>;
};
export type BleEvidenceBatch = {
  version: 1;
  scanId: string;
  source: string;
  devices: BleEvidenceDevice[];
  complete: boolean;
  droppedCount: number;
  capability: 'supported' | 'unsupported';
};
export type BleConnectionEvidence = {
  scan: BleEvidenceBatch;
  selectedDeviceId?: string;
  discoveredServices?: string[];
  discoveredServicesOriginalCount?: number;
  discoveryMode?: 'targeted' | 'full';
  discoveryOutcome?: 'pending' | 'complete' | 'failed';
  writeServiceUuid?: string;
  writeCharacteristicUuid?: string;
};
export type EvidencePacket = {
  deviceId: string;
  localName?: string | null;
  cachedName?: string | null;
  serviceUuids?: string[];
  manufacturerData?: string;
  serviceData?: Record<string, string>;
  rawScanRecord?: string;
};
const MAX_PENDING = 128;
const MAX_DEVICES = 30;
const MAX_HEX = 512 * 2;
const MAX_EVENT_BYTES = 16 * 1024;
let sequence = 0;
export function createBleEvidenceId(): string {
  sequence += 1;
  return `ble-${Date.now()}-${sequence}`;
}
function basisFor(
  device: Pick<BleEvidenceDevice, 'localName' | 'cachedName' | 'serviceUuids'>,
): BleEvidenceDevice['matchBasis'] {
  const name = device.localName ?? device.cachedName ?? '';
  if (/^(moonboard|woods|kilter|tension|grasshopper|touchstone|decoy|soill)(?:[\s#@-]|$)/i.test(name))
    return 'board_name';
  if (
    device.serviceUuids.some((uuid) =>
      [
        '4488b571-7806-4df6-bcff-a2897e4953ff',
        '2c9285bc-dfd0-4fd8-a13d-393660f8a060',
        '7a112233-4455-6677-8899-aabbccddee01',
      ].includes(uuid.toLowerCase()),
    )
  )
    return 'board_service';
  if (
    device.serviceUuids.some((uuid) =>
      ['6e400001-b5a3-f393-e0a9-e50e24dcca9e', '713d0000-503e-4c75-ba94-3148f18d941e'].includes(uuid.toLowerCase()),
    )
  )
    return 'generic_transport';
  return 'unknown';
}
export function evidenceHandleKind(platform: string): BleEvidenceDevice['handleKind'] {
  return platform === 'android'
    ? 'android_address'
    : platform === 'ios'
      ? 'ios_uuid'
      : platform === 'web'
        ? 'browser_origin'
        : 'unknown';
}
export function blePlxEvidencePacket(device: {
  id: string;
  localName?: string | null;
  name?: string | null;
  serviceUUIDs?: string[] | null;
  overflowServiceUUIDs?: string[] | null;
  manufacturerData?: string | null;
  serviceData?: Record<string, string> | null;
  rawScanRecord?: string | null;
}): EvidencePacket {
  return {
    deviceId: device.id,
    localName: device.localName,
    cachedName: device.name,
    serviceUuids: [...(device.serviceUUIDs ?? []), ...(device.overflowServiceUUIDs ?? [])],
    manufacturerData: base64ToHex(device.manufacturerData),
    serviceData: serviceDataToHex(device.serviceData),
    rawScanRecord: base64ToHex(device.rawScanRecord),
  };
}
export class BleEvidenceCollector {
  readonly scanId: string;
  private readonly entries = new Map<string, BleEvidenceDevice>();
  private droppedCount = 0;
  private selectedDeviceId?: string;
  select(deviceId: string): void {
    this.selectedDeviceId = deviceId;
  }
  constructor(
    private readonly source: string,
    private readonly platform: string,
    scanId = createBleEvidenceId(),
  ) {
    this.scanId = scanId;
  }
  observe(packet: EvidencePacket): BleEvidenceDevice {
    const existing = this.entries.get(packet.deviceId);
    const originalLengths = { ...existing?.originalLengths };
    let truncated = existing?.truncated ?? false;
    const bound = (key: string, text: string | null | undefined, limit: number): string | undefined => {
      if (text == null) return undefined;
      originalLengths[key] = Math.max(originalLengths[key] ?? 0, text.length);
      if (text.length > limit) truncated = true;
      const bounded = text.slice(0, limit);
      return /[\uD800-\uDBFF]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
    };
    const services = [
      ...new Set(
        [...(existing?.serviceUuids ?? []), ...(packet.serviceUuids ?? [])].map((uuid) =>
          uuid.toLowerCase().slice(0, 36),
        ),
      ),
    ];
    if (services.length > 32) truncated = true;
    originalLengths.serviceUuids = services.length;
    const serviceData = { ...existing?.serviceData };
    for (const [uuid, hex] of Object.entries(packet.serviceData ?? {})) {
      if (!/^[a-f\d-]{4,36}$/i.test(uuid)) {
        truncated = true;
        continue;
      }
      if (!(uuid in serviceData) && Object.keys(serviceData).length >= 16) {
        truncated = true;
        continue;
      }
      serviceData[uuid] = bound(`serviceData.${uuid}`, hex, MAX_HEX) ?? '';
    }
    const rawScanRecords = [...(existing?.rawScanRecords ?? [])];
    if (packet.rawScanRecord && !rawScanRecords.includes(packet.rawScanRecord.slice(0, MAX_HEX))) {
      if (rawScanRecords.length < 4) rawScanRecords.push(bound('rawScanRecord', packet.rawScanRecord, MAX_HEX) ?? '');
      else truncated = true;
    }
    const observation: BleEvidenceDevice = {
      deviceId: packet.deviceId,
      handleKind: evidenceHandleKind(this.platform),
      localName: bound('localName', packet.localName, 256) ?? existing?.localName,
      cachedName: bound('cachedName', packet.cachedName, 256) ?? existing?.cachedName,
      serviceUuids: services.slice(0, 32),
      manufacturerData: bound('manufacturerData', packet.manufacturerData, MAX_HEX) ?? existing?.manufacturerData,
      serviceData: Object.keys(serviceData).length ? serviceData : undefined,
      rawScanRecords: rawScanRecords.length ? rawScanRecords : undefined,
      rawScanRecordStatus: this.platform === 'android' ? 'supported' : 'unsupported',
      observedAt: new Date().toISOString(),
      advertisementStatus: 'observed',
      matchBasis: 'unknown',
      truncated,
      originalLengths,
    };
    observation.matchBasis = basisFor(observation);
    this.entries.delete(packet.deviceId);
    const eligible =
      ['board_name', 'board_service'].includes(observation.matchBasis) || packet.deviceId === this.selectedDeviceId;
    const cohort = [...this.entries].filter(
      ([, entry]) =>
        (['board_name', 'board_service'].includes(entry.matchBasis) || entry.deviceId === this.selectedDeviceId) ===
        eligible,
    );
    if (cohort.length >= (eligible ? MAX_DEVICES : MAX_PENDING)) {
      const evicted = cohort.find(([deviceId]) => deviceId !== this.selectedDeviceId)?.[0];
      if (evicted) this.entries.delete(evicted);
      this.droppedCount += 1;
    }
    this.entries.set(packet.deviceId, observation);
    return observation;
  }
  snapshot(selectedDeviceId?: string, complete = false): BleEvidenceBatch {
    const eligible = [...this.entries.values()].filter(
      (entry) => ['board_name', 'board_service'].includes(entry.matchBasis) || entry.deviceId === selectedDeviceId,
    );
    eligible.sort(
      (left, right) => Number(right.deviceId === selectedDeviceId) - Number(left.deviceId === selectedDeviceId),
    );
    return {
      version: 1,
      scanId: this.scanId,
      source: this.source,
      devices: eligible.slice(0, MAX_DEVICES).map((entry) => ({
        ...entry,
        serviceUuids: [...entry.serviceUuids],
        serviceData: entry.serviceData ? { ...entry.serviceData } : undefined,
        rawScanRecords: entry.rawScanRecords ? [...entry.rawScanRecords] : undefined,
        originalLengths: { ...entry.originalLengths },
      })),
      complete,
      droppedCount: this.droppedCount + Math.max(0, eligible.length - MAX_DEVICES),
      capability: 'supported',
    };
  }
}
function encodedLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
export function bleEvidenceProperties(
  evidence?: BleConnectionEvidence | BleEvidenceBatch,
): Record<string, string | number | boolean> {
  if (!evidence) return { bleEvidenceVersion: 1, bleEvidenceStatus: 'not_observed' };
  try {
    const connection: BleConnectionEvidence = 'scan' in evidence ? evidence : { scan: evidence };
    const orderedDevices = [...connection.scan.devices].sort(
      (left, right) =>
        Number(right.deviceId === connection.selectedDeviceId) - Number(left.deviceId === connection.selectedDeviceId),
    );
    const bounded: BleConnectionEvidence = {
      ...connection,
      selectedDeviceId: connection.selectedDeviceId?.slice(0, 256),
      discoveredServices: connection.discoveredServices?.slice(0, 32).map((uuid) => uuid.slice(0, 36)),
      writeServiceUuid: connection.writeServiceUuid?.slice(0, 36),
      writeCharacteristicUuid: connection.writeCharacteristicUuid?.slice(0, 36),
      scan: {
        ...connection.scan,
        scanId: connection.scan.scanId.slice(0, 256),
        source: connection.scan.source.slice(0, 128),
        devices: orderedDevices,
      },
    };
    let encoded = JSON.stringify(bounded);
    while (encodedLength(encoded) > MAX_EVENT_BYTES && bounded.scan.devices.length > 0) {
      const onlyDevice = bounded.scan.devices[0];
      if (
        bounded.scan.devices.length === 1 &&
        onlyDevice.deviceId === bounded.selectedDeviceId &&
        (onlyDevice.rawScanRecords || onlyDevice.serviceData)
      ) {
        bounded.scan.devices = [{ ...onlyDevice, rawScanRecords: undefined, serviceData: undefined, truncated: true }];
      } else {
        bounded.scan.devices.pop();
        bounded.scan.droppedCount += 1;
      }
      encoded = JSON.stringify(bounded);
    }
    return { bleEvidenceVersion: 1, bleScanId: bounded.scan.scanId, bleEvidence: encoded };
  } catch {
    // Telemetry never changes connection or scan behavior, even for malformed
    // native bridge values from a binary running a different JS generation.
    return { bleEvidenceVersion: 1, bleEvidenceStatus: 'unavailable' };
  }
}
export function evidenceBatchFromDevices(
  devices: readonly { evidence?: BleEvidenceDevice }[],
  source: string,
  scanId = createBleEvidenceId(),
): BleEvidenceBatch {
  return {
    version: 1,
    scanId,
    source,
    devices: devices.flatMap((device) => (device.evidence ? [device.evidence] : [])).slice(0, MAX_DEVICES),
    complete: false,
    droppedCount: Math.max(0, devices.length - MAX_DEVICES),
    capability: 'supported',
  };
}
export type NativeControllerEvidenceInput = {
  deviceId: string;
  localName?: string;
  cachedName?: string;
  serviceUuids?: string[];
  manufacturerData?: string;
  serviceData?: Record<string, string>;
  observedAt?: string;
  manufacturerDataOriginalBytes?: number;
  serviceDataOriginalBytes?: Record<string, number>;
  discoveredServicesOriginalCount?: number;
  advertisementStatus: BleEvidenceDevice['advertisementStatus'];
  truncated?: boolean;
  discoveredServices?: string[];
  discoveryMode?: 'targeted' | 'full';
  discoveryOutcome?: 'pending' | 'complete' | 'failed';
  writeServiceUuid?: string;
  writeCharacteristicUuid?: string;
};
export function nativeControllerEvidence(
  deviceId: string,
  native?: NativeControllerEvidenceInput,
  source = 'native_ios_adoption',
): BleConnectionEvidence {
  const collector = new BleEvidenceCollector(source, 'ios');
  if (native) collector.observe({ ...native, cachedName: native.cachedName });
  const scan = collector.snapshot(deviceId, true);
  scan.capability = native ? 'supported' : 'unsupported';
  if (native && scan.devices[0]) {
    scan.devices[0].observedAt = native.observedAt;
    scan.devices[0].advertisementStatus = native.advertisementStatus;
    scan.devices[0].truncated ||= native.truncated === true;
    preserveNativeOriginalLengths(scan.devices[0], native);
  }
  return {
    scan,
    selectedDeviceId: deviceId,
    discoveredServices: native?.discoveredServices,
    discoveredServicesOriginalCount: native?.discoveredServicesOriginalCount,
    discoveryMode: native?.discoveryMode,
    discoveryOutcome: native?.discoveryOutcome,
    writeServiceUuid: native?.writeServiceUuid,
    writeCharacteristicUuid: native?.writeCharacteristicUuid,
  };
}
export function nativeScanEvidence(
  batch: { scanId: string; devices: NativeControllerEvidenceInput[]; complete: boolean; droppedCount: number },
  selectedDeviceId?: string,
): BleEvidenceBatch {
  const collector = new BleEvidenceCollector('native_ios_picker', 'ios', batch.scanId);
  for (const device of batch.devices) collector.observe(device);
  const scan = collector.snapshot(selectedDeviceId, batch.complete);
  scan.droppedCount += batch.droppedCount;
  for (const device of scan.devices) {
    const native = batch.devices.find((candidate) => candidate.deviceId === device.deviceId);
    if (!native) continue;
    device.observedAt = native.observedAt;
    device.advertisementStatus = native.advertisementStatus;
    device.truncated ||= native.truncated === true;
    preserveNativeOriginalLengths(device, native);
  }
  return scan;
}

function preserveNativeOriginalLengths(device: BleEvidenceDevice, native: NativeControllerEvidenceInput): void {
  if (typeof native.manufacturerDataOriginalBytes === 'number')
    device.originalLengths.manufacturerData = native.manufacturerDataOriginalBytes * 2;
  for (const [uuid, bytes] of Object.entries(native.serviceDataOriginalBytes ?? {}).slice(0, 16)) {
    if (/^[a-f\d-]{4,36}$/i.test(uuid)) device.originalLengths[`serviceData.${uuid}`] = bytes * 2;
  }
}
