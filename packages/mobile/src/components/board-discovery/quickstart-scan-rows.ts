// The rows the picker's In range slot lists, built from what the scan heard and
// what the serial lookup made of it. Pure, so every state is testable without
// a radio or a server.
//
// Every board heard gets a row with a next step, closest first. A box whose
// serial matches a saved board can be picked straight away. Anything else
// (a MoonBoard, a box that advertises no serial, a serial nobody has saved)
// says what it is and offers the gym list or the builder, so a climber standing
// at it is never told "No boards in range".
//
// A serial-less box (a MoonBoard, a bare `Kilter Board`) this phone has bound
// to one of the climber's boards is named by its Bluetooth id instead
// (recognized-board-devices-store.ts), when the caller passes `recognition`.

import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import {
  compareBySignal,
  type QuickstartScanDevice,
  type QuickstartSeriallessDevice,
} from '../../lib/ble/quickstart-scan-device';
import {
  indexRecognizedBoardDevices,
  normalizeBoardDeviceId,
  type RecognizedBoardDevices,
} from '../../lib/ble/recognized-board-devices-store';
import { boardRowKeys, boardUuidOrNull } from '../../lib/boards/board-identity';

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

/**
 * How a `board` row knows which board it is: its advertised serial matched a
 * saved board, or this phone recognised a serial-less box by its Bluetooth id.
 */
export type QuickstartRowRecognition = 'serial' | 'device_id';

export type QuickstartRow =
  /** A board we can name. Tap to make it active. */
  | { kind: 'board'; key: string; board: UserBoard; rssi: number | null; recognizedBy: QuickstartRowRecognition }
  /** A serial nobody has saved a board for. */
  | { kind: 'unknown_setup'; key: string; boardType: BoardName; rssi: number | null }
  /** A MoonBoard. Its controller never says which layout it drives. */
  | { kind: 'moonboard'; key: string; boardType: BoardName; rssi: number | null; deviceId: string | null }
  /** An Aurora box that advertises only its type, no serial. */
  | { kind: 'bare_name'; key: string; boardType: BoardName; rssi: number | null; deviceId: string | null }
  /** Serials heard, but the lookup couldn't run or failed. */
  | { kind: 'lookup_failed'; key: string; rssi: number | null };

type GroupedRowKind = 'unknown_setup' | 'moonboard' | 'bare_name';

/**
 * The Bluetooth ids behind one serial-less row, kept so the picker can bind the
 * box to the board the climber goes on to pick (pending-board-recognition.ts).
 * Only a row with exactly one box carries an id: with two MoonBoards in range
 * the signal cannot say which one the climber is standing at.
 */
function soleDeviceId(deviceIds: ReadonlySet<string> | undefined): string | null {
  if (!deviceIds || deviceIds.size !== 1) return null;
  const [deviceId] = deviceIds;
  return deviceId ?? null;
}

function strongest(current: number | null | undefined, next: number | null): number | null {
  if (current === undefined || current === null) return next;
  if (next === null) return current;
  return Math.max(current, next);
}

/**
 * What lets a serial-less box be named. A box is named only when its id is
 * recognised as a board of the box's own type that is still one of
 * `knownBoards`: a board the climber unfollowed, or one recognised as another
 * type, leaves the box unnamed.
 */
export type QuickstartRecognition = {
  /** The ids this phone recognises (recognized-board-devices-store.ts). */
  devices: RecognizedBoardDevices;
  /** The climber's own and followed boards. */
  knownBoards: readonly UserBoard[];
};

/** The board one serial-less box is, or null when it is not recognised. */
function recognizedBoardFor(
  device: QuickstartSeriallessDevice,
  recognizedById: ReadonlyMap<string, { boardUuid: string; boardType: BoardName }>,
  knownBoardsByUuid: ReadonlyMap<string, UserBoard>,
): UserBoard | null {
  const recognized = recognizedById.get(normalizeBoardDeviceId(device.deviceId));
  if (!recognized || recognized.boardType !== device.boardType) return null;
  const board = knownBoardsByUuid.get(recognized.boardUuid);
  return board && toBoardName(board.boardType) === device.boardType ? board : null;
}

/**
 * One row per thing the climber can act on, strongest signal first:
 * - each saved board a heard serial resolved to (as the sheet always listed);
 * - each known board a recognised serial-less box is, one row per board however
 *   many of its boxes are heard. These don't wait for the serial lookup. A
 *   board also resolved by serial is listed once, by serial;
 * - one "We don't know its setup yet" row per board type among serials that
 *   resolved to nothing. A serial whose name names no type gets none, because
 *   its next steps need a type;
 * - one MoonBoard row however many MoonBoards are in range, and one bare-name
 *   row per board type. Rows with the same type would carry the same words and
 *   the same two buttons, so one says it all;
 * - one "need signal" row in place of all serial rows while the lookup is down.
 *
 * Each grouped row takes the strongest signal in its group. A MoonBoard or
 * bare-name row also carries its box's Bluetooth id when it stands for exactly
 * one box (`soleDeviceId`). Serial rows wait for the lookup: while it is
 * `pending` only the serial-less rows show.
 */
export function buildQuickstartRows({
  devices,
  boards,
  lookup,
  recognition,
}: {
  devices: readonly QuickstartScanDevice[];
  /** The saved boards the lookup resolved, after `selectBleBoardCandidates`. */
  boards: readonly UserBoard[];
  lookup: QuickstartLookupState;
  /** Absent: no serial-less box is named. */
  recognition?: QuickstartRecognition;
}): QuickstartRow[] {
  const rows: QuickstartRow[] = [];
  const signalBySerial = new Map<string, number | null>();
  const groupSignal = new Map<string, { kind: GroupedRowKind; boardType: BoardName; rssi: number | null }>();
  const groupDeviceIds = new Map<string, Set<string>>();
  let strongestSerialSignal: number | null | undefined;
  const recognizedById = indexRecognizedBoardDevices(recognition?.devices ?? []);
  const knownBoardsByUuid = new Map<string, UserBoard>();
  for (const board of recognition?.knownBoards ?? []) {
    const boardUuid = boardUuidOrNull(board.uuid);
    if (boardUuid) knownBoardsByUuid.set(boardUuid, board);
  }
  // Keyed by board uuid: two boxes recognised as one board make one row.
  const recognizedBoards = new Map<string, { board: UserBoard; rssi: number | null }>();

  const addToGroup = (kind: GroupedRowKind, boardType: BoardName, rssi: number | null, deviceId?: string) => {
    const groupKey = `${kind}:${boardType}`;
    const group = groupSignal.get(groupKey);
    groupSignal.set(groupKey, { kind, boardType, rssi: strongest(group?.rssi, rssi) });
    if (deviceId === undefined) return;
    const deviceIds = groupDeviceIds.get(groupKey) ?? new Set<string>();
    deviceIds.add(deviceId);
    groupDeviceIds.set(groupKey, deviceIds);
  };

  for (const device of devices) {
    if (device.kind === 'serial') {
      signalBySerial.set(device.serial, device.rssi);
      strongestSerialSignal = strongest(strongestSerialSignal, device.rssi);
    } else {
      const recognizedBoard = recognizedBoardFor(device, recognizedById, knownBoardsByUuid);
      if (recognizedBoard) {
        const earlier = recognizedBoards.get(recognizedBoard.uuid);
        recognizedBoards.set(recognizedBoard.uuid, {
          board: recognizedBoard,
          rssi: strongest(earlier?.rssi, device.rssi),
        });
      } else {
        addToGroup(device.kind, device.boardType, device.rssi, device.deviceId);
      }
    }
  }

  if (lookup === 'resolved') {
    const matchedSerials = new Set<string>();
    // A hidden board found by serial has an empty uuid, so rows key on its
    // serial and config instead (#6552).
    const boardKeys = boardRowKeys(boards);
    for (const [boardIndex, board] of boards.entries()) {
      if (board.serialNumber) matchedSerials.add(board.serialNumber);
      const serialSignal = board.serialNumber ? (signalBySerial.get(board.serialNumber) ?? null) : null;
      // The same board also heard as a recognised box: one row, by serial,
      // with the stronger of the two signals.
      const alsoRecognized = boardUuidOrNull(board.uuid) ? recognizedBoards.get(board.uuid) : undefined;
      if (alsoRecognized) recognizedBoards.delete(board.uuid);
      rows.push({
        kind: 'board',
        key: `board:${boardKeys[boardIndex]}`,
        board,
        rssi: alsoRecognized ? strongest(serialSignal, alsoRecognized.rssi) : serialSignal,
        recognizedBy: 'serial',
      });
    }
    for (const device of devices) {
      if (device.kind !== 'serial' || matchedSerials.has(device.serial) || !device.boardType) continue;
      addToGroup('unknown_setup', device.boardType, device.rssi);
    }
  } else if (lookup === 'failed') {
    rows.push({ kind: 'lookup_failed', key: 'lookup_failed', rssi: strongestSerialSignal ?? null });
  }

  // Keyed like a serial row for the same board, so a row that turns from
  // recognised to resolved keeps its place in the list.
  for (const [boardUuid, recognized] of recognizedBoards) {
    rows.push({
      kind: 'board',
      key: `board:${boardUuid}`,
      board: recognized.board,
      rssi: recognized.rssi,
      recognizedBy: 'device_id',
    });
  }

  for (const [groupKey, group] of groupSignal) {
    if (group.kind === 'unknown_setup') {
      rows.push({ kind: group.kind, key: groupKey, boardType: group.boardType, rssi: group.rssi });
    } else {
      rows.push({
        kind: group.kind,
        key: groupKey,
        boardType: group.boardType,
        rssi: group.rssi,
        deviceId: soleDeviceId(groupDeviceIds.get(groupKey)),
      });
    }
  }

  return rows.sort(compareBySignal);
}
