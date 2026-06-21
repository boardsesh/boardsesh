import {
  type GeneratorGradeScale,
  type GeneratorOptions,
  type GradeFocusOptions,
  type LadderOptions,
  type PlannedClimbSlot,
  type PyramidOptions,
  type VolumeOptions,
  type WarmUpType,
  WARM_UP_CONFIG,
} from './types';

const clampGrade = (grade: number, grades: GeneratorGradeScale): number => {
  const minGrade = grades[0]?.difficulty_id ?? grade;
  const maxGrade = grades[grades.length - 1]?.difficulty_id ?? grade;
  return Math.max(minGrade, Math.min(maxGrade, grade));
};

const getTargetGradeIndex = (targetGrade: number, grades: GeneratorGradeScale): number => {
  if (grades.length === 0) return -1;
  const targetIndex = grades.findIndex((grade) => grade.difficulty_id >= targetGrade);
  return targetIndex >= 0 ? targetIndex : grades.length - 1;
};

const getPyramidGrade = (targetGrade: number, distanceFromPeak: number, grades: GeneratorGradeScale): number => {
  if (distanceFromPeak === 0) return targetGrade;
  if (grades.length === 0) return targetGrade - distanceFromPeak;
  const targetIndex = getTargetGradeIndex(targetGrade, grades);
  const gradeIndex = Math.max(0, targetIndex - distanceFromPeak);
  return grades[gradeIndex].difficulty_id;
};

const generateWarmUp = (
  targetGrade: number,
  warmUpType: WarmUpType,
  grades: GeneratorGradeScale,
): PlannedClimbSlot[] => {
  if (warmUpType === 'none' || grades.length === 0) {
    return [];
  }

  const config = WARM_UP_CONFIG[warmUpType];
  const slots: PlannedClimbSlot[] = [];

  // Iterate over the grades array by index — difficulty_id values aren't
  // guaranteed to be dense contiguous integers (MoonBoard starts at 13;
  // future boards may skip values entirely). Walking the array keeps the
  // warm-up grounded in the real grade table.
  const targetIndex = grades.findIndex((grade) => grade.difficulty_id >= targetGrade);
  if (targetIndex <= 0) return [];

  const startIndex = Math.max(0, targetIndex - config.grades);
  let slotIndex = 0;

  for (let i = startIndex; i < targetIndex; i++) {
    for (let copy = 0; copy < config.climbsPerGrade; copy++) {
      slots.push({
        grade: grades[i].difficulty_id,
        section: 'warmUp',
        index: slotIndex++,
      });
    }
  }

  return slots;
};

export const generateVolumePlan = (options: VolumeOptions, grades: GeneratorGradeScale): PlannedClimbSlot[] => {
  const slots: PlannedClimbSlot[] = [];

  slots.push(...generateWarmUp(options.targetGrade, options.warmUp, grades));

  const mainStartIndex = slots.length;

  for (let i = 0; i < options.mainSetClimbs; i++) {
    let grade: number;
    if (options.mainSetVariability === 0) {
      grade = options.targetGrade;
    } else {
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

export const generatePyramidPlan = (options: PyramidOptions, grades: GeneratorGradeScale): PlannedClimbSlot[] => {
  const slots: PlannedClimbSlot[] = [];

  const warmUpSlots = generateWarmUp(options.targetGrade, options.warmUp, grades);
  slots.push(...warmUpSlots);

  const stepCount = Math.max(0, options.numberOfSteps);
  const climbsPerStep = Math.max(0, options.climbsPerStep);
  const center = (stepCount - 1) / 2;
  let currentIndex = slots.length;

  for (let step = 0; step < stepCount; step++) {
    const distanceFromPeak = Math.floor(Math.abs(step - center));
    const grade = getPyramidGrade(options.targetGrade, distanceFromPeak, grades);
    const section = distanceFromPeak === 0 ? 'peak' : step < center ? 'increasing' : 'decreasing';

    for (let climb = 0; climb < climbsPerStep; climb++) {
      slots.push({
        grade,
        section,
        index: currentIndex++,
      });
    }
  }

  return slots;
};

export const generateLadderPlan = (options: LadderOptions, grades: GeneratorGradeScale): PlannedClimbSlot[] => {
  const slots: PlannedClimbSlot[] = [];

  const warmUpSlots = generateWarmUp(options.targetGrade, options.warmUp, grades);
  slots.push(...warmUpSlots);

  const stepCount = Math.max(0, options.numberOfSteps);
  const climbsPerStep = Math.max(0, options.climbsPerStep);
  const targetIndex = getTargetGradeIndex(options.targetGrade, grades);
  const startIndex = targetIndex >= 0 ? Math.max(0, targetIndex - stepCount + 1) : -1;
  let currentIndex = slots.length;

  for (let step = 0; step < stepCount; step++) {
    const grade =
      step === stepCount - 1
        ? options.targetGrade
        : targetIndex >= 0
          ? grades[Math.min(targetIndex, startIndex + step)].difficulty_id
          : options.targetGrade - (stepCount - step - 1);

    for (let climb = 0; climb < climbsPerStep; climb++) {
      slots.push({
        grade,
        section: step === stepCount - 1 ? 'peak' : 'increasing',
        index: currentIndex++,
      });
    }
  }

  return slots;
};

export const generateGradeFocusPlan = (options: GradeFocusOptions, grades: GeneratorGradeScale): PlannedClimbSlot[] => {
  const slots: PlannedClimbSlot[] = [];

  slots.push(...generateWarmUp(options.targetGrade, options.warmUp, grades));

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

export const generateWorkoutPlan = (options: GeneratorOptions, grades: GeneratorGradeScale): PlannedClimbSlot[] => {
  switch (options.type) {
    case 'volume':
      return generateVolumePlan(options, grades);
    case 'pyramid':
      return generatePyramidPlan(options, grades);
    case 'ladder':
      return generateLadderPlan(options, grades);
    case 'gradeFocus':
      return generateGradeFocusPlan(options, grades);
    default: {
      // Exhaustiveness check — a new WorkoutType variant fails to compile
      // here rather than silently emitting an empty plan.
      const _exhaustive: never = options;
      void _exhaustive;
      return [];
    }
  }
};

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
        groups.push({ section: currentSection, slots: [...currentGroup] });
      }
      currentSection = slot.section;
      currentGroup = [slot];
    } else {
      currentGroup.push(slot);
    }
  }

  if (currentSection && currentGroup.length > 0) {
    groups.push({ section: currentSection, slots: currentGroup });
  }

  return groups;
};
