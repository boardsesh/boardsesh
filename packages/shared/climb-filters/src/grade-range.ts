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
 * A bound does not have to sit on stop edges. One saved under Font grades, or
 * before chips were grouped, can cover only PART of a stop ("4a" alone, where
 * the V chip is all of V0). Nothing here rewrites such a bound by itself. A
 * gesture puts the end it touches on a stop edge and leaves the other end's id
 * exactly as it was, and a tap or hold on a partly covered stop first completes
 * that stop instead of clearing or trimming it.
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

/**
 * Whether the whole selection sits inside the stop: both ends are set and both
 * fall in it. The selection may cover only part of the stop.
 */
export function isGradeStopAlone(bound: GradeBound, stop: GradeStop): boolean {
  return stopCovers(stop, bound.minGradeId) && stopCovers(stop, bound.maxGradeId);
}

/** Whether the bound is this stop edge to edge: no more, and no less. */
export function isExactGradeStop(bound: GradeBound, stop: GradeStop): boolean {
  return bound.minGradeId === stop.minGradeId && bound.maxGradeId === stop.maxGradeId;
}

/** Whether the stop sits between the two ends of a range, and is neither end. */
export function isGradeStopInRange(bound: GradeBound, stop: GradeStop): boolean {
  if (bound.minGradeId === undefined || bound.maxGradeId === undefined) return false;
  return stop.minGradeId > bound.minGradeId && stop.maxGradeId < bound.maxGradeId;
}

/**
 * The one stop the whole selection sits in (it may cover only part of it), or
 * undefined for Any, a range across stops or an open-ended bound.
 */
export function findSelectedGradeStop<Stop extends GradeStop>(
  bound: GradeBound,
  stops: readonly Stop[],
): Stop | undefined {
  return stops.find((stop) => isGradeStopAlone(bound, stop));
}

function selectStop(stop: GradeStop): GradeBound {
  return { minGradeId: stop.minGradeId, maxGradeId: stop.maxGradeId };
}

/** The bound from the lowest point of two spans to the highest. */
function coverAll(first: GradeStop, second: GradeStop): GradeBound {
  return {
    minGradeId: Math.min(first.minGradeId, second.minGradeId),
    maxGradeId: Math.max(first.maxGradeId, second.maxGradeId),
  };
}

/** A grade id as a one-grade span, for `coverAll`: the end a gesture leaves alone. */
function gradeSpan(gradeId: number): GradeStop {
  return { minGradeId: gradeId, maxGradeId: gradeId };
}

/**
 * A range whose lower end stop was tapped: the lower end moves to the next stop
 * up, and the upper end stays where it is. When that next stop is the upper
 * end's own, or there is none short of it, what is left is the upper end alone.
 */
function trimLowerEnd(
  lowerStop: GradeStop,
  upperStop: GradeStop,
  upperGradeId: number,
  stops: readonly GradeStop[],
): GradeBound {
  const lowerIndex = stops.findIndex((stop) => isSameStop(stop, lowerStop));
  const inwardStop = lowerIndex === -1 ? undefined : stops[lowerIndex + 1];
  const minGradeId =
    inwardStop && inwardStop.minGradeId <= upperGradeId
      ? inwardStop.minGradeId
      : Math.min(upperStop.minGradeId, upperGradeId);
  return { minGradeId, maxGradeId: upperGradeId };
}

/** The mirror of `trimLowerEnd`: the upper end moves to the next stop down, the lower end stays. */
function trimUpperEnd(
  lowerStop: GradeStop,
  upperStop: GradeStop,
  lowerGradeId: number,
  stops: readonly GradeStop[],
): GradeBound {
  const upperIndex = stops.findIndex((stop) => isSameStop(stop, upperStop));
  const inwardStop = upperIndex <= 0 ? undefined : stops[upperIndex - 1];
  const maxGradeId =
    inwardStop && inwardStop.maxGradeId >= lowerGradeId
      ? inwardStop.maxGradeId
      : Math.max(lowerStop.maxGradeId, lowerGradeId);
  return { minGradeId: lowerGradeId, maxGradeId };
}

/**
 * Pure reducer for one tap on a stop. `stops` is the picker's whole row,
 * easiest first. `withinExtendWindow` is the caller's clock saying this tap
 * landed inside RANGE_EXTEND_WINDOW_MS of the tap that picked the one selected
 * stop.
 *   1. From Any, or an open-ended bound -> that stop alone.
 *   2. The stop the bound covers exactly -> Any (clear).
 *   3. The whole selection sits inside the tapped stop without covering it ->
 *      that stop, whole. The chip reads as selected, so the tap completes it
 *      rather than clearing a filter that never was all of it.
 *   4. One stop selected, a different stop tapped: within the window -> the
 *      range covering both; after it -> that stop alone.
 *   5. A range set, one of its end stops tapped -> that end moves one stop
 *      inward, settling on the other end when they meet. An end stop the range
 *      only partly covers is completed first, as in 3.
 *   6. A range set, any other stop tapped (inside or outside) -> that stop
 *      alone.
 *
 * An end the tap does not touch keeps its exact id, on a stop edge or not.
 */
export function computeGradeTap(
  current: GradeBound,
  tapped: GradeStop,
  stops: readonly GradeStop[],
  withinExtendWindow: boolean,
): GradeBound {
  const { minGradeId, maxGradeId } = current;
  if (minGradeId === undefined || maxGradeId === undefined) return selectStop(tapped);
  if (isExactGradeStop(current, tapped)) return clearGradeBound();
  if (isGradeStopAlone(current, tapped)) return selectStop(tapped);

  const lowerStop = stopOf(stops, minGradeId);
  const upperStop = stopOf(stops, maxGradeId);
  if (isSameStop(lowerStop, upperStop)) {
    return withinExtendWindow ? coverAll({ minGradeId, maxGradeId }, tapped) : selectStop(tapped);
  }
  if (isSameStop(tapped, lowerStop)) {
    const coversLowerStop = minGradeId === lowerStop.minGradeId;
    return coversLowerStop
      ? trimLowerEnd(lowerStop, upperStop, maxGradeId, stops)
      : { minGradeId: lowerStop.minGradeId, maxGradeId };
  }
  if (isSameStop(tapped, upperStop)) {
    const coversUpperStop = maxGradeId === upperStop.maxGradeId;
    return coversUpperStop
      ? trimUpperEnd(lowerStop, upperStop, minGradeId, stops)
      : { minGradeId, maxGradeId: upperStop.maxGradeId };
  }
  return selectStop(tapped);
}

/**
 * A touch and hold on a stop: the way to a range that does not depend on how
 * fast a second tap follows.
 *   - from Any -> that stop alone: it is the first end
 *   - on the stop the bound covers exactly -> Any, like a tap
 *   - on a stop the whole selection sits inside without covering it -> that
 *     stop, whole, like a tap
 *   - from one stop (or an open-ended bound) -> the range covering it and the
 *     held stop
 *   - with a range set -> the held stop replaces the nearer end, counted in
 *     stops. Equally far from both, the upper end moves. Holding an end the
 *     range covers leaves the range as it is; holding one it only partly covers
 *     completes that stop.
 *
 * `stops` is the picker's whole row, easiest first. As in `computeGradeTap`, an
 * end the hold does not touch keeps its exact id.
 */
export function extendGradeRange(current: GradeBound, held: GradeStop, stops: readonly GradeStop[]): GradeBound {
  const lowerGradeId = current.minGradeId ?? current.maxGradeId;
  const upperGradeId = current.maxGradeId ?? current.minGradeId;
  if (lowerGradeId === undefined || upperGradeId === undefined) return selectStop(held);
  if (isExactGradeStop(current, held)) return clearGradeBound();

  const lowerStop = stopOf(stops, lowerGradeId);
  const upperStop = stopOf(stops, upperGradeId);
  // One stop holds the selection (all of it or part), or the bound is open-ended.
  if (isSameStop(lowerStop, upperStop)) {
    return coverAll({ minGradeId: lowerGradeId, maxGradeId: upperGradeId }, held);
  }

  // Position in the row. An id with no chip takes the position of the next
  // stop up, so every id has a position and no case is special.
  const positionOf = (gradeId: number): number => {
    const index = stops.findIndex((stop) => stop.maxGradeId >= gradeId);
    return index === -1 ? stops.length : index;
  };
  const heldPosition = positionOf(held.minGradeId);
  const stopsFromLower = Math.abs(heldPosition - positionOf(lowerGradeId));
  const stopsFromUpper = Math.abs(heldPosition - positionOf(upperGradeId));
  // The held stop takes the place of the nearer end, whole; the other end stays.
  return stopsFromLower < stopsFromUpper
    ? coverAll(held, gradeSpan(upperGradeId))
    : coverAll(gradeSpan(lowerGradeId), held);
}
