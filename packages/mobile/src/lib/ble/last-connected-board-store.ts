// The last board we held a BLE link to — the board config it was paired against
// plus a reconnect handle — persisted in **unsecure** AsyncStorage (via
// preference-store) so a one-tap silent reconnect survives a cold start or
// provider remount, not just the in-memory session (#3609).
//
// The reconnect handle is one of two, depending on board generation:
//   - `serial` — Aurora boards advertise a parseable serial; reconnect matches it.
//   - `deviceId` — MoonBoards carry no serial, so we remember the BLE peripheral
//     id (a stable per-device identifier on iOS) and match on that instead.
// At least one is always present.
//
// This ONLY remembers the reconnect *target*; it never auto-connects. The
// lightbulb tap reads it and reconnects, keeping the deliberate, user-initiated,
// no-auto-reconnect policy (bluetooth-provider.tsx) intact — so it can't fight
// another climber for a last-connection-wins box.
//
// A deliberate disconnect forgets the board (clears this), matching the
// in-memory `lastConnectedBoard` semantics in use-board-bluetooth.ts. Only an
// involuntary drop or a config switch keeps the memory alive.
//
// The stored `configKey` is `boardConfigKey(boardName, layoutId, sizeId)`. The
// caller only rehydrates when it matches the board currently in view, so a
// handle recorded against a different board is never offered as a reconnect
// target for the wrong config.

import { getPreference, setPreference, removePreference } from '../preference-store';

const LAST_CONNECTED_BOARD_KEY = 'boardsesh_last_connected_board_v1';

export type StoredLastConnectedBoard = {
  configKey: string;
  // Aurora reconnect handle (parsed from the advertised name). Absent for MoonBoard.
  serial?: string;
  // MoonBoard reconnect handle (BLE peripheral id). Absent for serial-bearing boards.
  deviceId?: string;
};

function isStoredLastConnectedBoard(value: unknown): value is StoredLastConnectedBoard {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.configKey !== 'string') return false;
  const hasSerial = typeof candidate.serial === 'string';
  const hasDeviceId = typeof candidate.deviceId === 'string';
  // Reject stray non-string handles, and require at least one usable handle so a
  // config-only record can never be offered as a reconnect target.
  if (candidate.serial !== undefined && !hasSerial) return false;
  if (candidate.deviceId !== undefined && !hasDeviceId) return false;
  // The two handles are mutually exclusive by board generation (Aurora serial vs.
  // MoonBoard device id) — the writer only ever sets one. Reject a record with
  // both rather than silently picking one, so a future writer bug that sets both
  // fails visibly (falls back to the picker) instead of reconnecting on an
  // unvalidated pairing.
  if (hasSerial && hasDeviceId) return false;
  return hasSerial || hasDeviceId;
}

export async function getStoredLastConnectedBoard(): Promise<StoredLastConnectedBoard | null> {
  const stored = await getPreference<unknown>(LAST_CONNECTED_BOARD_KEY);
  return isStoredLastConnectedBoard(stored) ? stored : null;
}

export function setStoredLastConnectedBoard(board: StoredLastConnectedBoard): Promise<void> {
  return setPreference(LAST_CONNECTED_BOARD_KEY, board);
}

export function clearStoredLastConnectedBoard(): Promise<void> {
  return removePreference(LAST_CONNECTED_BOARD_KEY);
}
