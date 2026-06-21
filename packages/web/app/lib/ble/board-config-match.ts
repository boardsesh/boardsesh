import type { BoardDetails, BoardName } from '@/app/lib/types';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
// set_ids parsing/normalisation is shared with the backend's recordBoardSerial
// resolver (which compares a recording against a saved board), so it lives in
// @boardsesh/board-config. Re-exported here to keep the BLE call sites' import
// path stable.
import { parseSetIds, normaliseSetIds } from '@boardsesh/board-config';
import { getBoardDetails } from '@/app/lib/board-constants';
import { constructBoardSlugListUrl, constructClimbListWithSlugs } from '@/app/lib/url-utils';
import { parseSerialNumber } from '@/app/components/board-bluetooth-control/bluetooth-aurora';
import type { DiscoveredDevice } from '@/app/lib/ble/types';
import type { ResolvedBoardEntry } from './resolve-serials';

export { parseSetIds, normaliseSetIds };

/**
 * Narrow a string from the DB / wire to the closed `BoardName` union. Returns
 * undefined if the value isn't a recognised board so callers can fail
 * gracefully instead of relying on an unsafe `as BoardName` cast.
 */
function asBoardName(value: string): BoardName | undefined {
  return (SUPPORTED_BOARDS as readonly string[]).includes(value) ? (value as BoardName) : undefined;
}

export type ResolvedBoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  /** When the entry is linked to a saved board, its slug — used to build /b/{slug}/... URLs. */
  boardSlug?: string | null;
};

/** Extract a unified config shape from either kind of resolved entry. */
export function configFromResolvedEntry(entry: ResolvedBoardEntry): ResolvedBoardConfig {
  if (entry.kind === 'saved') {
    return {
      boardName: entry.board.boardType,
      layoutId: entry.board.layoutId,
      sizeId: entry.board.sizeId,
      setIds: entry.board.setIds,
      boardSlug: entry.board.slug,
    };
  }
  return {
    boardName: entry.config.boardName,
    layoutId: entry.config.layoutId,
    sizeId: entry.config.sizeId,
    setIds: entry.config.setIds,
    boardSlug: entry.config.boardSlug,
  };
}

/**
 * Whether the resolved config for a serial matches the user's current board route.
 * Angle is excluded — the same physical controller is used at multiple angles.
 */
export function matchesBoardDetails(config: ResolvedBoardConfig, current: BoardDetails): boolean {
  return (
    config.boardName === current.board_name &&
    config.layoutId === current.layout_id &&
    config.sizeId === current.size_id &&
    normaliseSetIds(config.setIds) === normaliseSetIds(current.set_ids.join(','))
  );
}

/**
 * Decide what to do when the user picks a device from the BLE picker. Pure so
 * it can be unit-tested without mounting the BluetoothProvider.
 *
 * Returns:
 * - `{ kind: 'forward' }` — no resolved entry or config matches the current
 *   route → forward the deviceId to the picker promise resolver.
 * - `{ kind: 'mismatch', config, serial }` — the resolved config differs from
 *   the route the user is on → caller should open the mismatch dialog.
 */
export type PickerSelectionDecision =
  | { kind: 'forward' }
  | { kind: 'mismatch'; serial: string; config: ResolvedBoardConfig };

export function decidePickerSelection(
  deviceId: string,
  devices: ReadonlyArray<DiscoveredDevice>,
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>,
  boardDetails: BoardDetails | undefined,
): PickerSelectionDecision {
  if (!boardDetails) return { kind: 'forward' };
  const device = devices.find((d) => d.deviceId === deviceId);
  const serial = device ? parseSerialNumber(device.name) : undefined;
  if (!serial) return { kind: 'forward' };
  const entry = resolvedBoards.get(serial);
  if (!entry) return { kind: 'forward' };
  const config = configFromResolvedEntry(entry);
  if (matchesBoardDetails(config, boardDetails)) return { kind: 'forward' };
  return { kind: 'mismatch', serial, config };
}

/**
 * Build the climb-list URL the user should land on when they choose
 * "Switch to correct config" in the BoardConfigMismatchDialog.
 *
 * Always uses `currentAngle` — the saved-board's default angle is intentionally
 * ignored because angle is physically adjustable on almost every board, so a
 * user on /b/slug/35/list shouldn't be yanked to 40° just because the saved
 * board was created with that default. Prefers `/b/{slug}/{angle}/list` when
 * the entry is linked to a saved board; otherwise falls back to the traditional
 * climb-list URL derived from layout/size/set names. Returns null if no
 * resolvable URL exists for the config.
 */
export function buildSwitchUrl(config: ResolvedBoardConfig, currentAngle: number): string | null {
  if (config.boardSlug) {
    return constructBoardSlugListUrl(config.boardSlug, currentAngle);
  }
  // Validate the wire-side string against the closed BoardName union before
  // handing it to getBoardDetails — avoids an unsafe `as BoardName` cast.
  const boardName = asBoardName(config.boardName);
  if (!boardName) {
    console.warn('[BLE] buildSwitchUrl: unrecognised boardName', config.boardName);
    return null;
  }
  try {
    const details = getBoardDetails({
      board_name: boardName,
      layout_id: config.layoutId,
      size_id: config.sizeId,
      set_ids: parseSetIds(config.setIds),
    });
    if (details.layout_name && details.size_name && details.set_names) {
      return constructClimbListWithSlugs(
        details.board_name,
        details.layout_name,
        details.size_name,
        details.size_description,
        details.set_names,
        currentAngle,
      );
    }
  } catch (err) {
    // getBoardDetails throws on unknown layout/size/set combinations. Surface
    // it for debugging — the user-facing snackbar in the mismatch handler
    // already covers the null return.
    console.warn('[BLE] buildSwitchUrl: getBoardDetails threw for', config, err);
  }
  return null;
}
