// Which board a serial-less Bluetooth box is, as this phone has learned it.
//
// MoonBoards and bare `Kilter Board` boxes advertise no serial, so a scan alone
// can only say "a MoonBoard is in range". Once a climber has bound such a box to
// a board, this remembers the box's OS Bluetooth id against that board, so the
// board picker's in-range rows can name it the next time this phone hears it
// (quickstart-scan-rows.ts).
//
// A box is bound when a connect to it from a board succeeds (useBoardBluetooth,
// where it also records the reconnect handle in known-board-devices-store.ts).
// `rememberRecognizedBoardDevice` is also called after a bind that answers the
// picker's in-range slot: the climber acted on an unnamed row and then bound a
// board of its type, on the picker, the gym map or the builder
// (pending-board-recognition.ts).
//
// This is identity only, and kept apart from the reconnect handles on purpose.
// Those are reconnect *targets*: 8 at most, and a hang-up stamps them to expire
// after 10 minutes. Nothing here connects or reconnects, so nothing expires:
// the newest MAX_RECOGNIZED_BOARD_DEVICES ids are kept. An id is forgotten when
// a connect to it turns out to be the wrong box, and every id goes at sign-out
// (remembered-boards-sign-out.ts).
//
// Per phone. iOS gives every phone its own `CBPeripheral.identifier` for the
// same box (and a new one after a reinstall), and Android uses the box's MAC.
// So one climber's binding never names a box on anyone else's phone.

import { useEffect, useSyncExternalStore } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import { getPreference, removePreference, setPreference } from '../preference-store';
import { boardUuidOrNull } from '../boards/board-identity';

const RECOGNIZED_BOARD_DEVICES_KEY = 'boardsesh_recognized_board_devices_v1';

export const MAX_RECOGNIZED_BOARD_DEVICES = 32;

export type RecognizedBoardDevice = {
  /** The OS Bluetooth id, upper-cased: iOS `CBPeripheral.identifier`, Android MAC. */
  deviceId: string;
  boardUuid: string;
  /** The board's type, so an id is only taken for a box of the same type. */
  boardType: BoardName;
  /** Epoch ms of the latest binding. */
  savedAt: number;
};

/** Newest first. One entry per device id. */
export type RecognizedBoardDevices = ReadonlyArray<RecognizedBoardDevice>;

const EMPTY_RECOGNIZED_BOARD_DEVICES: RecognizedBoardDevices = [];

/**
 * Both platforms report upper-case ids today (iOS `uuidString`, Android MACs),
 * but the native connect and ble-plx's scan are two different libraries. Case
 * must never decide whether a box is recognised.
 */
export function normalizeBoardDeviceId(deviceId: string): string {
  return deviceId.trim().toUpperCase();
}

function isRecognizedBoardDevice(value: unknown): value is RecognizedBoardDevice {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deviceId === 'string' &&
    candidate.deviceId.length > 0 &&
    typeof candidate.boardUuid === 'string' &&
    candidate.boardUuid.length > 0 &&
    typeof candidate.boardType === 'string' &&
    toBoardName(candidate.boardType) !== null &&
    typeof candidate.savedAt === 'number' &&
    Number.isFinite(candidate.savedAt)
  );
}

/** The stored list, minus anything malformed and any repeat of an id. */
export function parseRecognizedBoardDevices(stored: unknown): RecognizedBoardDevices {
  if (!Array.isArray(stored)) return EMPTY_RECOGNIZED_BOARD_DEVICES;
  const seenDeviceIds = new Set<string>();
  const devices: RecognizedBoardDevice[] = [];
  for (const entry of stored) {
    if (!isRecognizedBoardDevice(entry)) continue;
    const deviceId = normalizeBoardDeviceId(entry.deviceId);
    if (seenDeviceIds.has(deviceId)) continue;
    seenDeviceIds.add(deviceId);
    devices.push({ ...entry, deviceId });
  }
  return devices.slice(0, MAX_RECOGNIZED_BOARD_DEVICES);
}

/**
 * `device` becomes the newest entry, replacing whatever its id named before.
 * One board may keep several ids (two controllers, an Android box that changed
 * its address); one id names one board.
 */
export function withRecognizedBoardDevice(
  devices: RecognizedBoardDevices,
  device: RecognizedBoardDevice,
): RecognizedBoardDevices {
  const others = devices.filter((recognized) => recognized.deviceId !== device.deviceId);
  return [device, ...others].slice(0, MAX_RECOGNIZED_BOARD_DEVICES);
}

/**
 * Drop an id, only while it names `boardUuid`: a connect that proves a box is
 * not board A says nothing about it being board B.
 */
export function withoutRecognizedBoardDevice(
  devices: RecognizedBoardDevices,
  deviceId: string,
  boardUuid: string,
): RecognizedBoardDevices {
  const normalizedDeviceId = normalizeBoardDeviceId(deviceId);
  const forgets = (recognized: RecognizedBoardDevice) =>
    recognized.deviceId === normalizedDeviceId && recognized.boardUuid === boardUuid;
  return devices.some(forgets) ? devices.filter((recognized) => !forgets(recognized)) : devices;
}

/** Device id → entry, for a scan's per-device lookup. */
export function indexRecognizedBoardDevices(
  devices: RecognizedBoardDevices,
): ReadonlyMap<string, RecognizedBoardDevice> {
  return new Map(devices.map((recognized) => [recognized.deviceId, recognized]));
}

// The in-memory list every reader shares, and the queue every change goes
// through. Changes run one at a time on the stored list, so a binding made
// before the first read lands on what was stored instead of replacing it.
let recognizedDevices: RecognizedBoardDevices = EMPTY_RECOGNIZED_BOARD_DEVICES;
let hydrated = false;
let changeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function publish(devices: RecognizedBoardDevices): void {
  recognizedDevices = devices;
  for (const listener of listeners) listener();
}

/**
 * The list as stored, read once. A failed read (iOS refuses storage before the
 * first unlock) is not cached, so the next caller reads again.
 */
async function readCurrentList(): Promise<{ devices: RecognizedBoardDevices; readFailed: boolean }> {
  if (hydrated) return { devices: recognizedDevices, readFailed: false };
  try {
    const stored = parseRecognizedBoardDevices(await getPreference<unknown>(RECOGNIZED_BOARD_DEVICES_KEY));
    hydrated = true;
    publish(stored);
    return { devices: stored, readFailed: false };
  } catch {
    return { devices: EMPTY_RECOGNIZED_BOARD_DEVICES, readFailed: true };
  }
}

/** Queue one step. The promise it returns never rejects. */
function enqueue(step: () => Promise<void>): Promise<void> {
  const run = changeQueue.then(step);
  changeQueue = run.catch(() => {});
  return changeQueue;
}

/**
 * Apply one change and store the result. A failed read counts as an empty list:
 * the change still lands, and losing older recognitions only costs the climber
 * an unnamed row, never a wrong board. A failed write keeps the change in
 * memory for this session.
 */
function changeRecognizedDevices(change: (devices: RecognizedBoardDevices) => RecognizedBoardDevices): Promise<void> {
  return enqueue(async () => {
    const { devices, readFailed } = await readCurrentList();
    const changed = change(devices);
    if (changed === devices && !readFailed) return;
    hydrated = true;
    publish(changed);
    await setPreference(RECOGNIZED_BOARD_DEVICES_KEY, changed);
  });
}

/** Read the stored list into memory, once per app run (again after a failed read). */
export function loadRecognizedBoardDevices(): Promise<void> {
  return enqueue(async () => {
    await readCurrentList();
  });
}

/**
 * Remember that `deviceId` is `board` on this phone. A board with no uuid (the
 * geometry a signed-out serial lookup returns) or an unknown type is ignored:
 * there is nothing to recognise it as. Never rejects.
 */
export function rememberRecognizedBoardDevice(
  deviceId: string,
  board: { uuid: string | null | undefined; boardType: string },
): Promise<void> {
  const boardUuid = boardUuidOrNull(board.uuid);
  const boardType = toBoardName(board.boardType);
  const normalizedDeviceId = normalizeBoardDeviceId(deviceId);
  if (!boardUuid || !boardType || !normalizedDeviceId) return Promise.resolve();
  const savedAt = Date.now();
  return changeRecognizedDevices((devices) =>
    withRecognizedBoardDevice(devices, { deviceId: normalizedDeviceId, boardUuid, boardType, savedAt }),
  );
}

/**
 * Forget that `deviceId` is the board `boardUuid`, for a connect that proved it
 * the wrong box. A board with no uuid has nothing recognised to forget. Never
 * rejects.
 */
export function forgetRecognizedBoardDevice(deviceId: string, boardUuid: string | null | undefined): Promise<void> {
  const knownBoardUuid = boardUuidOrNull(boardUuid);
  if (!knownBoardUuid) return Promise.resolve();
  return changeRecognizedDevices((devices) => withoutRecognizedBoardDevice(devices, deviceId, knownBoardUuid));
}

/** Sign-out: forget every id, in memory and in storage. Never rejects. */
export function clearRecognizedBoardDevices(): Promise<void> {
  return enqueue(async () => {
    hydrated = true;
    publish(EMPTY_RECOGNIZED_BOARD_DEVICES);
    await removePreference(RECOGNIZED_BOARD_DEVICES_KEY);
  });
}

function subscribeRecognizedBoardDevices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readRecognizedBoardDevicesSnapshot(): RecognizedBoardDevices {
  return recognizedDevices;
}

/**
 * The ids this phone recognises, loaded on first use. `enabled: false` reads
 * nothing (the Bluetooth quickstart sheet, which names boards by serial only).
 */
export function useRecognizedBoardDevices(enabled: boolean): RecognizedBoardDevices {
  const devices = useSyncExternalStore(subscribeRecognizedBoardDevices, readRecognizedBoardDevicesSnapshot);
  useEffect(() => {
    if (enabled) void loadRecognizedBoardDevices();
  }, [enabled]);
  return enabled ? devices : EMPTY_RECOGNIZED_BOARD_DEVICES;
}
