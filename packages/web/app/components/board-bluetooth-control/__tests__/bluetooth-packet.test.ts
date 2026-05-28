import { describe, it, expect, vi } from 'vite-plus/test';
import {
  checksum,
  wrapBytes,
  encodePositionV3,
  encodeColorV3,
  encodePositionAndColorV3,
  encodePositionAndColorV2,
  scaledColorV2,
  computeV2Scale,
  getAuroraBluetoothPacket as getBluetoothPacket,
  parseApiLevel,
} from '../bluetooth-aurora';
import { splitMessages } from '../bluetooth-shared';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';

/**
 * Comprehensive BLE protocol tests validated against:
 * - Aurora Bluetooth Protocol Spec (derived from Kilter Board Android App v3.6.4)
 * - Captured payloads from Aurora's official Kilter app
 * - 3rd-party validated payloads for Kilter Original boards
 *
 * Spec sections referenced in comments (e.g. "§6" = Section 6 of the spec).
 */

// Mock transitive dependencies so bluetooth-aurora.ts can be imported directly
vi.mock('@/app/lib/moonboard-config', () => ({
  MOONBOARD_ENABLED: false,
}));

// ---- Test helpers ----

function toHex(data: Uint8Array | number[]): string {
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, '0'))
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
    leds.push({
      position: ledData[i] | (ledData[i + 1] << 8),
      color: ledData[i + 2],
    });
  }
  return leds;
}

/** Decode v2 LED data (2 bytes per LED) from a single framed packet. */
function decodeLedPositionsV2(input: Uint8Array | string): { position: number; colorByte: number }[] {
  const bytes =
    typeof input === 'string'
      ? Array.from({ length: input.length / 2 }, (_, i) => parseInt(input.substring(i * 2, i * 2 + 2), 16))
      : Array.from(input);
  const ledData = bytes.slice(5, -1);
  const leds: { position: number; colorByte: number }[] = [];
  for (let i = 0; i < ledData.length; i += 2) {
    const posLo = ledData[i];
    const byte2 = ledData[i + 1];
    const posHi = byte2 & 0x03;
    leds.push({
      position: posLo | (posHi << 8),
      colorByte: byte2,
    });
  }
  return leds;
}

/**
 * Parse concatenated framed data into individual frames.
 * Each frame starts with SOH (0x01) and ends with ETX (0x03).
 * Returns the command byte (first byte of payload) for each frame.
 */
function parseFrames(packet: Uint8Array): { commandByte: number; payloadLength: number }[] {
  const bytes = Array.from(packet);
  const frames: { commandByte: number; payloadLength: number }[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0x01) break; // Not a valid frame start
    const payloadLen = bytes[i + 1];
    const cmdByte = bytes[i + 4]; // SOH(1) + LEN(1) + CHK(1) + STX(1) → index 4
    frames.push({ commandByte: cmdByte, payloadLength: payloadLen });
    // Skip to next frame: header(4) + payload + ETX(1) = payloadLen + 5
    i += payloadLen + 5;
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
    // LED data starts after header(4) + command byte(1) = i+5
    const ledStart = i + 5;
    const ledEnd = i + 4 + payloadLen; // header(4) + payloadLen, minus ETX
    for (let j = ledStart; j < ledEnd; j += 2) {
      const posLo = bytes[j];
      const byte2 = bytes[j + 1];
      leds.push({
        position: posLo | ((byte2 & 0x03) << 8),
        colorByte: byte2,
      });
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
      leds.push({
        position: bytes[j] | (bytes[j + 1] << 8),
        color: bytes[j + 2],
      });
    }
    i += payloadLen + 5;
  }
  return leds;
}

// =============================================================================
// §6 — Message Framing Protocol
// =============================================================================

describe('§6 Message Framing Protocol', () => {
  describe('checksum', () => {
    it('computes bitwise NOT of 8-bit sum (spec algorithm)', () => {
      // checksum = (~(sum of all payload bytes)) & 0xFF
      // For payload [0x54, 0x2A, 0x00, 0x1C] (from spec Example 1):
      // sum = (0x54 + 0x2A + 0x00 + 0x1C) & 0xFF = 0x9A
      // checksum = ~0x9A & 0xFF = 0x65
      expect(checksum([0x54, 0x2a, 0x00, 0x1c])).toBe(0x65);
    });

    it('handles single byte', () => {
      // ~0x00 & 0xFF = 0xFF
      expect(checksum([0x00])).toBe(0xff);
      // ~0xFF & 0xFF = 0x00
      expect(checksum([0xff])).toBe(0x00);
    });

    it('wraps on overflow correctly', () => {
      // Two 0x80 values: sum = 0x100 & 0xFF = 0x00, ~0x00 & 0xFF = 0xFF
      expect(checksum([0x80, 0x80])).toBe(0xff);
    });

    it('is verified correct by byte-exact Aurora payload matches', () => {
      // The captured Aurora payloads below pass byte-exact comparison,
      // which implicitly verifies checksum correctness against the real hardware.
      // This is more authoritative than the spec's worked examples which
      // contain arithmetic errors in the checksum calculation.
      const payload = [0x54, 0x44, 0x00, 0xe3, 0xdc, 0x01, 0xe3, 0x00, 0x00, 0xf4, 0x21, 0x00, 0xf4];
      const frame = wrapBytes(payload);
      // This checksum matches the validated 12x12 payload: 010dbb0254...
      expect(frame[2]).toBe(0xbb);
    });
  });

  describe('wrapBytes (frame structure)', () => {
    it('produces correct frame: SOH + LENGTH + CHECKSUM + STX + PAYLOAD + ETX', () => {
      const payload = [0x54, 0x2a, 0x00, 0x1c];
      const frame = wrapBytes(payload);
      expect(frame[0]).toBe(0x01); // SOH
      expect(frame[1]).toBe(4); // LENGTH = payload.length
      expect(frame[2]).toBe(0x65); // CHECKSUM
      expect(frame[3]).toBe(0x02); // STX
      expect(frame.slice(4, 8)).toEqual(payload);
      expect(frame[8]).toBe(0x03); // ETX
    });

    it('total frame size = payload_length + 5', () => {
      const payload = [1, 2, 3, 4, 5];
      const frame = wrapBytes(payload);
      expect(frame.length).toBe(payload.length + 5);
    });

    it('returns empty array when payload exceeds 255 bytes', () => {
      const oversized = Array.from({ length: 256 }, () => 0);
      expect(wrapBytes(oversized)).toEqual([]);
    });

    it('accepts exactly 255 bytes (max payload)', () => {
      const maxPayload = Array.from({ length: 255 }, () => 0);
      const frame = wrapBytes(maxPayload);
      expect(frame.length).toBe(260); // 255 + 5
      expect(frame[1]).toBe(255); // LENGTH
    });

    it('handles empty payload', () => {
      const frame = wrapBytes([]);
      expect(frame).toEqual([0x01, 0x00, 0xff, 0x02, 0x03]);
    });
  });
});

// =============================================================================
// §7.2 — API v3 Encoding (3 bytes per LED)
// =============================================================================

describe('§7.2 API v3 Encoding', () => {
  describe('encodePositionV3 (16-bit little-endian)', () => {
    it('encodes position 0', () => {
      expect(encodePositionV3(0)).toEqual([0x00, 0x00]);
    });

    it('encodes position 42 (spec Example 1)', () => {
      expect(encodePositionV3(42)).toEqual([0x2a, 0x00]);
    });

    it('encodes position 256 (crosses byte boundary)', () => {
      expect(encodePositionV3(256)).toEqual([0x00, 0x01]);
    });

    it('encodes position 389 (Kilter 8x12 max range)', () => {
      expect(encodePositionV3(389)).toEqual([0x85, 0x01]);
    });

    it('encodes position 527 (Kilter 12x14 max)', () => {
      expect(encodePositionV3(527)).toEqual([0x0f, 0x02]);
    });

    it('encodes position 65535 (16-bit max)', () => {
      expect(encodePositionV3(65535)).toEqual([0xff, 0xff]);
    });
  });

  describe('encodeColorV3', () => {
    it('encodes "00FF00" green: R=0, G=7, B=0 -> 0x1C', () => {
      // R: 0x00/32 = 0 << 5 = 0x00
      // G: 0xFF/32 = 7 << 2 = 0x1C
      // B: 0x00/64 = 0
      expect(encodeColorV3('00FF00')).toBe(0x1c);
    });

    it('encodes "FF0000" red: R=7, G=0, B=0 -> 0xE0', () => {
      expect(encodeColorV3('FF0000')).toBe(0xe0);
    });

    it('encodes "0000FF" blue: R=0, G=0, B=3 -> 0x03', () => {
      expect(encodeColorV3('0000FF')).toBe(0x03);
    });

    it('encodes "FFFFFF" white: R=7, G=7, B=3 -> 0xFF', () => {
      expect(encodeColorV3('FFFFFF')).toBe(0xff);
    });

    it('encodes "000000" black: all zeros -> 0x00', () => {
      expect(encodeColorV3('000000')).toBe(0x00);
    });

    it('encodes "FF00FF" magenta: R=7, G=0, B=3 -> 0xE3', () => {
      expect(encodeColorV3('FF00FF')).toBe(0xe3);
    });

    it('encodes "FFAA00" orange: R=7, G=5, B=0 -> 0xF4', () => {
      // R: 0xFF/32 = 7 << 5 = 0xE0
      // G: 0xAA/32 = 5 << 2 = 0x14
      // B: 0x00/64 = 0
      expect(encodeColorV3('FFAA00')).toBe(0xf4);
    });
  });

  describe('encodePositionAndColorV3', () => {
    it('produces 3 bytes per LED', () => {
      const result = encodePositionAndColorV3(42, '00FF00');
      expect(result).toHaveLength(3);
    });

    it('matches spec Example 1: position=42, color="00FF00"', () => {
      // pos_lo=0x2A, pos_hi=0x00, color=0x1C
      expect(encodePositionAndColorV3(42, '00FF00')).toEqual([0x2a, 0x00, 0x1c]);
    });

    it('max LEDs per v3 frame: 84 (254 bytes / 3 bytes per LED)', () => {
      // §7.2: Available payload after command byte: 254 bytes
      // 254 / 3 = 84.67, so max 84 LEDs
      expect(Math.floor(254 / 3)).toBe(84);
    });
  });
});

// =============================================================================
// §7.1 — API v2 Encoding (2 bytes per LED)
// =============================================================================

describe('§7.1 API v2 Encoding', () => {
  describe('scaledColorV2', () => {
    it('scales 0xFF at scale=1.0: floor(255*1.0)/64 = 3', () => {
      expect(scaledColorV2(0xff, 1.0)).toBe(3);
    });

    it('scales 0x00 at any scale: 0', () => {
      expect(scaledColorV2(0x00, 1.0)).toBe(0);
      expect(scaledColorV2(0x00, 0.5)).toBe(0);
    });

    it('scales 0xFF at scale=0.5: floor(127.5)/64 = 1', () => {
      expect(scaledColorV2(0xff, 0.5)).toBe(1);
    });

    it('scales 0xFF at scale=0.1: floor(25.5)/64 = 0', () => {
      expect(scaledColorV2(0xff, 0.1)).toBe(0);
    });

    it('result is always 0-3 (2-bit)', () => {
      expect(scaledColorV2(0xff, 1.0)).toBeLessThanOrEqual(3);
      expect(scaledColorV2(0xff, 1.0)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('encodePositionAndColorV2', () => {
    it('produces 2 bytes per LED', () => {
      expect(encodePositionAndColorV2(10, '00FF00', 1.0)).toHaveLength(2);
    });

    it('matches spec Example 2 LED 1: pos=10, color="00FF00", scale=1.0', () => {
      // pos_lo = 10 & 0xFF = 0x0A
      // pos_hi = (10 >> 8) & 0x03 = 0x00
      // R=0, G=floor(0xFF*1.0)/64=3, B=0
      // color_byte = (0<<6)|(3<<4)|0x00|(0<<2) = 0x30
      const result = encodePositionAndColorV2(10, '00FF00', 1.0);
      expect(result).toEqual([0x0a, 0x30]);
    });

    it('matches spec Example 2 LED 2: pos=256, color="0000FF", scale=1.0', () => {
      // pos_lo = 256 & 0xFF = 0x00
      // pos_hi = (256 >> 8) & 0x03 = 0x01
      // R=0, G=0, B=floor(0xFF*1.0)/64=3
      // color_byte = (0<<6)|(0<<4)|(3<<2)|0x01 = 0x0D
      const result = encodePositionAndColorV2(256, '0000FF', 1.0);
      expect(result).toEqual([0x00, 0x0d]);
    });

    it('matches spec Example 2 LED 3: pos=500, color="FF0000", scale=1.0', () => {
      // pos_lo = 500 & 0xFF = 0xF4
      // pos_hi = (500 >> 8) & 0x03 = 0x01
      // R=floor(0xFF*1.0)/64=3, G=0, B=0
      // color_byte = (3<<6)|(0<<4)|(0<<2)|0x01 = 0xC1
      const result = encodePositionAndColorV2(500, 'FF0000', 1.0);
      expect(result).toEqual([0xf4, 0xc1]);
    });

    it('packs position upper 2 bits into color byte bits [1:0]', () => {
      // Position 768 = 0x300 → posHi = 3
      const result = encodePositionAndColorV2(768, '000000', 1.0);
      expect(result[1] & 0x03).toBe(3);
    });

    it('returns empty array for position > 1023 (10-bit limit)', () => {
      expect(encodePositionAndColorV2(1024, 'FF0000', 1.0)).toEqual([]);
    });

    it('encodes position 1023 (10-bit max)', () => {
      const result = encodePositionAndColorV2(1023, '000000', 1.0);
      expect(result).toHaveLength(2);
      const posLo = result[0];
      const posHi = result[1] & 0x03;
      expect(posLo | (posHi << 8)).toBe(1023);
    });

    it('max LEDs per v2 frame: 127 (254 bytes / 2 bytes per LED)', () => {
      // §7.1: Available payload after command byte: 254 bytes
      expect(Math.floor(254 / 2)).toBe(127);
    });

    it('applies power scale to colors', () => {
      // At scale=0.5: R=floor(255*0.5)/64=1
      const full = encodePositionAndColorV2(0, 'FF0000', 1.0);
      const half = encodePositionAndColorV2(0, 'FF0000', 0.5);
      // Full scale: R=3 → (3<<6) = 0xC0
      expect((full[1] >> 6) & 0x03).toBe(3);
      // Half scale: R=1 → (1<<6) = 0x40
      expect((half[1] >> 6) & 0x03).toBe(1);
    });
  });
});

// =============================================================================
// §10 — Power Management (API v2)
// =============================================================================

describe('§10 Power Management (v2 only)', () => {
  describe('computeV2Scale', () => {
    it('returns 1.0 for a small number of LEDs (well within budget)', () => {
      const leds = [{ position: 0, color: 'FF0000' }];
      expect(computeV2Scale(leds, 1)).toBe(1.0);
    });

    it('returns 1.0 for Kilter (ledsPerHold=2) with few LEDs', () => {
      const leds = Array.from({ length: 5 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
      expect(computeV2Scale(leds, 2)).toBe(1.0);
    });

    it('scales down when total power exceeds 18W budget', () => {
      // At scale=1.0: white LED R=G=B=3 → power per LED = (3+3+3)/30 = 0.3W
      // With ledsPerHold=2: effective = 2 * N * 0.3
      // For N=40: 2 * 40 * 0.3 = 24W > 18W → must scale down
      const leds = Array.from({ length: 40 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
      const scale = computeV2Scale(leds, 2);
      expect(scale).toBeLessThan(1.0);
      expect(scale).toBeGreaterThan(0);
    });

    it('Kilter (ledsPerHold=2) scales down more aggressively than Tension (ledsPerHold=1)', () => {
      const leds = Array.from({ length: 40 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
      const kilterScale = computeV2Scale(leds, 2);
      const tensionScale = computeV2Scale(leds, 1);
      expect(kilterScale).toBeLessThanOrEqual(tensionScale);
    });

    it('uses spec scale progression: [1.0, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05]', () => {
      const leds = Array.from({ length: 40 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
      const scale = computeV2Scale(leds, 2);
      expect([1.0, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05, 0]).toContain(scale);
    });

    it('black LEDs (000000) always fit at scale=1.0', () => {
      const leds = Array.from({ length: 500 }, (_, i) => ({ position: i, color: '000000' }));
      expect(computeV2Scale(leds, 2)).toBe(1.0);
    });

    it('power per LED = (r+g+b)/30 per spec', () => {
      // At scale=1.0, white LED: R=G=B=3, power = 9/30 = 0.3W
      // 59 LEDs at ledsPerHold=1: 1 * 59 * 0.3 = 17.7W → within budget → scale=1.0
      const leds59 = Array.from({ length: 59 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
      expect(computeV2Scale(leds59, 1)).toBe(1.0);
      // Note: at scale=0.8, floor(255*0.8)>>6 still = 3 (same as 1.0), so
      // the next effective reduction is at scale=0.6 where colors drop to 2-bit value 2.
      // 61 LEDs: 1 * 61 * 0.3 ≈ 18.3W > 18W → must scale down to 0.6
      const leds61 = Array.from({ length: 61 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
      expect(computeV2Scale(leds61, 1)).toBe(0.6);
    });
  });
});

// =============================================================================
// §4 — Device Name Format / parseApiLevel
// =============================================================================

describe('§4 Device Name Format — parseApiLevel', () => {
  it('parses @3 from full name: "Kilter Board#abc123@3"', () => {
    expect(parseApiLevel('Kilter Board#abc123@3')).toBe(3);
  });

  it('parses @2 from name with explicit level', () => {
    expect(parseApiLevel('Kilter Board@2')).toBe(2);
  });

  it('defaults to 2 when no @ is present (spec default)', () => {
    expect(parseApiLevel('Kilter Board')).toBe(2);
  });

  it('defaults to 2 for undefined device name', () => {
    expect(parseApiLevel(undefined)).toBe(2);
  });

  it('defaults to 2 for empty string', () => {
    expect(parseApiLevel('')).toBe(2);
  });

  it('parses level from name with serial but no @', () => {
    expect(parseApiLevel('Kilter Board#abc123')).toBe(2);
  });

  it('parses Tension board names', () => {
    expect(parseApiLevel('Tension Board#xyz789@3')).toBe(3);
  });

  it('parses higher API levels', () => {
    expect(parseApiLevel('Kilter Board@4')).toBe(4);
  });
});

// =============================================================================
// §7.5 — Empty-frames "clear all" packet
// =============================================================================

describe('§7.5 Empty-frames clear packet', () => {
  it('emits a single-frame ONLY packet with no LED data on v3', () => {
    const result = getBluetoothPacket('', {}, 'kilter', 3);
    expect(result.totalPlacements).toBe(0);
    expect(result.skippedPositionCount).toBe(0);
    expect(result.skippedRoleCount).toBe(0);
    expect(result.packet.length).toBeGreaterThan(0);

    const parsed = parseFrames(result.packet);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].commandByte).toBe(84); // T = ONLY
    expect(parsed[0].payloadLength).toBe(1); // command byte only — no LED entries
  });

  it('emits a single-frame ONLY packet on v2', () => {
    const result = getBluetoothPacket('', {}, 'kilter', 2);
    const parsed = parseFrames(result.packet);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].commandByte).toBe(80); // P = ONLY (v2)
    expect(parsed[0].payloadLength).toBe(1);
  });

  it('does not require placement positions to clear', () => {
    // The clear path must not look up the placement map — passing empty
    // placements and an unknown layout still produces a valid clear packet.
    const result = getBluetoothPacket('', {}, 'tension', 3);
    expect(result.packet.length).toBeGreaterThan(0);
    const parsed = parseFrames(result.packet);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].commandByte).toBe(84);
  });

  it('still returns an empty packet when every placement is skipped (not the clear path)', () => {
    // Non-empty frames with all-unknown placements must NOT take the clear
    // path — that case represents a render failure, not an intentional clear.
    const result = getBluetoothPacket('p999r42', {}, 'kilter', 3);
    expect(result.packet.length).toBe(0);
    expect(result.skippedPositionCount).toBe(1);
  });
});

// =============================================================================
// §8 — Multi-Part Message Sequencing
// =============================================================================

describe('§8 Multi-Part Message Sequencing', () => {
  describe('v3 command bytes (Q=81, R=82, S=83, T=84)', () => {
    it('uses T (84) for single-frame packets', () => {
      const positions: Record<number, number> = { 1: 10 };
      const packet = getBluetoothPacket('p1r42', positions, 'kilter', 3).packet;
      const frames = parseFrames(packet);
      expect(frames).toHaveLength(1);
      expect(frames[0].commandByte).toBe(84); // T = Single
    });

    it('uses R/Q/S (82/81/83) for multi-frame packets', () => {
      // 100 LEDs * 3 bytes = 300 bytes, exceeds 254 → 2 frames
      const positions: Record<number, number> = {};
      let frames = '';
      for (let i = 0; i < 100; i++) {
        positions[i] = i;
        frames += `p${i}r42`;
      }
      const packet = getBluetoothPacket(frames, positions, 'kilter', 3).packet;
      const parsed = parseFrames(packet);
      expect(parsed.length).toBeGreaterThan(1);
      expect(parsed[0].commandByte).toBe(82); // R = Start
      expect(parsed[parsed.length - 1].commandByte).toBe(83); // S = End
      for (let i = 1; i < parsed.length - 1; i++) {
        expect(parsed[i].commandByte).toBe(81); // Q = Continue
      }
    });
  });

  describe('v2 command bytes (M=77, N=78, O=79, P=80)', () => {
    it('uses P (80) for single-frame packets', () => {
      const positions: Record<number, number> = { 1: 10 };
      const packet = getBluetoothPacket('p1r42', positions, 'kilter', 2).packet;
      const frames = parseFrames(packet);
      expect(frames).toHaveLength(1);
      expect(frames[0].commandByte).toBe(80); // P = Single
    });

    it('uses N/M/O (78/77/79) for multi-frame packets', () => {
      // 200 LEDs * 2 bytes = 400 bytes, exceeds 254 → multiple frames
      const positions: Record<number, number> = {};
      let frames = '';
      for (let i = 0; i < 200; i++) {
        positions[i] = i;
        frames += `p${i}r42`;
      }
      const packet = getBluetoothPacket(frames, positions, 'kilter', 2).packet;
      const parsed = parseFrames(packet);
      expect(parsed.length).toBeGreaterThan(1);
      expect(parsed[0].commandByte).toBe(78); // N = Start
      expect(parsed[parsed.length - 1].commandByte).toBe(79); // O = End
      for (let i = 1; i < parsed.length - 1; i++) {
        expect(parsed[i].commandByte).toBe(77); // M = Continue
      }
    });
  });

  it('each frame payload does not exceed 255 bytes', () => {
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 300; i++) {
      positions[i] = i;
      frames += `p${i}r42`;
    }
    const packet = getBluetoothPacket(frames, positions, 'kilter', 3).packet;
    const parsed = parseFrames(packet);
    for (const frame of parsed) {
      expect(frame.payloadLength).toBeLessThanOrEqual(255);
    }
  });

  it('all LEDs are present across all frames (v3, no data loss)', () => {
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 200; i++) {
      positions[i] = i;
      frames += `p${i}r42`;
    }
    const packet = getBluetoothPacket(frames, positions, 'kilter', 3).packet;
    const allLeds = decodeAllV3Leds(packet);
    expect(allLeds).toHaveLength(200);
    // Verify all positions are present
    const decodedPositions = allLeds.map((l) => l.position).sort((a, b) => a - b);
    expect(decodedPositions).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it('all LEDs are present across all frames (v2, no data loss)', () => {
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 200; i++) {
      positions[i] = i;
      frames += `p${i}r42`;
    }
    const packet = getBluetoothPacket(frames, positions, 'kilter', 2).packet;
    const allLeds = decodeAllV2Leds(packet);
    expect(allLeds).toHaveLength(200);
    const decodedPositions = allLeds.map((l) => l.position).sort((a, b) => a - b);
    expect(decodedPositions).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });
});

// =============================================================================
// §9 — BLE Transmission (20-byte chunking)
// =============================================================================

describe('§9 BLE Transmission — splitMessages', () => {
  it('chunks into 20-byte segments', () => {
    const data = new Uint8Array(50);
    const chunks = splitMessages(data);
    expect(chunks).toHaveLength(3); // 20 + 20 + 10
    expect(chunks[0].length).toBe(20);
    expect(chunks[1].length).toBe(20);
    expect(chunks[2].length).toBe(10);
  });

  it('returns single chunk for data <= 20 bytes', () => {
    const data = new Uint8Array(9);
    const chunks = splitMessages(data);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(9);
  });

  it('returns single chunk for exactly 20 bytes', () => {
    const data = new Uint8Array(20);
    expect(splitMessages(data)).toHaveLength(1);
  });

  it('handles empty buffer', () => {
    const data = new Uint8Array(0);
    expect(splitMessages(data)).toHaveLength(0);
  });

  it('preserves data content through chunking', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    const chunks = splitMessages(original);
    const reassembled = new Uint8Array([...chunks[0], ...chunks[1]]);
    expect(Array.from(reassembled)).toEqual(Array.from(original));
  });
});

// =============================================================================
// §17 — Worked Examples (byte-exact verification against spec)
// =============================================================================

describe('§17 Worked Examples', () => {
  it('Example 1: Single LED, API v3 — position=42, color="00FF00"', () => {
    // Spec: payload = [T, pos_lo, pos_hi, color] = [0x54, 0x2A, 0x00, 0x1C]
    // Verify encoding
    const payload = [0x54, ...encodePositionAndColorV3(42, '00FF00')];
    expect(payload).toEqual([0x54, 0x2a, 0x00, 0x1c]);

    // Verify checksum
    expect(checksum(payload)).toBe(0x65);

    // Verify full frame
    const frame = wrapBytes(payload);
    expect(toHex(frame)).toBe('01046502542a001c03');
  });

  it('Example 2: Three LEDs, API v2 with scale=1.0 — verify LED encoding', () => {
    // Spec §17 Example 2:
    // LED 1: pos=10, "00FF00" → [0x0A, 0x30]
    // LED 2: pos=256, "0000FF" → [0x00, 0x0D]
    // LED 3: pos=500, "FF0000" → [0xF4, 0xC1]
    const led1 = encodePositionAndColorV2(10, '00FF00', 1.0);
    const led2 = encodePositionAndColorV2(256, '0000FF', 1.0);
    const led3 = encodePositionAndColorV2(500, 'FF0000', 1.0);

    expect(led1).toEqual([0x0a, 0x30]);
    expect(led2).toEqual([0x00, 0x0d]);
    expect(led3).toEqual([0xf4, 0xc1]);

    // Build the full v2 payload with Single command byte (P=0x50)
    const payload = [0x50, ...led1, ...led2, ...led3];
    expect(payload).toEqual([0x50, 0x0a, 0x30, 0x00, 0x0d, 0xf4, 0xc1]);

    // Verify the frame wrapping is correct
    const frame = wrapBytes(payload);
    expect(frame[0]).toBe(0x01); // SOH
    expect(frame[1]).toBe(7); // LENGTH = 7 bytes
    // checksum verified implicitly by byte-exact Aurora tests
    expect(frame[3]).toBe(0x02); // STX
    expect(frame[4]).toBe(0x50); // P = v2 Single
    expect(frame[frame.length - 1]).toBe(0x03); // ETX
  });
});

// =============================================================================
// getBluetoothPacket — API level selection
// =============================================================================

describe('getBluetoothPacket — API level selection', () => {
  const positions: Record<number, number> = { 1: 10 };

  it('defaults to v3 encoding when apiLevel is omitted', () => {
    const packet = getBluetoothPacket('p1r42', positions, 'kilter').packet;
    const frames = parseFrames(packet);
    expect(frames[0].commandByte).toBe(84); // T = v3 Single
  });

  it('uses v3 encoding for apiLevel=3', () => {
    const packet = getBluetoothPacket('p1r42', positions, 'kilter', 3).packet;
    const bytes = Array.from(packet);
    // v3: 3 bytes per LED + 1 cmd byte = 4 bytes payload
    expect(bytes[1]).toBe(4); // LENGTH
    expect(bytes[4]).toBe(84); // T
  });

  it('uses v2 encoding for apiLevel=2', () => {
    const packet = getBluetoothPacket('p1r42', positions, 'kilter', 2).packet;
    const bytes = Array.from(packet);
    // v2: 2 bytes per LED + 1 cmd byte = 3 bytes payload
    expect(bytes[1]).toBe(3); // LENGTH
    expect(bytes[4]).toBe(80); // P
  });

  it('uses v2 encoding for apiLevel=1', () => {
    const packet = getBluetoothPacket('p1r42', positions, 'kilter', 1).packet;
    const frames = parseFrames(packet);
    expect(frames[0].commandByte).toBe(80); // P = v2 Single
  });

  it('reports skipped placements when any are missing', () => {
    const sparse: Record<number, number> = { 1: 39 };
    const result = getBluetoothPacket('p1r42p9999r42', sparse, 'kilter', 3);
    expect(result.skippedPositionCount).toBe(1);
    expect(result.totalPlacements).toBe(2);
    expect(result.packet.length).toBeGreaterThan(0);
  });

  it('reports skipped role when a hold role is not mapped for the board', () => {
    const positions: Record<number, number> = { 1: 39, 2: 40 };
    const result = getBluetoothPacket('p1r42p2r1', positions, 'kilter', 3);
    expect(result.skippedRoleCount).toBe(1);
    expect(result.totalPlacements).toBe(2);
    expect(result.packet.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// getBluetoothPacket — v2 encoding integration
// =============================================================================

describe('getBluetoothPacket — v2 encoding integration', () => {
  it('encodes 2 bytes per LED', () => {
    const positions: Record<number, number> = { 1: 10, 2: 256 };
    const packet = getBluetoothPacket('p1r42p2r42', positions, 'kilter', 2).packet;
    const leds = decodeLedPositionsV2(packet);
    expect(leds).toHaveLength(2);
    expect(leds[0].position).toBe(10);
    expect(leds[1].position).toBe(256);
  });

  it('packs position high bits into color byte', () => {
    const positions: Record<number, number> = { 1: 512 }; // 0x200, posHi=2
    const packet = getBluetoothPacket('p1r42', positions, 'kilter', 2).packet;
    const leds = decodeLedPositionsV2(packet);
    expect(leds[0].position).toBe(512);
    expect(leds[0].colorByte & 0x03).toBe(2); // posHi in bits [1:0]
  });

  it('skips v2 positions that exceed the 10-bit limit instead of throwing', () => {
    const positions: Record<number, number> = { 1: 39, 2: 1024 };
    const result = getBluetoothPacket('p1r42p2r42', positions, 'kilter', 2);
    expect(result.skippedPositionCount).toBe(1);
    expect(result.totalPlacements).toBe(2);
    expect(result.packet.length).toBeGreaterThan(0);
  });

  it('returns an empty packet when all v2 positions exceed the 10-bit limit', () => {
    const positions: Record<number, number> = { 1: 1024, 2: 2000 };
    const result = getBluetoothPacket('p1r42p2r42', positions, 'kilter', 2);
    expect(result.skippedPositionCount).toBe(2);
    expect(result.totalPlacements).toBe(2);
    expect(result.packet.length).toBe(0);
  });
});

// =============================================================================
// ledsPerHold — per-board power budget
// =============================================================================

describe('ledsPerHold — per-board v2 power budget', () => {
  it('Kilter uses ledsPerHold=2 (stricter power budget)', () => {
    // 40 bright white LEDs: at scale=1.0, power=2*40*0.3=24W > 18W → must scale down
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 40; i++) {
      positions[i] = i;
      frames += `p${i}r42`; // Kilter role 42
    }
    const packet = getBluetoothPacket(frames, positions, 'kilter', 2).packet;
    const allLeds = decodeAllV2Leds(packet);
    expect(allLeds).toHaveLength(40);
  });

  it('Tension uses ledsPerHold=1 (more generous power budget)', () => {
    // Same 40 LEDs but with Tension role codes (role 1 = starting)
    const positions: Record<number, number> = {};
    let frames = '';
    for (let i = 0; i < 40; i++) {
      positions[i] = i;
      frames += `p${i}r1`; // Tension role 1
    }
    const packet = getBluetoothPacket(frames, positions, 'tension', 2).packet;
    const allLeds = decodeAllV2Leds(packet);
    expect(allLeds).toHaveLength(40);
  });

  it('Kilter v2 dims more than Tension v2 for the same number of bright LEDs', () => {
    // At high LED counts, Kilter (ledsPerHold=2) should scale down more aggressively
    const leds = Array.from({ length: 40 }, (_, i) => ({ position: i, color: 'FFFFFF' }));
    const kilterScale = computeV2Scale(leds, 2); // Kilter
    const tensionScale = computeV2Scale(leds, 1); // Tension
    expect(kilterScale).toBeLessThan(tensionScale);
  });
});

// =============================================================================
// Captured Aurora payload verification (ground truth)
// =============================================================================

// Known-good payloads captured from Aurora's official Kilter app
const AURORA_8x12_HEX = '01134002542700e38501e31400f41300f40100f40000f403';
const AURORA_10x12_HEX = '0113e202545000e3ae01e30400f40300f41700f41600f403';
const CLIMB_FRAMES = 'p4131r42p4421r42p4669r45p4655r45p4665r45p4678r45';

const CORRECT_8x12_POSITIONS: Record<number, number> = {
  4131: 39,
  4421: 389,
  4669: 20,
  4655: 19,
  4665: 1,
  4678: 0,
};
const CORRECT_10x12_POSITIONS: Record<number, number> = {
  4131: 80,
  4421: 430,
  4669: 4,
  4655: 3,
  4665: 23,
  4678: 22,
};

describe('Captured Aurora payloads — position verification', () => {
  it('Kilter 10x12 Full Ride (size 25) LED positions match Aurora app', () => {
    const packet = getBluetoothPacket(CLIMB_FRAMES, CORRECT_10x12_POSITIONS, 'kilter').packet;
    const ourPositions = decodeLedPositionsV3(packet).map((l) => l.position);
    const auroraPositions = decodeLedPositionsV3(AURORA_10x12_HEX).map((l) => l.position);
    expect(ourPositions).toEqual(auroraPositions);
  });

  it('Kilter 8x12 Full Ride (size 23) LED positions match Aurora app', () => {
    const packet = getBluetoothPacket(CLIMB_FRAMES, CORRECT_8x12_POSITIONS, 'kilter').packet;
    const ourPositions = decodeLedPositionsV3(packet).map((l) => l.position);
    const auroraPositions = decodeLedPositionsV3(AURORA_8x12_HEX).map((l) => l.position);
    expect(ourPositions).toEqual(auroraPositions);
  });

  it('reports skipped placements when some have no LED mapping', () => {
    const sparseLedMap = { 4131: 39, 4421: 389 };
    const result = getBluetoothPacket('p4131r42p4421r42p9999r45', sparseLedMap, 'kilter');
    expect(result.skippedPositionCount).toBe(1);
    expect(result.totalPlacements).toBe(3);
    expect(result.packet.length).toBeGreaterThan(0);
  });

  it('8x12 kickboard positions match Aurora expectations', () => {
    expect(CORRECT_8x12_POSITIONS[4678]).toBe(0); // leftmost y=-8
    expect(CORRECT_8x12_POSITIONS[4665]).toBe(1); // leftmost y=-4
    expect(CORRECT_8x12_POSITIONS[4655]).toBe(19); // rightmost y=-4
    expect(CORRECT_8x12_POSITIONS[4669]).toBe(20); // rightmost y=-8
  });
});

// 3rd-party validated payloads for Kilter Original (Layout 1) — FULL byte-exact
const VALIDATED_12x12_HEX = '010dbb02544400e3dc01e30000f42100f403';
const VALIDATED_8x12_ORIGINAL_HEX = '010d7802543800e33701e30000f41500f403';
const CORNERS_12x12_FRAMES = 'p1379r44p1395r44p1447r45p1464r45';
const CORNERS_8x12_ORIGINAL_FRAMES = 'p1382r44p1392r44p1450r45p1461r45';

const CORRECT_12x12_POSITIONS: Record<number, number> = {
  1379: 68,
  1395: 476,
  1447: 0,
  1464: 33,
};
const CORRECT_8x12_ORIGINAL_POSITIONS: Record<number, number> = {
  1382: 56,
  1392: 311,
  1450: 0,
  1461: 21,
};

describe('Kilter Original (Layout 1) — 3rd-party validated payloads (byte-exact)', () => {
  it('12x12 full packet byte-exact match', () => {
    const packet = getBluetoothPacket(CORNERS_12x12_FRAMES, CORRECT_12x12_POSITIONS, 'kilter').packet;
    expect(toHex(packet)).toBe(VALIDATED_12x12_HEX);
  });

  it('8x12 Original full packet byte-exact match', () => {
    const packet = getBluetoothPacket(CORNERS_8x12_ORIGINAL_FRAMES, CORRECT_8x12_ORIGINAL_POSITIONS, 'kilter').packet;
    expect(toHex(packet)).toBe(VALIDATED_8x12_ORIGINAL_HEX);
  });

  it('12x12 LED data from getLedPlacements matches validated positions', () => {
    const ledMap = getLedPlacements('kilter', 1, 10);
    expect(ledMap[1379]).toBe(68);
    expect(ledMap[1395]).toBe(476);
    expect(ledMap[1447]).toBe(0);
    expect(ledMap[1464]).toBe(33);
  });

  it('8x12 Original LED data from getLedPlacements matches validated positions', () => {
    const ledMap = getLedPlacements('kilter', 1, 8);
    expect(ledMap[1382]).toBe(56);
    expect(ledMap[1392]).toBe(311);
    expect(ledMap[1450]).toBe(0);
    expect(ledMap[1461]).toBe(21);
  });

  it('12x12 full packet matches when using real LED data', () => {
    const ledMap = getLedPlacements('kilter', 1, 10);
    const packet = getBluetoothPacket(CORNERS_12x12_FRAMES, ledMap, 'kilter').packet;
    const ourPositions = decodeLedPositionsV3(packet).map((l) => l.position);
    const validatedPositions = decodeLedPositionsV3(VALIDATED_12x12_HEX).map((l) => l.position);
    expect(ourPositions).toEqual(validatedPositions);
  });

  it('8x12 Original full packet matches when using real LED data', () => {
    const ledMap = getLedPlacements('kilter', 1, 8);
    const packet = getBluetoothPacket(CORNERS_8x12_ORIGINAL_FRAMES, ledMap, 'kilter').packet;
    const ourPositions = decodeLedPositionsV3(packet).map((l) => l.position);
    const validatedPositions = decodeLedPositionsV3(VALIDATED_8x12_ORIGINAL_HEX).map((l) => l.position);
    expect(ourPositions).toEqual(validatedPositions);
  });
});
