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
 * - `pending`: looking up, or waiting on the climber's saved serial choices,
 *   with no answer drawn yet this scan.
 * - `updating`: an answer this scan already drew stays up while the serials
 *   heard since are looked up (`carryDrawnAnswer`).
 * - `resolved`: the lookup answered every serial heard, even if it matched nothing.
 * - `failed`: serials heard but the lookup could not run (no signal, the
 *   request paused) or failed after its retries.
 */
export type QuickstartLookupState = 'none' | 'pending' | 'updating' | 'resolved' | 'failed';

/** A lookup's answer: the serials it was asked about, and the boards it named for them. */
export type QuickstartSerialAnswer = {
  /** In the order the scan heard them. */
  serials: readonly string[];
  /** After `selectBleBoardCandidates`. */
  boards: readonly UserBoard[];
};

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
 * The lookup as the rows draw it. The lookup is keyed on every serial heard,
 * so each new serial starts it over with no answer, and a board already drawn
 * fell back to "Looking" whenever another box was heard across the gym. An
 * answer this scan already drew (`drawn`) stays drawn instead, for the serials
 * it answered, until the new answer lands:
 * - still out: `updating`, with the serials heard since held back;
 * - failed: `failed`, with one need-signal row for the serials heard since.
 *
 * `drawn` counts only when the serials it answered are where this scan's list
 * starts. A scan only appends serials, in the order it hears them
 * (`useBoardScan`), so an answer from earlier in this scan always answered the
 * start of the list. One from another scan does not: a scan that hears S2 and
 * then S1 again waits for its own first answer rather than draw the last
 * scan's S1 board ahead of it. The caller also drops `drawn` when a scan
 * starts over; this keeps a scan whose empty start never rendered just as safe.
 */
export function carryDrawnAnswer({
  lookup,
  serials,
  drawn,
}: {
  /** `quickstartLookupState` for the serials heard now. */
  lookup: QuickstartLookupState;
  serials: readonly string[];
  /** The answer for the serials heard now when `resolved`, else the last one drawn. */
  drawn: QuickstartSerialAnswer | null;
}): { lookup: QuickstartLookupState; answer: QuickstartSerialAnswer | null } {
  if (lookup === 'none') return { lookup, answer: null };
  const answeredThisScan =
    drawn !== null &&
    drawn.serials.length <= serials.length &&
    drawn.serials.every((serial, index) => serials[index] === serial);
  if (!answeredThisScan) return { lookup, answer: null };
  if (lookup === 'pending') return { lookup: 'updating', answer: drawn };
  return { lookup, answer: drawn };
}

/**
 * How a `board` row knows which board it is: its advertised serial matched a
 * saved board, or this phone recognised a serial-less box by its Bluetooth id.
 */
export type QuickstartRowRecognition = 'serial' | 'device_id';

export type QuickstartRow =
  /** A board we can name. Tap to make it active. */
  | { kind: 'board'; key: string; board: UserBoard; rssi: number | null; recognizedBy: QuickstartRowRecognition }
  /**
   * Serials nobody has saved a board for, one row per board type. `serials`
   * are every serial of that type heard that no saved board answers for,
   * looked up or not, in the order heard; `serialLessBoxCount` the bare-name
   * boxes of that type heard, which could be the same wall. With exactly one
   * box behind the row, the builder can open with its serial filled in
   * (`builderSerialForRow`).
   */
  | {
      kind: 'unknown_setup';
      key: string;
      boardType: BoardName;
      rssi: number | null;
      serials: readonly string[];
      serialLessBoxCount: number;
    }
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
 * - one "need signal" row in place of the serial rows the lookup is down for.
 *
 * Each grouped row takes the strongest signal in its group. A MoonBoard or
 * bare-name row also carries its box's Bluetooth id when it stands for exactly
 * one box (`soleDeviceId`). Serial rows wait for the lookup: while it is
 * `pending` only the serial-less rows show, and while it is `updating` the
 * serials heard since the drawn answer are held back.
 */
export function buildQuickstartRows({
  devices,
  boards,
  answeredSerials,
  lookup,
  recognition,
}: {
  devices: readonly QuickstartScanDevice[];
  /** The saved boards the lookup named, after `selectBleBoardCandidates`. */
  boards: readonly UserBoard[];
  /**
   * The serials `boards` answers for while the lookup is `updating` or `failed`
   * (`carryDrawnAnswer`). Absent: every serial heard once `resolved`, and none
   * before.
   */
  answeredSerials?: readonly string[];
  lookup: QuickstartLookupState;
  /** Absent: no serial-less box is named. */
  recognition?: QuickstartRecognition;
}): QuickstartRow[] {
  const rows: QuickstartRow[] = [];
  const signalBySerial = new Map<string, number | null>();
  const groupSignal = new Map<string, { kind: GroupedRowKind; boardType: BoardName; rssi: number | null }>();
  const groupDeviceIds = new Map<string, Set<string>>();
  // Serials a saved board answers for. Every other serial of a type is a box
  // the unknown_setup row of that type may stand for.
  const matchedSerials = new Set<string>();
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

  // Which heard serials the lookup has answered: every one once `resolved`,
  // those of the answer still drawn while it is `updating` or `failed`.
  const carriedSerials =
    (lookup === 'updating' || lookup === 'failed') && answeredSerials !== undefined ? new Set(answeredSerials) : null;
  const carriesAnswer = carriedSerials !== null;
  const isAnswered = (serial: string): boolean => lookup === 'resolved' || (carriedSerials?.has(serial) ?? false);

  if (lookup === 'resolved' || carriesAnswer) {
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
      if (device.kind !== 'serial' || !isAnswered(device.serial)) continue;
      if (matchedSerials.has(device.serial) || !device.boardType) continue;
      addToGroup('unknown_setup', device.boardType, device.rssi);
    }
  }
  if (lookup === 'failed') {
    const unansweredSignals = devices.flatMap((device) =>
      device.kind === 'serial' && !isAnswered(device.serial) ? [device.rssi] : [],
    );
    if (!carriesAnswer || unansweredSignals.length > 0) {
      const rssi = unansweredSignals.reduce<number | null | undefined>(strongest, undefined) ?? null;
      rows.push({ kind: 'lookup_failed', key: 'lookup_failed', rssi });
    }
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
      rows.push({
        kind: group.kind,
        key: groupKey,
        boardType: group.boardType,
        rssi: group.rssi,
        ...boxesOfType(devices, group.boardType, matchedSerials),
      });
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

/**
 * Every box of `boardType` heard that the unknown_setup row may stand for: the
 * serials no saved board answers for (looked up or not; a Set, since a box
 * heard twice is one box) and the bare-name boxes of that type, which say no
 * serial at all.
 */
function boxesOfType(
  devices: readonly QuickstartScanDevice[],
  boardType: BoardName,
  matchedSerials: ReadonlySet<string>,
): { serials: string[]; serialLessBoxCount: number } {
  const serials = new Set<string>();
  const serialLessDeviceIds = new Set<string>();
  for (const device of devices) {
    if (device.boardType !== boardType) continue;
    if (device.kind === 'serial') {
      if (!matchedSerials.has(device.serial)) serials.add(device.serial);
    } else if (device.kind === 'bare_name') {
      serialLessDeviceIds.add(device.deviceId);
    }
  }
  return { serials: [...serials], serialLessBoxCount: serialLessDeviceIds.size };
}

/**
 * The serial the builder opens with when the climber says a box it heard but
 * can't name is their own. Only:
 * - an unknown_setup row (MoonBoards and bare-name boxes advertise none);
 * - once the lookup has answered every serial heard (`resolved`): an
 *   unanswered one may be a second unsaved box;
 * - when exactly one box of that type was heard, counting every unsaved
 *   serial and every bare-name box of the type;
 * - when the scan listened long enough for "one" to mean one
 *   (`listenedLongEnoughForSoleBox`).
 * With two boxes of a type in range the signal can't say which one the
 * climber stands at, so the field stays empty rather than guess. The
 * builder's serial checks still run on what it fills.
 */
export function builderSerialForRow(
  row: Extract<QuickstartRow, { kind: 'unknown_setup' | 'moonboard' | 'bare_name' }>,
  soleBoxHeardLongEnough: boolean,
  lookup: QuickstartLookupState,
): string | null {
  if (row.kind !== 'unknown_setup' || lookup !== 'resolved' || !soleBoxHeardLongEnough) return null;
  if (row.serials.length !== 1 || row.serialLessBoxCount !== 0) return null;
  return row.serials[0] ?? null;
}
