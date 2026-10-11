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
 * Two gestures change the bound. A tap (`computeGradeTap`) picks one stop, and
 * a second tap on another stop soon after the first makes a range. A touch and
 * hold (`extendGradeRange`) makes or moves a range whenever it happens.
 */

/**
 * Tapping a different stop while one stop is selected only extends to a range
 * when the second tap lands within this window of the pick. Past it, the tap
 * switches to the tapped stop instead.
 */
export const RANGE_EXTEND_WINDOW_MS = 3000;

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

function isSameStop(first: GradeStop, second: GradeStop): boolean {
  return first.minGradeId === second.minGradeId && first.maxGradeId === second.maxGradeId;
}

/** The stop a grade id falls in, or undefined when the picker has no chip for it. */
export function findGradeStop<Stop extends GradeStop>(stops: readonly Stop[], gradeId: number): Stop | undefined {
  return stops.find((stop) => stopCovers(stop, gradeId));
}

/** As `findGradeStop`, with an id that has no chip (another board's scale) standing in as its own stop. */
function stopOf(stops: readonly GradeStop[], gradeId: number): GradeStop {
  return findGradeStop(stops, gradeId) ?? { minGradeId: gradeId, maxGradeId: gradeId };
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
 * A range with one end tapped: that end moves one stop inward. When the next
 * stop inward is the other end, or there is none, the range settles on the
 * other end alone.
 */
function trimRangeEnd(
  trimmedStop: GradeStop,
  survivingStop: GradeStop,
  inward: 1 | -1,
  stops: readonly GradeStop[],
): GradeBound {
  const trimmedIndex = stops.findIndex((stop) => isSameStop(stop, trimmedStop));
  const inwardStop = trimmedIndex === -1 ? undefined : stops[trimmedIndex + inward];
  if (!inwardStop) return selectStop(survivingStop);
  const passesSurvivingEnd =
    inward === 1 ? inwardStop.minGradeId > survivingStop.maxGradeId : inwardStop.maxGradeId < survivingStop.minGradeId;
  return passesSurvivingEnd ? selectStop(survivingStop) : coverStops(inwardStop, survivingStop);
}

/**
 * Pure reducer for one tap on a stop. `stops` is the picker's whole row,
 * easiest first. `withinExtendWindow` is the caller's clock saying this tap
 * landed inside RANGE_EXTEND_WINDOW_MS of the tap that picked the one selected
 * stop.
 *   1. From Any, or an open-ended bound -> that stop alone.
 *   2. The stop that already is the whole selection -> Any (clear).
 *   3. One stop selected, a different stop tapped: within the window -> the
 *      range covering both; after it -> that stop alone.
 *   4. A range set, one of its end stops tapped -> that end moves one stop
 *      inward, settling on the other end when they meet.
 *   5. A range set, any other stop tapped (inside or outside) -> that stop
 *      alone.
 *
 * An end kept from `current` widens to the stop it falls in, so a bound saved
 * inside a group ("4b" under V grades, where the chip is all of V0) comes out
 * on stop edges.
 */
export function computeGradeTap(
  current: GradeBound,
  tapped: GradeStop,
  stops: readonly GradeStop[],
  withinExtendWindow: boolean,
): GradeBound {
  const { minGradeId, maxGradeId } = current;
  if (minGradeId === undefined || maxGradeId === undefined) return selectStop(tapped);
  if (isGradeStopAlone(current, tapped)) return clearGradeBound();

  const lowerStop = stopOf(stops, minGradeId);
  const upperStop = stopOf(stops, maxGradeId);
  if (isSameStop(lowerStop, upperStop)) {
    return withinExtendWindow ? coverStops(lowerStop, tapped) : selectStop(tapped);
  }
  if (isSameStop(tapped, lowerStop)) return trimRangeEnd(lowerStop, upperStop, 1, stops);
  if (isSameStop(tapped, upperStop)) return trimRangeEnd(upperStop, lowerStop, -1, stops);
  return selectStop(tapped);
}

/**
 * A touch and hold on a stop: the way to a range that does not depend on how
 * fast a second tap follows.
 *   - from Any -> that stop alone: it is the first end
 *   - on the stop that already is the whole selection -> Any, like a tap
 *   - from one stop (or an open-ended bound) -> the range covering it and the
 *     held stop
 *   - with a range set -> the held stop replaces the nearer end, counted in
 *     stops. Equally far from both, the upper end moves. Holding an end leaves
 *     the range as it is.
 *
 * `stops` is the picker's whole row, easiest first. As in `computeGradeTap`, an
 * end kept from `current` widens to the stop it falls in.
 */
export function extendGradeRange(current: GradeBound, held: GradeStop, stops: readonly GradeStop[]): GradeBound {
  const lowerGradeId = current.minGradeId ?? current.maxGradeId;
  const upperGradeId = current.maxGradeId ?? current.minGradeId;
  if (lowerGradeId === undefined || upperGradeId === undefined) return selectStop(held);
  if (isGradeStopAlone(current, held)) return clearGradeBound();

  const lowerStop = stopOf(stops, lowerGradeId);
  const upperStop = stopOf(stops, upperGradeId);
  if (isSameStop(lowerStop, upperStop)) return coverStops(lowerStop, held);

  // Position in the row. An id with no chip takes the position of the next
  // stop up, so every id has a position and no case is special.
  const positionOf = (gradeId: number): number => {
    const index = stops.findIndex((stop) => stop.maxGradeId >= gradeId);
    return index === -1 ? stops.length : index;
  };
  const heldPosition = positionOf(held.minGradeId);
  const stopsFromLower = Math.abs(heldPosition - positionOf(lowerGradeId));
  const stopsFromUpper = Math.abs(heldPosition - positionOf(upperGradeId));
  return stopsFromLower < stopsFromUpper ? coverStops(held, upperStop) : coverStops(lowerStop, held);
}
