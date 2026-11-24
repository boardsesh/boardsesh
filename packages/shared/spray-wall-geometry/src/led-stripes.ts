import { homographyFromAnchors, invert, mapPoint, type ReferenceSize } from './homography';
import { MAX_LED_POSITIONS } from './led-limits';
import type { LedPosition, TnutWiring } from './led-layout';
import { readLedPairs } from './led-pairs';
import { pruneTnutLedLinks } from './tnut-led-links';
import { isValidTnutCorners, type TnutLayout, type TnutPoint } from './tnut-layout';

export type SprayLedStripe = { id: string; start: TnutPoint; end: TnutPoint; ledIds: string[] };
export type SprayLedStripes = {
  orientation: 'horizontal' | 'vertical';
  nextStripeId: number;
  nextLedId: number;
  stripes: SprayLedStripe[];
};
export const DEFAULT_STRIPE_LED_COUNT = 20;
export const MAX_LED_STRIPES = 100;
const record = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
const point = (candidate: unknown): candidate is TnutPoint =>
  record(candidate) &&
  typeof candidate.x === 'number' &&
  typeof candidate.y === 'number' &&
  Number.isFinite(candidate.x) &&
  Number.isFinite(candidate.y) &&
  candidate.x >= 0 &&
  candidate.x <= 1 &&
  candidate.y >= 0 &&
  candidate.y <= 1;
const counter = (candidate: unknown): candidate is number =>
  typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0;
const countValid = (count: number) => Number.isInteger(count) && count >= 1 && count <= MAX_LED_POSITIONS;
const segmentValid = (start: TnutPoint, end: TnutPoint) =>
  point(start) && point(end) && Math.hypot(end.x - start.x, end.y - start.y) > 1e-6;
const interpolate = (stripe: SprayLedStripe, fraction: number): TnutPoint => ({
  x: stripe.start.x + (stripe.end.x - stripe.start.x) * fraction,
  y: stripe.start.y + (stripe.end.y - stripe.start.y) * fraction,
});

export function readLedStripes(candidate: unknown, leds: readonly LedPosition[]): SprayLedStripes | null {
  if (
    !record(candidate) ||
    (candidate.orientation !== 'horizontal' && candidate.orientation !== 'vertical') ||
    !counter(candidate.nextStripeId) ||
    !counter(candidate.nextLedId) ||
    !Array.isArray(candidate.stripes) ||
    candidate.stripes.length > MAX_LED_STRIPES
  )
    return null;
  const known = new Set(leds.map((led) => led.id));
  const stripeIds = new Set<string>();
  const members = new Set<string>();
  const stripes: SprayLedStripe[] = [];
  for (const stripe of candidate.stripes) {
    if (
      !record(stripe) ||
      typeof stripe.id !== 'string' ||
      !point(stripe.start) ||
      !point(stripe.end) ||
      !segmentValid(stripe.start, stripe.end) ||
      !Array.isArray(stripe.ledIds) ||
      !stripe.ledIds.length ||
      stripe.ledIds.length > MAX_LED_POSITIONS ||
      stripeIds.has(stripe.id)
    )
      return null;
    const stripeMatch = /^stripe-(0|[1-9]\d*)$/.exec(stripe.id);
    if (!stripeMatch || !counter(Number(stripeMatch[1])) || Number(stripeMatch[1]) >= candidate.nextStripeId)
      return null;
    const ledIds: string[] = [];
    for (const id of stripe.ledIds) {
      if (typeof id !== 'string' || !known.has(id) || members.has(id)) return null;
      const ledMatch = /^stripe-led-(0|[1-9]\d*)$/.exec(id);
      if (!ledMatch || !counter(Number(ledMatch[1])) || Number(ledMatch[1]) >= candidate.nextLedId) return null;
      members.add(id);
      ledIds.push(id);
    }
    stripeIds.add(stripe.id);
    stripes.push({ id: stripe.id, start: { ...stripe.start }, end: { ...stripe.end }, ledIds });
  }
  if (members.size !== known.size || members.size > MAX_LED_POSITIONS) return null;
  return {
    orientation: candidate.orientation,
    nextStripeId: candidate.nextStripeId,
    nextLedId: candidate.nextLedId,
    stripes,
  };
}

export function stripeCableUnits(
  layout: Pick<TnutLayout, 'ledPlacement' | 'ledStripes'>,
): readonly (readonly string[])[] {
  return layout.ledPlacement === 'stripe' ? (layout.ledStripes?.stripes.map((stripe) => stripe.ledIds) ?? []) : [];
}

/** An entire stripe is either unwired, or consecutive in one complete direction. */
export function isValidStripeWiring(stripes: SprayLedStripes, wiring: TnutWiring | undefined): boolean {
  if (!wiring) return true;
  const locations = new Map<string, { path: number; index: number }>();
  wiring.paths.forEach((path, pathIndex) => path.forEach((id, index) => locations.set(id, { path: pathIndex, index })));
  const gaps = new Set(wiring.skips.map((skip) => JSON.stringify([skip.from, skip.to].sort())));
  for (const stripe of stripes.stripes) {
    const wired = stripe.ledIds.map((id) => locations.get(id));
    if (wired.every((entry) => entry === undefined)) continue;
    if (wired.some((entry) => entry === undefined)) return false;
    const first = wired[0]!;
    const direction = wired.length > 1 ? wired[1]!.index - first.index : 1;
    if (Math.abs(direction) !== 1) return false;
    for (const [index, entry] of wired.entries()) {
      if (entry!.path !== first.path || entry!.index !== first.index + index * direction) return false;
      if (index && gaps.has(JSON.stringify([stripe.ledIds[index - 1], stripe.ledIds[index]].sort()))) return false;
    }
  }
  return true;
}

function finish(layout: TnutLayout, model: SprayLedStripes, leds: LedPosition[], topology: boolean): TnutLayout {
  return pruneTnutLedLinks({
    ...layout,
    ledPlacement: 'stripe',
    ledStripes: model,
    ledPositions: leds,
    ...(topology ? { wiring: undefined } : {}),
    ...(layout.ledGroups !== undefined ? { ledGroups: readLedPairs(layout.ledGroups, leds) ?? [] } : {}),
  });
}

function stripePoints(stripe: SprayLedStripe): LedPosition[] {
  return stripe.ledIds.map((id, index) => ({
    id,
    ...interpolate(stripe, stripe.ledIds.length === 1 ? 0.5 : index / (stripe.ledIds.length - 1)),
  }));
}

function allocateIds(model: SprayLedStripes, count: number): { ids: string[]; nextLedId: number } | null {
  if (!countValid(count) || model.nextLedId + count > Number.MAX_SAFE_INTEGER) return null;
  return {
    ids: Array.from({ length: count }, (_, index) => `stripe-led-${model.nextLedId + index}`),
    nextLedId: model.nextLedId + count,
  };
}

/** Intersect an infinite calibrated grid line with the rectified wall boundary. */
function wallSegment(first: TnutPoint, second: TnutPoint): { start: TnutPoint; end: TnutPoint } | null {
  const deltaX = second.x - first.x;
  const deltaY = second.y - first.y;
  const hits: { fraction: number; point: TnutPoint }[] = [];
  for (const boundary of [0, 1]) {
    if (Math.abs(deltaX) > 1e-10) {
      const fraction = (boundary - first.x) / deltaX;
      const y = first.y + deltaY * fraction;
      if (y >= -1e-8 && y <= 1 + 1e-8) hits.push({ fraction, point: { x: boundary, y: Math.max(0, Math.min(1, y)) } });
    }
    if (Math.abs(deltaY) > 1e-10) {
      const fraction = (boundary - first.y) / deltaY;
      const x = first.x + deltaX * fraction;
      if (x >= -1e-8 && x <= 1 + 1e-8) hits.push({ fraction, point: { x: Math.max(0, Math.min(1, x)), y: boundary } });
    }
  }
  hits.sort((firstHit, secondHit) => firstHit.fraction - secondHit.fraction);
  return hits.length >= 2 && segmentValid(hits[0].point, hits.at(-1)!.point)
    ? { start: hits[0].point, end: hits.at(-1)!.point }
    : null;
}

export function createLedStripes(
  layout: TnutLayout,
  orientation: SprayLedStripes['orientation'],
  ledsPerStripe = DEFAULT_STRIPE_LED_COUNT,
): TnutLayout | 'capacity' {
  const total =
    orientation === 'vertical'
      ? layout.pattern === 'offset' && layout.columnConvention !== 'all'
        ? 2 * layout.columns - 1
        : layout.columns
      : layout.rows;
  if (!countValid(ledsPerStripe) || total * ledsPerStripe > MAX_LED_POSITIONS) return 'capacity';
  const { topLeft, topRight, bottomRight, bottomLeft } = layout.corners;
  const toWall = isValidTnutCorners(layout.corners)
    ? invert(
        homographyFromAnchors(
          [topLeft, topRight, bottomRight, bottomLeft].map(({ x, y }) => [x, y]),
          { width: 1, height: 1 },
        ),
      )
    : null;
  const project = (column: number, row: number): TnutPoint => {
    if (!toWall) return { x: column, y: row };
    const [x, y] = mapPoint(toWall, column, row);
    return { x, y };
  };
  let result = finish(
    // A full rebuild replaces every physical LED. Empty per-hold/nut overrides
    // would suppress automatic mapping rather than clear the old assignments.
    { ...layout, holdLeds: [], holdAboveLeds: [], tnutLeds: [] },
    {
      orientation,
      nextStripeId: layout.ledStripes?.nextStripeId ?? 0,
      nextLedId: layout.ledStripes?.nextLedId ?? 0,
      stripes: [],
    },
    [],
    true,
  );
  for (let index = 0; index < total; index++) {
    const fraction = total === 1 ? 0 : index / (total - 1);
    let first: TnutPoint, second: TnutPoint;
    if (layout.rows === 1 && layout.columns === 1) {
      first = topLeft;
      second = orientation === 'vertical' ? { x: first.x, y: first.y + 1 } : { x: first.x + 1, y: first.y };
    } else if (layout.rows === 1) {
      const deltaX = topRight.x - topLeft.x,
        deltaY = topRight.y - topLeft.y;
      first = { x: topLeft.x + deltaX * fraction, y: topLeft.y + deltaY * fraction };
      second =
        orientation === 'horizontal'
          ? { x: topLeft.x + (deltaX || (deltaY ? 0 : 1)), y: topLeft.y + deltaY }
          : { x: first.x - deltaY, y: first.y + (deltaX || (deltaY ? 0 : 1)) };
      if (orientation === 'horizontal') first = topLeft;
    } else if (layout.columns === 1) {
      const deltaX = bottomLeft.x - topLeft.x,
        deltaY = bottomLeft.y - topLeft.y;
      first = { x: topLeft.x + deltaX * fraction, y: topLeft.y + deltaY * fraction };
      second = orientation === 'vertical' ? bottomLeft : { x: first.x + deltaY, y: first.y - deltaX };
      if (orientation === 'vertical') first = topLeft;
    } else {
      first = orientation === 'vertical' ? project(fraction, 0) : project(0, fraction);
      second = orientation === 'vertical' ? project(fraction, 1) : project(1, fraction);
    }
    const segment = wallSegment(first, second);
    if (!segment) return 'capacity';
    const next = addLedStripe(result, segment.start, segment.end, ledsPerStripe);
    if (next === 'capacity') return next;
    result = next;
  }
  return result;
}

export function addLedStripe(
  layout: TnutLayout,
  start: TnutPoint,
  end: TnutPoint,
  count = DEFAULT_STRIPE_LED_COUNT,
): TnutLayout | 'capacity' {
  const model = layout.ledStripes;
  if (!model || !segmentValid(start, end)) return layout;
  if (
    !countValid(count) ||
    model.stripes.length >= MAX_LED_STRIPES ||
    (layout.ledPositions?.length ?? 0) + count > MAX_LED_POSITIONS ||
    model.nextStripeId >= Number.MAX_SAFE_INTEGER
  )
    return 'capacity';
  const allocated = allocateIds(model, count);
  if (!allocated) return 'capacity';
  const stripe: SprayLedStripe = {
    id: `stripe-${model.nextStripeId}`,
    start: { ...start },
    end: { ...end },
    ledIds: allocated.ids,
  };
  return finish(
    layout,
    {
      ...model,
      nextStripeId: model.nextStripeId + 1,
      nextLedId: allocated.nextLedId,
      stripes: [...model.stripes, stripe],
    },
    [...(layout.ledPositions ?? []), ...stripePoints(stripe)],
    true,
  );
}

export function setLedStripeCount(layout: TnutLayout, stripeId: string, count: number): TnutLayout | 'capacity' {
  const model = layout.ledStripes;
  const stripe = model?.stripes.find((entry) => entry.id === stripeId);
  if (!model || !stripe) return layout;
  if (!countValid(count) || (layout.ledPositions?.length ?? 0) - stripe.ledIds.length + count > MAX_LED_POSITIONS)
    return 'capacity';
  if (count === stripe.ledIds.length) return layout;
  const extra = count > stripe.ledIds.length ? allocateIds(model, count - stripe.ledIds.length) : null;
  if (count > stripe.ledIds.length && !extra) return 'capacity';
  const updated = { ...stripe, ledIds: [...stripe.ledIds.slice(0, count), ...(extra?.ids ?? [])] };
  const removed = new Set(stripe.ledIds);
  return finish(
    layout,
    {
      ...model,
      nextLedId: extra?.nextLedId ?? model.nextLedId,
      stripes: model.stripes.map((entry) => (entry.id === stripeId ? updated : entry)),
    },
    [...(layout.ledPositions ?? []).filter((led) => !removed.has(led.id)), ...stripePoints(updated)],
    true,
  );
}

export function moveLedStripeEndpoint(
  layout: TnutLayout,
  stripeId: string,
  endpoint: 'start' | 'end',
  destination: TnutPoint,
): TnutLayout {
  const model = layout.ledStripes;
  const stripe = model?.stripes.find((entry) => entry.id === stripeId);
  if (!model || !stripe || !point(destination)) return layout;
  const updated = { ...stripe, [endpoint]: { ...destination } };
  if (!segmentValid(updated.start, updated.end)) return layout;
  const moved = new Map(stripePoints(updated).map((led) => [led.id, led]));
  return finish(
    layout,
    { ...model, stripes: model.stripes.map((entry) => (entry.id === stripeId ? updated : entry)) },
    (layout.ledPositions ?? []).map((led) => moved.get(led.id) ?? led),
    false,
  );
}

export function removeLedStripe(layout: TnutLayout, stripeId: string): TnutLayout {
  const model = layout.ledStripes;
  const stripe = model?.stripes.find((entry) => entry.id === stripeId);
  if (!model || !stripe) return layout;
  const removed = new Set(stripe.ledIds);
  return finish(
    layout,
    { ...model, stripes: model.stripes.filter((entry) => entry.id !== stripeId) },
    (layout.ledPositions ?? []).filter((led) => !removed.has(led.id)),
    true,
  );
}

export function stripeProgress(
  stripe: SprayLedStripe,
  position: TnutPoint,
  frame: ReferenceSize = { width: 1, height: 1 },
): number {
  const deltaX = (stripe.end.x - stripe.start.x) * frame.width;
  const deltaY = (stripe.end.y - stripe.start.y) * frame.height;
  return (
    ((position.x - stripe.start.x) * frame.width * deltaX + (position.y - stripe.start.y) * frame.height * deltaY) /
    (deltaX ** 2 + deltaY ** 2)
  );
}

export function addLedStripeLed(layout: TnutLayout, stripeId: string, position?: TnutPoint): TnutLayout | 'capacity' {
  const model = layout.ledStripes;
  const stripe = model?.stripes.find((entry) => entry.id === stripeId);
  if (!model || !stripe || (position !== undefined && !point(position))) return layout;
  if ((layout.ledPositions?.length ?? 0) >= MAX_LED_POSITIONS) return 'capacity';
  const allocated = allocateIds(model, 1);
  if (!allocated) return 'capacity';
  const byId = new Map((layout.ledPositions ?? []).map((led) => [led.id, led]));
  const fractions = stripe.ledIds.map((id, index) =>
    stripeProgress(stripe, byId.get(id) ?? interpolate(stripe, index / Math.max(1, stripe.ledIds.length - 1))),
  );
  let fraction = position ? Math.max(0, Math.min(1, stripeProgress(stripe, position))) : 0.5;
  if (!position) {
    const stops = [0, ...fractions, 1].sort((first, second) => first - second);
    let longest = -1;
    for (let index = 1; index < stops.length; index++)
      if (stops[index] - stops[index - 1] > longest) {
        longest = stops[index] - stops[index - 1];
        fraction = (stops[index] + stops[index - 1]) / 2;
      }
  }
  const insertion = fractions.findIndex((existing) => existing > fraction);
  const ledIds = [...stripe.ledIds];
  ledIds.splice(insertion < 0 ? ledIds.length : insertion, 0, allocated.ids[0]);
  const updated = { ...stripe, ledIds };
  return finish(
    layout,
    {
      ...model,
      nextLedId: allocated.nextLedId,
      stripes: model.stripes.map((entry) => (entry.id === stripeId ? updated : entry)),
    },
    [...(layout.ledPositions ?? []), { id: allocated.ids[0], ...(position ?? interpolate(stripe, fraction)) }],
    true,
  );
}

export function removeLedStripeLed(layout: TnutLayout, stripeId: string, ledId: string): TnutLayout {
  const model = layout.ledStripes;
  const stripe = model?.stripes.find((entry) => entry.id === stripeId);
  if (!model || !stripe?.ledIds.includes(ledId)) return layout;
  if (stripe.ledIds.length === 1) return removeLedStripe(layout, stripeId);
  return finish(
    layout,
    {
      ...model,
      stripes: model.stripes.map((entry) =>
        entry.id === stripeId ? { ...entry, ledIds: entry.ledIds.filter((id) => id !== ledId) } : entry,
      ),
    },
    (layout.ledPositions ?? []).filter((led) => led.id !== ledId),
    true,
  );
}
