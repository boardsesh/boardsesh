import { describe, expect, it } from 'vitest';
import {
  MAX_RING_COORDINATE,
  MAX_RING_NUMBERS,
  MIN_RING_NUMBERS,
  isValidOutlineRing,
} from '@boardsesh/board-art-geometry/ring';
import { passesBackendRingContract, ringForTheWire } from '../ring-contract';

/** A ring of `points` points on the unit circle — the shape of every real outline. */
function ringOf(points: number): number[] {
  const ring: number[] = [];
  for (let index = 0; index < points; index += 1) {
    const angle = (index / points) * Math.PI * 2;
    ring.push(Number(Math.cos(angle).toFixed(4)), Number(Math.sin(angle).toFixed(4)));
  }
  return ring;
}

describe('passesBackendRingContract', () => {
  it('agrees with the shared validator the backend refines on, ring for ring', () => {
    // The parity that matters: this predicate IS `isValidOutlineRing`, so no
    // sample can exist where the client and the server disagree.
    const samples: number[][] = [
      ringOf(3),
      ringOf(12),
      ringOf(MAX_RING_NUMBERS / 2),
      ringOf(MAX_RING_NUMBERS / 2 + 1),
      ringOf(2),
      [0, 0, 1, 0, 0, 1, 5],
      [0, 0, 1, 0, 0, Number.NaN],
      [0, 0, 1, 0, 0, MAX_RING_COORDINATE + 0.01],
      [0, 0, 1, 0, 0, MAX_RING_COORDINATE],
    ];
    for (const sample of samples) {
      expect(passesBackendRingContract(sample)).toBe(isValidOutlineRing(sample));
    }
  });

  it('takes the smallest ring the contract allows and refuses one point fewer', () => {
    expect(ringOf(MIN_RING_NUMBERS / 2)).toHaveLength(MIN_RING_NUMBERS);
    expect(passesBackendRingContract(ringOf(MIN_RING_NUMBERS / 2))).toBe(true);
    expect(passesBackendRingContract(ringOf(MIN_RING_NUMBERS / 2 - 1))).toBe(false);
  });

  it('takes the longest ring the contract allows and refuses one point more', () => {
    expect(passesBackendRingContract(ringOf(MAX_RING_NUMBERS / 2))).toBe(true);
    expect(passesBackendRingContract(ringOf(MAX_RING_NUMBERS / 2 + 1))).toBe(false);
  });

  it('refuses an odd-length list, which is not a flat [x, y, ...] ring at all', () => {
    expect(passesBackendRingContract([0, 0, 1, 0, 0, 1, 2])).toBe(false);
  });

  it('refuses a coordinate outside the four-radii bound, and takes one exactly on it', () => {
    expect(passesBackendRingContract([0, 0, MAX_RING_COORDINATE, 0, 0, MAX_RING_COORDINATE])).toBe(true);
    expect(passesBackendRingContract([0, 0, MAX_RING_COORDINATE + 1e-9, 0, 0, 1])).toBe(false);
  });

  it('refuses a non-finite coordinate', () => {
    expect(passesBackendRingContract([0, 0, 1, 0, 0, Number.POSITIVE_INFINITY])).toBe(false);
    expect(passesBackendRingContract([0, 0, 1, 0, 0, Number.NaN])).toBe(false);
  });

  it('refuses null and undefined, which is how an untraced hold arrives', () => {
    expect(passesBackendRingContract(null)).toBe(false);
    expect(passesBackendRingContract(undefined)).toBe(false);
  });
});

describe('ringForTheWire', () => {
  it('copies a storable ring rather than aliasing the editor state', () => {
    const ring = ringOf(8);
    const wire = ringForTheWire(ring);
    expect(wire).toEqual(ring);
    expect(wire).not.toBe(ring);
  });

  it('answers null for a ring the server would refuse, so the hold saves as a circle', () => {
    expect(ringForTheWire(ringOf(MAX_RING_NUMBERS / 2 + 1))).toBeNull();
    expect(ringForTheWire([0, 0, 1, 0, 0, Number.NaN])).toBeNull();
    expect(ringForTheWire(null)).toBeNull();
  });
});
