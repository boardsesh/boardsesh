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

/**
 * Compare against the full scale before selecting the nearest supported board grade.
 * `grade` is the lowest difficulty id the request names on this board. `band` is
 * every id it names, lowest first: a V grade spans each Font grade the board's own
 * table gives it (Kilter V4 is 6b and 6b+; MoonBoard labels 6A as V2, so its V3 is
 * 6A+ alone). A Font grade, or a grade clamped onto the board, is one id.
 */
export function resolvePartnerGrade(
  request: RequestedGrade,
  grades: readonly BoulderGrade[],
): { grade: number; band: number[]; clamped: boolean } {
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
  const clamped = requested === undefined || nearest.difficulty_id !== wantedId;
  const band =
    request.scale === 'v' && !clamped
      ? grades.filter(matches).map((grade) => grade.difficulty_id)
      : [nearest.difficulty_id];
  return { grade: nearest.difficulty_id, band, clamped };
}

/**
 * The grades a block's slots draw from: `from` and `to`, the lowest and highest
 * difficulty ids, with every V band whole, and `target`, the grade its stage is
 * labelled with (the lowest id of the target, or of the range's top, band).
 * `band` is set for a single target grade: its slots take turns across it.
 */
function rangeForBlock(
  block: WorkoutBlock,
  grades: readonly BoulderGrade[],
): { from: number; to: number; target: number; band?: number[]; clamped: boolean } | null {
  if ('gradeRange' in block) {
    const from = resolvePartnerGrade(
      { scale: block.gradeRange.scale, value: block.gradeRange.from } as RequestedGrade,
      grades,
    );
    const to = resolvePartnerGrade(
      { scale: block.gradeRange.scale, value: block.gradeRange.to } as RequestedGrade,
      grades,
    );
    return { from: from.band[0], to: to.band.at(-1)!, target: to.grade, clamped: from.clamped || to.clamped };
  }
  if ('targetGrade' in block) {
    const target = resolvePartnerGrade(block.targetGrade, grades);
    return {
      from: target.band[0],
      to: target.band.at(-1)!,
      target: target.grade,
      band: target.band,
      clamped: target.clamped,
    };
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
        stage = { id, kind: 'warmUp', warmUpType: 'standard', targetGrade: range.target };
        break;
      case 'volume':
        stage = {
          id,
          kind: 'volume',
          options: {
            ...DEFAULT_VOLUME_OPTIONS,
            targetGrade: range.target,
            warmUp: 'none',
            mainSetClimbs: block.climbCount,
          },
        };
        break;
      case 'pyramid':
        stage = {
          id,
          kind: 'pyramid',
          options: { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: range.target, warmUp: 'none' },
        };
        break;
      case 'ladder':
        stage = {
          id,
          kind: 'ladder',
          options: { ...DEFAULT_LADDER_OPTIONS, targetGrade: range.target, warmUp: 'none' },
        };
        break;
      case 'onTheMinute':
        stage = {
          id,
          kind: 'onTheMinute',
          options: {
            ...DEFAULT_ON_THE_MINUTE_OPTIONS,
            targetGrade: range.target,
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
            targetGrade: range.target,
            warmUp: 'none',
            numberOfClimbs: block.climbCount,
          },
        };
    }
    stages.push(stage);
    const available = grades.filter((grade) => grade.difficulty_id >= range.from && grade.difficulty_id <= range.to);
    const { band } = range;
    for (let position = 0; position < block.climbCount; position++) {
      const progress = block.climbCount === 1 ? 1 : position / (block.climbCount - 1);
      const peakHeight = block.climbCount % 2 === 0 ? (block.climbCount - 2) / (block.climbCount - 1) : 1;
      const ramp =
        block.type === 'pyramid' && block.climbCount > 2 ? (1 - Math.abs(2 * progress - 1)) / peakHeight : progress;
      // One target grade: the slots take turns across its band, so a V grade
      // draws from each Font grade in it and a short one borrows from the next.
      const grade = band
        ? band[position % band.length]
        : (available[Math.round(ramp * (available.length - 1))]?.difficulty_id ?? range.to);
      slots.push({ index: slots.length, grade, section: block.type === 'warmUp' ? 'warmUp' : 'main', stageId: id });
    }
  }
  return { plan: { stages }, slots, clampedBlocks };
}
