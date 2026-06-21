import { describe, it, expect } from 'vitest';
import {
  checksum,
  wrapBytes,
  encodePositionV3,
  encodeColorV3,
  parseApiLevel,
  parseSerialNumber,
  parseBoardTypeFromDeviceName,
  getAuroraBluetoothPacket,
} from '../aurora';
import { MESSAGE_BODY_MAX_LENGTH } from '../transport';

describe('checksum', () => {
  it('returns 0xFF XOR complement for an empty array', () => {
    // sum = 0, 0 & 255 = 0, 0 ^ 255 = 255
    expect(checksum([])).toBe(255);
  });

  it('computes correct checksum for known data', () => {
    // sum = 1+2+3 = 6, 6 & 255 = 6, 6 ^ 255 = 249
    expect(checksum([1, 2, 3])).toBe(249);
  });

  it('handles overflow by masking to 8 bits before XOR', () => {
    // sum = 200+100 = 300, 300 & 255 = 44, 44 ^ 255 = 211
    expect(checksum([200, 100])).toBe(211);
  });
});

describe('wrapBytes', () => {
  it('wraps data in [1, length, checksum, 2, ...data, 3] format', () => {
    const data = [84]; // ONLY command byte
    const result = wrapBytes(data);
    expect(result[0]).toBe(1); // start marker
    expect(result[1]).toBe(data.length); // length
    expect(result[2]).toBe(checksum(data)); // checksum
    expect(result[3]).toBe(2); // data start marker
    expect(result.slice(4, 4 + data.length)).toEqual(data);
    expect(result[result.length - 1]).toBe(3); // end marker
  });

  it('returns empty array when data exceeds MESSAGE_BODY_MAX_LENGTH', () => {
    const oversizedData = Array.from({ length: MESSAGE_BODY_MAX_LENGTH + 1 }, (_, index) => index & 0xff);
    expect(wrapBytes(oversizedData)).toEqual([]);
  });

  it('accepts data at exactly MESSAGE_BODY_MAX_LENGTH', () => {
    const maxData = Array.from({ length: MESSAGE_BODY_MAX_LENGTH }, (_, index) => index & 0xff);
    const result = wrapBytes(maxData);
    expect(result.length).toBe(MESSAGE_BODY_MAX_LENGTH + 5); // start(1) + length(1) + checksum(1) + data_start(1) + data + end(1)
    expect(result[0]).toBe(1);
    expect(result[result.length - 1]).toBe(3);
  });
});

describe('encodePositionV3', () => {
  it('encodes position as little-endian 2 bytes', () => {
    // position 300 = 0x012C -> low byte 0x2C (44), high byte 0x01 (1)
    expect(encodePositionV3(300)).toEqual([44, 1]);
  });

  it('encodes position 0 as [0, 0]', () => {
    expect(encodePositionV3(0)).toEqual([0, 0]);
  });

  it('encodes position 255 as [255, 0]', () => {
    expect(encodePositionV3(255)).toEqual([255, 0]);
  });

  it('encodes position 256 as [0, 1]', () => {
    expect(encodePositionV3(256)).toEqual([0, 1]);
  });
});

describe('encodeColorV3', () => {
  it('quantizes full white (FFFFFF) to packed byte', () => {
    // R: floor(255/32) = 7, shifted left 5 = 224
    // G: floor(255/32) = 7, shifted left 2 = 28
    // B: floor(255/64) = 3
    // 224 | 28 | 3 = 255
    expect(encodeColorV3('FFFFFF')).toBe(255);
  });

  it('quantizes full black (000000) to 0', () => {
    expect(encodeColorV3('000000')).toBe(0);
  });

  it('quantizes pure red (FF0000)', () => {
    // R: floor(255/32) = 7, shifted left 5 = 224
    // G: 0, B: 0
    expect(encodeColorV3('FF0000')).toBe(224);
  });

  it('quantizes pure green (00FF00)', () => {
    // G: floor(255/32) = 7, shifted left 2 = 28
    expect(encodeColorV3('00FF00')).toBe(28);
  });

  it('quantizes pure blue (0000FF)', () => {
    // B: floor(255/64) = 3
    expect(encodeColorV3('0000FF')).toBe(3);
  });
});

describe('parseApiLevel', () => {
  it('extracts API level from standard device name', () => {
    expect(parseApiLevel('Kilter Board#751737@3')).toBe(3);
  });

  it('returns 2 as default when no @ segment', () => {
    expect(parseApiLevel('Kilter Board#751737')).toBe(2);
  });

  it('returns 2 for undefined input', () => {
    expect(parseApiLevel(undefined)).toBe(2);
  });

  it('returns 2 for empty string', () => {
    expect(parseApiLevel('')).toBe(2);
  });

  it('parses multi-digit API levels', () => {
    expect(parseApiLevel('Board#123@12')).toBe(12);
  });
});

describe('parseSerialNumber', () => {
  it('extracts serial number from standard device name', () => {
    expect(parseSerialNumber('Kilter Board#751737@3')).toBe('751737');
  });

  it('extracts serial when no API level suffix', () => {
    expect(parseSerialNumber('Board#ABC123')).toBe('ABC123');
  });

  it('returns undefined for undefined input', () => {
    expect(parseSerialNumber(undefined)).toBeUndefined();
  });

  it('returns undefined when no # segment', () => {
    expect(parseSerialNumber('Kilter Board')).toBeUndefined();
  });
});

describe('parseBoardTypeFromDeviceName', () => {
  it('parses "Kilter Board#123@3" as kilter', () => {
    expect(parseBoardTypeFromDeviceName('Kilter Board#123@3')).toBe('kilter');
  });

  it('parses "Tension Board#456@2" as tension', () => {
    expect(parseBoardTypeFromDeviceName('Tension Board#456@2')).toBe('tension');
  });

  it('parses "So iLL Board#42@3" as soill (strips spaces)', () => {
    expect(parseBoardTypeFromDeviceName('So iLL Board#42@3')).toBe('soill');
  });

  it('parses "So-iLL Board#42@3" as soill (strips hyphens)', () => {
    expect(parseBoardTypeFromDeviceName('So-iLL Board#42@3')).toBe('soill');
  });

  it('returns undefined for undefined input', () => {
    expect(parseBoardTypeFromDeviceName(undefined)).toBeUndefined();
  });

  it('returns undefined for unrecognized board name', () => {
    expect(parseBoardTypeFromDeviceName('Unknown Board#1@3')).toBeUndefined();
  });

  it('parses decoy from device name', () => {
    expect(parseBoardTypeFromDeviceName('Decoy Board#789@3')).toBe('decoy');
  });

  it('parses touchstone from device name', () => {
    expect(parseBoardTypeFromDeviceName('Touchstone Board#101@3')).toBe('touchstone');
  });

  it('parses grasshopper from device name', () => {
    expect(parseBoardTypeFromDeviceName('Grasshopper Board#202@3')).toBe('grasshopper');
  });
});

describe('getAuroraBluetoothPacket', () => {
  it('returns a valid clear packet for empty frames', () => {
    const result = getAuroraBluetoothPacket('', {}, 'kilter', 3);
    expect(result.packet.length).toBeGreaterThan(0);
    expect(result.skippedPositionCount).toBe(0);
    expect(result.skippedRoleCount).toBe(0);
    expect(result.totalPlacements).toBe(0);
    // The packet should be a wrapped ONLY command (84 = 'T' for v3)
    // wrapBytes([84]) = [1, 1, checksum([84]), 2, 84, 3]
    const expectedPacket = Uint8Array.from(wrapBytes([84]));
    expect(result.packet).toEqual(expectedPacket);
  });

  it('returns v2 clear packet for empty frames with apiLevel 2', () => {
    const result = getAuroraBluetoothPacket('', {}, 'kilter', 2);
    expect(result.packet.length).toBeGreaterThan(0);
    // V2 ONLY command is 80 ('P')
    const expectedPacket = Uint8Array.from(wrapBytes([80]));
    expect(result.packet).toEqual(expectedPacket);
  });

  it('builds a correct packet for valid v3 frames with placements', () => {
    // Use kilter role code 12 (STARTING, color #00FF00)
    const frames = 'p100r12p200r13';
    const placements = { 100: 5, 200: 10 };
    const result = getAuroraBluetoothPacket(frames, placements, 'kilter', 3);

    expect(result.skippedPositionCount).toBe(0);
    expect(result.skippedRoleCount).toBe(0);
    expect(result.totalPlacements).toBe(2);
    expect(result.packet.length).toBeGreaterThan(0);
  });

  it('skips placements not found in placement positions', () => {
    // placement 999 does not exist in the map
    const frames = 'p999r12';
    const placements = { 100: 5 };
    const result = getAuroraBluetoothPacket(frames, placements, 'kilter', 3);
    expect(result.skippedPositionCount).toBe(1);
    expect(result.totalPlacements).toBe(1);
  });

  it('skips placements with unrecognized role codes', () => {
    const frames = 'p100r999';
    const placements = { 100: 5 };
    const result = getAuroraBluetoothPacket(frames, placements, 'kilter', 3);
    expect(result.skippedRoleCount).toBe(1);
  });

  it('honours a 6-digit hex color override', () => {
    // Kilter role 12 = STARTING; override its colour with pure red.
    const result = getAuroraBluetoothPacket('p100r12', { 100: 5 }, 'kilter', 3, { STARTING: '#FF0000' });
    // Body: [ONLY, posLow, posHigh, color]; encodeColorV3('FF0000') = 224.
    expect(result.packet).toEqual(Uint8Array.from(wrapBytes([84, 5, 0, 224])));
  });

  it('falls back to the canonical color for a malformed override', () => {
    const placements = { 100: 5 };
    const canonical = getAuroraBluetoothPacket('p100r12', placements, 'kilter', 3);
    // Shorthand hex would parseInt('' , 16) = NaN in the encoder and stream a
    // garbage byte to the wall — the override must be ignored, not honoured.
    const shorthand = getAuroraBluetoothPacket('p100r12', placements, 'kilter', 3, { STARTING: '#fff' });
    const named = getAuroraBluetoothPacket('p100r12', placements, 'kilter', 3, { STARTING: 'red' });
    expect(shorthand.packet).toEqual(canonical.packet);
    expect(named.packet).toEqual(canonical.packet);
  });
});
