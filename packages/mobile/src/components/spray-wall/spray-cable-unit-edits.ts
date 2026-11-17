import {
  connectWiring,
  cutWiring,
  MAX_LED_POSITIONS,
  type SprayLedPair,
  type TnutWiring,
} from '@boardsesh/spray-wall-geometry';

type CableUnitLocation = { section: number; start: number; end: number };
type CableUnit = readonly [string] | SprayLedPair;

/** Saved pairs may predate unit wiring. Their members must already be together to edit the unit. */
function locateUnit(paths: TnutWiring['paths'], unit: CableUnit): CableUnitLocation | null {
  const locations = unit.map((id) => {
    const section = paths.findIndex((path) => path.includes(id));
    return { section, position: section < 0 ? -1 : paths[section].indexOf(id) };
  });
  if (locations.every(({ section }) => section < 0)) return { section: -1, start: 0, end: unit.length - 1 };
  const [first, ...others] = locations.sort((left, right) => left.position - right.position);
  if (
    first.section < 0 ||
    others.some(({ section, position }, index) => section !== first.section || position !== first.position + index + 1)
  )
    return null;
  return { section: first.section, start: first.position, end: first.position + unit.length - 1 };
}

export function planCableUnitEdits(wiring: TnutWiring, first: CableUnit, second: CableUnit) {
  const unchanged = { cut: wiring, joined: wiring };
  const firstLocation = locateUnit(wiring.paths, first);
  const secondLocation = locateUnit(wiring.paths, second);
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
