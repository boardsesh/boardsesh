// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import { zoomToRadiusKm, roundCoord } from '../board-search';

describe('zoomToRadiusKm', () => {
  it('returns 5 km at high zoom levels (14+)', () => {
    expect(zoomToRadiusKm(14)).toBe(5);
    expect(zoomToRadiusKm(15)).toBe(5);
    expect(zoomToRadiusKm(19)).toBe(5);
  });

  it('maps each mid-zoom level to its band', () => {
    expect(zoomToRadiusKm(13)).toBe(10);
    expect(zoomToRadiusKm(12)).toBe(15);
    expect(zoomToRadiusKm(11)).toBe(20);
    expect(zoomToRadiusKm(10)).toBe(40);
    expect(zoomToRadiusKm(9)).toBe(80);
    expect(zoomToRadiusKm(8)).toBe(160);
  });

  it('caps at 300 km for zoomed-out views (7 and below)', () => {
    expect(zoomToRadiusKm(7)).toBe(300);
    expect(zoomToRadiusKm(3)).toBe(300);
    expect(zoomToRadiusKm(0)).toBe(300);
  });

  it('is monotonically non-increasing as zoom increases', () => {
    let prev = Infinity;
    for (let zoom = 0; zoom <= 19; zoom++) {
      const radius = zoomToRadiusKm(zoom);
      expect(radius).toBeLessThanOrEqual(prev);
      prev = radius;
    }
  });
});

describe('roundCoord', () => {
  it('rounds to 2 decimals (~1km)', () => {
    expect(roundCoord(37.123456)).toBe(37.12);
    expect(roundCoord(-122.987654)).toBe(-122.99);
  });

  it('passes through null', () => {
    expect(roundCoord(null)).toBeNull();
  });

  it('keeps already-rounded values stable', () => {
    expect(roundCoord(37.12)).toBe(37.12);
    expect(roundCoord(0)).toBe(0);
  });
});
