import { extendWiring, MAX_LED_POSITIONS, type TnutWiring } from '@boardsesh/spray-wall-geometry';
import { expandCableUnits, type SprayCableLedUnit } from './spray-led-units';

type CableOutput = { sectionStart: string; tail: string };
export type CableExtensionPlan = { steps: TnutWiring[]; output: CableOutput | null };

/** Any member can pick a whole unit at a section's output, never its input or an interior LED. */
function outputAt(wiring: TnutWiring, id: string, units: ReadonlyMap<string, SprayCableLedUnit>): CableOutput | null {
  const unit = units.get(id) ?? [id];
  for (const path of wiring.paths) {
    if (path.length < unit.length) continue;
    const suffix = path.slice(-unit.length);
    if (
      unit.every((member, index) => suffix[index] === member) ||
      unit.every((member, index) => suffix[unit.length - 1 - index] === member)
    )
      return { sectionStart: path[0], tail: path[path.length - 1] };
  }
  return null;
}

/** Preview and commit share section choice, unit expansion, and one Undo snapshot per stop. */
export function planCableExtension(
  wiring: TnutWiring,
  ids: readonly string[],
  preferredFrom: string | null | undefined,
  units: ReadonlyMap<string, SprayCableLedUnit>,
  indivisibleMembers: ReadonlySet<string>,
  recordStops = true,
): CableExtensionPlan {
  const picked = ids.length ? outputAt(wiring, ids[0], units) : null;
  const from = picked?.tail ?? preferredFrom;
  if (from === null) return { steps: [], output: null };
  const section =
    from === undefined ? Math.max(0, wiring.paths.length - 1) : wiring.paths.findIndex((path) => path.at(-1) === from);
  if (section < 0) return { steps: [], output: null };
  const steps: TnutWiring[] = [];
  const wired = new Set(wiring.paths.flat());
  const stops: string[][] = [];
  for (const id of ids) {
    const members = expandCableUnits([id], units, wired, indivisibleMembers);
    if (!members.length || wired.size + members.length > MAX_LED_POSITIONS) continue;
    stops.push(members);
    for (const member of members) wired.add(member);
  }
  let current = wiring;
  let tail = from;
  // A live preview needs only the final path, not a copy for every Undo stop.
  for (const members of recordStops ? stops : stops.length ? [stops.flat()] : []) {
    const next = extendWiring(current, members, tail);
    if (next === current) continue;
    steps.push(next);
    current = next;
    tail = current.paths[section].at(-1);
  }
  const path = current.paths[section];
  return {
    steps,
    output: path?.length && (picked || steps.length) ? { sectionStart: path[0], tail: path[path.length - 1] } : null,
  };
}
