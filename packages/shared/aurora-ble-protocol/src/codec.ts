import type { Rgb } from '@boardsesh/ble-core';

export const MESSAGE_BODY_MAX_LENGTH = 255;
/** Resolved physical addresses and six-digit RGB hex, without a leading '#'. */
export interface AuroraLedEntry {
  position: number;
  color: string;
}
export interface AuroraEncodeOptions {
  /** Defaults to 3 for codecs; connected sessions infer the advertised API level. */
  apiLevel?: number;
  /** Number of physical LEDs powered by one address; Kilter uses two. */
  ledsPerHold?: number;
}
export interface AuroraPacketResult {
  packet: Uint8Array;
  skippedPositionCount: number;
  allLedsDark: boolean;
  ledsWritten: number;
  ledsWithColour: number;
}

export function rgbToHex(color: Rgb): string {
  return color.map((channel) => channel.toString(16).padStart(2, '0')).join('');
}

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

// Shared helpers — exported for testing
export const checksum = (data: number[]) => data.reduce((acc, value) => (acc + value) & 255, 0) ^ 255;

export const wrapBytes = (data: number[]) =>
  data.length > MESSAGE_BODY_MAX_LENGTH ? [] : [1, data.length, checksum(data), 2, ...data, 3];

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
export const computeV2Scale = (
  ledEntries: readonly { position: number; color: string }[],
  ledsPerHold: number,
): number => {
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

/** Deliberate clear is separate from an empty or entirely skipped LED list. */
export function encodeAuroraClear(apiLevel = 3): Uint8Array {
  return Uint8Array.from(wrapBytes([apiLevel < 3 ? V2_COMMANDS.only : V3_COMMANDS.only]));
}

/**
 * Encode resolved LED addresses. This low-level compatibility codec retains
 * Aurora's v2 overflow skipping and power diagnostics. Sessions validate all
 * addresses and colours before calling it, and reject an all-dark v2 result.
 * An empty entry list returns no bytes; use encodeAuroraClear to clear a wall.
 */
export const encodeAuroraEntries = (
  ledEntries: readonly AuroraLedEntry[],
  { apiLevel = 3, ledsPerHold = 1 }: AuroraEncodeOptions = {},
): AuroraPacketResult => {
  const isV2 = apiLevel < 3;
  const cmds = isV2 ? V2_COMMANDS : V3_COMMANDS;
  let skippedPositionCount = 0;
  // Compute v2 power scale (v3 doesn't need it)
  const v2Scale = isV2 ? computeV2Scale(ledEntries, ledsPerHold) : 1;

  // Build message parts
  const resultArray: number[][] = [];
  let messageBody = [cmds.middle];
  let ledsWritten = 0;
  // LEDs whose encoded bytes carry at least one non-zero colour bit. When this
  // stays at 0 for a packet that DID write LEDs, the board receives a full,
  // well-formed packet that lights nothing — see `allLedsDark`.
  let ledsWithColour = 0;

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

    if (messageBody.length + encoded.length > MESSAGE_BODY_MAX_LENGTH) {
      resultArray.push(messageBody);
      messageBody = [cmds.middle];
    }
    messageBody.push(...encoded);
    ledsWritten++;
    // Byte layout, per `encodePositionAndColorV2` / `encodePositionAndColorV3`
    // above: v2 emits [posLo, (r<<6)|(g<<4)|(b<<2)|posHi], so colour is bits
    // [7:2] of byte 2 and 0xfc masks off the position bits; v3 emits
    // [posLo, posHi, colour], so colour is the whole third byte. Both must be
    // re-read if either encoder's packing changes.
    const colourBits = isV2 ? encoded[1] & 0xfc : encoded[2];
    if (colourBits !== 0) ledsWithColour++;
  }

  // All LEDs overflowed the v2 10-bit limit — return empty packet so the caller
  // can treat it as a full miss (same path as "every placement was skipped").
  if (ledsWritten === 0) {
    return {
      packet: new Uint8Array(0),
      skippedPositionCount,
      allLedsDark: false,
      ledsWritten: 0,
      ledsWithColour: 0,
    };
  }

  resultArray.push(messageBody);
  if (resultArray.length === 1) resultArray[0][0] = cmds.only;
  else {
    resultArray[0][0] = cmds.first;
    resultArray[resultArray.length - 1][0] = cmds.last;
  }

  return {
    packet: Uint8Array.from(resultArray.flatMap(wrapBytes)),
    skippedPositionCount,
    // Scoped to v2 deliberately. On v3 a zero colour byte can only come from a
    // caller-supplied near-black `LedColorOverrides` value (R<32, G<32, B<64) —
    // that is the user's own choice, not the power ladder silently overruling
    // them, and refusing their send with "incompatible climb" would be wrong.
    allLedsDark: isV2 && ledsWithColour === 0,
    ledsWritten,
    ledsWithColour,
  };
};
