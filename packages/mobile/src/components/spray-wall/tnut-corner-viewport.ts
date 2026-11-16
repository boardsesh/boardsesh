/** View-only transforms; persisted corners always remain normalized wall coordinates. */
/**
 * Keep the zoomed photo covering the frame. `minTravel` (a fraction of the frame)
 * lets the photo move that far at any zoom, so a hold on the photo's edge can be
 * brought away from the edge and the fingers even before zooming in.
 */
export function clampViewportPan(pan: number, size: number, zoom: number, minTravel = 0): number {
  'worklet';
  const limit = Math.max((size * (zoom - 1)) / 2, size * minTravel);
  if (limit <= 0) return 0;
  return Math.max(-limit, Math.min(limit, pan));
}

export function cornerScreenCoordinate(normalized: number, size: number, zoom: number, pan: number): number {
  'worklet';
  return size / 2 + pan + (normalized - 0.5) * size * zoom;
}

/** Keep the photo point under the initial focal position under the moving focal position. */
export function focalZoomPan(
  startFocal: number,
  focal: number,
  size: number,
  startZoom: number,
  zoom: number,
  startPan: number,
  minTravel = 0,
): number {
  'worklet';
  const anchored = focal - size / 2 - ((startFocal - size / 2 - startPan) * zoom) / startZoom;
  return clampViewportPan(anchored, size, zoom, minTravel);
}

export function draggedCornerCoordinate(start: number, translation: number, size: number, zoom: number): number {
  'worklet';
  return Math.max(0, Math.min(1, start + translation / (size * zoom)));
}

/** Quad storage order is TL, TR, BR, BL; hidden anchors are never removed from storage. */
export function activeTnutCorners(rows: number, columns: number): readonly number[] {
  'worklet';
  if (rows === 1 && columns === 1) return [0];
  if (rows === 1) return [0, 1];
  if (columns === 1) return [0, 3];
  return [0, 1, 2, 3];
}

/** Hit testing is measured in screen points even when the photo is zoomed. */
export function nearestPhotoPointIndex(
  points: readonly { x: number; y: number }[],
  target: { x: number; y: number },
  width: number,
  height: number,
  radius: number,
): number {
  'worklet';
  let nearest = -1;
  let distanceSquared = radius * radius;
  for (let index = 0; index < points.length; index++) {
    const dx = (points[index].x - target.x) * width;
    const dy = (points[index].y - target.y) * height;
    const candidate = dx * dx + dy * dy;
    if (candidate < distanceSquared) {
      nearest = index;
      distanceSquared = candidate;
    }
  }
  return nearest;
}
