import { distanceToRing, isValidOutlineRing, pointInRing } from '@boardsesh/board-art-geometry/ring';
import type { CanonicalSprayHold } from './hold-projection';
import { homographyFromAnchors, mapPoint, type ReferenceSize } from './homography';
import { assignLedIndices, generateLedPositions, type LedPosition } from './led-layout';
import { generateTnutGrid, isValidTnutCorners, type TnutLayout, type TnutPoint } from './tnut-layout';

export type SprayHoleLedMapping = {
  holeIndex: number;
  holdId: number | null;
  ledIds: string[];
  indices: number[];
  aboveLedIds: string[];
  aboveIndices: number[];
};
export type SprayHoldLedMapping = {
  holdId: number;
  holeIndices: number[];
  ledIds: string[];
  indices: number[];
  aboveLedIds: string[];
  aboveIndices: number[];
};
export type SprayLedMapping = { holes: SprayHoleLedMapping[]; holds: SprayHoldLedMapping[] };

const keyFor = (point: TnutPoint) => `${point.x.toFixed(8)}:${point.y.toFixed(8)}`;
const distanceSquared = (first: TnutPoint, second: TnutPoint, frame: ReferenceSize) =>
  ((first.x - second.x) * frame.width) ** 2 + ((first.y - second.y) * frame.height) ** 2;

function validFrame(frame: ReferenceSize): boolean {
  return Number.isFinite(frame.width) && Number.isFinite(frame.height) && frame.width > 0 && frame.height > 0;
}

function holdCandidates(holds: readonly CanonicalSprayHold[]) {
  return holds
    .filter((hold) => Number.isFinite(hold.cx) && Number.isFinite(hold.cy) && Number.isFinite(hold.r) && hold.r > 0)
    .map((hold) => ({ hold, outline: isValidOutlineRing(hold.outline) ? hold.outline : null }));
}

function findHold(
  candidates: ReturnType<typeof holdCandidates>,
  point: TnutPoint,
  frame: ReferenceSize,
): number | null {
  let chosen: number | null = null;
  let nearest = Infinity;
  for (const { hold, outline } of candidates) {
    const relativeX = (point.x * frame.width - hold.cx) / hold.r;
    const relativeY = (point.y * frame.height - hold.cy) / hold.r;
    const distance = relativeX ** 2 + relativeY ** 2;
    if (outline) {
      if (Math.abs(relativeX) > 4 || Math.abs(relativeY) > 4) continue;
      if (!pointInRing(outline, relativeX, relativeY) && distanceToRing(outline, relativeX, relativeY) > 1e-8) continue;
    } else if (distance > 1 + 1e-8) continue;
    if (distance < nearest || (distance === nearest && hold.id < (chosen ?? Infinity))) {
      chosen = hold.id;
      nearest = distance;
    }
  }
  return chosen;
}

/** Hit test normalized rectified photo taps against the canonical hold silhouettes. */
export function findSprayHoldAtPoint(
  holds: readonly CanonicalSprayHold[],
  point: TnutPoint,
  frame: ReferenceSize,
): number | null {
  if (
    !validFrame(frame) ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.x > 1 ||
    point.y < 0 ||
    point.y > 1
  )
    return null;
  return findHold(holdCandidates(holds), point, frame);
}

/** The generated ID remembers the original slot even after an older LED was moved. */
function originalPosition(led: LedPosition): TnutPoint {
  if (led.origin) return led.origin;
  const coordinates = /^led-(\d+\.\d+)-(\d+\.\d+)$/.exec(led.id);
  if (!coordinates) return led;
  const point = { x: Number(coordinates[1]), y: Number(coordinates[2]) };
  return point.x <= 1 && point.y <= 1 ? point : led;
}

function holeBindings(layout: TnutLayout, frame: ReferenceSize): Map<string, number[]> {
  const bindings = new Map<string, number[]>();
  if (!layout.ledPlacement || !validFrame(frame)) return bindings;
  const holesByKey = new Map(layout.holes.map((point, index) => [keyFor(point), index]));
  const generated = generateLedPositions(layout);
  const generatedById = new Map(generated.map((led) => [led.id, led]));
  const leds = layout.ledPositions ?? [];

  let limits: number[] | null = null;
  for (const led of leds) {
    const storedHole = led.hole ?? generatedById.get(led.id)?.hole;
    if (storedHole) {
      const holeIndex = holesByKey.get(keyFor(storedHole));
      if (holeIndex !== undefined) bindings.set(led.id, [holeIndex]);
      continue;
    }
    const origin = originalPosition(led);
    limits ??= layout.holes.map((hole, index) => {
      let spacing = Infinity;
      for (const [otherIndex, other] of layout.holes.entries()) {
        if (otherIndex === index) continue;
        const distance = distanceSquared(hole, other, frame);
        if (distance > 1e-12) spacing = Math.min(spacing, Math.sqrt(distance));
      }
      return Math.min(spacing * 0.45, Math.min(frame.width, frame.height) * 0.1) ** 2;
    });
    let nearest = Infinity;
    let chosen: number | null = null;
    let ambiguous = false;
    for (const expected of generated) {
      if (!expected.hole) continue;
      const holeIndex = holesByKey.get(keyFor(expected.hole));
      if (holeIndex === undefined) continue;
      const distance = distanceSquared(origin, expected, frame);
      if (distance > limits[holeIndex] + 1e-8) continue;
      if (distance < nearest - 1e-8) {
        nearest = distance;
        chosen = holeIndex;
        ambiguous = false;
      } else if (Math.abs(distance - nearest) <= 1e-8 && chosen !== holeIndex) ambiguous = true;
    }
    if (chosen !== null && !ambiguous) bindings.set(led.id, [chosen]);
  }
  return bindings;
}

function customSpacing(layout: TnutLayout): number {
  const distances = layout.holes
    .map((hole, holeIndex) => {
      let nearest = Infinity;
      for (const [otherIndex, other] of layout.holes.entries()) {
        if (otherIndex === holeIndex) continue;
        const distance = Math.hypot(hole.x - other.x, hole.y - other.y);
        if (distance > 1e-8) nearest = Math.min(nearest, distance);
      }
      return nearest;
    })
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return distances[Math.floor(distances.length / 2)] ?? 0.1;
}

/** Direction and spacing belong to the calibrated grid, not the displayed photo. */
function verticalGrid(layout: TnutLayout) {
  const { topLeft, topRight, bottomRight, bottomLeft } = layout.corners;
  const matrix =
    layout.pattern !== 'custom' && isValidTnutCorners(layout.corners)
      ? homographyFromAnchors(
          [topLeft, topRight, bottomRight, bottomLeft].map(({ x, y }) => [x, y]),
          { width: 1, height: 1 },
        )
      : null;
  const horizontal = { x: topRight.x - topLeft.x, y: topRight.y - topLeft.y };
  const vertical = { x: bottomLeft.x - topLeft.x, y: bottomLeft.y - topLeft.y };
  const determinant = horizontal.x * vertical.y - horizontal.y * vertical.x;
  const toGrid = (point: TnutPoint): TnutPoint => {
    if (matrix) {
      const [x, y] = mapPoint(matrix, point.x, point.y);
      return { x, y };
    }
    if (layout.pattern !== 'custom' && Math.abs(determinant) > 1e-10) {
      const offsetX = point.x - topLeft.x;
      const offsetY = point.y - topLeft.y;
      return {
        x: (offsetX * vertical.y - offsetY * vertical.x) / determinant,
        y: (offsetY * horizontal.x - offsetX * horizontal.y) / determinant,
      };
    }
    return point;
  };
  const spacing = layout.pattern === 'custom' ? customSpacing(layout) : null;
  const columnStep =
    spacing ??
    (layout.pattern === 'offset' && layout.columnConvention === 'all' ? 2 : 1) / Math.max(1, layout.columns - 1);
  const rowStep = spacing ?? 1 / Math.max(1, layout.rows - 1);
  return {
    toGrid,
    columnStep,
    lowerGap: rowStep * (layout.ledPlacement === 'alternating' ? 1 : 0.5),
    // Staggered rows have no same-column nut in the previous row. Its below-LED
    // belongs to the preceding matching phase, one and a half rows above us.
    upperGap:
      rowStep *
      (layout.ledPlacement === 'alternating' ? 1 : layout.pattern === 'offset' && layout.columns > 1 ? 1.5 : 0.5),
  };
}

function verticalBindings(layout: TnutLayout): { main: Map<string, number[]>; above: Map<string, number[]> } {
  const { toGrid, columnStep, lowerGap, upperGap } = verticalGrid(layout);
  const available = (layout.ledPositions ?? []).map((led) => ({ led, point: toGrid(originalPosition(led)) }));
  const holes = layout.holes.map((hole, holeIndex) => ({ holeIndex, key: keyFor(hole), point: toGrid(hole) }));
  const singleColumnGaps = new Map<string, { lower: number | null; upper: number | null }>();
  if (layout.pattern !== 'custom' && layout.columns === 1) {
    // One-axis nuts interpolate along the active edge, while LED offsets use
    // the full saved perspective. Their spacing in that plane is not uniform.
    const nominal = generateTnutGrid({ ...layout, pattern: layout.pattern })
      .map((hole) => ({ key: keyFor(hole), point: toGrid(hole) }))
      .sort((first, second) => first.point.y - second.point.y);
    for (const [index, hole] of nominal.entries()) {
      const previous = nominal[index - 1];
      const next = nominal[index + 1];
      singleColumnGaps.set(hole.key, {
        lower: layout.ledPlacement === 'alternating' ? (next ? next.point.y - hole.point.y : null) : lowerGap,
        upper: previous
          ? hole.point.y - previous.point.y - (layout.ledPlacement === 'alternating' ? 0 : lowerGap)
          : null,
      });
    }
  }
  const bucketKey = (column: number, row: number) => `${column}:${row}`;
  const select = (direction: 1 | -1) => {
    const gap = direction === 1 ? lowerGap : upperGap;
    const byHole = new Map<string, typeof available>();
    const bySlot = new Map<string, typeof available>();
    for (const candidate of available) {
      // Only primary bindings are authoritative. Upper metadata is a derived
      // cache, so older clients dropping that key cannot change selection.
      const bound = direction === 1 ? candidate.led.hole : undefined;
      const key = bound
        ? keyFor(bound)
        : bucketKey(Math.floor(candidate.point.x / columnStep), Math.floor(candidate.point.y / gap));
      const index = bound ? byHole : bySlot;
      const bucket = index.get(key);
      if (bucket) bucket.push(candidate);
      else index.set(key, [candidate]);
    }
    const selected = new Map<string, { holeIndex: number; key: string; distance: number }>();
    for (const { holeIndex, key, point } of holes) {
      let chosen: string | null = null;
      let nearest = Infinity;
      // Explicit references have priority and stale ones never enter the slot
      // index. Unbound markers only search the immediate expected neighborhood.
      const explicit = byHole.get(key);
      const singleColumn = singleColumnGaps.get(key);
      const expectedGap = singleColumn ? (direction === 1 ? singleColumn.lower : singleColumn.upper) : gap;
      if ((expectedGap === null || expectedGap <= 1e-8) && !explicit?.length) continue;
      const directionalGap = expectedGap !== null && expectedGap > 1e-8 ? expectedGap : gap;
      const nearby: typeof available = [];
      if (!explicit?.length) {
        const column = Math.floor(point.x / columnStep);
        const row = Math.floor((point.y + direction * directionalGap) / gap);
        const rowRadius = Math.ceil((directionalGap * 0.4) / gap);
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
          for (let rowOffset = -rowRadius; rowOffset <= rowRadius; rowOffset++) {
            const bucket = bySlot.get(bucketKey(column + columnOffset, row + rowOffset));
            if (bucket) nearby.push(...bucket);
          }
        }
      }
      for (const { led, point: slot } of explicit ?? nearby) {
        const horizontal = (slot.x - point.x) / columnStep;
        const vertical = ((slot.y - point.y) * direction) / directionalGap;
        // A missing slot stays missing. Same-row, sideways and later-row slots
        // must not substitute for the one immediately below/above the hole.
        if (!explicit && (Math.abs(horizontal) > 0.2 || vertical < 0.6 || vertical > 1.4)) continue;
        const distance = horizontal ** 2 + (vertical - 1) ** 2;
        if (distance < nearest - 1e-8 || (Math.abs(distance - nearest) <= 1e-8 && led.id < (chosen ?? ''))) {
          chosen = led.id;
          nearest = distance;
        }
      }
      if (chosen === null) continue;
      const previous = selected.get(chosen);
      // Nearby edited nuts may nominate the same slot. Resolve by proximity,
      // then coordinates, so reordering the hole list cannot move ownership.
      if (
        !previous ||
        nearest < previous.distance - 1e-8 ||
        (Math.abs(nearest - previous.distance) <= 1e-8 && key < previous.key)
      )
        selected.set(chosen, { holeIndex, key, distance: nearest });
    }
    return new Map([...selected].map(([id, { holeIndex }]) => [id, [holeIndex]]));
  };
  return { main: select(1), above: select(-1) };
}

function allBindings(layout: TnutLayout, frame: ReferenceSize) {
  if (!validFrame(frame)) return { main: new Map<string, number[]>(), above: new Map<string, number[]>() };
  return layout.ledPlacement === 'below' || layout.ledPlacement === 'alternating'
    ? verticalBindings(layout)
    : { main: holeBindings(layout, frame), above: new Map<string, number[]>() };
}

/** A grip is mounted at one nut near its center; its outline remains a tap target. */
function mountingHoles(layout: TnutLayout, holds: readonly CanonicalSprayHold[], frame: ReferenceSize) {
  const ownership = new Map<number, { holdId: number; distance: number }>();
  for (const { hold, outline } of holdCandidates(holds)) {
    let chosen: number | null = null;
    let nearest = Infinity;
    for (const [holeIndex, hole] of layout.holes.entries()) {
      const relativeX = (hole.x * frame.width - hold.cx) / hold.r;
      const relativeY = (hole.y * frame.height - hold.cy) / hold.r;
      const distance = relativeX ** 2 + relativeY ** 2;
      if (outline) {
        if (Math.abs(relativeX) > 4 || Math.abs(relativeY) > 4) continue;
        if (!pointInRing(outline, relativeX, relativeY) && distanceToRing(outline, relativeX, relativeY) > 1e-8)
          continue;
      } else if (distance > 1 + 1e-8) continue;
      if (distance < nearest - 1e-8) {
        chosen = holeIndex;
        nearest = distance;
      }
    }
    if (chosen === null) continue;
    const mountingHole = layout.holes[chosen];
    let spacing = Infinity;
    for (const [holeIndex, hole] of layout.holes.entries()) {
      if (holeIndex === chosen) continue;
      const distance = distanceSquared(mountingHole, hole, frame);
      if (distance > 1e-8) spacing = Math.min(spacing, distance);
    }
    // A wide outline must not pull in a remote nut when its center has none.
    if (nearest * hold.r ** 2 > spacing * 0.75 ** 2 + 1e-8) continue;
    const previous = ownership.get(chosen);
    if (!previous || nearest < previous.distance || (nearest === previous.distance && hold.id < previous.holdId))
      ownership.set(chosen, { holdId: hold.id, distance: nearest });
  }
  return ownership;
}

/** Persist inferred associations before a manual LED is moved on a later visit. */
export function bindLedPositionsToHoles(layout: TnutLayout, frame: ReferenceSize): LedPosition[] {
  const leds = layout.ledPositions ?? [];
  if (!validFrame(frame)) return leds;
  const { main, above } = allBindings(layout, frame);
  return leds.map((led) => {
    const indices = main.get(led.id);
    const aboveIndices = above.get(led.id);
    if (layout.ledPlacement === 'alternating' || layout.ledPlacement === 'below') {
      const { aboveHole: _aboveHole, ...withoutAbove } = led;
      if (!indices?.length && !aboveIndices?.length) return led.aboveHole ? withoutAbove : led;
      const origin = originalPosition(led);
      return {
        ...withoutAbove,
        origin: { x: origin.x, y: origin.y },
        ...(!led.hole && indices?.length === 1 ? { hole: { ...layout.holes[indices[0]] } } : {}),
        ...(aboveIndices?.length === 1 ? { aboveHole: { ...layout.holes[aboveIndices[0]] } } : {}),
      };
    }
    if (led.hole || indices?.length !== 1) return led;
    return { ...led, hole: { ...layout.holes[indices[0]] } };
  });
}

/** Match in canonical pixels. The photo homography has already rectified the setup frame. */
export function buildSprayLedMapping(
  layout: TnutLayout,
  frame: ReferenceSize,
  holds: readonly CanonicalSprayHold[],
): SprayLedMapping {
  const mappedHolds: SprayHoldLedMapping[] = holds.map((hold) => ({
    holdId: hold.id,
    holeIndices: [],
    ledIds: [],
    indices: [],
    aboveLedIds: [],
    aboveIndices: [],
  }));
  const holes: SprayHoleLedMapping[] = layout.holes.map((_, holeIndex) => ({
    holeIndex,
    holdId: null,
    ledIds: [],
    indices: [],
    aboveLedIds: [],
    aboveIndices: [],
  }));
  if (!validFrame(frame)) return { holes, holds: mappedHolds };
  const { main, above } = allBindings(layout, frame);
  const indices = new Map((layout.wiring ? assignLedIndices(layout.wiring) : []).map((led) => [led.id, led.index]));
  for (const [id, holeIndices] of main) {
    for (const holeIndex of holeIndices) {
      holes[holeIndex].ledIds.push(id);
      const index = indices.get(id);
      if (index !== undefined) holes[holeIndex].indices.push(index);
    }
  }
  for (const [id, holeIndices] of above) {
    for (const holeIndex of holeIndices) {
      holes[holeIndex].aboveLedIds.push(id);
      const index = indices.get(id);
      if (index !== undefined) holes[holeIndex].aboveIndices.push(index);
    }
  }
  const ownership = mountingHoles(layout, holds, frame);
  const holdMappings = new Map(mappedHolds.map((hold) => [hold.holdId, hold]));
  for (const entry of holes) {
    const chosen = ownership.get(entry.holeIndex)?.holdId;
    if (chosen === undefined) continue;
    entry.holdId = chosen;
    const matched = holdMappings.get(chosen)!;
    matched.holeIndices.push(entry.holeIndex);
    matched.ledIds.push(...entry.ledIds);
    matched.indices.push(...entry.indices);
    matched.aboveLedIds.push(...entry.aboveLedIds);
    matched.aboveIndices.push(...entry.aboveIndices);
  }
  // Hand-made links win: a linked hold gets exactly its chosen LEDs, and an LED
  // linked by hand leaves the hold the geometry gave it.
  const links = new Map((layout.holdLeds ?? []).map((link) => [link.holdId, link.ledIds]));
  const known = new Set((layout.ledPositions ?? []).map((led) => led.id));
  const linkedLeds = new Set<string>();
  for (const [holdId, ledIds] of links) {
    if (!holdMappings.has(holdId)) continue;
    for (const id of ledIds) if (known.has(id)) linkedLeds.add(id);
  }
  for (const hold of mappedHolds) {
    const link = links.get(hold.holdId);
    const ledIds = link ? link.filter((id) => known.has(id)) : hold.ledIds.filter((id) => !linkedLeds.has(id));
    hold.ledIds = [...new Set(ledIds)];
    hold.indices = [
      ...new Set(
        hold.ledIds.flatMap((id) => {
          const index = indices.get(id);
          return index === undefined ? [] : [index];
        }),
      ),
    ].sort((left, right) => left - right);
    // Upper references remain independent: one physical LED can sit below one
    // hold and above another. Playback resolves active primary colors first.
    hold.aboveLedIds = [...new Set(hold.aboveLedIds)];
    hold.aboveIndices = hold.aboveLedIds.flatMap((id) => {
      const index = indices.get(id);
      return index === undefined ? [] : [index];
    });
  }
  return { holes, holds: mappedHolds };
}
