/**
 * Pure grade-range rules for a chip-based grade picker (the mobile
 * GradeRangeRail). The bounds are `{ minGradeId, maxGradeId }`:
 *   - both undefined = "Any" (filter cleared)
 *   - equal = single grade
 *   - unequal = range
 * Grade ids are difficulty_ids, which ascend with difficulty.
 *
 * Whether a tap picks one grade or builds a range is the picker's visible Range
 * toggle, passed in as `rangeMode`. Nothing here is timed.
 */

export type GradeBound = { minGradeId: number | undefined; maxGradeId: number | undefined };

/** Both bounds undefined = "Any" (filter cleared). */
export function isAnyGrade(bound: GradeBound): boolean {
  return bound.minGradeId === undefined && bound.maxGradeId === undefined;
}

/** Both bounds set and equal = a single grade is selected. */
export function isSingleGrade(bound: GradeBound): boolean {
  return bound.minGradeId !== undefined && bound.maxGradeId !== undefined && bound.minGradeId === bound.maxGradeId;
}

/** Both bounds set and unequal = a true range is selected. */
export function isRangeGrade(bound: GradeBound): boolean {
  return bound.minGradeId !== undefined && bound.maxGradeId !== undefined && bound.minGradeId !== bound.maxGradeId;
}

/** The cleared ("Any") bound. */
export function clearGradeBound(): GradeBound {
  return { minGradeId: undefined, maxGradeId: undefined };
}

/** Whether a grade id falls within the inclusive bounds (false unless both set). */
export function isGradeInRange(bound: GradeBound, gradeId: number): boolean {
  if (bound.minGradeId === undefined || bound.maxGradeId === undefined) return false;
  return gradeId >= bound.minGradeId && gradeId <= bound.maxGradeId;
}

/** Whether a grade id is exactly one of the two endpoints. */
export function isGradeEndpoint(bound: GradeBound, gradeId: number): boolean {
  return gradeId === bound.minGradeId || gradeId === bound.maxGradeId;
}

/**
 * Pure reducer for one grade tap.
 *
 * Range mode off (one grade at a time):
 *   - tap the selected single grade -> Any (clear)
 *   - any other tap -> that single grade, also when `current` is a range
 * Range mode on (two taps make a range):
 *   - from Any or from a range -> single: the tapped grade is the first end
 *   - from a single grade, tap a different grade -> range [min, max]
 *   - from a single grade, tap it again -> Any (clear)
 */
export function computeGradeTap(current: GradeBound, tappedGradeId: number, rangeMode: boolean): GradeBound {
  const tappedAlone: GradeBound = { minGradeId: tappedGradeId, maxGradeId: tappedGradeId };
  const selectedGradeId = isSingleGrade(current) ? current.minGradeId : undefined;

  // Any, a range, or a half-set bound: the tap starts over on one grade.
  if (selectedGradeId === undefined) return tappedAlone;
  if (selectedGradeId === tappedGradeId) return clearGradeBound();
  if (!rangeMode) return tappedAlone;
  return {
    minGradeId: Math.min(selectedGradeId, tappedGradeId),
    maxGradeId: Math.max(selectedGradeId, tappedGradeId),
  };
}

/**
 * Turning range mode off while a range is set keeps the range's lower end as
 * the single grade. Any other bound is returned as is.
 */
export function collapseToLowerEnd(bound: GradeBound): GradeBound {
  if (!isRangeGrade(bound)) return bound;
  return { minGradeId: bound.minGradeId, maxGradeId: bound.minGradeId };
}
