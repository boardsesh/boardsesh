import { MAX_LEDS_PER_HOLD_LINK, readHoldLedLinks } from './hold-led-links';
import type { LedPosition } from './led-layout';
import type { TnutLayout, TnutPoint } from './tnut-layout';

export type SprayLedLinkLayer = 'primary' | 'above';
/** Missing role: automatic. An explicit empty role: deliberately no LEDs. */
export type SprayTnutLedLink = { hole: TnutPoint; ledIds?: string[]; aboveLedIds?: string[] };

const pointKey = (point: TnutPoint) => `${point.x.toFixed(8)}:${point.y.toFixed(8)}`;
const record = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);

export function readTnutLedLinks(
  candidate: unknown,
  holes: readonly TnutPoint[],
  leds: readonly LedPosition[],
): SprayTnutLedLink[] | null {
  if (!Array.isArray(candidate) || candidate.length > 3000) return null;
  const knownHoles = new Map(holes.map((hole) => [pointKey(hole), hole]));
  const knownLeds = new Set(leds.map((led) => led.id));
  const links = new Map<string, SprayTnutLedLink>();
  for (const entry of candidate) {
    if (
      !record(entry) ||
      !record(entry.hole) ||
      typeof entry.hole.x !== 'number' ||
      typeof entry.hole.y !== 'number' ||
      !Number.isFinite(entry.hole.x) ||
      !Number.isFinite(entry.hole.y) ||
      entry.hole.x < 0 ||
      entry.hole.x > 1 ||
      entry.hole.y < 0 ||
      entry.hole.y > 1 ||
      (entry.ledIds === undefined && entry.aboveLedIds === undefined)
    )
      return null;
    for (const ids of [entry.ledIds, entry.aboveLedIds]) {
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.length > MAX_LEDS_PER_HOLD_LINK ||
          !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100))
      )
        return null;
    }
    const key = pointKey({ x: entry.hole.x, y: entry.hole.y });
    const hole = knownHoles.get(key);
    if (!hole) continue;
    const previous = links.get(key);
    links.set(key, {
      ...previous,
      hole: { ...hole },
      ...(entry.ledIds !== undefined
        ? { ledIds: [...new Set((entry.ledIds as string[]).filter((id) => knownLeds.has(id)))] }
        : {}),
      ...(entry.aboveLedIds !== undefined
        ? { aboveLedIds: [...new Set((entry.aboveLedIds as string[]).filter((id) => knownLeds.has(id)))] }
        : {}),
    });
  }
  return [...links.values()];
}

export function setTnutLedLink(
  layout: TnutLayout,
  holeIndex: number,
  ledIds: readonly string[],
  layer: SprayLedLinkLayer = 'primary',
): TnutLayout {
  const hole = layout.holes[holeIndex];
  if (!hole) return layout;
  const key = pointKey(hole);
  const field = layer === 'above' ? 'aboveLedIds' : 'ledIds';
  const links = readTnutLedLinks(layout.tnutLeds ?? [], layout.holes, layout.ledPositions ?? []) ?? [];
  const previous = links.find((link) => pointKey(link.hole) === key);
  const next = { ...previous, hole: { ...hole }, [field]: [...new Set(ledIds)].slice(0, MAX_LEDS_PER_HOLD_LINK) };
  return {
    ...layout,
    tnutLeds:
      readTnutLedLinks(
        [...links.filter((link) => pointKey(link.hole) !== key), next],
        layout.holes,
        layout.ledPositions ?? [],
      ) ?? [],
  };
}

export function clearTnutLedLink(
  layout: TnutLayout,
  holeIndex: number,
  layer: SprayLedLinkLayer = 'primary',
): TnutLayout {
  const hole = layout.holes[holeIndex];
  if (!hole) return layout;
  const key = pointKey(hole);
  const links = (readTnutLedLinks(layout.tnutLeds ?? [], layout.holes, layout.ledPositions ?? []) ?? []).flatMap(
    (link) => {
      if (pointKey(link.hole) !== key) return [link];
      const { ledIds, aboveLedIds } = link;
      const remaining = layer === 'above' ? ledIds : aboveLedIds;
      return remaining === undefined
        ? []
        : [{ hole: link.hole, ...(layer === 'above' ? { ledIds: remaining } : { aboveLedIds: remaining }) }];
    },
  );
  return { ...layout, tnutLeds: links };
}

/** Move an existing nut marker's associations; the caller updates its hole list atomically. */
export function moveTnutLedLinks(layout: TnutLayout, from: TnutPoint, to: TnutPoint): TnutLayout {
  const key = pointKey(from);
  return {
    ...layout,
    ...(layout.tnutLeds !== undefined
      ? {
          tnutLeds: layout.tnutLeds.map((link) => (pointKey(link.hole) === key ? { ...link, hole: { ...to } } : link)),
        }
      : {}),
    ...(layout.ledPositions !== undefined
      ? {
          ledPositions: layout.ledPositions.map((led) => ({
            ...led,
            ...(led.hole && pointKey(led.hole) === key ? { hole: { ...to } } : {}),
            ...(led.aboveHole && pointKey(led.aboveHole) === key ? { aboveHole: { ...to } } : {}),
          })),
        }
      : {}),
  };
}

export function pruneTnutLedLinks(layout: TnutLayout): TnutLayout {
  return {
    ...layout,
    ...(layout.tnutLeds !== undefined
      ? { tnutLeds: readTnutLedLinks(layout.tnutLeds, layout.holes, layout.ledPositions ?? []) ?? [] }
      : {}),
    ...(layout.holdLeds !== undefined
      ? { holdLeds: readHoldLedLinks(layout.holdLeds, layout.ledPositions ?? []) ?? [] }
      : {}),
    ...(layout.holdAboveLeds !== undefined
      ? { holdAboveLeds: readHoldLedLinks(layout.holdAboveLeds, layout.ledPositions ?? []) ?? [] }
      : {}),
  };
}

/** Newer keys survive older writers, unless that writer rebuilt the physical layout. */
export function keepLedLinksFromOlderApp(
  incoming: TnutLayout,
  sent: { tnutLeds: boolean; holdAboveLeds: boolean },
  stored: TnutLayout | null,
): TnutLayout {
  if (!stored || incoming.photoKey !== stored.photoKey) return incoming;
  const geometry = (layout: TnutLayout) =>
    JSON.stringify([
      layout.holes.map(pointKey).sort(),
      layout.ledPlacement,
      layout.corners,
      layout.rows,
      layout.columns,
      layout.columnConvention,
      layout.firstRowOffset,
    ]);
  const spots = (layout: TnutLayout) =>
    JSON.stringify(
      [...(layout.ledPositions ?? [])]
        .sort((first, second) => first.id.localeCompare(second.id))
        .map(({ id, x, y }) => [id, x, y]),
    );
  if (geometry(incoming) !== geometry(stored) && spots(incoming) !== spots(stored)) return incoming;
  return {
    ...incoming,
    ...(!sent.tnutLeds && stored.tnutLeds !== undefined
      ? { tnutLeds: readTnutLedLinks(stored.tnutLeds, incoming.holes, incoming.ledPositions ?? []) ?? [] }
      : {}),
    ...(!sent.holdAboveLeds && stored.holdAboveLeds !== undefined
      ? { holdAboveLeds: readHoldLedLinks(stored.holdAboveLeds, incoming.ledPositions ?? []) ?? [] }
      : {}),
  };
}
