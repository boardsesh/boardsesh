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
 * The grades a block's slots draw from, as `bands`, easiest first: the groups of
 * difficulty ids a slot can pick from. A V grade is one band, every Font grade
 * the board's table gives it; a Font grade is a band of one. A target grade is
 * one band; a range is every band from its bottom to its top, V bands whole.
 * `target` is the grade the block's stage is labelled with: the lowest id of the
 * target band, or of the range's top band.
 */
function rangeForBlock(
  block: WorkoutBlock,
  grades: readonly BoulderGrade[],
): { bands: number[][]; target: number; clamped: boolean } | null {
  if ('gradeRange' in block) {
    const from = resolvePartnerGrade(
      { scale: block.gradeRange.scale, value: block.gradeRange.from } as RequestedGrade,
      grades,
    );
    const to = resolvePartnerGrade(
      { scale: block.gradeRange.scale, value: block.gradeRange.to } as RequestedGrade,
      grades,
    );
    const lowest = from.band[0];
    const highest = to.band.at(-1)!;
    const inRange = grades.filter((grade) => grade.difficulty_id >= lowest && grade.difficulty_id <= highest);
    const bands: number[][] = [];
    // A V range ramps over V grades, not Font grades, so V0's three Font
    // grades do not crowd out V1's two. A Font range ramps over Font grades.
    for (const [position, grade] of inRange.entries()) {
      const sameBand = block.gradeRange.scale === 'v' && inRange[position - 1]?.v_grade === grade.v_grade;
      if (sameBand) bands.at(-1)!.push(grade.difficulty_id);
      else bands.push([grade.difficulty_id]);
    }
    return { bands: bands.length > 0 ? bands : [[to.grade]], target: to.grade, clamped: from.clamped || to.clamped };
  }
  if ('targetGrade' in block) {
    const target = resolvePartnerGrade(block.targetGrade, grades);
    return { bands: [target.band], target: target.grade, clamped: target.clamped };
  }
  return null;
}

/** A planned slot, with the V band it may fill from (`PreviewSlot.band`). */
export type PartnerSlot = StagedSlot & { band?: readonly number[] };

export function partnerBlockRunsNatively(block: WorkoutBlock): boolean {
  return block.type !== 'limitBouldering' && block.type !== 'freeClimbing';
}

/** One stage per native block, retaining explicit warm-up ranges and exact requested counts. */
export function buildPartnerWorkoutPlan(
  spec: CreateWorkout,
  grades: readonly BoulderGrade[],
  workoutId: string,
): {
  plan: WorkoutPlan;
  slots: PartnerSlot[];
  clampedBlocks: number[];
} {
  const stages: WorkoutStage[] = [];
  const slots: PartnerSlot[] = [];
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
    const firstSlotIndex = slots.length;
    const slotCount = block.climbCount * (block.type === 'fourByFour' ? block.rounds : 1);
    const { bands } = range;
    // How many slots each band has given a grade so far: a band's slots take
    // turns across its Font grades, so a V grade draws from each of them and a
    // short one fills from its band mates first (`PreviewSlot.band`).
    const usesByBand = bands.map(() => 0);
    for (let position = 0; position < slotCount; position++) {
      const progress = block.climbCount === 1 ? 1 : position / (block.climbCount - 1);
      const peakHeight = block.climbCount % 2 === 0 ? (block.climbCount - 2) / (block.climbCount - 1) : 1;
      const ramp =
        block.type === 'pyramid' && block.climbCount > 2 ? (1 - Math.abs(2 * progress - 1)) / peakHeight : progress;
      const bandIndex = Math.round(ramp * (bands.length - 1));
      const band = bands[bandIndex];
      const grade = band[usesByBand[bandIndex]++ % band.length];
      slots.push({
        index: slots.length,
        ...(block.type === 'fourByFour' && position >= block.climbCount
          ? { repeatOfIndex: firstSlotIndex + (position % block.climbCount) }
          : {}),
        grade,
        section: block.type === 'warmUp' ? 'warmUp' : 'main',
        stageId: id,
        ...(band.length > 1 ? { band } : {}),
      });
    }
  }
  return { plan: { stages }, slots, clampedBlocks };
}
