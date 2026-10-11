/**
 * Pure grade-range rules for a chip-based grade picker (the mobile
 * GradeRangeRail). The bounds are `{ minGradeId, maxGradeId }`:
 *   - both undefined = "Any" (filter cleared)
 *   - both set = a selection, from one grade up to a range
 *   - one set = an open-ended bound ("V6 and up"), which older data can hold
 * Grade ids are difficulty_ids, which ascend with difficulty.
 *
 * The picker's chips are STOPS, and a stop can cover more than one grade id:
 * under V grades 4a, 4b and 4c all read "V0", so they are one chip. That is why
 * nothing here asks "is min equal to max?". A selection is one stop when both
 * its ends fall inside the same stop, whatever the two ids are.
 *
 * A plain tap picks one stop (`computeGradeTap`). A range is made on purpose,
 * through the picker's Range button or a touch and hold (`extendGradeRange`).
 * Nothing here is timed.
 */

export type GradeBound = { minGradeId: number | undefined; maxGradeId: number | undefined };

/**
 * One chip of a grade picker: the run of grade ids it covers, ends included.
 * A stop for a single grade has equal ids.
 */
export type GradeStop = { minGradeId: number; maxGradeId: number };

/** Both bounds undefined = "Any" (filter cleared). */
export function isAnyGrade(bound: GradeBound): boolean {
  return bound.minGradeId === undefined && bound.maxGradeId === undefined;
}

/** The cleared ("Any") bound. */
export function clearGradeBound(): GradeBound {
  return { minGradeId: undefined, maxGradeId: undefined };
}

/** Whether two bounds filter the same grades. */
export function isSameGradeBound(first: GradeBound, second: GradeBound): boolean {
  return first.minGradeId === second.minGradeId && first.maxGradeId === second.maxGradeId;
}

function stopCovers(stop: GradeStop, gradeId: number | undefined): boolean {
  return gradeId !== undefined && gradeId >= stop.minGradeId && gradeId <= stop.maxGradeId;
}

/** The stop a grade id falls in, or undefined when the picker has no chip for it. */
export function findGradeStop<Stop extends GradeStop>(stops: readonly Stop[], gradeId: number): Stop | undefined {
  return stops.find((stop) => stopCovers(stop, gradeId));
}

/** Whether the stop is an end of the selection: the bound's min or max falls inside it. */
export function isGradeStopEnd(bound: GradeBound, stop: GradeStop): boolean {
  return stopCovers(stop, bound.minGradeId) || stopCovers(stop, bound.maxGradeId);
}

/** Whether the stop is the whole selection: both ends are set and both fall inside it. */
export function isGradeStopAlone(bound: GradeBound, stop: GradeStop): boolean {
  return stopCovers(stop, bound.minGradeId) && stopCovers(stop, bound.maxGradeId);
}

/** Whether the stop sits between the two ends of a range, and is neither end. */
export function isGradeStopInRange(bound: GradeBound, stop: GradeStop): boolean {
  if (bound.minGradeId === undefined || bound.maxGradeId === undefined) return false;
  return stop.minGradeId > bound.minGradeId && stop.maxGradeId < bound.maxGradeId;
}

/** The one stop the bound selects, or undefined for Any, a range or an open-ended bound. */
export function findSelectedGradeStop<Stop extends GradeStop>(
  bound: GradeBound,
  stops: readonly Stop[],
): Stop | undefined {
  return stops.find((stop) => isGradeStopAlone(bound, stop));
}

function selectStop(stop: GradeStop): GradeBound {
  return { minGradeId: stop.minGradeId, maxGradeId: stop.maxGradeId };
}

function coverStops(first: GradeStop, second: GradeStop): GradeBound {
  return {
    minGradeId: Math.min(first.minGradeId, second.minGradeId),
    maxGradeId: Math.max(first.maxGradeId, second.maxGradeId),
  };
}

/**
 * A plain tap on a stop: that stop alone, also when a range is set. Tapping the
 * stop that already is the whole selection clears to Any.
 */
export function computeGradeTap(current: GradeBound, tapped: GradeStop): GradeBound {
  if (isGradeStopAlone(current, tapped)) return clearGradeBound();
  return selectStop(tapped);
}

/**
 * A tap that makes or moves a range: the picker's Range button was armed, or
 * the climber touched and held the stop.
 *   - from Any -> that stop alone: it is the first end
 *   - on the stop that already is the whole selection -> Any, like a plain tap
 *   - from one stop (or an open-ended bound) -> the range covering it and the
 *     tapped stop
 *   - with a range set -> the tapped stop replaces the nearer end, counted in
 *     stops. Equally far from both, the upper end moves. Tapping an end leaves
 *     the range as it is.
 *
 * `stops` is the picker's whole row, easiest first. An end kept from `current`
 * widens to the stop it falls in, so a bound saved inside a group ("4b" under
 * V grades, where the chip is all of V0) comes out on stop edges.
 */
export function extendGradeRange(current: GradeBound, tapped: GradeStop, stops: readonly GradeStop[]): GradeBound {
  const lowerGradeId = current.minGradeId ?? current.maxGradeId;
  const upperGradeId = current.maxGradeId ?? current.minGradeId;
  if (lowerGradeId === undefined || upperGradeId === undefined) return selectStop(tapped);
  if (isGradeStopAlone(current, tapped)) return clearGradeBound();

  // A grade id with no chip (another board's scale) stands in as its own stop.
  const stopOf = (gradeId: number): GradeStop =>
    findGradeStop(stops, gradeId) ?? { minGradeId: gradeId, maxGradeId: gradeId };
  const lowerStop = stopOf(lowerGradeId);
  const upperStop = stopOf(upperGradeId);
  const selectionIsOneStop =
    lowerStop.minGradeId === upperStop.minGradeId && lowerStop.maxGradeId === upperStop.maxGradeId;
  if (selectionIsOneStop) return coverStops(lowerStop, tapped);

  // Position in the row. An id with no chip takes the position of the next
  // stop up, so every id has a position and no case is special.
  const positionOf = (gradeId: number): number => {
    const index = stops.findIndex((stop) => stop.maxGradeId >= gradeId);
    return index === -1 ? stops.length : index;
  };
  const tappedPosition = positionOf(tapped.minGradeId);
  const stopsFromLower = Math.abs(tappedPosition - positionOf(lowerGradeId));
  const stopsFromUpper = Math.abs(tappedPosition - positionOf(upperGradeId));
  return stopsFromLower < stopsFromUpper ? coverStops(tapped, upperStop) : coverStops(lowerStop, tapped);
}
