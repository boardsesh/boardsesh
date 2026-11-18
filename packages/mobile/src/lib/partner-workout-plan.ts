import type { CreateWorkout, WorkoutBlock } from '@boardsesh/public-api';
import { BOULDER_GRADES, type BoulderGrade } from '@boardsesh/board-config';
import {
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_ON_THE_MINUTE_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type WorkoutPlan,
  type WorkoutStage,
  type StagedSlot,
} from '@boardsesh/playlist-generator';

type RequestedGrade = { scale: 'v'; value: number } | { scale: 'font'; value: string };

/** Compare against the full scale before selecting the nearest supported board grade. */
export function resolvePartnerGrade(
  request: RequestedGrade,
  grades: readonly BoulderGrade[],
): { grade: number; clamped: boolean } {
  if (grades.length === 0) throw new Error('No board grades');
  const matches = (grade: BoulderGrade) =>
    request.scale === 'v'
      ? grade.v_grade === `V${request.value}`
      : grade.font_grade.toUpperCase() === request.value.toUpperCase();
  const requested = grades.find(matches) ?? BOULDER_GRADES.find(matches);
  // The partner scale includes grades beyond Aurora's table. Clamp those at the boundary.
  // Aurora's legacy low labels are 4a–5c. The partner Font scale uses 4/4+/5/5+;
  // the lowest Moon grade is represented by difficulty 13 (5+).
  const lowFontIds: Readonly<Record<string, number>> = { '3': 0, '3+': 0, '4': 10, '4+': 11, '5': 12, '5+': 13 };
  const wantedId = requested?.difficulty_id ?? (request.scale === 'font' ? (lowFontIds[request.value] ?? 100) : 100);
  const nearest = grades.reduce((best, grade) =>
    Math.abs(grade.difficulty_id - wantedId) < Math.abs(best.difficulty_id - wantedId) ? grade : best,
  );
  return { grade: nearest.difficulty_id, clamped: requested === undefined || nearest.difficulty_id !== wantedId };
}

function rangeForBlock(block: WorkoutBlock, grades: readonly BoulderGrade[]) {
  if ('gradeRange' in block) {
    const from = resolvePartnerGrade(
      { scale: block.gradeRange.scale, value: block.gradeRange.from } as RequestedGrade,
      grades,
    );
    const to = resolvePartnerGrade(
      { scale: block.gradeRange.scale, value: block.gradeRange.to } as RequestedGrade,
      grades,
    );
    return { from: from.grade, to: to.grade, clamped: from.clamped || to.clamped };
  }
  if ('targetGrade' in block) {
    const target = resolvePartnerGrade(block.targetGrade, grades);
    return { from: target.grade, to: target.grade, clamped: target.clamped };
  }
  return null;
}

export function partnerBlockRunsNatively(block: WorkoutBlock): boolean {
  return block.type !== 'fourByFour' && block.type !== 'limitBouldering' && block.type !== 'freeClimbing';
}

/** One stage per native block, retaining explicit warm-up ranges and exact requested counts. */
export function buildPartnerWorkoutPlan(
  spec: CreateWorkout,
  grades: readonly BoulderGrade[],
  workoutId: string,
): {
  plan: WorkoutPlan;
  slots: StagedSlot[];
  clampedBlocks: number[];
} {
  const stages: WorkoutStage[] = [];
  const slots: StagedSlot[] = [];
  const clampedBlocks: number[] = [];
  for (const [index, block] of spec.blocks.entries()) {
    if (!partnerBlockRunsNatively(block) || !('climbCount' in block)) continue;
    const range = rangeForBlock(block, grades);
    if (!range) continue;
    if (range.clamped) clampedBlocks.push(index);
    const id = `${workoutId}:${index}`;
    let stage: WorkoutStage;
    switch (block.type) {
      case 'warmUp':
        stage = { id, kind: 'warmUp', warmUpType: 'standard', targetGrade: range.to };
        break;
      case 'volume':
        stage = {
          id,
          kind: 'volume',
          options: {
            ...DEFAULT_VOLUME_OPTIONS,
            targetGrade: range.to,
            warmUp: 'none',
            mainSetClimbs: block.climbCount,
          },
        };
        break;
      case 'pyramid':
        stage = { id, kind: 'pyramid', options: { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: range.to, warmUp: 'none' } };
        break;
      case 'ladder':
        stage = { id, kind: 'ladder', options: { ...DEFAULT_LADDER_OPTIONS, targetGrade: range.to, warmUp: 'none' } };
        break;
      case 'onTheMinute':
        stage = {
          id,
          kind: 'onTheMinute',
          options: {
            ...DEFAULT_ON_THE_MINUTE_OPTIONS,
            targetGrade: range.to,
            warmUp: 'none',
            numberOfClimbs: block.climbCount,
            intervalSeconds: block.intervalSeconds,
          },
        };
        break;
      default:
        stage = {
          id,
          kind: 'gradeFocus',
          options: {
            ...DEFAULT_GRADE_FOCUS_OPTIONS,
            targetGrade: range.to,
            warmUp: 'none',
            numberOfClimbs: block.climbCount,
          },
        };
    }
    stages.push(stage);
    const available = grades.filter((grade) => grade.difficulty_id >= range.from && grade.difficulty_id <= range.to);
    for (let position = 0; position < block.climbCount; position++) {
      const progress = block.climbCount === 1 ? 1 : position / (block.climbCount - 1);
      const peakHeight = block.climbCount % 2 === 0 ? (block.climbCount - 2) / (block.climbCount - 1) : 1;
      const ramp =
        block.type === 'pyramid' && block.climbCount > 2 ? (1 - Math.abs(2 * progress - 1)) / peakHeight : progress;
      const grade = available[Math.round(ramp * (available.length - 1))]?.difficulty_id ?? range.to;
      slots.push({ index: slots.length, grade, section: block.type === 'warmUp' ? 'warmUp' : 'main', stageId: id });
    }
  }
  return { plan: { stages }, slots, clampedBlocks };
}
