// The address a filter picker route hands its picks back to. A picker (Setters,
// Hold types, Board region, the Logbook's setters) is a pushed route, and more
// than one list that opens it can be mounted at once: the Climbs tab's sheet
// stays suspended under a setter page whose own sheet then opens Hold types.
// Each opener mints one id for its life, every push carries it, and a route
// hands its picks back to that id only. A route opened without one (a deep
// link) hands them back to nobody.

let handoffCounter = 0;

/** A fresh id for one mounted opener (a filter sheet, a Logbook). */
export function createFilterPickerHandoffId(): string {
  handoffCounter += 1;
  return `filter-picker-${handoffCounter}`;
}
