import type { Climb } from '@boardsesh/shared-schema';

export type RandomSource = () => number;

/** A climb chosen for one slot of the plan, with the grade that slot asked for. */
export type PlannedClimb = { climb: Climb; grade: number };

export function shuffled<T>(items: readonly T[], random: RandomSource = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

/**
 * One distinct climb per planned grade, taken in order from each grade's pool.
 * A grade whose pool has run out is dropped and counted in `missing`.
 */
export function pickClimbs(
  grades: readonly number[],
  pools: ReadonlyMap<number, readonly Climb[]>,
): { planned: PlannedClimb[]; missing: number } {
  const used = new Set<string>();
  const planned: PlannedClimb[] = [];
  let missing = 0;
  for (const grade of grades) {
    const next = (pools.get(grade) ?? []).find((climb) => !used.has(climb.uuid));
    if (!next) {
      missing += 1;
      continue;
    }
    used.add(next.uuid);
    planned.push({ climb: next, grade });
  }
  return { planned, missing };
}

/** A different climb for slot `index` at the same grade, never one already in the plan. */
export function swapClimb(
  planned: readonly PlannedClimb[],
  index: number,
  pools: ReadonlyMap<number, readonly Climb[]>,
  random: RandomSource = Math.random,
): PlannedClimb[] {
  const slot = planned[index];
  if (!slot) return [...planned];
  const used = new Set(planned.map((entry) => entry.climb.uuid));
  const candidates = (pools.get(slot.grade) ?? []).filter((climb) => !used.has(climb.uuid));
  if (candidates.length === 0) return [...planned];
  const replacement = candidates[Math.floor(random() * candidates.length)];
  return planned.map((entry, entryIndex) => (entryIndex === index ? { ...entry, climb: replacement } : entry));
}
