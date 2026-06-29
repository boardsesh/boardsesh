/**
 * Pure grade-range tap rules shared by the web GradeRangePicker and the mobile
 * GradePopover. The bounds are `{ minGradeId, maxGradeId }`:
 *   - both undefined = "Any" (filter cleared)
 *   - equal = single grade
 *   - unequal = range
 * The grade ids fed in MUST be ascending difficulty_ids.
 */

/**
 * Tapping a different chip while a single grade is selected only extends to a
 * range when the second tap lands within this window. Past it, the tap is
 * treated as a single-grade switch instead — matches user intent (rapid taps =
 * "I'm building a range", slow taps over a session = "I'm switching grades").
 */
export const RANGE_EXTEND_WINDOW_MS = 3000;

export type GradeBound = { minGradeId: number | undefined; maxGradeId: number | undefined };

/**
 * Optional metadata emitted with a tap result. Lets the call site fold
 * picker-internal context into analytics without the rule logic knowing about
 * the analytics layer.
 */
export type GradeTapMeta = {
  /**
   * Set only when the user tapped a different chip from the currently-selected
   * single grade. `true` = the second tap landed inside the
   * RANGE_EXTEND_WINDOW_MS window from the first tap and was treated as range
   * extension. `false` = the window had expired so we switched single grade
   * (avoiding an accidental range). Undefined for all other rules.
   */
  extendedRangeWithinWindow?: boolean;
};

export type GradeTapResult = { next: GradeBound; meta?: GradeTapMeta };

/** The shape of a grade bound, for analytics. */
export type GradeFilterShape = { kind: 'any' | 'single' | 'range'; size: number | null };

/**
 * Classify a grade bound for analytics: "any" (cleared), "single" (one grade,
 * size 1), or "range" (size = count of grades spanned, inclusive). `gradeIds`
 * MUST be ascending difficulty_ids; ids absent from it (legacy one-sided
 * bookmarks) fall through to a range with null size. Shared so web and mobile
 * classify the `Grade Filter Changed` event identically.
 */
export function describeGradeFilter(bound: GradeBound, gradeIds: readonly number[]): GradeFilterShape {
  const { minGradeId, maxGradeId } = bound;
  if (minGradeId === undefined && maxGradeId === undefined) {
    return { kind: 'any', size: null };
  }
  if (minGradeId !== undefined && maxGradeId !== undefined) {
    if (minGradeId === maxGradeId) return { kind: 'single', size: 1 };
    const minIdx = gradeIds.indexOf(minGradeId);
    const maxIdx = gradeIds.indexOf(maxGradeId);
    const size = minIdx >= 0 && maxIdx >= 0 ? maxIdx - minIdx + 1 : null;
    return { kind: 'range', size };
  }
  return { kind: 'range', size: null };
}

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
 * Pure reducer for one chip tap. `gradeIds` MUST be ascending difficulty_ids.
 * `withinExtendWindow` = caller's timer says the tap is inside
 * RANGE_EXTEND_WINDOW_MS of the last fresh single-grade selection. Implements
 * rules 1-6 + clear-on-resame:
 *   1. From Any -> single. 2. Tap the same single grade -> Any (clear).
 *   3. From single, tap a different chip: within window -> range [min,max];
 *      else -> switch single.
 *   4. From range, tap an endpoint -> trim inward (collapse to surviving
 *      endpoint if it inverts).
 *   5. From range, tap interior -> collapse to that single grade.
 *   6. From range, tap outside -> collapse to that single grade.
 */
export function computeGradeTap(
  current: GradeBound,
  gradeIds: number[],
  tappedGradeId: number,
  withinExtendWindow: boolean,
): GradeTapResult {
  const { minGradeId, maxGradeId } = current;

  if (isRangeGrade(current) && minGradeId !== undefined && maxGradeId !== undefined) {
    // Rule 4: tapping an endpoint of a range trims it. The other endpoint is
    // preserved; the tapped endpoint moves inward by one grade (still within
    // the range). If the trim collapses min > max, settle on the surviving
    // endpoint as a single grade.
    if (tappedGradeId === minGradeId) {
      const minIdx = gradeIds.findIndex((id) => id === minGradeId);
      const nextMinIdx = minIdx + 1;
      if (nextMinIdx < gradeIds.length && gradeIds[nextMinIdx] <= maxGradeId) {
        const newMin = gradeIds[nextMinIdx];
        return { next: { minGradeId: newMin, maxGradeId } };
      }
      // Trim would invert; collapse to the surviving (max) endpoint.
      return { next: { minGradeId: maxGradeId, maxGradeId } };
    }
    if (tappedGradeId === maxGradeId) {
      const maxIdx = gradeIds.findIndex((id) => id === maxGradeId);
      const nextMaxIdx = maxIdx - 1;
      if (nextMaxIdx >= 0 && gradeIds[nextMaxIdx] >= minGradeId) {
        const newMax = gradeIds[nextMaxIdx];
        return { next: { minGradeId, maxGradeId: newMax } };
      }
      return { next: { minGradeId, maxGradeId: minGradeId } };
    }
    // Rules 5 & 6: interior or outside — collapse to the tapped grade.
    return { next: { minGradeId: tappedGradeId, maxGradeId: tappedGradeId } };
  }

  if (isSingleGrade(current)) {
    if (minGradeId === tappedGradeId) {
      // Rule 2: tap the same single grade -> Any (clear).
      return { next: clearGradeBound() };
    }
    // Rule 3 is time-gated: rapid taps after a fresh single-grade pick build a
    // range; slow taps switch single grade. Avoids accidentally creating a
    // range during the user's primary single-grade workflow (warm-up V4, then
    // climb V6 30s later — V6 should *replace*, not extend).
    if (withinExtendWindow) {
      const otherId = minGradeId as number;
      const lo = Math.min(otherId, tappedGradeId);
      const hi = Math.max(otherId, tappedGradeId);
      return { next: { minGradeId: lo, maxGradeId: hi }, meta: { extendedRangeWithinWindow: true } };
    }
    return {
      next: { minGradeId: tappedGradeId, maxGradeId: tappedGradeId },
      meta: { extendedRangeWithinWindow: false },
    };
  }

  // Rule 1: "Any" or any other state — collapse to single grade.
  return { next: { minGradeId: tappedGradeId, maxGradeId: tappedGradeId } };
}
