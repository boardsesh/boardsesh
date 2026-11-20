import { connectWiring, cutWiring, MAX_LED_POSITIONS, type TnutWiring } from '@boardsesh/spray-wall-geometry';

type CableUnitLocation = { section: number; start: number; end: number };
type CableUnit = readonly string[];
type CableMemberLocation = { section: number; position: number };

/** Saved pairs may predate unit wiring. Their members must already be together to edit the unit. */
function locateUnit(known: ReadonlyMap<string, CableMemberLocation>, unit: CableUnit): CableUnitLocation | null {
  if (new Set(unit).size !== unit.length) return null;
  const locations = unit.map((id) => known.get(id) ?? { section: -1, position: -1 });
  if (locations.every(({ section }) => section < 0)) return { section: -1, start: 0, end: unit.length - 1 };
  const first = locations[0];
  if (first.section < 0 || locations.some(({ section }) => section !== first.section)) return null;
  if (locations.length > 1) {
    const step = locations[1].position - locations[0].position;
    if (
      Math.abs(step) !== 1 ||
      locations.some(({ position }, index) => index > 0 && position - locations[index - 1].position !== step)
    )
      return null;
  }
  const last = locations[locations.length - 1];
  return {
    section: first.section,
    start: Math.min(first.position, last.position),
    end: Math.max(first.position, last.position),
  };
}

export function planCableUnitEdits(wiring: TnutWiring, first: CableUnit, second: CableUnit) {
  const unchanged = { cut: wiring, joined: wiring };
  if (!first.length || !second.length) return unchanged;
  const secondMembers = new Set(second);
  if (first.some((id) => secondMembers.has(id))) return unchanged;
  const known = new Map<string, CableMemberLocation>();
  wiring.paths.forEach((path, section) => path.forEach((id, position) => known.set(id, { section, position })));
  const firstLocation = locateUnit(known, first);
  const secondLocation = locateUnit(known, second);
  if (!firstLocation || !secondLocation) return unchanged;

  if (firstLocation.section === secondLocation.section && firstLocation.section >= 0) {
    const path = wiring.paths[firstLocation.section];
    const [before, after] =
      firstLocation.end < secondLocation.start ? [firstLocation, secondLocation] : [secondLocation, firstLocation];
    if (before.end + 1 !== after.start) return unchanged;
    return { ...unchanged, cut: cutWiring(wiring, path[before.end], path[after.start]) };
  }
  if (firstLocation.section < 0 && secondLocation.section < 0 && wiring.paths.length) return unchanged;

  const newMembers = (firstLocation.section < 0 ? first.length : 0) + (secondLocation.section < 0 ? second.length : 0);
  if (newMembers && wiring.paths.reduce((total, path) => total + path.length, newMembers) > MAX_LED_POSITIONS)
    return unchanged;
  const paths = [...wiring.paths];
  const place = (location: CableUnitLocation, unit: CableUnit) =>
    location.section < 0 ? { ...location, section: paths.push([...unit]) - 1 } : location;
  const placedFirst = place(firstLocation, first);
  const placedSecond = place(secondLocation, second);
  const [before, after] =
    placedFirst.section < placedSecond.section ? [placedFirst, placedSecond] : [placedSecond, placedFirst];
  const head = paths[before.section];
  const tail = paths[after.section];
  // When an entire unit is exposed, choose the existing path direction.
  const from = before.end === head.length - 1 ? head[before.end] : before.start === 0 ? head[0] : undefined;
  const to = after.start === 0 ? tail[0] : after.end === tail.length - 1 ? tail[after.end] : undefined;
  if (from === undefined || to === undefined) return unchanged;
  return { ...unchanged, joined: connectWiring(newMembers ? { ...wiring, paths } : wiring, from, to) };
}
