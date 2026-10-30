// The device this phone last connected to on each board, for a gym with several
// boards (#7076).
//
// `last-connected-board-store.ts` keeps ONE record: the board held last. At a
// gym with a Kilter and a MoonBoard that record flips on every walk between
// them, so coming back to a board this phone has already used opened the
// picker again. This keeps one handle per board, so the walk back reconnects
// the way the bulb does on a single board.
//
// Same rules as the single record:
//   - A handle is a `serial` (Aurora) or a `deviceId` (MoonBoard), never both.
//   - It is only a reconnect *target* for a deliberate connect (a tap, or the
//     auto-follow of a climber already driving a wall). Nothing here connects.
//   - A deliberate disconnect forgets that board (`forgetKnownBoardDevice`): it
//     frees the board for the next climber.
//   - Keyed by `boardConfigKey(boardName, layoutId, sizeId, boardUuid)`, so a
//     handle is only offered for the board it was recorded against.
//
// The newest MAX_KNOWN_BOARD_DEVICES boards are kept; a gym rarely has more.

import { getPreference, setPreference } from '../preference-store';
import type { StoredLastConnectedBoard } from './last-connected-board-store';

const KNOWN_BOARD_DEVICES_KEY = 'boardsesh_known_board_devices_v1';

export const MAX_KNOWN_BOARD_DEVICES = 8;

/** Newest first. One entry per `configKey`. */
export type KnownBoardDevices = ReadonlyArray<StoredLastConnectedBoard>;

function isKnownBoardDevice(value: unknown): value is StoredLastConnectedBoard {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.configKey !== 'string') return false;
  const hasSerial = typeof candidate.serial === 'string';
  const hasDeviceId = typeof candidate.deviceId === 'string';
  if (candidate.serial !== undefined && !hasSerial) return false;
  if (candidate.deviceId !== undefined && !hasDeviceId) return false;
  // Exactly one handle, as the single record requires.
  return hasSerial !== hasDeviceId;
}

/** The handle remembered for one board, or null. */
export function findKnownBoardDevice(
  devices: KnownBoardDevices,
  configKey: string | null,
): StoredLastConnectedBoard | null {
  if (!configKey) return null;
  return devices.find((device) => device.configKey === configKey) ?? null;
}

/** `device` becomes the newest entry, replacing any for its board. */
export function rememberKnownBoardDevice(
  devices: KnownBoardDevices,
  device: StoredLastConnectedBoard,
): KnownBoardDevices {
  const others = devices.filter((known) => known.configKey !== device.configKey);
  return [device, ...others].slice(0, MAX_KNOWN_BOARD_DEVICES);
}

/** Drop the handle for one board. */
export function forgetKnownBoardDevice(devices: KnownBoardDevices, configKey: string): KnownBoardDevices {
  return devices.some((known) => known.configKey === configKey)
    ? devices.filter((known) => known.configKey !== configKey)
    : devices;
}

/**
 * The stored list read on mount, merged into handles this session already
 * changed: `current` first (it is newer), then the stored ones in their own
 * newest-first order, minus any board this session remembered or forgot.
 */
export function mergeKnownBoardDevices(
  current: KnownBoardDevices,
  stored: KnownBoardDevices,
  touchedConfigKeys: ReadonlySet<string>,
): KnownBoardDevices {
  const fromStorage = stored.filter(
    (device) => !touchedConfigKeys.has(device.configKey) && !findKnownBoardDevice(current, device.configKey),
  );
  return [...current, ...fromStorage].slice(0, MAX_KNOWN_BOARD_DEVICES);
}

export async function getStoredKnownBoardDevices(): Promise<KnownBoardDevices> {
  const stored = await getPreference<unknown>(KNOWN_BOARD_DEVICES_KEY);
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const devices: StoredLastConnectedBoard[] = [];
  for (const entry of stored) {
    if (!isKnownBoardDevice(entry) || seen.has(entry.configKey)) continue;
    seen.add(entry.configKey);
    devices.push(entry);
  }
  return devices.slice(0, MAX_KNOWN_BOARD_DEVICES);
}

export function setStoredKnownBoardDevices(devices: KnownBoardDevices): Promise<void> {
  return setPreference(KNOWN_BOARD_DEVICES_KEY, devices);
}
