import { describe, expect, it } from 'vitest';
import { summarizePickerResolution } from '../picker-resolution-stats';
import type { ResolvedBoardEntry } from '../resolve-serials';
import type { BleBoardConfig } from '../board-config-match';
import type { DiscoveredDevice } from '../types';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';

const KILTER_CONFIG: BleBoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };
const TENSION_CONFIG: BleBoardConfig = { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13' };

function savedEntry(boardType = 'kilter'): ResolvedBoardEntry {
  return {
    kind: 'saved',
    board: { name: 'Garage Kilter', boardType, layoutId: 1, sizeId: 10, setIds: '1,20' } as UserBoard,
  };
}

function recordedEntry(boardName = 'kilter'): ResolvedBoardEntry {
  return {
    kind: 'recorded',
    config: { serialNumber: 'SN-2', boardName, layoutId: 1, sizeId: 10, setIds: '1,20' } as BoardSerialConfig,
  };
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
      // d1 (saved kilter), d2 (recorded kilter), d3 (kilter) match; d4 (tension)
      // mismatches; d5 (nameless) is unknown. At least one matched → not "none".
      matchedSelectedType: 3,
      mismatchedSelectedType: 1,
      unknownType: 1,
      noneMatchedSelectedType: false,
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
      // No selected board: a known type can't "match", and noneMatched only
      // applies when a board is selected.
      matchedSelectedType: 0,
      mismatchedSelectedType: 1,
      unknownType: 1,
      noneMatchedSelectedType: false,
    });
  });

  it('flags noneMatchedSelectedType when no listed board is the selected type', () => {
    // The reported case: selected board is tension, but the only devices are the
    // user's saved kilter and an unidentified non-tension board — their tension
    // board was never discovered.
    const devices = [
      device('d1', 'Kilter Board#SN-1@3'), // saved kilter
      device('d2', 'Kilter Board#SN-7@3'), // unresolved, parses to kilter
    ];
    const resolvedBoards = new Map<string, ResolvedBoardEntry>([['SN-1', savedEntry('kilter')]]);

    const stats = summarizePickerResolution(devices, resolvedBoards, TENSION_CONFIG);
    expect(stats.matchedSelectedType).toBe(0);
    expect(stats.mismatchedSelectedType).toBe(2);
    expect(stats.unknownType).toBe(0);
    expect(stats.noneMatchedSelectedType).toBe(true);
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
      matchedSelectedType: 0,
      mismatchedSelectedType: 0,
      unknownType: 0,
      // No devices → nothing to match, so not flagged.
      noneMatchedSelectedType: false,
    });
  });
});
