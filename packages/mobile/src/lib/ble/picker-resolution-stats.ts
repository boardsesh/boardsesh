import { parseBoardTypeFromDeviceName, parseSerialNumber } from '@boardsesh/ble-protocol';
import type { DiscoveredDevice } from './types';
import type { ResolvedBoardEntry } from './resolve-serials';
import { configFromResolvedEntry, type BleBoardConfig } from './board-config-match';

// Per-picker-session tallies of how each listed device's board preview
// resolved, flushed as one analytics event when the sheet closes. Answers
// "how often does the serial→board resolution actually pay off in the UI".
export type PickerResolutionStats = {
  /** Devices listed in the picker when it closed. */
  devicesTotal: number;
  /** Devices whose advertised name carried a parseable Aurora serial. */
  devicesWithSerial: number;
  /** Devices whose serial resolved to a saved board (name + full preview). */
  resolvedSaved: number;
  /** Devices whose serial resolved to a recorded serial config. */
  resolvedRecorded: number;
  /** Devices with a serial the backend knew nothing about. */
  unresolvedWithSerial: number;
  /** Unresolved devices that still showed the current board as a fallback preview. */
  fallbackPreview: number;
  /** Devices that rendered the generic icon — no preview at all. */
  noPreview: number;
  /** Listed devices whose effective board type equals the selected board's. */
  matchedSelectedType: number;
  /** Listed devices whose effective board type is a KNOWN, different type. */
  mismatchedSelectedType: number;
  /** Listed devices whose board type couldn't be determined at all. */
  unknownType: number;
  /**
   * True when a board is selected, devices were listed, yet none match the
   * selected board type — the reported "my board isn't here" case, where the
   * user's target board was never discovered.
   */
  noneMatchedSelectedType: boolean;
};

/**
 * Mirror of DeviceCard's presentation rules (keep in lockstep): a resolved
 * entry always yields a preview; an unresolved device falls back to the
 * current board's preview unless its name positively identifies a different
 * board type.
 */
export function summarizePickerResolution(
  devices: ReadonlyArray<DiscoveredDevice>,
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>,
  currentBoardConfig: BleBoardConfig | undefined,
): PickerResolutionStats {
  const stats: PickerResolutionStats = {
    devicesTotal: devices.length,
    devicesWithSerial: 0,
    resolvedSaved: 0,
    resolvedRecorded: 0,
    unresolvedWithSerial: 0,
    fallbackPreview: 0,
    noPreview: 0,
    matchedSelectedType: 0,
    mismatchedSelectedType: 0,
    unknownType: 0,
    noneMatchedSelectedType: false,
  };

  const selectedType = currentBoardConfig?.boardName;

  for (const device of devices) {
    const serial = parseSerialNumber(device.name);
    if (serial) stats.devicesWithSerial += 1;

    const resolvedEntry = serial ? resolvedBoards.get(serial) : undefined;

    // Effective board type per device, mirroring DeviceCard: a resolved entry's
    // real board type, else the type parsed from the advertised name.
    const effectiveType = resolvedEntry
      ? configFromResolvedEntry(resolvedEntry)?.boardName
      : parseBoardTypeFromDeviceName(device.name);
    if (effectiveType == null) {
      stats.unknownType += 1;
    } else if (effectiveType === selectedType) {
      stats.matchedSelectedType += 1;
    } else {
      stats.mismatchedSelectedType += 1;
    }

    if (resolvedEntry?.kind === 'saved') {
      stats.resolvedSaved += 1;
      continue;
    }
    if (resolvedEntry?.kind === 'recorded') {
      stats.resolvedRecorded += 1;
      continue;
    }

    if (serial) stats.unresolvedWithSerial += 1;
    const inferredBoardType = parseBoardTypeFromDeviceName(device.name);
    const showsFallbackPreview =
      currentBoardConfig !== undefined && (!inferredBoardType || inferredBoardType === currentBoardConfig.boardName);
    if (showsFallbackPreview) {
      stats.fallbackPreview += 1;
    } else {
      stats.noPreview += 1;
    }
  }

  stats.noneMatchedSelectedType = selectedType != null && devices.length > 0 && stats.matchedSelectedType === 0;

  return stats;
}
