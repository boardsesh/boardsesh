import { describe, expect, it } from 'vitest';
import {
  BleEvidenceCollector,
  bleEvidenceProperties,
  nativeControllerEvidence,
  type BleConnectionEvidence,
} from '../controller-evidence';

describe('controller evidence', () => {
  it('merges split packets before classification and distinguishes same-name handles', () => {
    const collector = new BleEvidenceCollector('test', 'android', 'scan');
    collector.observe({ deviceId: 'first', manufacturerData: '000102', rawScanRecord: '000102' });
    collector.observe({ deviceId: 'first', localName: 'MoonBoard A' });
    collector.observe({ deviceId: 'second', localName: 'MoonBoard A' });
    const snapshot = collector.snapshot(undefined, true);
    expect(snapshot.devices).toHaveLength(2);
    expect(snapshot.devices[0]).toMatchObject({
      deviceId: 'first',
      manufacturerData: '000102',
      handleKind: 'android_address',
      rawScanRecords: ['000102'],
    });
    expect(snapshot.devices[1].deviceId).toBe('second');
  });

  it('preserves board observations through unrelated-device churn and bounds both cohorts', () => {
    const collector = new BleEvidenceCollector('test', 'ios');
    collector.observe({ deviceId: 'board', localName: 'Tension Board' });
    for (let index = 0; index < 200; index += 1) collector.observe({ deviceId: `other-${index}` });
    expect(collector.snapshot().devices.map((device) => device.deviceId)).toEqual(['board']);
    expect(collector.snapshot().droppedCount).toBe(72);
    for (let index = 0; index < 40; index += 1)
      collector.observe({ deviceId: `board-${index}`, localName: 'Kilter Board' });
    expect(collector.snapshot().devices).toHaveLength(30);
  });

  it('labels generic UART as transport evidence rather than a board identity', () => {
    const collector = new BleEvidenceCollector('test', 'ios');
    collector.observe({ deviceId: 'uart', serviceUuids: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'] });
    expect(collector.snapshot().devices).toEqual([]);
    expect(collector.snapshot('uart').devices[0].matchBasis).toBe('generic_transport');
  });

  it('bounds rotating Android raw records and snapshots do not mutate afterwards', () => {
    const collector = new BleEvidenceCollector('test', 'android');
    collector.observe({ deviceId: 'first', localName: 'Woods Board', rawScanRecord: '00' });
    const before = collector.snapshot();
    for (let index = 1; index <= 8; index += 1)
      collector.observe({ deviceId: 'first', rawScanRecord: index.toString(16).padStart(2, '0') });
    expect(before.devices[0].rawScanRecords).toEqual(['00']);
    expect(collector.snapshot().devices[0].rawScanRecords).toEqual(['00', '01', '02', '03']);
    expect(collector.snapshot().devices[0].truncated).toBe(true);
  });

  it('never exceeds the event byte budget, including Unicode and GATT metadata', () => {
    const collector = new BleEvidenceCollector('test', 'android');
    for (let index = 0; index < 30; index += 1)
      collector.observe({
        deviceId: `board-${index}`,
        localName: `MoonBoard ${'😀'.repeat(300)}\ud800`,
        manufacturerData: 'ab'.repeat(5000),
        serviceData: Object.fromEntries(
          Array.from({ length: 16 }, (_, service) => [
            `0000${service.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`,
            'aa'.repeat(512),
          ]),
        ),
      });
    const evidence: BleConnectionEvidence = {
      scan: collector.snapshot('board-0'),
      selectedDeviceId: 'board-0',
      discoveredServices: ['a'.repeat(100000)],
      writeServiceUuid: 'a'.repeat(100000),
    };
    const props = bleEvidenceProperties(evidence);
    expect(typeof props.bleEvidence).toBe('string');
    expect(new TextEncoder().encode(String(props.bleEvidence)).byteLength).toBeLessThanOrEqual(16384);
    const decoded = JSON.parse(String(props.bleEvidence));
    expect(decoded.scan.droppedCount).toBeGreaterThan(0);
    expect(decoded.scan.devices[0].deviceId).toBe('board-0');
    expect(decoded.scan.devices[0].manufacturerData).toBeDefined();
  });

  it('marks older native binaries unsupported and keeps handles separate', () => {
    const evidence = nativeControllerEvidence('ios-handle');
    expect(evidence.selectedDeviceId).toBe('ios-handle');
    expect(evidence.scan.capability).toBe('unsupported');
    expect(evidence.scan.devices).toEqual([]);
  });
  it('retains native truncation provenance instead of reporting clipped bytes as original length', () => {
    const evidence = nativeControllerEvidence('controller', {
      deviceId: 'controller',
      localName: 'MoonBoard A',
      serviceUuids: [],
      manufacturerData: '00'.repeat(512),
      manufacturerDataOriginalBytes: 800,
      serviceData: { fff0: '0102' },
      serviceDataOriginalBytes: { fff0: 900 },
      discoveredServices: ['180a'],
      discoveredServicesOriginalCount: 60,
      advertisementStatus: 'cached',
      truncated: true,
      observedAt: '2026-11-20T00:00:00Z',
    });
    expect(evidence.scan.devices[0]).toMatchObject({
      advertisementStatus: 'cached',
      truncated: true,
      observedAt: '2026-11-20T00:00:00Z',
      originalLengths: { manufacturerData: 1600, 'serviceData.fff0': 1800 },
    });
    expect(evidence.discoveredServicesOriginalCount).toBe(60);
  });
});
