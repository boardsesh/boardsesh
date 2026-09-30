import type { Climb, ClimbSearchInput } from '@boardsesh/shared-schema';
import { SEARCH_CLIMBS, type ClimbSearchResponse } from '@boardsesh/graphql/operations/climb-search';
import { graphqlRequest } from '../api/graphql-client';
import { toSearchConfig, type ActiveBoard } from '../board/active-board';
import { shuffled } from './pick-climbs';

// Enough variety to shuffle and swap from, at one search per grade.
const POOL_SIZE = 50;

async function searchGrade(board: ActiveBoard, grade: number, unsentOnly: boolean): Promise<Climb[]> {
  const input: ClimbSearchInput = {
    ...toSearchConfig(board),
    minGrade: grade,
    maxGrade: grade,
    page: 0,
    pageSize: POOL_SIZE,
    // The best-rated climbs at each grade, so a workout is made of good problems.
    sortBy: 'quality',
    sortOrder: 'desc',
    boulders: true,
    ...(unsentOnly ? { hideCompleted: true } : {}),
  };
  return (await graphqlRequest<ClimbSearchResponse>(SEARCH_CLIMBS, { input })).searchClimbs.climbs;
}

/**
 * A shuffled pool of climbs for each grade in the plan. With `unsentOnly`, a
 * grade that doesn't have enough unsent climbs is topped up with sent ones,
 * listed after them, so the workout still fills.
 */
export async function fetchGradePools(
  board: ActiveBoard,
  grades: readonly number[],
  options: { unsentOnly: boolean },
): Promise<Map<number, Climb[]>> {
  const neededPerGrade = new Map<number, number>();
  for (const grade of grades) neededPerGrade.set(grade, (neededPerGrade.get(grade) ?? 0) + 1);

  const pools = new Map<number, Climb[]>();
  await Promise.all(
    [...neededPerGrade.entries()].map(async ([grade, needed]) => {
      const first = shuffled(await searchGrade(board, grade, options.unsentOnly));
      if (!options.unsentOnly || first.length >= needed) {
        pools.set(grade, first);
        return;
      }
      const seen = new Set(first.map((climb) => climb.uuid));
      const topUp = shuffled((await searchGrade(board, grade, false)).filter((climb) => !seen.has(climb.uuid)));
      pools.set(grade, [...first, ...topUp]);
    }),
  );
  return pools;
}
