import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { QuickstartScanDevice } from '../../../lib/ble/quickstart-scan-device';
import { buildQuickstartRows, quickstartLookupState } from '../quickstart-scan-rows';

function serialDevice(
  serial: string,
  boardType: 'kilter' | 'tension' | null,
  rssi: number | null,
): QuickstartScanDevice {
  return {
    key: `serial:${serial}`,
    deviceId: `id-${serial}`,
    name: `Board#${serial}@3`,
    kind: 'serial',
    serial,
    boardType,
    rssi,
  };
}

function moonboard(deviceId: string, rssi: number | null): QuickstartScanDevice {
  return {
    key: `device:${deviceId}`,
    deviceId,
    name: 'MoonBoard A',
    kind: 'moonboard',
    serial: null,
    boardType: 'moonboard',
    rssi,
  };
}

function bareBox(deviceId: string, boardType: 'kilter' | 'tension', rssi: number | null): QuickstartScanDevice {
  return {
    key: `device:${deviceId}`,
    deviceId,
    name: 'Kilter Board',
    kind: 'bare_name',
    serial: null,
    boardType,
    rssi,
  };
}

function savedBoard(uuid: string, serialNumber: string): UserBoard {
  return { uuid, serialNumber, name: uuid, boardType: 'kilter' } as unknown as UserBoard;
}

const kinds = (rows: ReturnType<typeof buildQuickstartRows>) =>
  rows.map((row) =>
    row.kind === 'board'
      ? `board:${row.board.uuid}`
      : row.kind === 'lookup_failed'
        ? row.kind
        : `${row.kind}:${row.boardType}`,
  );

describe('buildQuickstartRows', () => {
  it('lists saved boards for resolved serials, and the rest by type', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -50), serialDevice('2', 'tension', -60)],
      boards: [savedBoard('crux', '1')],
      lookup: 'resolved',
    });
    expect(kinds(rows)).toEqual(['board:crux', 'unknown_setup:tension']);
    expect(rows[0].rssi).toBe(-50);
  });

  // Its next steps are "find it at my gym" and "it's my own board" for a TYPE,
  // so a serial whose name named no type has nothing to offer.
  it('gives a serial whose name named no type no row', () => {
    const rows = buildQuickstartRows({ devices: [serialDevice('1', null, -50)], boards: [], lookup: 'resolved' });
    expect(rows).toEqual([]);
  });

  it('folds boards it cannot name into one row per type, at the strongest signal', () => {
    const rows = buildQuickstartRows({
      devices: [
        moonboard('mb-1', -80),
        moonboard('mb-2', -45),
        bareBox('kb-1', 'kilter', -70),
        bareBox('kb-2', 'kilter', -65),
        bareBox('tb-1', 'tension', -90),
        serialDevice('3', 'kilter', -75),
        serialDevice('4', 'kilter', -40),
      ],
      boards: [],
      lookup: 'resolved',
    });
    expect(kinds(rows)).toEqual([
      'unknown_setup:kilter',
      'moonboard:moonboard',
      'bare_name:kilter',
      'bare_name:tension',
    ]);
    expect(rows.map((row) => row.rssi)).toEqual([-40, -45, -65, -90]);
  });

  it('holds serial rows back while the lookup is pending, but not the boards with no serial', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -50), moonboard('mb-1', -70)],
      boards: [savedBoard('crux', '1')],
      lookup: 'pending',
    });
    expect(kinds(rows)).toEqual(['moonboard:moonboard']);
  });

  it('puts one need-signal row in place of every serial when the lookup failed', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -70), serialDevice('2', 'tension', -55), moonboard('mb-1', -60)],
      boards: [],
      lookup: 'failed',
    });
    expect(kinds(rows)).toEqual(['lookup_failed', 'moonboard:moonboard']);
    expect(rows[0].rssi).toBe(-55);
  });

  it('sorts every row by signal, strongest first, unknown last', () => {
    const rows = buildQuickstartRows({
      devices: [moonboard('mb-1', null), serialDevice('1', 'kilter', -80), bareBox('kb-1', 'kilter', -50)],
      boards: [savedBoard('crux', '1')],
      lookup: 'resolved',
    });
    expect(kinds(rows)).toEqual(['bare_name:kilter', 'board:crux', 'moonboard:moonboard']);
  });

  it('gives each saved board its own key, even two the lookup could not name', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -50)],
      boards: [savedBoard('', '1'), savedBoard('', '1')],
      lookup: 'resolved',
    });
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it('lists nothing when nothing was heard', () => {
    expect(buildQuickstartRows({ devices: [], boards: [], lookup: 'none' })).toEqual([]);
  });
});

describe('quickstartLookupState', () => {
  const base = { serialCount: 1, hasResult: false, failed: false, resolving: false };

  it('has nothing to look up without a serial', () => {
    expect(quickstartLookupState({ ...base, serialCount: 0, failed: true })).toBe('none');
  });

  it('is pending while the request runs', () => {
    expect(quickstartLookupState({ ...base, resolving: true })).toBe('pending');
  });

  // Offline, `networkMode: 'offlineFirst'` pauses the request: no error, no
  // data, not loading. That used to read as "No boards in range".
  it('is failed when the request paused or errored with no answer', () => {
    expect(quickstartLookupState({ ...base, failed: true })).toBe('failed');
  });

  it('keeps an answer it already has through a failed refetch', () => {
    expect(quickstartLookupState({ ...base, hasResult: true, failed: true })).toBe('resolved');
  });

  it('waits for the saved serial choices before calling an answer resolved', () => {
    expect(quickstartLookupState({ ...base, hasResult: true, resolving: true })).toBe('pending');
  });
});
