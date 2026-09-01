import { parseBoardTypeFromDeviceName, parseSerialNumber } from '@boardsesh/ble-protocol';
import type { BoardName } from '@boardsesh/shared-schema';
import type { DiscoveredDevice } from './types';
import type { ResolvedBoardEntry } from './resolve-serials';
import { configFromResolvedEntry, type BleBoardConfig } from './board-config-match';

/**
 * The board type a picker row effectively represents, mirroring DeviceCard: a
 * resolved (saved/recorded) board's real type, else the type parsed from the
 * advertised name. `undefined` when neither can identify it.
 *
 * The resolved board winning is safe because `resolveBleSerialNumbers` already
 * refuses any entry whose type contradicts the advertisement, so the two can no
 * longer disagree — the resolved type is the advertised one, just more specific.
 * If that filter is ever relaxed, this precedence has to flip: it is what let a
 * Tension controller render as a stranger's Kilter board.
 */
export function effectiveBoardType(
  device: DiscoveredDevice,
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>,
): BoardName | undefined {
  const serial = parseSerialNumber(device.name);
  const resolvedEntry = serial ? resolvedBoards.get(serial) : undefined;
  // A resolved board's real type wins; fall back to the name parse when there's
  // no resolved entry OR the entry carries no usable board type (e.g. a
  // corrupted saved board) — otherwise a known board would count as unknown.
  const resolvedType = resolvedEntry ? configFromResolvedEntry(resolvedEntry)?.boardName : undefined;
  return resolvedType ?? parseBoardTypeFromDeviceName(device.name);
}

/**
 * True when a board is selected and devices were listed, yet none of them are
 * the selected board's type — i.e. the user's target board was never
 * discovered. Shared by the picker UI (to show a hint) and the resolution stats
 * (to flag it in analytics) so both read the same rule.
 */
export function noListedBoardMatchesSelectedType(
  devices: ReadonlyArray<DiscoveredDevice>,
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>,
  currentBoardConfig: BleBoardConfig | undefined,
): boolean {
  const selectedType = currentBoardConfig?.boardName;
  if (selectedType == null || devices.length === 0) return false;
  return !devices.some((device) => effectiveBoardType(device, resolvedBoards) === selectedType);
}

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
  /** Listed devices whose type couldn't be determined (or with no selected board to compare). */
  unknownType: number;
  /**
   * True when a board is selected, devices were listed, yet none match the
   * selected board type — i.e. the user's target board was never discovered.
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

    const deviceType = effectiveBoardType(device, resolvedBoards);
    if (deviceType == null || selectedType == null) {
      // Type couldn't be determined, or there's no selected board to compare
      // against — either way it's neither a match nor a mismatch. (No selected
      // board doesn't happen from the picker, which always has an active board.)
      stats.unknownType += 1;
    } else if (deviceType === selectedType) {
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

  // Equivalent to noListedBoardMatchesSelectedType (which the picker UI calls),
  // but read off the tally we already built so we don't scan devices twice.
  stats.noneMatchedSelectedType = selectedType != null && devices.length > 0 && stats.matchedSelectedType === 0;

  return stats;
}
