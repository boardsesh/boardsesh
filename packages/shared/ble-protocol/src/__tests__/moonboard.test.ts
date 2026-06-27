import { describe, it, expect } from 'vitest';
import { getMoonboardSerialPosition, isMoonboardDeviceName, getMoonboardBluetoothPacket } from '../moonboard';
import { splitMessages, MAX_BLUETOOTH_MESSAGE_SIZE } from '../transport';

describe('getMoonboardSerialPosition', () => {
  it('returns correct position for hold 1 (first column, first row)', () => {
    // holdId=1, zeroBasedHoldId=0, col=0 (even), row=0
    // position = col * 18 + row = 0
    expect(getMoonboardSerialPosition(1)).toBe(0);
  });

  it('returns correct position for hold 12 (second column, first row)', () => {
    // holdId=12, zeroBasedHoldId=11, col=11%11=0, row=floor(11/11)=1
    // Wait: col = 11 % 11 = 0, row = floor(11/11) = 1
    // position = 0*18 + 1 = 1
    expect(getMoonboardSerialPosition(12)).toBe(1);
  });

  it('returns correct position for hold 2 (second column in first row)', () => {
    // holdId=2, zeroBasedHoldId=1, col=1 (odd), row=0
    // position = 1*18 + (18-1-0) = 18+17 = 35
    expect(getMoonboardSerialPosition(2)).toBe(35);
  });

  it('returns correct position for max hold 198', () => {
    // holdId=198, zeroBasedHoldId=197, col=197%11=10 (even), row=floor(197/11)=17
    // position = 10*18 + 17 = 197
    expect(getMoonboardSerialPosition(198)).toBe(197);
  });

  it('throws for hold id 0 (out of range)', () => {
    expect(() => getMoonboardSerialPosition(0)).toThrow('MoonBoard hold id out of range');
  });

  it('throws for hold id exceeding grid size', () => {
    // max is 11*18 = 198
    expect(() => getMoonboardSerialPosition(199)).toThrow('MoonBoard hold id out of range');
  });

  it('throws for non-integer hold id', () => {
    expect(() => getMoonboardSerialPosition(1.5)).toThrow('MoonBoard hold id out of range');
  });
});

describe('isMoonboardDeviceName', () => {
  it('returns true for "MoonBoard A"', () => {
    expect(isMoonboardDeviceName('MoonBoard A')).toBe(true);
  });

  it('returns true for "Moonboard A" (lowercase b)', () => {
    expect(isMoonboardDeviceName('Moonboard A')).toBe(true);
  });

  it('returns false for "Kilter Board#123@3"', () => {
    expect(isMoonboardDeviceName('Kilter Board#123@3')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isMoonboardDeviceName(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isMoonboardDeviceName('')).toBe(false);
  });
});

describe('getMoonboardBluetoothPacket', () => {
  it('produces correct output format for a single hold', () => {
    // Role 42 = 'S' (start), placement 1 -> serial position 0
    const result = getMoonboardBluetoothPacket('p1r42');
    const decoded = new TextDecoder().decode(result.packet);
    expect(decoded).toBe('l#S0#');
  });

  it('produces correct output for multiple holds', () => {
    // Role 42='S', 43='P', 44='E'
    // placement 1 -> position 0, placement 2 -> position 35
    const result = getMoonboardBluetoothPacket('p1r42p2r43');
    const decoded = new TextDecoder().decode(result.packet);
    expect(decoded).toBe('l#S0,P35#');
  });

  it('includes end hold type', () => {
    // Role 44='E', placement 198 -> position 197
    const result = getMoonboardBluetoothPacket('p198r44');
    const decoded = new TextDecoder().decode(result.packet);
    expect(decoded).toBe('l#E197#');
  });

  it('skips unsupported role codes gracefully', () => {
    const result = getMoonboardBluetoothPacket('p1r99');
    const decoded = new TextDecoder().decode(result.packet);
    expect(decoded).toBe('l##');
    expect(result.skippedRoleCount).toBe(1);
  });

  it('encodes valid holds and skips invalid role codes', () => {
    // role 42='S' is valid, role 99 is invalid
    const result = getMoonboardBluetoothPacket('p1r42p2r99');
    const decoded = new TextDecoder().decode(result.packet);
    expect(decoded).toBe('l#S0#');
    expect(result.skippedRoleCount).toBe(1);
    expect(result.totalPlacements).toBe(2);
  });

  it('maps all three wire markers (S/P/E)', () => {
    // 42='S' start, 43='P' problem/intermediate, 44='E' end.
    const result = getMoonboardBluetoothPacket('p1r42p2r43p198r44');
    expect(new TextDecoder().decode(result.packet)).toBe('l#S0,P35,E197#');
  });
});

// =============================================================================
// §5.3 — Serpentine LED numbering (full wiring verification)
// =============================================================================

describe('getMoonboardSerialPosition — serpentine wiring (spec §5.3)', () => {
  // Spec worked checks: holdId 1 → 0, 2 → 35, 12 → 1, 198 → 197.
  it.each([
    [1, 0],
    [2, 35],
    [11, 180], // col 10 (even, last column), row 0
    [12, 1], // col 0, row 1
    [13, 34], // col 1 (odd), row 1 → 18 + (17-1)
    [23, 2], // col 0, row 2
    [198, 197], // col 10 (even), row 17
  ])('holdId %i → position %i', (holdId, position) => {
    expect(getMoonboardSerialPosition(holdId)).toBe(position);
  });

  it('wires even column A bottom-to-top (ascending 0..17)', () => {
    // Column A holds are holdId 1, 12, 23, … (every 11th). Even column → row order.
    const columnA = Array.from({ length: 18 }, (_, row) => getMoonboardSerialPosition(1 + row * 11));
    expect(columnA).toEqual(Array.from({ length: 18 }, (_, row) => row));
  });

  it('wires odd column B top-to-bottom (descending 35..18)', () => {
    // Column B holds are holdId 2, 13, 24, …; odd column → reversed row order.
    const columnB = Array.from({ length: 18 }, (_, row) => getMoonboardSerialPosition(2 + row * 11));
    expect(columnB).toEqual(Array.from({ length: 18 }, (_, row) => 18 + (17 - row)));
  });

  it('covers the whole 0..197 range with no gaps or collisions', () => {
    const positions = Array.from({ length: 198 }, (_, i) => getMoonboardSerialPosition(i + 1)).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 198 }, (_, i) => i));
  });
});

// =============================================================================
// §5.4 — BLE chunking (transport detail, does not change the ASCII message)
// =============================================================================

describe('MoonBoard frame chunking', () => {
  it('splits a long l#…# frame into 20-byte writes that reassemble to the frame', () => {
    // Every column-A hold lit as a start hold → a frame well over 20 bytes.
    const frames = Array.from({ length: 18 }, (_, row) => `p${1 + row * 11}r42`).join('');
    const { packet } = getMoonboardBluetoothPacket(frames);
    expect(packet.length).toBeGreaterThan(MAX_BLUETOOTH_MESSAGE_SIZE);

    const chunks = splitMessages(packet);
    expect(chunks.length).toBe(Math.ceil(packet.length / MAX_BLUETOOTH_MESSAGE_SIZE));
    const reassembled = new Uint8Array(packet.length);
    let offset = 0;
    for (const chunk of chunks) {
      reassembled.set(chunk, offset);
      offset += chunk.length;
    }
    expect(new TextDecoder().decode(reassembled)).toBe(new TextDecoder().decode(packet));
  });
});
