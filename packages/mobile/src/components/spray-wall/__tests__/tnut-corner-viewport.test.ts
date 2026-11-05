import { describe, expect, it } from 'vitest';
import {
  activeTnutCorners,
  clampViewportPan,
  cornerScreenCoordinate,
  draggedCornerCoordinate,
  focalZoomPan,
} from '../tnut-corner-viewport';

describe('T-nut viewport coordinates', () => {
  it('keeps the same photo point under a moving pinch focal point', () => {
    const photoPoint = 0.4;
    const size = 400;
    const startZoom = 2;
    const startPan = 30;
    const startFocal = cornerScreenCoordinate(photoPoint, size, startZoom, startPan);
    const focal = startFocal + 25;
    const zoom = 3;
    const pan = focalZoomPan(startFocal, focal, size, startZoom, zoom, startPan);
    expect(cornerScreenCoordinate(photoPoint, size, zoom, pan)).toBeCloseTo(focal, 10);
  });

  it('moves an anchor by the finger distance after a zoomed and panned transform', () => {
    const size = 320;
    const zoom = 4;
    const pan = 90;
    const start = 0.4;
    const next = draggedCornerCoordinate(start, 80, size, zoom);
    expect(cornerScreenCoordinate(next, size, zoom, pan) - cornerScreenCoordinate(start, size, zoom, pan)).toBeCloseTo(
      80,
      10,
    );
    expect(next).toBeCloseTo(0.4625, 10);
  });

  it('bounds panning to the image edges and returns to its fitted origin at 1×', () => {
    expect(clampViewportPan(999, 300, 2)).toBe(150);
    expect(clampViewportPan(-999, 300, 2)).toBe(-150);
    expect(clampViewportPan(40, 300, 1)).toBe(0);
    expect(focalZoomPan(100, 50, 300, 3, 1, 150)).toBe(0);
    expect(draggedCornerCoordinate(0.4, -10000, 300, 2)).toBe(0);
    expect(draggedCornerCoordinate(0.4, 10000, 300, 2)).toBe(1);
  });

  it('uses top endpoints for a row, left endpoints for a column, and TL for a single hole', () => {
    expect(activeTnutCorners(1, 8)).toEqual([0, 1]);
    expect(activeTnutCorners(8, 1)).toEqual([0, 3]);
    expect(activeTnutCorners(1, 1)).toEqual([0]);
    expect(activeTnutCorners(8, 8)).toEqual([0, 1, 2, 3]);
  });
});
