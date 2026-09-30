import { gradeBandFromId, type GradeOption } from '../grades/grades';

/** One stop on the grade slider: a label and every difficulty id shown as it. */
export type GradeStop = { label: string; difficultyIds: number[] };

/** Difficulty ids, inclusive; null is an open end. */
export type GradeRange = { minGrade: number | null; maxGrade: number | null };

/** The stops under the two thumbs, easiest first. They can share a stop. */
export type StopRange = { min: number; max: number };

export type Thumb = 'min' | 'max';

/**
 * The board's grades as slider stops, easiest first. On the V scale neighbouring
 * difficulty ids often share a label (6a and 6a+ are both V3), so they share a stop.
 */
export function gradeStops(options: readonly GradeOption[]): GradeStop[] {
  const stops: GradeStop[] = [];
  for (const option of options) {
    const last = stops[stops.length - 1];
    if (last?.label === option.label) last.difficultyIds.push(option.difficultyId);
    else stops.push({ label: option.label, difficultyIds: [option.difficultyId] });
  }
  return stops;
}

const lowest = (stop: GradeStop) => stop.difficultyIds[0];
const highest = (stop: GradeStop) => stop.difficultyIds[stop.difficultyIds.length - 1];

/** Where a grade filter puts the thumbs. An open end puts its thumb at that end of the scale. */
export function stopRange(stops: readonly GradeStop[], { minGrade, maxGrade }: GradeRange): StopRange {
  const last = Math.max(0, stops.length - 1);
  let min = 0;
  if (minGrade !== null) {
    min = stops.findIndex((stop) => highest(stop) >= minGrade);
    if (min === -1) min = last;
  }
  let max = last;
  if (maxGrade !== null) {
    while (max > 0 && lowest(stops[max]) > maxGrade) max -= 1;
  }
  return { min, max: Math.max(min, max) };
}

/** The grade filter the thumbs make. A thumb at either end of the scale leaves that end open. */
export function rangeFromStops(stops: readonly GradeStop[], { min, max }: StopRange): GradeRange {
  const last = stops.length - 1;
  return {
    minGrade: min <= 0 ? null : lowest(stops[min]),
    maxGrade: max >= last ? null : highest(stops[max]),
  };
}

/**
 * The thumb a touch at `index` moves: the nearer one. When both are as near,
 * the drag's direction decides (negative is left), so level thumbs can part either way.
 */
export function thumbFor({ min, max }: StopRange, index: number, direction: number): Thumb {
  if (index < min) return 'min';
  if (index > max) return 'max';
  const toMin = index - min;
  const toMax = max - index;
  if (toMin !== toMax) return toMin < toMax ? 'min' : 'max';
  return direction < 0 ? 'min' : 'max';
}

/** Moves one thumb to `index`. It stops at the other thumb, so the range never turns inside out. */
export function moveThumb({ min, max }: StopRange, thumb: Thumb, index: number): StopRange {
  return thumb === 'min' ? { min: Math.min(index, max), max } : { min, max: Math.max(index, min) };
}

/** The stops where a new grade band begins: where the scale gets its labels. */
export function bandStarts(stops: readonly GradeStop[]): number[] {
  return stops.flatMap((stop, index) =>
    index === 0 || gradeBandFromId(lowest(stop)) !== gradeBandFromId(lowest(stops[index - 1])) ? [index] : [],
  );
}
