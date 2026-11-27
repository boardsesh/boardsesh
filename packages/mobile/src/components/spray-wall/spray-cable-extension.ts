import { connectWiring, extendWiring, MAX_LED_POSITIONS, type TnutWiring } from '@boardsesh/spray-wall-geometry';
import { expandCableUnits, type SprayCableLedUnit } from './spray-led-units';

type CableOutput = { sectionStart: string; tail: string };
export type CableExtensionPlan = { steps: TnutWiring[]; output: CableOutput | null };
type CableExtensionOptions = { recordStops?: boolean; startAtHit?: boolean };

function matchesEndpoint(path: readonly string[], unit: SprayCableLedUnit, output: boolean): boolean {
  if (!unit.length || path.length < unit.length) return false;
  const offset = output ? path.length - unit.length : 0;
  return (
    unit.every((member, index) => path[offset + index] === member) ||
    unit.every((member, index) => path[offset + unit.length - 1 - index] === member)
  );
}

/** Only a complete, contiguous unit can expose a section's input or output. */
function endpointAt(
  wiring: TnutWiring,
  id: string,
  units: ReadonlyMap<string, SprayCableLedUnit>,
  output: boolean,
): number {
  const unit = units.get(id) ?? [id];
  return wiring.paths.findIndex((path) => matchesEndpoint(path, unit, output));
}

/** Preview and commit share section choice, unit expansion, and one Undo snapshot per stop. */
export function planCableExtension(
  wiring: TnutWiring,
  ids: readonly string[],
  preferredFrom: string | null | undefined,
  units: ReadonlyMap<string, SprayCableLedUnit>,
  indivisibleMembers: ReadonlySet<string>,
  { recordStops = true, startAtHit = true }: CableExtensionOptions = {},
): CableExtensionPlan {
  const preferredSection = wiring.paths.findIndex((path) => path.at(-1) === preferredFrom);
  const firstInput = ids.length ? endpointAt(wiring, ids[0], units, false) : -1;
  // A tap on a whole isolated pair/strip can mean join, while a drag starting
  // there still selects its output. Without a selected source it only selects.
  const joinSelected = !startAtHit && preferredSection >= 0 && firstInput > preferredSection;
  const pickedSection = ids.length && !joinSelected ? endpointAt(wiring, ids[0], units, true) : -1;
  const from = pickedSection >= 0 ? wiring.paths[pickedSection].at(-1) : preferredFrom;
  if (from === null) return { steps: [], output: null };
  const section =
    from === undefined ? Math.max(0, wiring.paths.length - 1) : wiring.paths.findIndex((path) => path.at(-1) === from);
  if (section < 0) return { steps: [], output: null };
  const steps: TnutWiring[] = [];
  const wired = new Set(wiring.paths.flat());
  const startByInput = new Map<string, string>();
  for (const path of wiring.paths) {
    const unit = units.get(path[0]) ?? [path[0]];
    if (matchesEndpoint(path, unit, false)) for (const member of unit) startByInput.set(member, path[0]);
  }
  let sectionByStart = new Map(wiring.paths.map((path, index) => [path[0], index]));
  let current = wiring;
  let tail = from;
  let pending: string[] = [];
  const accept = (next: TnutWiring) => {
    if (next === current) return;
    if (next.paths.length !== current.paths.length)
      sectionByStart = new Map(next.paths.map((path, index) => [path[0], index]));
    current = next;
    tail = current.paths[section].at(-1);
    if (recordStops) steps.push(next);
  };
  const flush = () => {
    if (!pending.length) return;
    accept(extendWiring(current, pending, tail));
    pending = [];
  };
  for (const id of ids) {
    if (wired.has(id)) {
      const inputStart = startByInput.get(id);
      const input = inputStart === undefined ? -1 : (sectionByStart.get(inputStart) ?? -1);
      // Keep the controller start and every existing section's direction.
      // The undirected join helper is safe only from an earlier tail to a later head.
      if (input > section) {
        flush();
        if (tail !== undefined) accept(connectWiring(current, tail, current.paths[input][0]));
      }
      continue;
    }
    const members = expandCableUnits([id], units, wired, indivisibleMembers);
    if (!members.length || wired.size + members.length > MAX_LED_POSITIONS) continue;
    pending.push(...members);
    for (const member of members) wired.add(member);
    if (recordStops) flush();
  }
  // A live preview batches additions between joins instead of copying each stop.
  flush();
  if (!recordStops && current !== wiring) steps.push(current);
  const path = current.paths[section];
  return {
    steps,
    output:
      path?.length && (pickedSection >= 0 || steps.length)
        ? { sectionStart: path[0], tail: path[path.length - 1] }
        : null,
  };
}
