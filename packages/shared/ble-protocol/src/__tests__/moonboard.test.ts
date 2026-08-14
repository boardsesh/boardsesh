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
    // The bytes match the clear frame but this is NOT a clear — consumers must
    // refuse to write it (zero encodable holds on a non-clear send).
    expect(result.isClear).toBe(false);
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

  it('sends the deliberate clear-all `l##` frame for empty frames (#3420)', () => {
    // Empty frames is the deliberate clear path: `l##` clears every LED on
    // community firmware. Only this input marks the result isClear — the flag
    // consumers use to let the clear through their zero-encodable refusal.
    const result = getMoonboardBluetoothPacket('');
    expect(new TextDecoder().decode(result.packet)).toBe('l##');
    expect(result.totalPlacements).toBe(0);
    expect(result.skippedRoleCount).toBe(0);
    expect(result.skippedPositionCount).toBe(0);
    expect(result.isClear).toBe(true);
  });

  it('never marks a degenerate non-empty frames string as a clear (#3420)', () => {
    // Separator-only input parses to zero placements and produces the same
    // `l##` bytes, but isClear false tells consumers to refuse the write
    // instead of silently darking the wall on a corrupt climb.
    const result = getMoonboardBluetoothPacket('p');
    expect(new TextDecoder().decode(result.packet)).toBe('l##');
    expect(result.totalPlacements).toBe(0);
    expect(result.isClear).toBe(false);
  });
});

describe('getMoonboardBluetoothPacket — V2 additional-LED prefix', () => {
  it('prefixes a non-empty frame with ~D when lightAdjacentHolds is set', () => {
    const result = getMoonboardBluetoothPacket('p1r42p2r43p198r44', undefined, {
      lightAdjacentHolds: true,
    });
    expect(new TextDecoder().decode(result.packet)).toBe('~Dl#S0,P35,E197#');
  });

  it('omits the ~D prefix by default', () => {
    const result = getMoonboardBluetoothPacket('p1r42');
    expect(new TextDecoder().decode(result.packet)).toBe('l#S0#');
  });

  it('encodes an explicit false option exactly like the default path', () => {
    const defaultPacket = getMoonboardBluetoothPacket('p1r42', 18).packet;
    const disabledPacket = getMoonboardBluetoothPacket('p1r42', 18, { lightAdjacentHolds: false }).packet;

    expect(disabledPacket).toEqual(defaultPacket);
    expect(new TextDecoder().decode(disabledPacket)).toBe('l#S0#');
  });

  it('never prefixes the deliberate clear-all frame, even when requested', () => {
    const result = getMoonboardBluetoothPacket('', undefined, { lightAdjacentHolds: true });
    expect(new TextDecoder().decode(result.packet)).toBe('l##');
    expect(result.isClear).toBe(true);
  });

  it('never prefixes a degenerate all-skipped frame', () => {
    const result = getMoonboardBluetoothPacket('p1r99', undefined, { lightAdjacentHolds: true });
    expect(new TextDecoder().decode(result.packet)).toBe('l##');
    expect(result.isClear).toBe(false);
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

// =============================================================================
// Mini MoonBoard — 12-row serpentine (vs the standard 18)
// =============================================================================
// The Mini LED strip is wired 11 columns × 12 rows. Positions verified against
// the reverse-engineered MoonBoard app protocol (e-sr/moonboard), which sends an
// `M` flag and addresses the Mini on a 12-row grid.

describe('getMoonboardSerialPosition — Mini (numRows = 12)', () => {
  it.each([
    [1, 0], // A1: col 0 (even), row 0
    [2, 23], // B1: col 1 (odd), row 0 → 12 + (12-1-0)
    [11, 120], // K1: col 10 (even), row 0
    [12, 1], // A2: col 0, row 1
    [123, 12], // B12: col 1 (odd), row 11 → 12 + (12-1-11)
    [132, 131], // K12: col 10 (even), row 11 — last LED on the 132-LED strip
  ])('holdId %i → position %i', (holdId, position) => {
    expect(getMoonboardSerialPosition(holdId, 12)).toBe(position);
  });

  it('rejects hold ids past the 11×12 Mini strip (max 132)', () => {
    expect(getMoonboardSerialPosition(132, 12)).toBe(131);
    expect(() => getMoonboardSerialPosition(133, 12)).toThrow('MoonBoard hold id out of range');
  });

  it('encodes a Mini packet with 12-row positions', () => {
    // p1r42 → S0 (A1 start), p2r43 → P23 (B1 hand), p132r44 → E131 (K12 finish)
    const result = getMoonboardBluetoothPacket('p1r42p2r43p132r44', 12);
    expect(new TextDecoder().decode(result.packet)).toBe('l#S0,P23,E131#');
  });

  it('differs from the standard board for the same hold (B1)', () => {
    // B1 is serial 35 on the 18-row board but 23 on the 12-row Mini.
    expect(getMoonboardSerialPosition(2)).toBe(35);
    expect(getMoonboardSerialPosition(2, 12)).toBe(23);
  });
});
