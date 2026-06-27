import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { MESSAGE_BODY_MAX_LENGTH } from './transport';

// Canonical source: @boardsesh/shared-schema (board-config.ts, climb.ts).
// Duplicated here so ble-protocol stays portable without pulling in
// shared-schema's full type tree. Keep in sync when adding a new board.
export const AURORA_BOARDS = ['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill'] as const;
export type AuroraBoardName = (typeof AURORA_BOARDS)[number];
export type HoldState = 'OFF' | 'STARTING' | 'FINISH' | 'HAND' | 'FOOT' | 'ANY' | 'NOT' | 'AUX';

/** LED placement positions: maps placement ID to LED position index. */
export type LedPlacements = Record<number, number>;

/**
 * Optional per-state hex colour overrides (`#rrggbb` or `rrggbb`). When a
 * frame's role code maps to one of these states, the override replaces the
 * canonical colour from `HOLD_STATE_MAP` for that LED only.
 */
export type LedColorOverrides = Partial<Record<HoldState, string>>;

// The colour encoders parseInt fixed 2-char slices, so only exactly six hex
// digits with an optional LEADING '#' produce valid bytes. Anchored so an
// interior '#' ("ab#cdef") is rejected — this keeps byte-for-byte parity with
// the Swift `sanitizedOverride`, which only strips a leading '#'.
const SIX_DIGIT_HEX_PATTERN = /^#?[0-9a-fA-F]{6}$/;

// --- API v3 command bytes (3 bytes per LED, 16-bit positions) ---
const V3_PACKET_MIDDLE = 81; // 'Q'
const V3_PACKET_FIRST = 82; // 'R'
const V3_PACKET_LAST = 83; // 'S'
const V3_PACKET_ONLY = 84; // 'T'

// --- API v2 command bytes (2 bytes per LED, 10-bit positions) ---
const V2_PACKET_MIDDLE = 77; // 'M'
const V2_PACKET_FIRST = 78; // 'N'
const V2_PACKET_LAST = 79; // 'O'
const V2_PACKET_ONLY = 80; // 'P'

// --- v2 power budget constants ---
const V2_MAX_BOARD_POWER = 18.0;
const V2_POWER_SCALES = [1.0, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05];

// LEDs per hold: default is 1 for all boards, except Kilter which has 2 physical
// LEDs per hold position. Only affects v2 power budget calculation.
const KILTER_LEDS_PER_HOLD = 2;
const DEFAULT_LEDS_PER_HOLD = 1;

const getLedsPerHold = (boardName: AuroraBoardName): number =>
  boardName === 'kilter' ? KILTER_LEDS_PER_HOLD : DEFAULT_LEDS_PER_HOLD;

// Note: AURORA_ADVERTISED_SERVICE_UUID is available from './transport' — not
// re-exported here to avoid collisions in the barrel index.

// Shared helpers — exported for testing
export const checksum = (data: number[]) => data.reduce((acc, value) => (acc + value) & 255, 0) ^ 255;

export const wrapBytes = (data: number[]) =>
  data.length > MESSAGE_BODY_MAX_LENGTH ? [] : [1, data.length, checksum(data), 2, ...data, 3];

// --- Device name parsing ---

/**
 * Parse Aurora BLE device name to extract API level.
 * Format: {DisplayName}#{SerialNumber}@{APILevel}
 * Default API level is 2 if not specified.
 */
export const parseApiLevel = (deviceName?: string): number => {
  if (!deviceName) return 2;
  const match = deviceName.match(/@(\d+)/);
  return match ? parseInt(match[1], 10) : 2;
};

/**
 * Parse Aurora BLE device name to extract the serial number.
 * Format: {DisplayName}#{SerialNumber}@{APILevel}
 * Returns undefined if no serial found.
 */
export const parseSerialNumber = (deviceName?: string): string | undefined => {
  if (!deviceName) return undefined;
  const match = deviceName.match(/#([^@]+)/);
  return match ? match[1] : undefined;
};

/**
 * Infer the board type from a BLE device name.
 * e.g. "Kilter Board#751737@3" -> 'kilter', "Tension Board#123@2" -> 'tension', "So iLL Board#42@3" -> 'soill'.
 * Supports all Aurora boards: kilter, tension, decoy, touchstone, grasshopper, soill.
 * Whitespace and hyphens are stripped before matching so the multi-word "So iLL Board" name resolves.
 */
export const parseBoardTypeFromDeviceName = (deviceName?: string): AuroraBoardName | undefined => {
  if (!deviceName) return undefined;
  const normalized = deviceName.toLowerCase().replace(/[\s-]/g, '');
  return AURORA_BOARDS.find((board) => normalized.startsWith(board));
};

// --- v3 encoding (API level >= 3) ---

export const encodePositionV3 = (position: number) => [position & 255, (position >> 8) & 255];

export const encodeColorV3 = (color: string) => {
  const r = Math.floor(parseInt(color.substring(0, 2), 16) / 32) << 5;
  const g = Math.floor(parseInt(color.substring(2, 4), 16) / 32) << 2;
  const b = Math.floor(parseInt(color.substring(4, 6), 16) / 64);
  return r | g | b;
};

export const encodePositionAndColorV3 = (position: number, ledColor: string) => [
  ...encodePositionV3(position),
  encodeColorV3(ledColor),
];

// --- v2 encoding (API level < 3) ---

/**
 * Compute the brightness scale factor for v2 power budget.
 * Tries progressively lower scales until total power fits within 18W.
 */
export const computeV2Scale = (ledEntries: Array<{ position: number; color: string }>, ledsPerHold: number): number => {
  for (const scale of V2_POWER_SCALES) {
    let totalPower = 0;
    for (const { color } of ledEntries) {
      const r = Math.floor(parseInt(color.substring(0, 2), 16) * scale) >> 6;
      const g = Math.floor(parseInt(color.substring(2, 4), 16) * scale) >> 6;
      const b = Math.floor(parseInt(color.substring(4, 6), 16) * scale) >> 6;
      totalPower += (r + g + b) / 30;
    }
    if (ledsPerHold * totalPower <= V2_MAX_BOARD_POWER) {
      return scale;
    }
  }
  return 0;
};

export const scaledColorV2 = (value8bit: number, scale: number): number => Math.floor(value8bit * scale) >> 6; // Result: 0-3

/**
 * Encode a single LED for v2: 2 bytes.
 * Byte 1: position[7:0]
 * Byte 2: (red_2bit << 6) | (green_2bit << 4) | (blue_2bit << 2) | position[9:8]
 */
export const encodePositionAndColorV2 = (position: number, ledColor: string, scale: number): number[] => {
  if (position > 1023) {
    console.warn(`[BLE v2] Position ${position} exceeds 10-bit limit (1023), skipping`);
    return [];
  }
  const posLo = position & 0xff;
  const posHi = (position >> 8) & 0x03;

  const r = scaledColorV2(parseInt(ledColor.substring(0, 2), 16), scale);
  const g = scaledColorV2(parseInt(ledColor.substring(2, 4), 16), scale);
  const b = scaledColorV2(parseInt(ledColor.substring(4, 6), 16), scale);

  const colorByte = (r << 6) | (g << 4) | (b << 2) | posHi;
  return [posLo, colorByte];
};

// --- Packet generation ---

type CommandBytes = {
  middle: number;
  first: number;
  last: number;
  only: number;
};

const V3_COMMANDS: CommandBytes = {
  middle: V3_PACKET_MIDDLE,
  first: V3_PACKET_FIRST,
  last: V3_PACKET_LAST,
  only: V3_PACKET_ONLY,
};

const V2_COMMANDS: CommandBytes = {
  middle: V2_PACKET_MIDDLE,
  first: V2_PACKET_FIRST,
  last: V2_PACKET_LAST,
  only: V2_PACKET_ONLY,
};

export type BluetoothPacketResult = {
  packet: Uint8Array;
  /** Placements in frames with no LED position for this board size */
  skippedPositionCount: number;
  /** Placements with an unrecognised role code (no colour) */
  skippedRoleCount: number;
  /** Total placement entries parsed from the frames string */
  totalPlacements: number;
};

/**
 * Build the BLE packet for a set of Aurora LED placements.
 *
 * Missing placements are skipped gracefully — the returned result includes
 * counts so callers can decide how to handle partial or full misses.
 *
 * @param apiLevel - Protocol version from the board's BLE name (default 3)
 */
export const getAuroraBluetoothPacket = (
  frames: string,
  placementPositions: LedPlacements,
  boardName: AuroraBoardName,
  apiLevel: number = 3,
  colorOverrides?: LedColorOverrides,
): BluetoothPacketResult => {
  const isV2 = apiLevel < 3;
  const cmds = isV2 ? V2_COMMANDS : V3_COMMANDS;

  // Empty frames is the "clear all LEDs" path — emit a valid ONLY-command
  // packet with no LED entries so the board overwrites its state to "nothing
  // lit". A zero-length Uint8Array would never reach the board over BLE.
  if (frames === '') {
    return {
      packet: Uint8Array.from(wrapBytes([cmds.only])),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 0,
    };
  }

  // Pre-collect LED entries for v2 power scaling
  const ledEntries: Array<{ position: number; color: string }> = [];
  let skippedPositionCount = 0;
  let skippedRoleCount = 0;

  frames.split('p').forEach((frame) => {
    if (!frame) return;
    const [placement, role] = frame.split('r');
    const placementId = Number(placement);
    const ledPosition = placementPositions[placementId];

    if (ledPosition === undefined) {
      skippedPositionCount++;
      return;
    }

    const roleCode = Number(role);
    const state = HOLD_STATE_MAP[boardName]?.[roleCode];

    if (!state?.color) {
      skippedRoleCount++;
      return;
    }

    const overrideForState = colorOverrides?.[state.name];
    // Overrides arrive from app config; anything but 6-digit hex (shorthand
    // "#fff", a named color) would parseInt to NaN bytes in the colour
    // encoders and stream garbage to the wall. Fall back to the canonical
    // state colour instead of honouring a malformed override.
    const sanitizedOverride =
      overrideForState && SIX_DIGIT_HEX_PATTERN.test(overrideForState) ? overrideForState : undefined;
    const colorSource = sanitizedOverride ?? state.color;
    const color = colorSource.replace('#', '');
    ledEntries.push({ position: ledPosition, color });
  });

  const totalPlacements = ledEntries.length + skippedPositionCount + skippedRoleCount;

  // If every placement was skipped there's nothing to send — return an empty
  // packet so the caller can handle the full-miss case without an exception.
  if (ledEntries.length === 0) {
    return {
      packet: new Uint8Array(0),
      skippedPositionCount,
      skippedRoleCount,
      totalPlacements,
    };
  }

  // Compute v2 power scale (v3 doesn't need it)
  const v2Scale = isV2 ? computeV2Scale(ledEntries, getLedsPerHold(boardName)) : 1;

  // Build message parts
  const resultArray: number[][] = [];
  let tempArray = [cmds.middle];
  let ledsWritten = 0;

  for (const { position, color } of ledEntries) {
    const encoded = isV2
      ? encodePositionAndColorV2(position, color, v2Scale)
      : encodePositionAndColorV3(position, color);

    if (encoded.length === 0) {
      // v2 position > 1023 — never happens with real Aurora boards (max ~641).
      // Treat as a skipped placement to keep the contract consistent with graceful
      // degradation (result object, not exceptions).
      skippedPositionCount++;
      continue;
    }

    if (tempArray.length + encoded.length > MESSAGE_BODY_MAX_LENGTH) {
      resultArray.push(tempArray);
      tempArray = [cmds.middle];
    }
    tempArray.push(...encoded);
    ledsWritten++;
  }

  // All LEDs overflowed the v2 10-bit limit — return empty packet so the caller
  // can treat it as a full miss (same path as "every placement was skipped").
  if (ledsWritten === 0) {
    return {
      packet: new Uint8Array(0),
      skippedPositionCount,
      skippedRoleCount,
      totalPlacements,
    };
  }

  resultArray.push(tempArray);
  if (resultArray.length === 1) resultArray[0][0] = cmds.only;
  else {
    resultArray[0][0] = cmds.first;
    resultArray[resultArray.length - 1][0] = cmds.last;
  }

  return {
    packet: Uint8Array.from(resultArray.flatMap(wrapBytes)),
    skippedPositionCount,
    skippedRoleCount,
    totalPlacements,
  };
};
