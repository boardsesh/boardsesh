// The rows the Bluetooth quickstart lists, built from what the scan heard and
// what the serial lookup made of it. Pure, so every state is testable without
// a radio or a server.
//
// Every board heard gets a row with a next step, closest first. A box whose
// serial matches a saved board can be picked straight away. Anything else
// (a MoonBoard, a box that advertises no serial, a serial nobody has saved)
// says what it is and offers the gym list or the builder, so a climber standing
// at it is never told "No boards in range".

import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import { compareBySignal, type QuickstartScanDevice } from '../../lib/ble/quickstart-scan-device';
import { boardRowKeys } from '../../lib/boards/board-identity';

/**
 * Where the serial lookup stands.
 * - `none`: no serial heard, so nothing to look up.
 * - `pending`: looking up, or waiting on the climber's saved serial choices.
 * - `resolved`: the lookup answered, even if it matched nothing.
 * - `failed`: serials heard but the lookup could not run (no signal, the
 *   request paused) or failed after its retries.
 */
export type QuickstartLookupState = 'none' | 'pending' | 'resolved' | 'failed';

/**
 * The lookup's state from the query's own flags. Any result wins: rows the
 * lookup already returned stay up through a failed refetch. Without one, a
 * paused or failed request is `failed` rather than "still loading", which is
 * how an offline lookup used to read as "No boards in range".
 */
export function quickstartLookupState({
  serialCount,
  hasResult,
  failed,
  resolving,
}: {
  serialCount: number;
  /** The lookup has an answer for the current serials (possibly an empty one). */
  hasResult: boolean;
  /** The request errored after its retries, or is paused for want of a network. */
  failed: boolean;
  /** The lookup, or the climber's saved serial choices, are still loading. */
  resolving: boolean;
}): QuickstartLookupState {
  if (serialCount === 0) return 'none';
  if (hasResult) return resolving ? 'pending' : 'resolved';
  return failed ? 'failed' : 'pending';
}

export type QuickstartRow =
  /** A serial matched a saved board. Tap to make it active. */
  | { kind: 'board'; key: string; board: UserBoard; rssi: number | null }
  /** A serial nobody has saved a board for. */
  | { kind: 'unknown_setup'; key: string; boardType: BoardName; rssi: number | null }
  /** A MoonBoard. Its controller never says which layout it drives. */
  | { kind: 'moonboard'; key: string; boardType: BoardName; rssi: number | null }
  /** An Aurora box that advertises only its type, no serial. */
  | { kind: 'bare_name'; key: string; boardType: BoardName; rssi: number | null }
  /** Serials heard, but the lookup couldn't run or failed. */
  | { kind: 'lookup_failed'; key: string; rssi: number | null };

type GroupedRowKind = 'unknown_setup' | 'moonboard' | 'bare_name';

function strongest(current: number | null | undefined, next: number | null): number | null {
  if (current === undefined || current === null) return next;
  if (next === null) return current;
  return Math.max(current, next);
}

/**
 * One row per thing the climber can act on, strongest signal first:
 * - each saved board a heard serial resolved to (as the sheet always listed);
 * - one "We don't know its setup yet" row per board type among serials that
 *   resolved to nothing. A serial whose name names no type gets none, because
 *   its next steps need a type;
 * - one MoonBoard row however many MoonBoards are in range, and one bare-name
 *   row per board type. Rows with the same type would carry the same words and
 *   the same two buttons, so one says it all;
 * - one "need signal" row in place of all serial rows while the lookup is down.
 *
 * Each grouped row takes the strongest signal in its group. Serial rows wait
 * for the lookup: while it is `pending` only the serial-less rows show.
 */
export function buildQuickstartRows({
  devices,
  boards,
  lookup,
}: {
  devices: readonly QuickstartScanDevice[];
  /** The saved boards the lookup resolved, after `selectBleBoardCandidates`. */
  boards: readonly UserBoard[];
  lookup: QuickstartLookupState;
}): QuickstartRow[] {
  const rows: QuickstartRow[] = [];
  const signalBySerial = new Map<string, number | null>();
  const groupSignal = new Map<string, { kind: GroupedRowKind; boardType: BoardName; rssi: number | null }>();
  let strongestSerialSignal: number | null | undefined;

  const addToGroup = (kind: GroupedRowKind, boardType: BoardName, rssi: number | null) => {
    const groupKey = `${kind}:${boardType}`;
    const group = groupSignal.get(groupKey);
    groupSignal.set(groupKey, { kind, boardType, rssi: strongest(group?.rssi, rssi) });
  };

  for (const device of devices) {
    if (device.kind === 'serial') {
      signalBySerial.set(device.serial, device.rssi);
      strongestSerialSignal = strongest(strongestSerialSignal, device.rssi);
    } else {
      addToGroup(device.kind, device.boardType, device.rssi);
    }
  }

  if (lookup === 'resolved') {
    const matchedSerials = new Set<string>();
    // A hidden board found by serial has an empty uuid, so rows key on its
    // serial and config instead (#6552).
    const boardKeys = boardRowKeys(boards);
    for (const [boardIndex, board] of boards.entries()) {
      if (board.serialNumber) matchedSerials.add(board.serialNumber);
      rows.push({
        kind: 'board',
        key: `board:${boardKeys[boardIndex]}`,
        board,
        rssi: board.serialNumber ? (signalBySerial.get(board.serialNumber) ?? null) : null,
      });
    }
    for (const device of devices) {
      if (device.kind !== 'serial' || matchedSerials.has(device.serial) || !device.boardType) continue;
      addToGroup('unknown_setup', device.boardType, device.rssi);
    }
  } else if (lookup === 'failed') {
    rows.push({ kind: 'lookup_failed', key: 'lookup_failed', rssi: strongestSerialSignal ?? null });
  }

  for (const [groupKey, group] of groupSignal) {
    rows.push({ kind: group.kind, key: groupKey, boardType: group.boardType, rssi: group.rssi });
  }

  return rows.sort(compareBySignal);
}
