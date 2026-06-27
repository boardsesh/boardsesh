import { describe, it, expect } from 'vitest';
import {
  checksum,
  wrapBytes,
  encodePositionV3,
  encodeColorV3,
  encodePositionAndColorV3,
  encodePositionAndColorV2,
  scaledColorV2,
  computeV2Scale,
  getAuroraBluetoothPacket,
} from '../aurora';
import { splitMessages } from '../transport';

/**
 * Comprehensive Aurora BLE protocol tests for the CANONICAL encoder
 * (`@boardsesh/ble-protocol`, consumed directly by the React Native app).
 *
 * Validated against:
 * - docs/AURORA_BLUETOOTH_PROTOCOL_SPEC.md (Kilter Board Android App v3.6.4)
 * - Byte-exact payloads captured from Aurora's official Kilter app
 * - 3rd-party validated payloads for Kilter Original boards
 *
 * The web package has an equivalent suite that exercises the same functions via
 * its re-export wrapper; this one pins the shared package itself so a future
 * refactor can't regress the encoder the mobile app ships. Spec sections are
 * referenced in comments (e.g. "§6" = Section 6 of the spec).
 */

// ---- Test helpers ----

function toHex(data: Uint8Array | number[]): string {
  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Decode v3 LED data (3 bytes per LED) from a single framed packet. */
function decodeLedPositionsV3(input: Uint8Array | string): { position: number; color: number }[] {
  const bytes =
    typeof input === 'string'
      ? Array.from({ length: input.length / 2 }, (_, i) => parseInt(input.substring(i * 2, i * 2 + 2), 16))
      : Array.from(input);
  // SOH(1) Length(1) Checksum(1) STX(1) Command(1) ...ledData... ETX(1)
  const ledData = bytes.slice(5, -1);
  const leds: { position: number; color: number }[] = [];
  for (let i = 0; i < ledData.length; i += 3) {
    leds.push({ position: ledData[i] | (ledData[i + 1] << 8), color: ledData[i + 2] });
  }
  return leds;
}

/** Parse concatenated framed data into individual frames (command byte + payload length). */
function parseFrames(packet: Uint8Array): { commandByte: number; payloadLength: number }[] {
  const bytes = Array.from(packet);
  const frames: { commandByte: number; payloadLength: number }[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0x01) break; // not a valid frame start
    const payloadLen = bytes[i + 1];
    const cmdByte = bytes[i + 4]; // SOH(1)+LEN(1)+CHK(1)+STX(1) → index 4
    frames.push({ commandByte: cmdByte, payloadLength: payloadLen });
    i += payloadLen + 5; // header(4) + payload + ETX(1)
  }
  return frames;
}

/** Decode ALL v2 LEDs from a multi-frame packet. */
function decodeAllV2Leds(packet: Uint8Array): { position: number; colorByte: number }[] {
  const bytes = Array.from(packet);
  const leds: { position: number; colorByte: number }[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0x01) break;
    const payloadLen = bytes[i + 1];
    const ledStart = i + 5;
    const ledEnd = i + 4 + payloadLen;
    for (let j = ledStart; j < ledEnd; j += 2) {
      const posLo = bytes[j];
      const byte2 = bytes[j + 1];
      leds.push({ position: posLo | ((byte2 & 0x03) << 8), colorByte: byte2 });
    }
    i += payloadLen + 5;
  }
  return leds;
}

/** Decode ALL v3 LEDs from a multi-frame packet. */
function decodeAllV3Leds(packet: Uint8Array): { position: number; color: number }[] {
  const bytes = Array.from(packet);
  const leds: { position: number; color: number }[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0x01) break;
    const payloadLen = bytes[i + 1];
    const ledStart = i + 5;
    const ledEnd = i + 4 + payloadLen;
    for (let j = ledStart; j < ledEnd; j += 3) {
      leds.push({ position: bytes[j] | (bytes[j + 1] << 8), color: bytes[j + 2] });
    }
    i += payloadLen + 5;
  }
  return leds;
}

// =============================================================================
// §6 — Message Framing Protocol
// =============================================================================

describe('§6 Message Framing Protocol', () => {
  describe('checksum (bitwise NOT of 8-bit sum)', () => {
    it('matches spec Example 1 payload', () => {
      // sum([0x54,0x2A,0x00,0x1C]) & 0xFF = 0x9A; ~0x9A & 0xFF = 0x65
      expect(checksum([0x54, 0x2a, 0x00, 0x1c])).toBe(0x65);
    });

    it('handles single bytes', () => {
      expect(checksum([0x00])).toBe(0xff);
      expect(checksum([0xff])).toBe(0x00);
    });

    it('wraps on overflow', () => {
      // 0x80 + 0x80 = 0x100 & 0xFF = 0x00; ~0x00 & 0xFF = 0xFF
      expect(checksum([0x80, 0x80])).toBe(0xff);
    });

    it('matches the byte-exact validated 12x12 payload checksum (0xBB)', () => {
      const payload = [0x54, 0x44, 0x00, 0xe3, 0xdc, 0x01, 0xe3, 0x00, 0x00, 0xf4, 0x21, 0x00, 0xf4];
      expect(wrapBytes(payload)[2]).toBe(0xbb);
    });
  });

  describe('wrapBytes (SOH/LEN/CHK/STX/PAYLOAD/ETX)', () => {
    it('produces the correct frame for spec Example 1 payload', () => {
      const payload = [0x54, 0x2a, 0x00, 0x1c];
      const frame = wrapBytes(payload);
      expect(frame[0]).toBe(0x01); // SOH
      expect(frame[1]).toBe(4); // LEN = payload length
      expect(frame[2]).toBe(0x65); // CHK
      expect(frame[3]).toBe(0x02); // STX
      expect(frame.slice(4, 8)).toEqual(payload);
      expect(frame[8]).toBe(0x03); // ETX
    });

    it('total frame size = payload_length + 5', () => {
      expect(wrapBytes([1, 2, 3, 4, 5]).length).toBe(10);
    });

    it('returns empty array when payload exceeds 255 bytes', () => {
      expect(wrapBytes(new Array(256).fill(0))).toEqual([]);
    });

    it('accepts exactly 255 bytes (max payload)', () => {
      const frame = wrapBytes(new Array(255).fill(0));
      expect(frame.length).toBe(260);
      expect(frame[1]).toBe(255);
    });

    it('handles an empty payload', () => {
      expect(wrapBytes([])).toEqual([0x01, 0x00, 0xff, 0x02, 0x03]);
    });
  });
});

// =============================================================================
// §7.2 — API v3 Encoding (3 bytes per LED)
// =============================================================================

describe('§7.2 API v3 Encoding', () => {
  describe('encodePositionV3 (16-bit little-endian)', () => {
    it.each([
      [0, [0x00, 0x00]],
      [42, [0x2a, 0x00]],
      [256, [0x00, 0x01]],
      [389, [0x85, 0x01]], // Kilter 8x12 max range
      [527, [0x0f, 0x02]], // Kilter 12x14 max
      [65535, [0xff, 0xff]], // 16-bit max
    ])('encodes position %i', (position, expected) => {
      expect(encodePositionV3(position)).toEqual(expected);
    });
  });

  describe('encodeColorV3 (3:3:2 RGB)', () => {
    it.each([
      ['00FF00', 0x1c], // green: G=7<<2
      ['FF0000', 0xe0], // red: R=7<<5
      ['0000FF', 0x03], // blue: B=3
      ['FFFFFF', 0xff], // white: R=7,G=7,B=3
      ['000000', 0x00], // black
      ['FF00FF', 0xe3], // magenta
      ['FFAA00', 0xf4], // orange: R=7<<5, G=5<<2
    ])('encodes "%s" -> 0x%s', (color, expected) => {
      expect(encodeColorV3(color)).toBe(expected);
    });
  });

  describe('encodePositionAndColorV3', () => {
    it('produces 3 bytes per LED', () => {
      expect(encodePositionAndColorV3(42, '00FF00')).toHaveLength(3);
    });

    it('matches spec Example 1: position=42, color="00FF00"', () => {
      expect(encodePositionAndColorV3(42, '00FF00')).toEqual([0x2a, 0x00, 0x1c]);
    });

    it('max LEDs per v3 frame = 84 (254 / 3)', () => {
      expect(Math.floor(254 / 3)).toBe(84);
    });
  });
});

// =============================================================================
// §7.1 — API v2 Encoding (2 bytes per LED)
// =============================================================================

describe('§7.1 API v2 Encoding', () => {
  describe('scaledColorV2', () => {
    it.each([
      [0xff, 1.0, 3],
      [0x00, 1.0, 0],
      [0x00, 0.5, 0],
      [0xff, 0.5, 1], // floor(127.5) >> 6 = 1
      [0xff, 0.1, 0], // floor(25.5) >> 6 = 0
    ])('scales 0x%s at %f -> %i', (value, scale, expected) => {
      expect(scaledColorV2(value, scale)).toBe(expected);
    });

    it('is always a 2-bit value (0-3)', () => {
      expect(scaledColorV2(0xff, 1.0)).toBeLessThanOrEqual(3);
      expect(scaledColorV2(0xff, 1.0)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('encodePositionAndColorV2', () => {
    it('produces 2 bytes per LED', () => {
      expect(encodePositionAndColorV2(10, '00FF00', 1.0)).toHaveLength(2);
    });

    it('matches spec Example 2 LED 1: pos=10, "00FF00", scale=1.0', () => {
      // color_byte = (0<<6)|(3<<4)|(0<<2)|0x00 = 0x30
      expect(encodePositionAndColorV2(10, '00FF00', 1.0)).toEqual([0x0a, 0x30]);
    });

    it('matches spec Example 2 LED 2: pos=256, "0000FF", scale=1.0', () => {
      // color_byte = (0<<6)|(0<<4)|(3<<2)|0x01 = 0x0D
      expect(encodePositionAndColorV2(256, '0000FF', 1.0)).toEqual([0x00, 0x0d]);
    });

    it('matches spec Example 2 LED 3: pos=500, "FF0000", scale=1.0', () => {
      // color_byte = (3<<6)|(0<<4)|(0<<2)|0x01 = 0xC1
      expect(encodePositionAndColorV2(500, 'FF0000', 1.0)).toEqual([0xf4, 0xc1]);
    });

    it('packs position bits [9:8] into color byte bits [1:0]', () => {
      expect(encodePositionAndColorV2(768, '000000', 1.0)[1] & 0x03).toBe(3); // 0x300
    });

    it('returns empty array for position > 1023 (10-bit limit)', () => {
      expect(encodePositionAndColorV2(1024, 'FF0000', 1.0)).toEqual([]);
    });

    it('encodes position 1023 (10-bit max)', () => {
      const result = encodePositionAndColorV2(1023, '000000', 1.0);
      expect(result[0] | ((result[1] & 0x03) << 8)).toBe(1023);
    });

    it('applies the power scale to colors', () => {
      const full = encodePositionAndColorV2(0, 'FF0000', 1.0);
      const half = encodePositionAndColorV2(0, 'FF0000', 0.5);
      expect((full[1] >> 6) & 0x03).toBe(3); // R=3
      expect((half[1] >> 6) & 0x03).toBe(1); // R=1
    });

    it('max LEDs per v2 frame = 127 (254 / 2)', () => {
      expect(Math.floor(254 / 2)).toBe(127);
    });
  });
});

// =============================================================================
// §10 — Power Management (v2 only)
// =============================================================================

describe('§10 Power Management (v2)', () => {
  it('returns 1.0 for a small number of LEDs', () => {
    expect(computeV2Scale([{ position: 0, color: 'FF0000' }], 1)).toBe(1.0);
  });

  it('scales down when total power exceeds the 18W budget', () => {
    const leds = Array.from({ length: 40 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
    const scale = computeV2Scale(leds, 2); // Kilter
    expect(scale).toBeLessThan(1.0);
    expect(scale).toBeGreaterThan(0);
  });

  it('Kilter (ledsPerHold=2) scales down at least as hard as Tension (ledsPerHold=1)', () => {
    const leds = Array.from({ length: 40 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
    expect(computeV2Scale(leds, 2)).toBeLessThanOrEqual(computeV2Scale(leds, 1));
  });

  it('only ever returns a value from the spec progression', () => {
    const leds = Array.from({ length: 200 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
    expect([1.0, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05, 0]).toContain(computeV2Scale(leds, 2));
  });

  it('black LEDs always fit at scale 1.0', () => {
    const leds = Array.from({ length: 500 }, (_, i) => ({ position: i, color: '000000' }));
    expect(computeV2Scale(leds, 2)).toBe(1.0);
  });

  it('power per LED = (r+g+b)/30 at the budget boundary', () => {
    // white LED at scale 1.0: R=G=B=3 → 0.3W. 59 LEDs * 0.3 = 17.7W ≤ 18W → 1.0
    const leds59 = Array.from({ length: 59 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
    expect(computeV2Scale(leds59, 1)).toBe(1.0);
    // 61 LEDs * 0.3 = 18.3W > 18W; scale 0.8 still floors to 3, so it drops to 0.6
    const leds61 = Array.from({ length: 61 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
    expect(computeV2Scale(leds61, 1)).toBe(0.6);
  });
});

// =============================================================================
// §8 — Multi-Part Message Sequencing
// =============================================================================

describe('§8 Multi-Part Message Sequencing', () => {
  it('v3 single-frame uses T (84)', () => {
    const frames = parseFrames(getAuroraBluetoothPacket('p1r42', { 1: 10 }, 'kilter', 3).packet);
    expect(frames).toHaveLength(1);
    expect(frames[0].commandByte).toBe(84);
  });

  it('v3 multi-frame uses R/Q/S (82/81/83)', () => {
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 100; i++) {
      positions[i] = i;
      frames += `p${i}r42`;
    }
    const parsed = parseFrames(getAuroraBluetoothPacket(frames, positions, 'kilter', 3).packet);
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed[0].commandByte).toBe(82); // R = Start
    expect(parsed[parsed.length - 1].commandByte).toBe(83); // S = End
    for (let i = 1; i < parsed.length - 1; i++) expect(parsed[i].commandByte).toBe(81); // Q
  });

  it('v2 single-frame uses P (80)', () => {
    const frames = parseFrames(getAuroraBluetoothPacket('p1r42', { 1: 10 }, 'kilter', 2).packet);
    expect(frames[0].commandByte).toBe(80);
  });

  it('v2 multi-frame uses N/M/O (78/77/79)', () => {
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 200; i++) {
      positions[i] = i;
      frames += `p${i}r42`;
    }
    const parsed = parseFrames(getAuroraBluetoothPacket(frames, positions, 'kilter', 2).packet);
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed[0].commandByte).toBe(78); // N
    expect(parsed[parsed.length - 1].commandByte).toBe(79); // O
    for (let i = 1; i < parsed.length - 1; i++) expect(parsed[i].commandByte).toBe(77); // M
  });

  it('no frame payload exceeds 255 bytes', () => {
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 300; i++) {
      positions[i] = i;
      frames += `p${i}r42`;
    }
    const parsed = parseFrames(getAuroraBluetoothPacket(frames, positions, 'kilter', 3).packet);
    for (const frame of parsed) expect(frame.payloadLength).toBeLessThanOrEqual(255);
  });

  it('all LEDs survive multi-frame splitting (v3, no data loss)', () => {
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 200; i++) {
      positions[i] = i;
      frames += `p${i}r42`;
    }
    const leds = decodeAllV3Leds(getAuroraBluetoothPacket(frames, positions, 'kilter', 3).packet);
    expect(leds.map((l) => l.position).sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it('all LEDs survive multi-frame splitting (v2, no data loss)', () => {
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 200; i++) {
      positions[i] = i;
      frames += `p${i}r42`;
    }
    const leds = decodeAllV2Leds(getAuroraBluetoothPacket(frames, positions, 'kilter', 2).packet);
    expect(leds.map((l) => l.position).sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });
});

// =============================================================================
// §7.5 — Empty-frames "clear all" packet
// =============================================================================

describe('clear-all packet (empty frames)', () => {
  it('emits a single ONLY-command frame with no LED data on v3', () => {
    const parsed = parseFrames(getAuroraBluetoothPacket('', {}, 'kilter', 3).packet);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].commandByte).toBe(84); // T
    expect(parsed[0].payloadLength).toBe(1); // command byte only
  });

  it('emits a single ONLY-command frame on v2 (P)', () => {
    const parsed = parseFrames(getAuroraBluetoothPacket('', {}, 'kilter', 2).packet);
    expect(parsed[0].commandByte).toBe(80);
    expect(parsed[0].payloadLength).toBe(1);
  });

  it('does not take the clear path when all placements are skipped', () => {
    const result = getAuroraBluetoothPacket('p999r42', {}, 'kilter', 3);
    expect(result.packet.length).toBe(0); // not a clear — a render miss
    expect(result.skippedPositionCount).toBe(1);
  });
});

// =============================================================================
// §17 — Worked Examples (byte-exact)
// =============================================================================

describe('§17 Worked Examples', () => {
  it('Example 1: single LED v3, position=42, color="00FF00"', () => {
    const payload = [0x54, ...encodePositionAndColorV3(42, '00FF00')];
    expect(payload).toEqual([0x54, 0x2a, 0x00, 0x1c]);
    expect(checksum(payload)).toBe(0x65);
    expect(toHex(wrapBytes(payload))).toBe('01046502542a001c03');
  });

  it('Example 2: three LEDs v2, scale=1.0 (corrected checksum 0xB3)', () => {
    const led1 = encodePositionAndColorV2(10, '00FF00', 1.0);
    const led2 = encodePositionAndColorV2(256, '0000FF', 1.0);
    const led3 = encodePositionAndColorV2(500, 'FF0000', 1.0);
    expect(led1).toEqual([0x0a, 0x30]);
    expect(led2).toEqual([0x00, 0x0d]);
    expect(led3).toEqual([0xf4, 0xc1]);

    const payload = [0x50, ...led1, ...led2, ...led3];
    expect(payload).toEqual([0x50, 0x0a, 0x30, 0x00, 0x0d, 0xf4, 0xc1]);
    // The spec doc originally mis-stated this checksum as 0xA9; the real value
    // (and the one the hardware accepts) is 0xB3 = ~(0x4C).
    expect(checksum(payload)).toBe(0xb3);
    expect(toHex(wrapBytes(payload))).toBe('0107b302500a30000df4c103');
  });
});

// =============================================================================
// API-level selection
// =============================================================================

describe('getAuroraBluetoothPacket — API level selection', () => {
  const positions: Record<number, number> = { 1: 10 };

  it('defaults to v3 encoding when apiLevel is omitted', () => {
    const frames = parseFrames(getAuroraBluetoothPacket('p1r42', positions, 'kilter').packet);
    expect(frames[0].commandByte).toBe(84); // T
  });

  it('uses v3 for apiLevel=3 (3 bytes/LED)', () => {
    const bytes = Array.from(getAuroraBluetoothPacket('p1r42', positions, 'kilter', 3).packet);
    expect(bytes[1]).toBe(4); // cmd + 3-byte LED
    expect(bytes[4]).toBe(84);
  });

  it('uses v2 for apiLevel=2 (2 bytes/LED)', () => {
    const bytes = Array.from(getAuroraBluetoothPacket('p1r42', positions, 'kilter', 2).packet);
    expect(bytes[1]).toBe(3); // cmd + 2-byte LED
    expect(bytes[4]).toBe(80);
  });

  it('uses v2 for apiLevel=1', () => {
    const frames = parseFrames(getAuroraBluetoothPacket('p1r42', positions, 'kilter', 1).packet);
    expect(frames[0].commandByte).toBe(80);
  });
});

// =============================================================================
// v2 10-bit position skipping
// =============================================================================

describe('getAuroraBluetoothPacket — v2 position limits', () => {
  it('skips v2 positions over the 10-bit limit rather than throwing', () => {
    const result = getAuroraBluetoothPacket('p1r42p2r42', { 1: 39, 2: 1024 }, 'kilter', 2);
    expect(result.skippedPositionCount).toBe(1);
    expect(result.totalPlacements).toBe(2);
    expect(result.packet.length).toBeGreaterThan(0);
  });

  it('returns an empty packet when every v2 position exceeds the limit', () => {
    const result = getAuroraBluetoothPacket('p1r42p2r42', { 1: 1024, 2: 2000 }, 'kilter', 2);
    expect(result.skippedPositionCount).toBe(2);
    expect(result.packet.length).toBe(0);
  });
});

// =============================================================================
// Color overrides (sanitization parity with the Swift encoder)
// =============================================================================

describe('getAuroraBluetoothPacket — color overrides', () => {
  it('honours a valid 6-digit hex override', () => {
    const result = getAuroraBluetoothPacket('p100r12', { 100: 5 }, 'kilter', 3, { STARTING: '#FF0000' });
    expect(result.packet).toEqual(Uint8Array.from(wrapBytes([84, 5, 0, 224])));
  });

  it('ignores a malformed override and falls back to the canonical color', () => {
    const positions = { 100: 5 };
    const canonical = getAuroraBluetoothPacket('p100r12', positions, 'kilter', 3);
    for (const bad of ['#fff', 'red', '#FF00FF00', '12345g']) {
      expect(getAuroraBluetoothPacket('p100r12', positions, 'kilter', 3, { STARTING: bad }).packet).toEqual(
        canonical.packet,
      );
    }
  });
});

// =============================================================================
// Byte-exact captured Aurora payloads (ground truth from the official app)
// =============================================================================

const AURORA_8x12_HEX = '01134002542700e38501e31400f41300f40100f40000f403';
const AURORA_10x12_HEX = '0113e202545000e3ae01e30400f40300f41700f41600f403';
const CLIMB_FRAMES = 'p4131r42p4421r42p4669r45p4655r45p4665r45p4678r45';
const CORRECT_8x12_POSITIONS: Record<number, number> = { 4131: 39, 4421: 389, 4669: 20, 4655: 19, 4665: 1, 4678: 0 };
const CORRECT_10x12_POSITIONS: Record<number, number> = { 4131: 80, 4421: 430, 4669: 4, 4655: 3, 4665: 23, 4678: 22 };

describe('Captured Aurora payloads — position verification', () => {
  it('Kilter 10x12 Full Ride positions match the Aurora app', () => {
    const ours = decodeLedPositionsV3(getAuroraBluetoothPacket(CLIMB_FRAMES, CORRECT_10x12_POSITIONS, 'kilter').packet);
    expect(ours.map((l) => l.position)).toEqual(decodeLedPositionsV3(AURORA_10x12_HEX).map((l) => l.position));
  });

  it('Kilter 8x12 Full Ride positions match the Aurora app', () => {
    const ours = decodeLedPositionsV3(getAuroraBluetoothPacket(CLIMB_FRAMES, CORRECT_8x12_POSITIONS, 'kilter').packet);
    expect(ours.map((l) => l.position)).toEqual(decodeLedPositionsV3(AURORA_8x12_HEX).map((l) => l.position));
  });
});

// 3rd-party validated payloads for Kilter Original (Layout 1) — FULL byte-exact
const VALIDATED_12x12_HEX = '010dbb02544400e3dc01e30000f42100f403';
const VALIDATED_8x12_ORIGINAL_HEX = '010d7802543800e33701e30000f41500f403';
const CORNERS_12x12_FRAMES = 'p1379r44p1395r44p1447r45p1464r45';
const CORNERS_8x12_ORIGINAL_FRAMES = 'p1382r44p1392r44p1450r45p1461r45';
const CORRECT_12x12_POSITIONS: Record<number, number> = { 1379: 68, 1395: 476, 1447: 0, 1464: 33 };
const CORRECT_8x12_ORIGINAL_POSITIONS: Record<number, number> = { 1382: 56, 1392: 311, 1450: 0, 1461: 21 };

describe('Kilter Original (Layout 1) — 3rd-party validated payloads (byte-exact)', () => {
  it('12x12 full packet byte-exact match', () => {
    const packet = getAuroraBluetoothPacket(CORNERS_12x12_FRAMES, CORRECT_12x12_POSITIONS, 'kilter').packet;
    expect(toHex(packet)).toBe(VALIDATED_12x12_HEX);
  });

  it('8x12 Original full packet byte-exact match', () => {
    const packet = getAuroraBluetoothPacket(
      CORNERS_8x12_ORIGINAL_FRAMES,
      CORRECT_8x12_ORIGINAL_POSITIONS,
      'kilter',
    ).packet;
    expect(toHex(packet)).toBe(VALIDATED_8x12_ORIGINAL_HEX);
  });
});

// =============================================================================
// §9 — BLE Transmission chunking (protocol-agnostic)
// =============================================================================

describe('§9 BLE Transmission — splitMessages over a real packet', () => {
  it('chunks a multi-frame packet into 20-byte segments that reassemble', () => {
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 120; i++) {
      positions[i] = i;
      frames += `p${i}r42`;
    }
    const packet = getAuroraBluetoothPacket(frames, positions, 'kilter', 3).packet;
    const chunks = splitMessages(packet);
    expect(chunks.length).toBe(Math.ceil(packet.length / 20));
    for (let i = 0; i < chunks.length - 1; i++) expect(chunks[i].length).toBe(20);
    const reassembled = new Uint8Array(packet.length);
    let offset = 0;
    for (const chunk of chunks) {
      reassembled.set(chunk, offset);
      offset += chunk.length;
    }
    expect(reassembled).toEqual(packet);
  });
});
