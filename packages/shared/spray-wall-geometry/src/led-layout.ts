import { homographyFromAnchors, invert, mapPoint } from './homography';
import { generateTnutGrid, isValidTnutCorners, type TnutLayout, type TnutPoint } from './tnut-layout';

export type LedPosition = TnutPoint & { id: string };
export type CableDirection = 'horizontal' | 'vertical' | 'custom';
export type CableStartCorner = 'tl' | 'tr' | 'bl' | 'br';
export type TnutWiring = {
  direction: CableDirection;
  startCorner: CableStartCorner;
  paths: string[][];
  skips: { from: string; to: string; count: number }[];
  /** Unused physical LEDs before the first visible LED. Missing in older saves. */
  initialSkip?: number;
};
export const MAX_LED_POSITIONS = 6000;
export const MAX_WIRING_SKIP = 10000;
export const MAX_WIRING_TOTAL_SKIPS = 1000000;
const validSkipCount = (count: unknown): count is number =>
  typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= MAX_WIRING_SKIP;
const boundedPoint = (point: TnutPoint) =>
  Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
const record = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
export function readLedPositions(candidate: unknown): LedPosition[] | null {
  if (!Array.isArray(candidate) || candidate.length > MAX_LED_POSITIONS) return null;
  const ids = new Set<string>();
  const result: LedPosition[] = [];
  for (const point of candidate) {
    if (
      !record(point) ||
      typeof point.id !== 'string' ||
      !point.id ||
      point.id.length > 100 ||
      ids.has(point.id) ||
      typeof point.x !== 'number' ||
      typeof point.y !== 'number' ||
      !boundedPoint({ x: point.x, y: point.y })
    )
      return null;
    ids.add(point.id);
    result.push({ id: point.id, x: point.x, y: point.y });
  }
  return result;
}
const edgeKey = (from: string, to: string) => JSON.stringify([from, to].sort());
function edgeSet(paths: string[][]): Set<string> {
  return new Set(paths.flatMap((path) => path.slice(1).map((to, index) => edgeKey(path[index], to))));
}
export function readTnutWiring(candidate: unknown, leds: LedPosition[]): TnutWiring | null {
  if (
    !record(candidate) ||
    typeof candidate.direction !== 'string' ||
    !['horizontal', 'vertical', 'custom'].includes(candidate.direction) ||
    typeof candidate.startCorner !== 'string' ||
    !['tl', 'tr', 'bl', 'br'].includes(candidate.startCorner) ||
    !Array.isArray(candidate.paths) ||
    !Array.isArray(candidate.skips) ||
    (candidate.initialSkip !== undefined && !validSkipCount(candidate.initialSkip)) ||
    candidate.paths.length > leds.length ||
    candidate.skips.length > leds.length
  )
    return null;
  const available = new Set(leds.map((point) => point.id));
  const used = new Set<string>();
  const paths: string[][] = [];
  for (const path of candidate.paths) {
    if (!Array.isArray(path) || !path.length || path.length > leds.length) return null;
    const copy: string[] = [];
    for (const id of path) {
      if (typeof id !== 'string' || !available.has(id) || used.has(id)) return null;
      used.add(id);
      copy.push(id);
    }
    paths.push(copy);
  }
  const edges = edgeSet(paths);
  const seen = new Set<string>();
  const skips: TnutWiring['skips'] = [];
  let total = (candidate.initialSkip as number | undefined) ?? 0;
  for (const skip of candidate.skips) {
    if (
      !record(skip) ||
      typeof skip.from !== 'string' ||
      typeof skip.to !== 'string' ||
      typeof skip.count !== 'number' ||
      !Number.isInteger(skip.count) ||
      skip.count < 1 ||
      skip.count > MAX_WIRING_SKIP
    )
      return null;
    const key = edgeKey(skip.from, skip.to);
    total += skip.count;
    if (!edges.has(key) || seen.has(key) || total > MAX_WIRING_TOTAL_SKIPS) return null;
    seen.add(key);
    skips.push({ from: skip.from, to: skip.to, count: skip.count });
  }
  return {
    direction: candidate.direction as CableDirection,
    startCorner: candidate.startCorner as CableStartCorner,
    paths,
    skips,
    ...(candidate.initialSkip !== undefined ? { initialSkip: candidate.initialSkip as number } : {}),
  };
}
function wallFrame(layout: TnutLayout) {
  const { topLeft, topRight, bottomRight, bottomLeft } = layout.corners;
  if (!isValidTnutCorners(layout.corners)) return null;
  const toUnit = homographyFromAnchors(
    [topLeft, topRight, bottomRight, bottomLeft].map(({ x, y }) => [x, y]),
    { width: 1, height: 1 },
  );
  return { toUnit, toWall: invert(toUnit) };
}
/** Offsets are applied in the calibrated grid plane, as in CRUX, before projection. */
export function generateLedPositions(layout: TnutLayout): LedPosition[] {
  if (!layout.ledPlacement) return [];
  let points: TnutPoint[] = [];
  if (layout.ledPlacement === 'alternating' && layout.pattern === 'offset')
    points = generateTnutGrid({ ...layout, pattern: 'offset', firstRowOffset: !layout.firstRowOffset });
  else {
    const frame = wallFrame(layout);
    const customDistances =
      layout.pattern === 'custom'
        ? layout.holes
            .map((hole, index) =>
              Math.min(
                ...layout.holes
                  .filter((_, other) => other !== index)
                  .map((other) => Math.hypot(other.x - hole.x, other.y - hole.y)),
              ),
            )
            .filter((distance) => Number.isFinite(distance) && distance > 1e-8)
            .sort((left, right) => left - right)
        : [];
    const customSpacing = customDistances[Math.floor(customDistances.length / 2)] ?? 0.1;
    const columnStep =
      (layout.pattern === 'offset' && layout.columnConvention === 'all' ? 2 : 1) / Math.max(1, layout.columns - 1);
    const rowStep = 1 / Math.max(1, layout.rows - 1);
    for (const hole of layout.holes) {
      const offsets = layout.ledPlacement === 'sides' ? [-columnStep / 10, columnStep / 10] : [0];
      for (const offset of offsets) {
        if (layout.pattern === 'custom' && layout.ledPlacement !== 'center') {
          points.push({
            x: hole.x + (layout.ledPlacement === 'sides' ? (Math.sign(offset) * customSpacing) / 10 : 0),
            y: hole.y + (layout.ledPlacement === 'below' ? customSpacing / 2 : 0),
          });
          continue;
        }
        if (layout.ledPlacement === 'center') {
          points.push(hole);
          continue;
        }
        if (frame) {
          const [x, y] = mapPoint(frame.toUnit, hole.x, hole.y);
          const [mappedX, mappedY] = mapPoint(
            frame.toWall,
            x + offset,
            y + (layout.ledPlacement === 'below' ? rowStep / 2 : 0),
          );
          points.push({ x: mappedX, y: mappedY });
        } else {
          const horizontal = layout.corners.topRight;
          const vertical = layout.corners.bottomLeft;
          const origin = layout.corners.topLeft;
          points.push({
            x:
              hole.x +
              offset * (horizontal.x - origin.x) +
              (layout.ledPlacement === 'below' ? (rowStep / 2) * (vertical.x - origin.x) : 0),
            y:
              hole.y +
              offset * (horizontal.y - origin.y) +
              (layout.ledPlacement === 'below' ? (rowStep / 2) * (vertical.y - origin.y) : 0),
          });
        }
      }
    }
  }
  const seen = new Set<string>();
  return points
    .filter((point) => {
      const key = `${point.x.toFixed(8)}:${point.y.toFixed(8)}`;
      if (!boundedPoint(point) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_LED_POSITIONS)
    .map((point) => ({ ...point, id: `led-${point.x.toFixed(8)}-${point.y.toFixed(8)}` }));
}
/** Calibrated row/column grouping shared by cable order and the row-major LED test. */
function ledGroups(leds: LedPosition[], direction: 'horizontal' | 'vertical', layout?: TnutLayout) {
  const frame = layout ? wallFrame(layout) : null;
  const projected = leds.map((point) => {
    const [x, y] = frame ? mapPoint(frame.toUnit, point.x, point.y) : [point.x, point.y];
    return { id: point.id, x, y };
  });
  const primary = direction === 'horizontal' ? 'y' : 'x';
  const secondary = direction === 'horizontal' ? 'x' : 'y';
  const sorted = projected.sort((left, right) => left[primary] - right[primary] || left[secondary] - right[secondary]);
  const tolerance = layout ? 0.2 / Math.max(1, (direction === 'horizontal' ? layout.rows : layout.columns) - 1) : 0.01;
  const groups: (typeof projected)[] = [];
  for (const point of sorted) {
    const group = groups.at(-1);
    if (!group || Math.abs(point[primary] - group[0][primary]) > tolerance) groups.push([point]);
    else group.push(point);
  }
  for (const group of groups) group.sort((left, right) => left[secondary] - right[secondary]);
  return groups;
}
export function createWiring(
  leds: LedPosition[],
  direction: CableDirection,
  startCorner: CableStartCorner,
  layout?: TnutLayout,
): TnutWiring {
  const wiring: TnutWiring = { direction, startCorner, paths: [], skips: [] };
  if (direction === 'custom' || !leds.length) return wiring;
  const groups = ledGroups(leds, direction, layout);
  const reversePrimary = direction === 'horizontal' ? startCorner[0] === 'b' : startCorner[1] === 'r';
  const reverseSecondary = direction === 'horizontal' ? startCorner[1] === 'r' : startCorner[0] === 'b';
  if (reversePrimary) groups.reverse();
  const path: string[] = [];
  groups.forEach((group, index) => {
    if (reverseSecondary !== (index % 2 === 1)) group.reverse();
    path.push(...group.map((point) => point.id));
  });
  wiring.paths = [path];
  return wiring;
}
/** Append one trace to the existing tail, never start another section or revisit an LED. */
export function extendWiring(wiring: TnutWiring, ids: string[]): TnutWiring {
  const used = new Set(wiring.paths.flat());
  const additions: string[] = [];
  for (const id of ids) {
    if (used.size >= MAX_LED_POSITIONS) break;
    if (!id || id.length > 100 || used.has(id)) continue;
    used.add(id);
    additions.push(id);
  }
  if (!additions.length) return wiring;
  const paths = wiring.paths.slice();
  if (paths.length) paths[paths.length - 1] = [...paths[paths.length - 1], ...additions];
  else paths.push(additions);
  return { ...wiring, paths };
}
function withPaths(wiring: TnutWiring, paths: string[][]): TnutWiring {
  const edges = edgeSet(paths);
  return { ...wiring, paths, skips: wiring.skips.filter((skip) => edges.has(edgeKey(skip.from, skip.to))) };
}
/** Join free endpoints only; reversing a run never changes its physical gap counts. */
export function connectWiring(wiring: TnutWiring, from: string, to: string): TnutWiring {
  if (from === to) return wiring;
  const paths = wiring.paths.map((path) => [...path]);
  let first = paths.findIndex((path) => path.includes(from));
  let second = paths.findIndex((path) => path.includes(to));
  if (paths.length && first < 0 && second < 0) return wiring;
  if (first < 0) {
    paths.push([from]);
    first = paths.length - 1;
  }
  if (second < 0) {
    paths.push([to]);
    second = paths.length - 1;
  }
  if (first === second) return wiring;
  const a = paths[first],
    b = paths[second];
  if ((a[0] !== from && a.at(-1) !== from) || (b[0] !== to && b.at(-1) !== to)) return wiring;
  if (a[0] === from) a.reverse();
  if (b.at(-1) === to) b.reverse();
  return withPaths(wiring, [...paths.filter((_, index) => index !== first && index !== second), [...a, ...b]]);
}
export function cutWiring(wiring: TnutWiring, from: string, to: string): TnutWiring {
  for (let pathIndex = 0; pathIndex < wiring.paths.length; pathIndex++) {
    const path = wiring.paths[pathIndex];
    const index = path.findIndex(
      (id, index) => index < path.length - 1 && edgeKey(id, path[index + 1]) === edgeKey(from, to),
    );
    if (index >= 0)
      return withPaths(
        wiring,
        wiring.paths.flatMap((entry, position) =>
          position === pathIndex ? [path.slice(0, index + 1), path.slice(index + 1)] : [[...entry]],
        ),
      );
  }
  return wiring;
}
export function setWiringSkip(wiring: TnutWiring, from: string, to: string, count: number): TnutWiring {
  if (!validSkipCount(count) || !edgeSet(wiring.paths).has(edgeKey(from, to))) return wiring;
  const aggregate =
    wiring.skips
      .filter((skip) => edgeKey(skip.from, skip.to) !== edgeKey(from, to))
      .reduce((total, skip) => total + skip.count, wiring.initialSkip ?? 0) + count;
  if (aggregate > MAX_WIRING_TOTAL_SKIPS) return wiring;
  return {
    ...wiring,
    skips: [
      ...wiring.skips.filter((skip) => edgeKey(skip.from, skip.to) !== edgeKey(from, to)),
      ...(count ? [{ from, to, count }] : []),
    ],
  };
}
/** Invalid edits are no-ops, matching edge-gap edits and persisted bounds. */
export function setWiringInitialSkip(wiring: TnutWiring, count: number): TnutWiring {
  if (!validSkipCount(count) || (wiring.initialSkip ?? 0) === count) return wiring;
  if (wiring.skips.reduce((total, skip) => total + skip.count, count) > MAX_WIRING_TOTAL_SKIPS) return wiring;
  return { ...wiring, initialSkip: count };
}
export function assignLedIndices(wiring: TnutWiring): { id: string; index: number }[] {
  const skips = new Map(wiring.skips.map((skip) => [edgeKey(skip.from, skip.to), skip.count]));
  let index = wiring.initialSkip ?? 0;
  return wiring.paths.flatMap((path) =>
    path.map((id, position) => {
      if (position) index += skips.get(edgeKey(path[position - 1], id)) ?? 0;
      return { id, index: index++ };
    }),
  );
}
/** Physical LED indices in top-to-bottom rows, left-to-right within every row. */
export function rowMajorLedIndices(leds: LedPosition[], wiring: TnutWiring, layout?: TnutLayout): number[] {
  const indices = new Map(assignLedIndices(wiring).map(({ id, index }) => [id, index]));
  const ordered: number[] = [];
  for (const group of ledGroups(leds, 'horizontal', layout)) {
    for (const point of group) {
      const index = indices.get(point.id);
      if (index !== undefined) ordered.push(index);
    }
  }
  return ordered;
}
/** Hits along the stroke are ordered by traversal, with each LED visited once. */
export function traceLedPath(leds: LedPosition[], polyline: TnutPoint[], tolerance: number): string[] {
  if (!(tolerance >= 0) || !polyline.length || !leds.length) return [];
  const hits: string[] = [];
  const seen = new Set<string>();
  // Index once per completed gesture. Each short segment only visits LEDs in
  // its padded x-range, instead of allocating a candidate for every LED.
  const byX = leds.map((point, order) => ({ point, order })).sort((left, right) => left.point.x - right.point.x);
  const toleranceSquared = tolerance * tolerance;
  for (let index = 0; index < polyline.length; index++) {
    const start = polyline[Math.max(0, index - 1)],
      end = polyline[index];
    const minX = Math.min(start.x, end.x) - tolerance,
      maxX = Math.max(start.x, end.x) + tolerance;
    const minY = Math.min(start.y, end.y) - tolerance,
      maxY = Math.max(start.y, end.y) + tolerance;
    let first = 0,
      last = byX.length;
    while (first < last) {
      const middle = (first + last) >>> 1;
      if (byX[middle].point.x < minX) first = middle + 1;
      else last = middle;
    }
    const dx = end.x - start.x,
      dy = end.y - start.y,
      lengthSquared = dx * dx + dy * dy;
    const candidates: { id: string; order: number; progress: number; distanceSquared: number }[] = [];
    for (let candidate = first; candidate < byX.length; candidate++) {
      const { point, order } = byX[candidate];
      if (point.x > maxX) break;
      if (point.y < minY || point.y > maxY || seen.has(point.id)) continue;
      const progress = lengthSquared
        ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
        : 0;
      const offsetX = point.x - start.x - progress * dx,
        offsetY = point.y - start.y - progress * dy;
      const distanceSquared = offsetX * offsetX + offsetY * offsetY;
      if (distanceSquared <= toleranceSquared) candidates.push({ id: point.id, order, progress, distanceSquared });
    }
    candidates.sort(
      (left, right) =>
        left.progress - right.progress || left.distanceSquared - right.distanceSquared || left.order - right.order,
    );
    for (const hit of candidates) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      hits.push(hit.id);
    }
  }
  return hits;
}
