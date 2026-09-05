// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// Pure helpers for map-based board search, shared by web and mobile so both
// derive the same search radius and coordinate stability from the map camera.

/**
 * Map zoom level → search radius in km. Roughly tracks the visible radius at
 * common zoom levels; capped at 300 km so a fully-zoomed-out view doesn't fire a
 * planet-wide query.
 */
export function zoomToRadiusKm(zoom: number): number {
  if (zoom >= 14) return 5;
  if (zoom === 13) return 10;
  if (zoom === 12) return 15;
  if (zoom === 11) return 20;
  if (zoom === 10) return 40;
  if (zoom === 9) return 80;
  if (zoom === 8) return 160;
  return 300;
}

/**
 * Round a coordinate to ~1 km precision so small map pans don't refire the
 * query. 2 decimals ≈ 1.1 km at the equator.
 */
export function roundCoord(n: number | null): number | null {
  if (n == null) return null;
  return Math.round(n * 100) / 100;
}
