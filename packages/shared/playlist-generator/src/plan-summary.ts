import { groupSlotsBySection } from './generate';
import type { PlannedClimbSlot } from './types';

export type PlanSectionCount = {
  section: PlannedClimbSlot['section'];
  count: number;
};

/**
 * What a filled plan will actually start: how many of the planned climbs found
 * a climb, the grade span of the ones that did, and the run of sections they
 * fall into. Callers pass the slots the climbs were picked for, so a slot a
 * thin catalogue couldn't fill drops out of every number here.
 */
export type PlanFillSummary = {
  planned: number;
  filled: number;
  /** Planned slots with no climb. Never negative. */
  missing: number;
  /** Lowest and highest difficulty id among the filled slots; null when none filled. */
  lowestGrade: number | null;
  highestGrade: number | null;
  /** Consecutive runs of the filled slots, in workout order. */
  sections: PlanSectionCount[];
};

export const summarizePlanFill = (
  planned: readonly PlannedClimbSlot[],
  filled: readonly PlannedClimbSlot[],
): PlanFillSummary => {
  const grades = filled.map((slot) => slot.grade);
  return {
    planned: planned.length,
    filled: filled.length,
    missing: Math.max(0, planned.length - filled.length),
    lowestGrade: grades.length > 0 ? Math.min(...grades) : null,
    highestGrade: grades.length > 0 ? Math.max(...grades) : null,
    sections: groupSlotsBySection([...filled]).map((group) => ({ section: group.section, count: group.slots.length })),
  };
};
