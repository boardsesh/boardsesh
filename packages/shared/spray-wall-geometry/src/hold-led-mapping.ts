import { distanceToRing, isValidOutlineRing, pointInRing } from '@boardsesh/board-art-geometry/ring';
import type { CanonicalSprayHold } from './hold-projection';
import { homographyFromAnchors, mapPoint, type ReferenceSize } from './homography';
import { assignLedIndices, generateLedPositions, type LedPosition } from './led-layout';
import { generateTnutGrid, isValidTnutCorners, type TnutLayout, type TnutPoint } from './tnut-layout';
import { readTnutLedLinks } from './tnut-led-links';
import type { SprayLedLinkLayer } from './tnut-led-links';
import { clearHoldLedLink, setHoldLedLink } from './hold-led-links';
import { stripeProgress } from './led-stripes';

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

function holdPointDistance(
  { hold, outline }: ReturnType<typeof holdCandidates>[number],
  point: TnutPoint,
  frame: ReferenceSize,
): number | null {
  const relativeX = (point.x * frame.width - hold.cx) / hold.r;
  const relativeY = (point.y * frame.height - hold.cy) / hold.r;
  const distance = relativeX ** 2 + relativeY ** 2;
  if (outline) {
    if (Math.abs(relativeX) > 4 || Math.abs(relativeY) > 4) return null;
    if (!pointInRing(outline, relativeX, relativeY) && distanceToRing(outline, relativeX, relativeY) > 1e-8)
      return null;
  } else if (distance > 1 + 1e-8) return null;
  return distance;
}

function findHold(
  candidates: ReturnType<typeof holdCandidates>,
  point: TnutPoint,
  frame: ReferenceSize,
): number | null {
  let chosen: number | null = null;
  let nearest = Infinity;
  for (const candidate of candidates) {
    const { hold } = candidate;
    const distance = holdPointDistance(candidate, point, frame);
    if (distance === null) continue;
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
    const selected = new Map<string, { holeIndex: number; key: string; distance: number; ambiguous: boolean }>();
    for (const { holeIndex, key, point } of holes) {
      let chosen: string | null = null;
      let nearest = Infinity;
      let tied = false;
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
        if (distance < nearest - 1e-8) {
          chosen = led.id;
          nearest = distance;
          tied = false;
        } else if (Math.abs(distance - nearest) <= 1e-8 && led.id !== chosen) tied = true;
      }
      if (chosen === null || tied) continue;
      const previous = selected.get(chosen);
      // Nearby edited nuts may nominate the same slot. Resolve by proximity,
      // then coordinates, so reordering the hole list cannot move ownership.
      if (!previous || nearest < previous.distance - 1e-8)
        selected.set(chosen, { holeIndex, key, distance: nearest, ambiguous: false });
      else if (Math.abs(nearest - previous.distance) <= 1e-8) previous.ambiguous = true;
    }
    return new Map([...selected].flatMap(([id, { holeIndex, ambiguous }]) => (ambiguous ? [] : [[id, [holeIndex]]])));
  };
  return { main: select(1), above: select(-1) };
}

function allBindings(layout: TnutLayout, frame: ReferenceSize) {
  if (!validFrame(frame)) return { main: new Map<string, number[]>(), above: new Map<string, number[]>() };
  if (layout.ledPlacement === 'stripe')
    return { main: stripeBindings(layout, frame), above: new Map<string, number[]>() };
  return layout.ledPlacement === 'below' || layout.ledPlacement === 'alternating'
    ? verticalBindings(layout)
    : { main: holeBindings(layout, frame), above: new Map<string, number[]>() };
}

/** Every covered nut belongs to its closest containing hold; equal fits stay unassigned. */
function mountingHoles(layout: TnutLayout, holds: readonly CanonicalSprayHold[], frame: ReferenceSize) {
  const ownership = new Map<number, { holdId: number; distance: number; ambiguous: boolean }>();
  const candidates = holdCandidates(holds);
  for (const [holeIndex, hole] of layout.holes.entries()) {
    let chosen: number | null = null;
    let nearest = Infinity;
    let ambiguous = false;
    for (const candidate of candidates) {
      const relative = holdPointDistance(candidate, hole, frame);
      if (relative === null) continue;
      const distance = relative * candidate.hold.r ** 2;
      if (distance < nearest - 1e-8) {
        chosen = candidate.hold.id;
        nearest = distance;
        ambiguous = false;
      } else if (Math.abs(distance - nearest) <= 1e-8) ambiguous = true;
    }
    if (chosen !== null && !ambiguous)
      ownership.set(holeIndex, { holdId: chosen, distance: nearest, ambiguous: false });
  }
  return ownership;
}

function stripeBindings(layout: TnutLayout, frame: ReferenceSize): Map<string, number[]> {
  const stripes = layout.ledStripes?.stripes ?? [];
  const bindings = new Map<string, number[]>();
  const byId = new Map((layout.ledPositions ?? []).map((led) => [led.id, led]));
  const chosenStripe = new Int32Array(layout.holes.length).fill(-1);
  const nearest = new Float64Array(layout.holes.length).fill(Infinity);
  const ambiguous = new Uint8Array(layout.holes.length);
  const metrics = stripes.map((stripe) => {
    const deltaX = (stripe.end.x - stripe.start.x) * frame.width;
    const deltaY = (stripe.end.y - stripe.start.y) * frame.height;
    const length = Math.hypot(deltaX, deltaY);
    const count =
      layout.ledStripes?.orientation === 'horizontal'
        ? layout.rows
        : layout.pattern === 'offset' && layout.columnConvention !== 'all'
          ? 2 * layout.columns - 1
          : layout.columns;
    const { topLeft, topRight, bottomLeft, bottomRight } = layout.corners;
    const spans =
      layout.ledStripes?.orientation === 'horizontal'
        ? [
            { x: bottomLeft.x - topLeft.x, y: bottomLeft.y - topLeft.y },
            ...(layout.columns === 1 ? [] : [{ x: bottomRight.x - topRight.x, y: bottomRight.y - topRight.y }]),
          ]
        : [
            { x: topRight.x - topLeft.x, y: topRight.y - topLeft.y },
            ...(layout.rows === 1 ? [] : [{ x: bottomRight.x - bottomLeft.x, y: bottomRight.y - bottomLeft.y }]),
          ];
    const extents = spans
      .map((span) => Math.abs(span.x * frame.width * deltaY - span.y * frame.height * deltaX) / length)
      .filter((extent) => extent > 1e-6);
    const extent = extents.length ? Math.min(...extents) : Math.min(frame.width, frame.height) * 0.2;
    return {
      deltaX,
      deltaY,
      length,
      limit: count > 1 ? (extent / (count - 1)) * 0.5 : Math.min(frame.width, frame.height) * 0.1,
    };
  });
  stripes.forEach((stripe, stripeIndex) => {
    const metric = metrics[stripeIndex];
    layout.holes.forEach((hole, holeIndex) => {
      const progress = stripeProgress(stripe, hole, frame);
      if (progress < -1e-8 || progress > 1 + 1e-8) return;
      const distance = Math.abs(
        ((hole.x - stripe.start.x) * frame.width * metric.deltaY -
          (hole.y - stripe.start.y) * frame.height * metric.deltaX) /
          metric.length,
      );
      if (distance > metric.limit + 1e-6) return;
      if (distance < nearest[holeIndex] - 1e-6) {
        nearest[holeIndex] = distance;
        chosenStripe[holeIndex] = stripeIndex;
        ambiguous[holeIndex] = 0;
      } else if (Math.abs(distance - nearest[holeIndex]) <= 1e-6) ambiguous[holeIndex] = 1;
    });
  });
  stripes.forEach((stripe, stripeIndex) => {
    const sorted = layout.holes
      .flatMap((hole, holeIndex) =>
        chosenStripe[holeIndex] === stripeIndex && !ambiguous[holeIndex]
          ? [{ holeIndex, progress: stripeProgress(stripe, hole, frame), distance: nearest[holeIndex] }]
          : [],
      )
      .sort((first, second) => first.progress - second.progress || first.distance - second.distance);
    const anchors: { progress: number; holeIndex: number | null; distance: number }[] = [];
    for (const entry of sorted) {
      const previous = anchors.at(-1);
      const distance = entry.distance;
      if (previous && Math.abs(previous.progress - entry.progress) <= 1e-8) {
        if (distance < previous.distance - 1e-6) {
          previous.holeIndex = entry.holeIndex;
          previous.distance = distance;
        } else if (Math.abs(previous.distance - distance) <= 1e-6) previous.holeIndex = null;
      } else anchors.push({ progress: entry.progress, holeIndex: entry.holeIndex, distance });
    }
    for (const id of stripe.ledIds) {
      const led = byId.get(id);
      if (!led) continue;
      const progress = stripeProgress(stripe, led, frame);
      if (progress < -1e-8 || progress > 1 + 1e-8) continue;
      let first = 0,
        last = anchors.length - 1,
        tied = false;
      while (first < last) {
        const middle = (first + last) >>> 1;
        const boundary = (anchors[middle].progress + anchors[middle + 1].progress) / 2;
        if (Math.abs(progress - boundary) <= 1e-8) {
          tied = true;
          break;
        }
        if (progress < boundary) last = middle;
        else first = middle + 1;
      }
      const anchor = anchors[first];
      if (!tied && anchor && anchor.holeIndex !== null) bindings.set(id, [anchor.holeIndex]);
    }
  });
  return bindings;
}

function assignLedsToNuts(
  layout: TnutLayout,
  frame: ReferenceSize,
  holeIndices: readonly number[],
  ledIds: readonly string[],
  layer: SprayLedLinkLayer,
  automatic: readonly SprayHoleLedMapping[] = [],
  ambiguousIds?: Set<string>,
): Map<number, string[]> {
  const assigned = new Map(holeIndices.map((index) => [index, [] as string[]]));
  const positions = new Map((layout.ledPositions ?? []).map((led) => [led.id, led]));
  const field = layer === 'above' ? 'aboveLedIds' : 'ledIds';
  const manual = new Map((layout.tnutLeds ?? []).map((entry) => [keyFor(entry.hole), entry[field]]));
  const grid = layout.ledPlacement === 'below' || layout.ledPlacement === 'alternating' ? verticalGrid(layout) : null;
  const existingOwners = new Map<string, number[]>(),
    inferredOwners = new Map<string, number[]>();
  const targets = new Map(
    holeIndices.map((index) => [
      index,
      {
        key: keyFor(layout.holes[index]),
        point: grid ? grid.toGrid(layout.holes[index]) : layout.holes[index],
      },
    ]),
  );
  for (const index of holeIndices)
    for (const [ids, owners] of [
      [manual.get(keyFor(layout.holes[index])) ?? [], existingOwners],
      [automatic[index]?.[field] ?? [], inferredOwners],
    ] as const)
      for (const id of ids) {
        const existing = owners.get(id);
        if (existing) existing.push(index);
        else owners.set(id, [index]);
      }
  for (const id of new Set(ledIds)) {
    const led = positions.get(id);
    if (!led) continue;
    const candidates = existingOwners.get(id) ?? inferredOwners.get(id) ?? holeIndices;
    let chosen: number | null = null,
      nearest = Infinity,
      tied = false;
    const slot = layout.ledPlacement === 'stripe' ? led : originalPosition(led);
    const projectedSlot = grid?.toGrid(slot);
    for (const index of candidates) {
      const target = targets.get(index)!;
      let distance: number;
      if (grid) {
        const gap = layer === 'above' ? -grid.upperGap : grid.lowerGap;
        distance =
          ((projectedSlot!.x - target.point.x) / grid.columnStep) ** 2 +
          ((projectedSlot!.y - target.point.y - gap) / Math.abs(gap)) ** 2;
      } else distance = distanceSquared(slot, target.point, frame);
      if (distance < nearest - 1e-8) {
        chosen = index;
        nearest = distance;
        tied = false;
      } else if (Math.abs(distance - nearest) <= 1e-8) {
        tied = true;
        if (chosen !== null && target.key < targets.get(chosen)!.key) chosen = index;
      }
    }
    if (tied && ambiguousIds) {
      ambiguousIds.add(id);
      continue;
    }
    if (chosen !== null) assigned.get(chosen)!.push(id);
  }
  return assigned;
}

function writeNutRoles(
  layout: TnutLayout,
  assignments: ReadonlyMap<number, readonly string[] | undefined>,
  layer: SprayLedLinkLayer,
): TnutLayout {
  const field = layer === 'above' ? 'aboveLedIds' : 'ledIds';
  const entries = new Map(
    (readTnutLedLinks(layout.tnutLeds ?? [], layout.holes, layout.ledPositions ?? []) ?? []).map((entry) => [
      keyFor(entry.hole),
      entry,
    ]),
  );
  for (const [index, ids] of assignments) {
    const hole = layout.holes[index];
    if (!hole) continue;
    const key = keyFor(hole),
      existing = entries.get(key);
    if (ids === undefined) {
      if (!existing) continue;
      const remaining = layer === 'above' ? existing.ledIds : existing.aboveLedIds;
      if (remaining === undefined) entries.delete(key);
      else
        entries.set(key, {
          hole: existing.hole,
          ...(layer === 'above' ? { ledIds: remaining } : { aboveLedIds: remaining }),
        });
    } else entries.set(key, { ...existing, hole: { ...hole }, [field]: [...new Set(ids)] });
  }
  return { ...layout, tnutLeds: [...entries.values()] };
}

/** Persist inferred associations before a manual LED is moved on a later visit. */
export function bindLedPositionsToHoles(layout: TnutLayout, frame: ReferenceSize): LedPosition[] {
  const leds = layout.ledPositions ?? [];
  if (layout.ledPlacement === 'stripe') return leds;
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
  const nutLinks = new Map(
    (readTnutLedLinks(layout.tnutLeds ?? [], layout.holes, layout.ledPositions ?? []) ?? []).map((link) => [
      keyFor(link.hole),
      link,
    ]),
  );
  const roles = [
    { ids: 'ledIds', indices: 'indices', legacy: layout.holdLeds ?? [] },
    { ids: 'aboveLedIds', indices: 'aboveIndices', legacy: layout.holdAboveLeds ?? [] },
  ] as const;
  const physicalIndices = (ledIds: readonly string[]) =>
    [
      ...new Set(
        ledIds.flatMap((id) => {
          const index = indices.get(id);
          return index === undefined ? [] : [index];
        }),
      ),
    ].sort((first, second) => first - second);
  const ownership = mountingHoles(layout, holds, frame);
  const holdMappings = new Map(mappedHolds.map((hold) => [hold.holdId, hold]));
  for (const entry of holes) {
    const chosen = ownership.get(entry.holeIndex)?.holdId;
    if (chosen === undefined) continue;
    entry.holdId = chosen;
    const matched = holdMappings.get(chosen)!;
    matched.holeIndices.push(entry.holeIndex);
  }
  const known = new Set((layout.ledPositions ?? []).map((led) => led.id));
  const grid = layout.ledPlacement === 'below' || layout.ledPlacement === 'alternating' ? verticalGrid(layout) : null;
  const projectedHoles = grid ? layout.holes.map(grid.toGrid) : [];
  for (const role of roles) {
    if (layout.ledPlacement === 'stripe' && role.ids === 'aboveLedIds') continue;
    const nutClaims = new Set([...nutLinks.values()].flatMap((link) => link[role.ids] ?? []));
    const legacyNuts = new Map<number, string[]>();
    const legacyHolds = new Map<number, string[]>();
    for (const link of role.legacy) {
      const hold = holdMappings.get(link.holdId);
      if (!hold) continue;
      const ids = link.ledIds.filter((id) => known.has(id));
      if (!hold.holeIndices.length) {
        legacyHolds.set(
          link.holdId,
          ids.filter((id) => !nutClaims.has(id)),
        );
        continue;
      }
      const assignments = assignLedsToNuts(
        layout,
        frame,
        hold.holeIndices,
        ids,
        role.ids === 'aboveLedIds' ? 'above' : 'primary',
        holes,
      );
      for (const [index, assigned] of assignments) {
        if (nutLinks.get(keyFor(layout.holes[index]))?.[role.ids] === undefined)
          legacyNuts.set(
            index,
            assigned.filter((id) => !nutClaims.has(id)),
          );
      }
    }
    const legacyClaims = new Set([...legacyNuts.values(), ...legacyHolds.values()].flat());
    for (const entry of holes) {
      const override = nutLinks.get(keyFor(layout.holes[entry.holeIndex]))?.[role.ids];
      entry[role.ids] =
        override ??
        legacyNuts.get(entry.holeIndex) ??
        entry[role.ids].filter((id) => !nutClaims.has(id) && !legacyClaims.has(id));
      entry[role.indices] = physicalIndices(entry[role.ids]);
    }
    for (const hold of mappedHolds) {
      const ledIds =
        legacyHolds.get(hold.holdId) ??
        hold.holeIndices.flatMap((index) => {
          const manual = nutLinks.get(keyFor(layout.holes[index]))?.[role.ids] !== undefined || legacyNuts.has(index);
          if (!manual && grid) {
            const current = projectedHoles[index],
              direction = role.ids === 'aboveLedIds' ? -1 : 1;
            if (
              hold.holeIndices.some(
                (other) =>
                  other !== index &&
                  Math.abs(projectedHoles[other].x - current.x) <= grid.columnStep * 0.2 &&
                  (projectedHoles[other].y - current.y) * direction > 1e-8,
              )
            )
              return [];
          }
          return holes[index][role.ids];
        });
      hold[role.ids] = [...new Set(ledIds)];
      hold[role.indices] = physicalIndices(hold[role.ids]);
    }
  }
  return { holes, holds: mappedHolds };
}

/** Preserve sibling choices before an explicit individual nut edit replaces legacy hold provenance. */
export function prepareSprayNutLedEdit(
  layout: TnutLayout,
  frame: ReferenceSize,
  holds: readonly CanonicalSprayHold[],
  holeIndex: number,
  layer: SprayLedLinkLayer = 'primary',
): TnutLayout {
  const mapping = buildSprayLedMapping(layout, frame, holds);
  const holdId = mapping.holes[holeIndex]?.holdId;
  const legacy = layer === 'above' ? layout.holdAboveLeds : layout.holdLeds;
  const link = legacy?.find((entry) => entry.holdId === holdId);
  const mounted = mapping.holds.find((entry) => entry.holdId === holdId);
  if (!link || !mounted) return layout;
  const field = layer === 'above' ? 'aboveLedIds' : 'ledIds';
  const manual = new Map((layout.tnutLeds ?? []).map((entry) => [keyFor(entry.hole), entry[field]]));
  const missing = new Map(
    mounted.holeIndices
      .filter((index) => manual.get(keyFor(layout.holes[index])) === undefined)
      .map((index) => [index, mapping.holes[index][field]]),
  );
  return clearHoldLedLink(writeNutRoles(layout, missing, layer), mounted.holdId, layer);
}

export function setSprayHoldLedSelection(
  layout: TnutLayout,
  frame: ReferenceSize,
  holds: readonly CanonicalSprayHold[],
  holdId: number,
  ledIds: readonly string[],
  layer: SprayLedLinkLayer = 'primary',
): TnutLayout {
  const mapping = buildSprayLedMapping(layout, frame, holds);
  const mounted = mapping.holds.find((entry) => entry.holdId === holdId);
  if (!mounted?.holeIndices.length) return setHoldLedLink(layout, holdId, ledIds, layer);
  return clearHoldLedLink(
    writeNutRoles(layout, assignLedsToNuts(layout, frame, mounted.holeIndices, ledIds, layer, mapping.holes), layer),
    holdId,
    layer,
  );
}

export function clearSprayHoldLedSelection(
  layout: TnutLayout,
  frame: ReferenceSize,
  holds: readonly CanonicalSprayHold[],
  holdId: number,
  layer: SprayLedLinkLayer = 'primary',
): TnutLayout {
  const mounted = buildSprayLedMapping(layout, frame, holds).holds.find((entry) => entry.holdId === holdId);
  const cleared = mounted?.holeIndices.length
    ? writeNutRoles(layout, new Map(mounted.holeIndices.map((index) => [index, undefined])), layer)
    : layout;
  return clearHoldLedLink(cleared, holdId, layer);
}

/** Promote existing manual choices only when the climber confirms the mapping step. */
export function migrateHoldLedLinksToTnuts(
  layout: TnutLayout,
  frame: ReferenceSize,
  holds: readonly CanonicalSprayHold[],
): TnutLayout {
  if (!validFrame(frame) || (!layout.holdLeds?.length && !layout.holdAboveLeds?.length)) return layout;
  const mounted = new Map<number, number[]>();
  for (const [holeIndex, entry] of mountingHoles(layout, holds, frame)) {
    const existing = mounted.get(entry.holdId);
    if (existing) existing.push(holeIndex);
    else mounted.set(entry.holdId, [holeIndex]);
  }
  const candidates = holdCandidates(holds);
  const overlap = new Map<number, boolean>();
  const known = new Set((layout.ledPositions ?? []).map((led) => led.id));
  const automatic = buildSprayLedMapping({ ...layout, holdLeds: undefined, holdAboveLeds: undefined }, frame, []).holes;
  const nuts = new Map(
    (readTnutLedLinks(layout.tnutLeds ?? [], layout.holes, layout.ledPositions ?? []) ?? []).map((link) => [
      keyFor(link.hole),
      link,
    ]),
  );
  let changed = false;
  let holdLeds = layout.holdLeds;
  let holdAboveLeds = layout.holdAboveLeds;
  for (const role of [
    { field: 'ledIds', links: layout.holdLeds ?? [] },
    { field: 'aboveLedIds', links: layout.holdAboveLeds ?? [] },
  ] as const) {
    const claims = new Map<string, Set<number>>();
    for (const link of role.links)
      for (const id of link.ledIds) {
        const owners = claims.get(id);
        if (owners) owners.add(link.holdId);
        else claims.set(id, new Set([link.holdId]));
      }
    const nutClaims = new Map<string, Set<string>>();
    for (const [key, nut] of nuts)
      for (const id of nut[role.field] ?? []) {
        const owners = nutClaims.get(id);
        if (owners) owners.add(key);
        else nutClaims.set(id, new Set([key]));
      }
    const migrated = new Set<number>();
    for (const link of role.links) {
      const mounting = mounted.get(link.holdId);
      if (!mounting?.length) continue;
      // A silhouette overlap or shared legacy claim is uncertain provenance.
      // Keep it version-specific rather than changing another hold's behavior.
      if (
        mounting.some((holeIndex) => {
          let uncertain = overlap.get(holeIndex);
          if (uncertain === undefined) {
            uncertain = candidates.some(
              (candidate) =>
                candidate.hold.id !== link.holdId &&
                holdPointDistance(candidate, layout.holes[holeIndex], frame) !== null,
            );
            overlap.set(holeIndex, uncertain);
          }
          return uncertain;
        })
      )
        continue;
      const ledIds = link.ledIds.filter((id) => known.has(id));
      if (ledIds.some((id) => (claims.get(id)?.size ?? 0) > 1)) continue;
      const covered = new Set(mounting.map((index) => keyFor(layout.holes[index])));
      if (ledIds.some((id) => [...(nutClaims.get(id) ?? [])].some((key) => !covered.has(key)))) continue;
      const ambiguous = new Set<string>();
      const assignments = assignLedsToNuts(
        { ...layout, tnutLeds: [...nuts.values()] },
        frame,
        mounting,
        ledIds,
        role.field === 'aboveLedIds' ? 'above' : 'primary',
        automatic,
        ambiguous,
      );
      if (ambiguous.size) continue;
      if (
        [...assignments].some(([index, ids]) => {
          const previous = nuts.get(keyFor(layout.holes[index]))?.[role.field];
          if (previous === undefined) return false;
          const selected = new Set(ids);
          return previous.length !== selected.size || previous.some((id) => !selected.has(id));
        })
      )
        continue;
      for (const [index, ids] of assignments) {
        const hole = layout.holes[index],
          key = keyFor(hole),
          previous = nuts.get(key);
        if (previous?.[role.field] !== undefined) continue;
        nuts.set(key, { ...previous, hole: { ...hole }, [role.field]: ids });
        for (const id of ids) nutClaims.set(id, new Set([key]));
      }
      migrated.add(link.holdId);
      changed = true;
    }
    if (migrated.size) {
      const remaining = role.links.filter((link) => !migrated.has(link.holdId));
      if (role.field === 'ledIds') holdLeds = remaining;
      else holdAboveLeds = remaining;
    }
  }
  // Promoted choices now belong to the nut. Leaving a hold-ID mirror would
  // incorrectly override another nut if that same hold ID moves in a later scan.
  return changed
    ? {
        ...layout,
        tnutLeds: [...nuts.values()],
        ...(holdLeds !== undefined ? { holdLeds } : {}),
        ...(holdAboveLeds !== undefined ? { holdAboveLeds } : {}),
      }
    : layout;
}
