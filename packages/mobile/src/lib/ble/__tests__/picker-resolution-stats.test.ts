import { describe, expect, it } from 'vitest';
import { summarizePickerResolution } from '../picker-resolution-stats';
import type { ResolvedBoardEntry } from '../resolve-serials';
import type { BleBoardConfig } from '../board-config-match';
import type { DiscoveredDevice } from '../types';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';

const KILTER_CONFIG: BleBoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };

function savedEntry(): ResolvedBoardEntry {
  return { kind: 'saved', board: { name: 'Garage Kilter' } as UserBoard };
}

function recordedEntry(): ResolvedBoardEntry {
  return { kind: 'recorded', config: { serialNumber: 'SN-2' } as BoardSerialConfig };
}

function device(deviceId: string, name?: string): DiscoveredDevice {
  return { deviceId, name, rssi: -50 };
}

describe('summarizePickerResolution', () => {
  it('tallies each resolution kind for a mixed device list', () => {
    const devices = [
      device('d1', 'Kilter Board#SN-1@3'), // saved
      device('d2', 'Kilter Board#SN-2@3'), // recorded
      device('d3', 'Kilter Board#SN-3@3'), // serial, unresolved → fallback preview
      device('d4', 'Tension Board#SN-4@2'), // serial, unresolved, wrong board type → no preview
      device('d5'), // nameless → fallback preview
    ];
    const resolvedBoards = new Map<string, ResolvedBoardEntry>([
      ['SN-1', savedEntry()],
      ['SN-2', recordedEntry()],
    ]);

    expect(summarizePickerResolution(devices, resolvedBoards, KILTER_CONFIG)).toEqual({
      devicesTotal: 5,
      devicesWithSerial: 4,
      resolvedSaved: 1,
      resolvedRecorded: 1,
      unresolvedWithSerial: 2,
      fallbackPreview: 2,
      noPreview: 1,
    });
  });

  it('counts everything as no-preview when there is no current board config', () => {
    const devices = [device('d1', 'Kilter Board#SN-9@3'), device('d2')];

    expect(summarizePickerResolution(devices, new Map(), undefined)).toEqual({
      devicesTotal: 2,
      devicesWithSerial: 1,
      resolvedSaved: 0,
      resolvedRecorded: 0,
      unresolvedWithSerial: 1,
      fallbackPreview: 0,
      noPreview: 2,
    });
  });

  it('returns all-zero tallies for an empty scan', () => {
    expect(summarizePickerResolution([], new Map(), KILTER_CONFIG)).toEqual({
      devicesTotal: 0,
      devicesWithSerial: 0,
      resolvedSaved: 0,
      resolvedRecorded: 0,
      unresolvedWithSerial: 0,
      fallbackPreview: 0,
      noPreview: 0,
    });
  });
});
