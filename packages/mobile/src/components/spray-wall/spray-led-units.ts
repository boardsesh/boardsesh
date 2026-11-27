import { ledPairs, stripeCableUnits, type SprayLedPair, type TnutLayout } from '@boardsesh/spray-wall-geometry';

export type SprayCableLedUnit = readonly string[];

/** Both markers in a pair resolve to the same ordered unit. */
export function mapLedPairsById(pairs: readonly SprayLedPair[]): Map<string, SprayLedPair> {
  const byId = new Map<string, SprayLedPair>();
  for (const pair of pairs) {
    byId.set(pair[0], pair);
    byId.set(pair[1], pair);
  }
  return byId;
}

/** A strip takes priority over any older pair metadata naming one of its LEDs. */
export function mapCableUnitsById(layout: TnutLayout): Map<string, SprayCableLedUnit> {
  const byId = new Map<string, SprayCableLedUnit>();
  for (const unit of stripeCableUnits(layout)) for (const id of unit) byId.set(id, unit);
  for (const pair of ledPairs(layout)) {
    if (pair.some((id) => byId.has(id))) continue;
    for (const id of pair) byId.set(id, pair);
  }
  return byId;
}

/** Expand a touched member into a complete unit, entering from its nearer end. */
export function expandCableUnits(
  ids: readonly string[],
  units: ReadonlyMap<string, SprayCableLedUnit>,
  wired: ReadonlySet<string>,
  indivisibleMembers: ReadonlySet<string>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const visitedUnits = new Set<SprayCableLedUnit>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const unit = units.get(id) ?? [id];
    if (visitedUnits.has(unit)) continue;
    visitedUnits.add(unit);
    if (indivisibleMembers.has(id) && unit.some((member) => wired.has(member))) continue;
    const reversed = unit.indexOf(id) > (unit.length - 1) / 2;
    for (const member of reversed ? [...unit].reverse() : unit) {
      if (wired.has(member) || seen.has(member)) continue;
      seen.add(member);
      result.push(member);
    }
  }
  return result;
}
