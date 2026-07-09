import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockBleManager = vi.hoisted(() => ({
  startDeviceScan: vi.fn(),
  stopDeviceScan: vi.fn(),
}));
const trackMock = vi.hoisted(() => vi.fn());
const permissionMock = vi.hoisted(() => vi.fn());
const poweredOnMock = vi.hoisted(() => vi.fn());

vi.mock('../ble-manager', () => ({ bleManager: mockBleManager }));
vi.mock('../../analytics', () => ({ track: trackMock }));
vi.mock('../availability', () => ({ waitForBlePoweredOn: poweredOnMock }));
vi.mock('../use-ble-permissions', () => ({ requestBleRuntimePermissions: permissionMock }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: { BleAdvertisementRecon: 'BLE Advertisement Recon' } }));
vi.mock('@boardsesh/ble-protocol', () => ({
  parseSerialNumber: (name?: string) => (name?.includes('#') ? name.split('#')[1]?.split('@')[0] : undefined),
  parseApiLevel: (name?: string) => (name?.includes('@') ? Number(name.split('@')[1]) : 2),
}));
vi.mock('../board-device-filter', () => ({
  isLikelyBoardDevice: ({
    name,
    serviceUuids,
    scanFamily,
  }: {
    name?: string;
    serviceUuids?: string[];
    scanFamily: string;
  }) => {
    if (scanFamily === 'aurora') return serviceUuids?.includes('aurora-uuid') || /kilter|tension/i.test(name ?? '');
    if (scanFamily === 'moonboard') return /moonboard/i.test(name ?? '');
    return false;
  },
}));

import { runBleAdvertisementRecon } from '../advertisement-recon';

type ScanDevice = {
  id: string;
  localName?: string;
  name?: string;
  serviceUUIDs?: string[];
  overflowServiceUUIDs?: string[];
  manufacturerData?: string | null;
  serviceData?: Record<string, string> | null;
  rssi?: number;
};

function scanCallback() {
  const call = mockBleManager.startDeviceScan.mock.calls.at(-1);
  return call?.[2] as (error: unknown, device: ScanDevice | null) => void;
}

// The recon awaits permissions + powered-on (already-resolved mocks) before it
// registers the scan callback; flush microtasks so those settle.
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('runBleAdvertisementRecon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    permissionMock.mockResolvedValue(true);
    poweredOnMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not scan when BLE permission is denied', async () => {
    permissionMock.mockResolvedValue(false);
    const count = await runBleAdvertisementRecon('corr-denied');
    expect(count).toBe(0);
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
  });

  it('does not scan when Bluetooth is powered off', async () => {
    poweredOnMock.mockResolvedValue(false);
    const count = await runBleAdvertisementRecon('corr-off');
    expect(count).toBe(0);
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
  });

  it('scans unfiltered and emits one hex-payload event per distinct board', async () => {
    const promise = runBleAdvertisementRecon('corr-1');
    await flushMicrotasks();

    expect(mockBleManager.startDeviceScan).toHaveBeenCalledTimes(1);
    // Unfiltered (null services) so bare-name + MoonBoard boxes surface.
    expect(mockBleManager.startDeviceScan.mock.calls[0][0]).toBeNull();

    const emit = scanCallback();
    // Name arrives first (SCAN_RSP), manufacturer/service data in a later packet
    // (ADV_IND) — the recon must accumulate across both, not first-packet-win.
    emit(null, { id: 'k1', name: 'Kilter Board', serviceUUIDs: ['aurora-uuid'], rssi: -55 });
    emit(null, {
      id: 'k1',
      serviceData: { 'd9b1fad4-0d22-4d20-8521-04166b28cd24': 'AQI=' }, // 0102
      manufacturerData: 'TAACFQ==', // 4c000215
    });
    emit(null, { id: 'buds', name: 'AirPods', manufacturerData: 'TAAP' }); // not a board
    emit(null, { id: 'm1', name: 'MoonBoard A', rssi: -70 });

    // Nothing emitted until the scan window closes.
    expect(trackMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8_000);
    const count = await promise;

    expect(count).toBe(2);
    expect(mockBleManager.stopDeviceScan).toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledTimes(2);
    expect(trackMock).toHaveBeenCalledWith(
      'BLE Advertisement Recon',
      expect.objectContaining({
        reconCorrelationId: 'corr-1',
        family: 'aurora',
        deviceName: 'Kilter Board',
        deviceNamePresent: true,
        parsedSerial: undefined,
        // Merged from the second packet even though the name came in the first.
        bleManufacturerData: '4c000215',
        bleManufacturerCompanyId: 0x004c,
        bleServiceData: JSON.stringify({ 'd9b1fad4-0d22-4d20-8521-04166b28cd24': '0102' }),
      }),
    );
    expect(trackMock).toHaveBeenCalledWith(
      'BLE Advertisement Recon',
      expect.objectContaining({ family: 'moonboard', deviceName: 'MoonBoard A' }),
    );
  });
});
