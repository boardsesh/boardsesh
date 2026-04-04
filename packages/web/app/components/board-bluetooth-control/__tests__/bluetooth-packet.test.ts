import { describe, it, expect, vi } from 'vitest';

/**
 * Test BLE packet generation against known-good Aurora payloads.
 *
 * These payloads were captured from Aurora's official Kilter app for the
 * SAME climb on two different board sizes. They serve as ground truth
 * for LED position correctness.
 *
 * Climb holds (6 holds, same placement IDs on both sizes):
 *   4131 (x=-40, y=140) — starting hold
 *   4421 (x=40, y=140)  — starting hold
 *   4669 (x=36, y=-8)   — foot hold
 *   4655 (x=40, y=-4)   — foot hold
 *   4665 (x=-40, y=-4)  — foot hold
 *   4678 (x=-36, y=-8)  — foot hold
 */

// Mock transitive dependencies so bluetooth.ts can be imported directly
vi.mock('@/app/lib/moonboard-config', () => ({
  MOONBOARD_ENABLED: false,
}));

import { getBluetoothPacket } from '../bluetooth';
import { getLedPlacements } from '../../../lib/__generated__/led-placements-data';

// ---- Packet decoder ----

function decodeLedPositions(input: Uint8Array | string): { position: number; color: number }[] {
  let bytes: number[];
  if (typeof input === 'string') {
    bytes = [];
    for (let i = 0; i < input.length; i += 2) {
      bytes.push(parseInt(input.substring(i, i + 2), 16));
    }
  } else {
    bytes = Array.from(input);
  }
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

// ---- Known-good Aurora payloads ----

const AURORA_8x12_HEX = '01134002542700e38501e31400f41300f40100f40000f403';
const AURORA_10x12_HEX = '0113e202545000e3ae01e30400f40300f41700f41600f403';

// Frames string for this climb (derived from placement IDs)
// Order matches Aurora payload: 4131, 4421, 4669, 4655, 4665, 4678
const CLIMB_FRAMES = 'p4131r42p4421r42p4669r45p4655r45p4665r45p4678r45';

// Correct LED positions from Aurora's official app
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

describe('getBluetoothPacket — Aurora payload verification', () => {
  it('generates correct LED positions for Kilter 10x12 Full Ride (size 25)', () => {
    const packet = getBluetoothPacket(CLIMB_FRAMES, CORRECT_10x12_POSITIONS, 'kilter');
    const ourPositions = decodeLedPositions(packet).map((l) => l.position);
    const auroraPositions = decodeLedPositions(AURORA_10x12_HEX).map((l) => l.position);
    expect(ourPositions).toEqual(auroraPositions);
  });

  it('generates correct LED positions for Kilter 8x12 Full Ride (size 23)', () => {
    const packet = getBluetoothPacket(CLIMB_FRAMES, CORRECT_8x12_POSITIONS, 'kilter');
    const ourPositions = decodeLedPositions(packet).map((l) => l.position);
    const auroraPositions = decodeLedPositions(AURORA_8x12_HEX).map((l) => l.position);
    expect(ourPositions).toEqual(auroraPositions);
  });

  it('skips placements with no LED mapping instead of encoding position 0', () => {
    const sparseLedMap = { 4131: 39, 4421: 389 };
    const frames = 'p4131r42p4421r42p9999r45';

    const packet = getBluetoothPacket(frames, sparseLedMap, 'kilter');
    const leds = decodeLedPositions(packet);

    // 9999 should be skipped, not encoded as position 0
    expect(leds).toHaveLength(2);
    expect(leds[0].position).toBe(39);
    expect(leds[1].position).toBe(389);
  });

  it('8x12 kickboard positions match Aurora expectations', () => {
    // The 8x12 kickboard strip runs left-to-right, opposite from the 10x12.
    // Our database originally had these reversed.
    expect(CORRECT_8x12_POSITIONS[4678]).toBe(0);  // leftmost y=-8
    expect(CORRECT_8x12_POSITIONS[4665]).toBe(1);  // leftmost y=-4
    expect(CORRECT_8x12_POSITIONS[4655]).toBe(19); // rightmost y=-4
    expect(CORRECT_8x12_POSITIONS[4669]).toBe(20); // rightmost y=-8
  });
});

// ---- Kilter Original (Layout 1) validated payloads ----
// These payloads were validated by a 3rd party tool for the four corner holds
// (top-left, top-right, bottom-left, bottom-right) on each board size.

const VALIDATED_12x12_HEX = '010dbb02544400e3dc01e30000f42100f403';
const VALIDATED_8x12_ORIGINAL_HEX = '010d7802543800e33701e30000f41500f403';

// Frames: top-left finish, top-right finish, bottom-left foot, bottom-right foot
const CORNERS_12x12_FRAMES = 'p1379r44p1395r44p1447r45p1464r45';
const CORNERS_8x12_ORIGINAL_FRAMES = 'p1382r44p1392r44p1450r45p1461r45';

const CORRECT_12x12_POSITIONS: Record<number, number> = {
  1379: 68,   // top-left
  1395: 476,  // top-right
  1447: 0,    // bottom-left (kickboard)
  1464: 33,   // bottom-right (kickboard)
};

const CORRECT_8x12_ORIGINAL_POSITIONS: Record<number, number> = {
  1382: 56,   // top-left
  1392: 311,  // top-right
  1450: 0,    // bottom-left (kickboard)
  1461: 21,   // bottom-right (kickboard)
};

function toHex(packet: Uint8Array): string {
  return Array.from(packet)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('getBluetoothPacket — Kilter Original (Layout 1) payload verification', () => {
  it('generates correct full packet for Kilter 12x12 Original (size 10)', () => {
    const packet = getBluetoothPacket(CORNERS_12x12_FRAMES, CORRECT_12x12_POSITIONS, 'kilter');
    expect(toHex(packet)).toBe(VALIDATED_12x12_HEX);
  });

  it('generates correct full packet for Kilter 8x12 Original (size 8)', () => {
    const packet = getBluetoothPacket(CORNERS_8x12_ORIGINAL_FRAMES, CORRECT_8x12_ORIGINAL_POSITIONS, 'kilter');
    expect(toHex(packet)).toBe(VALIDATED_8x12_ORIGINAL_HEX);
  });

  it('12x12 LED data from getLedPlacements matches validated positions', () => {
    const ledMap = getLedPlacements('kilter', 1, 10);
    expect(ledMap[1379]).toBe(68);   // top-left
    expect(ledMap[1395]).toBe(476);  // top-right
    expect(ledMap[1447]).toBe(0);    // bottom-left
    expect(ledMap[1464]).toBe(33);   // bottom-right
  });

  it('8x12 Original LED data from getLedPlacements matches validated positions', () => {
    const ledMap = getLedPlacements('kilter', 1, 8);
    expect(ledMap[1382]).toBe(56);   // top-left
    expect(ledMap[1392]).toBe(311);  // top-right
    expect(ledMap[1450]).toBe(0);    // bottom-left
    expect(ledMap[1461]).toBe(21);   // bottom-right
  });

  it('12x12 full packet matches when using real LED data', () => {
    const ledMap = getLedPlacements('kilter', 1, 10);
    const packet = getBluetoothPacket(CORNERS_12x12_FRAMES, ledMap, 'kilter');
    const ourPositions = decodeLedPositions(packet).map((l) => l.position);
    const validatedPositions = decodeLedPositions(VALIDATED_12x12_HEX).map((l) => l.position);
    expect(ourPositions).toEqual(validatedPositions);
  });

  it('8x12 Original full packet matches when using real LED data', () => {
    const ledMap = getLedPlacements('kilter', 1, 8);
    const packet = getBluetoothPacket(CORNERS_8x12_ORIGINAL_FRAMES, ledMap, 'kilter');
    const ourPositions = decodeLedPositions(packet).map((l) => l.position);
    const validatedPositions = decodeLedPositions(VALIDATED_8x12_ORIGINAL_HEX).map((l) => l.position);
    expect(ourPositions).toEqual(validatedPositions);
  });
});
