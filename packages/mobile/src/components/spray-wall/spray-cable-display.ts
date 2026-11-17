import type { LedPosition, SprayLedPair, TnutPoint, TnutWiring } from '@boardsesh/spray-wall-geometry';
import { cableEndpoints } from './spray-cable-endpoints';

export type SprayCableDisplayEdge = {
  fromId: string;
  toId: string;
  from: TnutPoint;
  to: TnutPoint;
  skip: number;
  first: boolean;
};

/**
 * A pair shares a cable point only when its LEDs are adjacent with no skipped
 * slots between them. Keep the real IDs on every visible edge for editing skips.
 */
export function sprayCableDisplayGeometry(
  leds: readonly LedPosition[],
  wiring: TnutWiring | undefined,
  pairs: readonly SprayLedPair[],
) {
  const paths = wiring?.paths ?? [];
  const byId = new Map<string, TnutPoint>(leds.map(({ id, x, y }) => [id, { x, y }]));
  const partnerById = new Map<string, string>();
  for (const [first, second] of pairs) {
    partnerById.set(first, second);
    partnerById.set(second, first);
  }

  const edgeKey = (from: string, to: string) => JSON.stringify([from, to]);
  const skips = new Map<string, number>();
  for (const { from, to, count } of wiring?.skips ?? []) {
    skips.set(edgeKey(from, to), count);
    skips.set(edgeKey(to, from), count);
  }
  const collapsed = new Set<string>();
  for (const path of paths) {
    for (let index = 1; index < path.length; index++) {
      const fromId = path[index - 1];
      const toId = path[index];
      if (partnerById.get(fromId) !== toId || skips.get(edgeKey(fromId, toId))) continue;
      const from = byId.get(fromId);
      const to = byId.get(toId);
      if (!from || !to) continue;
      const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      byId.set(fromId, midpoint);
      byId.set(toId, midpoint);
      collapsed.add(fromId);
    }
  }

  const endpoints = cableEndpoints(paths);
  const start = endpoints.start === null ? undefined : byId.get(endpoints.start);
  const end = endpoints.end === null ? undefined : byId.get(endpoints.end);
  const loose = endpoints.loose.flatMap((id) => {
    const point = byId.get(id);
    return point ? [point] : [];
  });
  const edges: SprayCableDisplayEdge[] = [];
  for (const path of paths) {
    let first = path[0] === endpoints.start;
    for (let index = 1; index < path.length; index++) {
      const fromId = path[index - 1];
      if (collapsed.has(fromId)) continue;
      const toId = path[index];
      const from = byId.get(fromId);
      const to = byId.get(toId);
      if (!from || !to) continue;
      edges.push({ fromId, toId, from, to, skip: skips.get(edgeKey(fromId, toId)) ?? 0, first });
      first = false;
    }
  }
  // If the whole cable is one displayed point, its start marker takes priority.
  return { edges, start, end: end === start ? undefined : end, loose };
}
