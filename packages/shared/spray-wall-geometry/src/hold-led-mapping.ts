import { distanceToRing, isValidOutlineRing, pointInRing } from '@boardsesh/board-art-geometry/ring';
import type { CanonicalSprayHold } from './hold-projection';
import type { ReferenceSize } from './homography';
import { assignLedIndices, generateLedPositions, type LedPosition } from './led-layout';
import type { TnutLayout, TnutPoint } from './tnut-layout';

export type SprayHoleLedMapping = {
  holeIndex: number;
  holdId: number | null;
  ledIds: string[];
  indices: number[];
};
export type SprayHoldLedMapping = {
  holdId: number;
  holeIndices: number[];
  ledIds: string[];
  indices: number[];
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

  if (layout.ledPlacement === 'alternating') {
    // Complementary slots are shared by equally close holes. Resolve using the
    // original slot, so moving its on-screen position cannot change ownership.
    const available = leds.map((led) => ({ led, point: originalPosition(led) }));
    for (const [holeIndex, hole] of layout.holes.entries()) {
      let nearest = Infinity;
      const choices: string[] = [];
      for (const { led, point } of available) {
        // Compare against the complete template first. A deleted LED must leave
        // a missing association rather than move that hole to its neighbor.
        const expected = generatedById.get(led.id);
        const distance = distanceSquared(hole, expected ?? point, frame);
        if (distance < nearest - 1e-8) {
          nearest = distance;
          choices.length = 0;
        }
        if (Math.abs(distance - nearest) <= 1e-8) choices.push(led.id);
      }
      const templateDistance = generated.reduce(
        (minimum, led) => Math.min(minimum, distanceSquared(hole, led, frame)),
        Infinity,
      );
      if (nearest > templateDistance + 1e-8) continue;
      for (const id of choices) bindings.set(id, [...(bindings.get(id) ?? []), holeIndex]);
    }
    return bindings;
  }

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

/** Persist inferred associations before a manual LED is moved on a later visit. */
export function bindLedPositionsToHoles(layout: TnutLayout, frame: ReferenceSize): LedPosition[] {
  const leds = layout.ledPositions ?? [];
  const bindings = holeBindings(layout, frame);
  return leds.map((led) => {
    const indices = bindings.get(led.id);
    if (layout.ledPlacement === 'alternating') {
      if (led.origin || !indices?.length) return led;
      const origin = originalPosition(led);
      return { ...led, origin: { x: origin.x, y: origin.y } };
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
  }));
  const holes: SprayHoleLedMapping[] = layout.holes.map((_, holeIndex) => ({
    holeIndex,
    holdId: null,
    ledIds: [],
    indices: [],
  }));
  if (!validFrame(frame)) return { holes, holds: mappedHolds };
  const bindings = holeBindings(layout, frame);
  const indices = new Map((layout.wiring ? assignLedIndices(layout.wiring) : []).map((led) => [led.id, led.index]));
  for (const [id, holeIndices] of bindings) {
    for (const holeIndex of holeIndices) {
      holes[holeIndex].ledIds.push(id);
      const index = indices.get(id);
      if (index !== undefined) holes[holeIndex].indices.push(index);
    }
  }
  const candidates = holdCandidates(holds);
  const holdMappings = new Map(mappedHolds.map((hold) => [hold.holdId, hold]));
  for (const entry of holes) {
    const chosen = findHold(candidates, layout.holes[entry.holeIndex], frame);
    if (chosen === null) continue;
    entry.holdId = chosen;
    const matched = holdMappings.get(chosen)!;
    matched.holeIndices.push(entry.holeIndex);
    matched.ledIds.push(...entry.ledIds);
    matched.indices.push(...entry.indices);
  }
  for (const hold of mappedHolds) {
    hold.ledIds = [...new Set(hold.ledIds)];
    hold.indices = [...new Set(hold.indices)].sort((left, right) => left - right);
  }
  return { holes, holds: mappedHolds };
}
