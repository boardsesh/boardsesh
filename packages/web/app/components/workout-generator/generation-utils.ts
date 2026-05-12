// Playlist Generation Utilities

import { getGradesForBoard } from '@/app/lib/board-data';
import type { BoardName } from '@/app/lib/types';
import {
  type GeneratorOptions,
  type PlannedClimbSlot,
  type VolumeOptions,
  type PyramidOptions,
  type LadderOptions,
  type GradeFocusOptions,
  WARM_UP_CONFIG,
} from './types';

type GradeScale = ReturnType<typeof getGradesForBoard>;

// Clamp grade to valid range
const clampGrade = (grade: number, grades: GradeScale): number => {
  const minGrade = grades[0]?.difficulty_id ?? grade;
  const maxGrade = grades[grades.length - 1]?.difficulty_id ?? grade;
  return Math.max(minGrade, Math.min(maxGrade, grade));
};

// Generate warm-up slots
const generateWarmUp = (
  targetGrade: number,
  warmUpType: 'standard' | 'extended' | 'none',
  grades: GradeScale,
): PlannedClimbSlot[] => {
  if (warmUpType === 'none') {
    return [];
  }

  const config = WARM_UP_CONFIG[warmUpType];
  const slots: PlannedClimbSlot[] = [];

  // Start from lower grades and work up
  const startGrade = clampGrade(targetGrade - config.grades, grades);
  const minGrade = grades[0]?.difficulty_id ?? startGrade;
  let index = 0;

  for (let grade = startGrade; grade < targetGrade; grade++) {
    if (grade < minGrade) continue;

    for (let i = 0; i < config.climbsPerGrade; i++) {
      slots.push({
        grade: clampGrade(grade, grades),
        section: 'warmUp',
        index: index++,
      });
    }
  }

  return slots;
};

// Generate Volume workout plan
export const generateVolumePlan = (options: VolumeOptions, grades: GradeScale): PlannedClimbSlot[] => {
  const slots: PlannedClimbSlot[] = [];

  // Add warm-up
  const warmUpSlots = generateWarmUp(options.targetGrade, options.warmUp, grades);
  slots.push(...warmUpSlots);

  // Add main set with variability
  const mainStartIndex = slots.length;

  for (let i = 0; i < options.mainSetClimbs; i++) {
    // Distribute climbs across the grade range
    let grade: number;
    if (options.mainSetVariability === 0) {
      grade = options.targetGrade;
    } else {
      // Weighted distribution favoring target grade
      const offset = Math.round((Math.random() * 2 - 1) * options.mainSetVariability);
      grade = clampGrade(options.targetGrade + offset, grades);
    }

    slots.push({
      grade,
      section: 'main',
      index: mainStartIndex + i,
    });
  }

  return slots;
};

// Generate Pyramid workout plan
export const generatePyramidPlan = (options: PyramidOptions, grades: GradeScale): PlannedClimbSlot[] => {
  const slots: PlannedClimbSlot[] = [];

  // Add warm-up
  const warmUpSlots = generateWarmUp(options.targetGrade, options.warmUp, grades);
  slots.push(...warmUpSlots);

  // Calculate step size
  // Start from a lower grade, peak at target, then come back down
  const warmUpEndGrade =
    warmUpSlots.length > 0
      ? warmUpSlots[warmUpSlots.length - 1].grade
      : clampGrade(options.targetGrade - options.numberOfSteps, grades);

  const stepsUp = Math.floor(options.numberOfSteps / 2) + 1;
  const stepsDown = options.numberOfSteps - stepsUp + 1;

  const gradeIncrement = Math.max(1, Math.floor((options.targetGrade - warmUpEndGrade) / Math.max(1, stepsUp - 1)));

  let currentIndex = slots.length;

  // Increasing phase
  for (let step = 0; step < stepsUp; step++) {
    const grade =
      step === stepsUp - 1 ? options.targetGrade : clampGrade(warmUpEndGrade + gradeIncrement * step, grades);

    for (let i = 0; i < options.climbsPerStep; i++) {
      slots.push({
        grade,
        section: step === stepsUp - 1 ? 'peak' : 'increasing',
        index: currentIndex++,
      });
    }
  }

  // Decreasing phase
  for (let step = 1; step < stepsDown; step++) {
    const grade = clampGrade(options.targetGrade - gradeIncrement * step, grades);

    for (let i = 0; i < options.climbsPerStep; i++) {
      slots.push({
        grade,
        section: 'decreasing',
        index: currentIndex++,
      });
    }
  }

  return slots;
};

// Generate Ladder workout plan
export const generateLadderPlan = (options: LadderOptions, grades: GradeScale): PlannedClimbSlot[] => {
  const slots: PlannedClimbSlot[] = [];

  // Add warm-up
  const warmUpSlots = generateWarmUp(options.targetGrade, options.warmUp, grades);
  slots.push(...warmUpSlots);

  // Calculate starting grade and step size
  const warmUpEndGrade =
    warmUpSlots.length > 0
      ? warmUpSlots[warmUpSlots.length - 1].grade
      : clampGrade(options.targetGrade - options.numberOfSteps, grades);

  const gradeIncrement = Math.max(
    1,
    Math.floor((options.targetGrade - warmUpEndGrade) / Math.max(1, options.numberOfSteps - 1)),
  );

  let currentIndex = slots.length;

  // Increasing phase only (ladder goes up)
  for (let step = 0; step < options.numberOfSteps; step++) {
    const grade =
      step === options.numberOfSteps - 1
        ? options.targetGrade
        : clampGrade(warmUpEndGrade + gradeIncrement * step, grades);

    for (let i = 0; i < options.climbsPerStep; i++) {
      slots.push({
        grade,
        section: step === options.numberOfSteps - 1 ? 'peak' : 'increasing',
        index: currentIndex++,
      });
    }
  }

  return slots;
};

// Generate Grade Focus workout plan
export const generateGradeFocusPlan = (options: GradeFocusOptions, grades: GradeScale): PlannedClimbSlot[] => {
  const slots: PlannedClimbSlot[] = [];

  // Add warm-up
  const warmUpSlots = generateWarmUp(options.targetGrade, options.warmUp, grades);
  slots.push(...warmUpSlots);

  // All climbs at target grade
  const mainStartIndex = slots.length;

  for (let i = 0; i < options.numberOfClimbs; i++) {
    slots.push({
      grade: options.targetGrade,
      section: 'main',
      index: mainStartIndex + i,
    });
  }

  return slots;
};

// Main function to generate plan based on options
export const generateWorkoutPlan = (options: GeneratorOptions, boardName: BoardName): PlannedClimbSlot[] => {
  const grades = getGradesForBoard(boardName);
  switch (options.type) {
    case 'volume':
      return generateVolumePlan(options, grades);
    case 'pyramid':
      return generatePyramidPlan(options, grades);
    case 'ladder':
      return generateLadderPlan(options, grades);
    case 'gradeFocus':
      return generateGradeFocusPlan(options, grades);
    default:
      return [];
  }
};

// Get grade name from difficulty_id
export const getGradeName = (difficultyId: number, boardName: BoardName): string => {
  const grade = getGradesForBoard(boardName).find((g) => g.difficulty_id === difficultyId);
  return grade?.difficulty_name || `Grade ${difficultyId}`;
};

// Group slots by section for display. Callers translate `section` via the
// `playlists` namespace at `generator.sections.<section>` to render the label.
export type GroupedSlots = {
  section: PlannedClimbSlot['section'];
  slots: PlannedClimbSlot[];
};

export const groupSlotsBySection = (slots: PlannedClimbSlot[]): GroupedSlots[] => {
  const groups: GroupedSlots[] = [];
  let currentSection: PlannedClimbSlot['section'] | null = null;
  let currentGroup: PlannedClimbSlot[] = [];

  for (const slot of slots) {
    if (slot.section !== currentSection) {
      if (currentSection && currentGroup.length > 0) {
        groups.push({
          section: currentSection,
          slots: [...currentGroup],
        });
      }
      currentSection = slot.section;
      currentGroup = [slot];
    } else {
      currentGroup.push(slot);
    }
  }

  // Add final group
  if (currentSection && currentGroup.length > 0) {
    groups.push({
      section: currentSection,
      slots: currentGroup,
    });
  }

  return groups;
};
