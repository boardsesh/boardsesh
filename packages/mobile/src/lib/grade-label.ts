// Grade-id → label + quality → stars, ported from packages/db so the offline
// local-search path produces the SAME `difficulty` string ("6a/V3") and `stars`
// count the server does — mobile doesn't depend on @boardsesh/db (drizzle/pg),
// so these tiny pure functions are duplicated rather than imported. Keep the map
// and the star logic in lockstep with packages/db/src/queries/climbs/{grade-lookup,climb-stars}.ts.

const GRADE_MAP: Record<number, string> = {
  10: '4a/V0',
  11: '4b/V0',
  12: '4c/V0',
  13: '5a/V1',
  14: '5b/V1',
  15: '5c/V2',
  16: '6a/V3',
  17: '6a+/V3',
  18: '6b/V4',
  19: '6b+/V4',
  20: '6c/V5',
  21: '6c+/V5',
  22: '7a/V6',
  23: '7a+/V7',
  24: '7b/V8',
  25: '7b+/V8',
  26: '7c/V9',
  27: '7c+/V10',
  28: '8a/V11',
  29: '8a+/V12',
  30: '8b/V13',
  31: '8b+/V14',
  32: '8c/V15',
  33: '8c+/V16',
};

/** Boulder grade label for a rounded difficulty id, or '' when out of range / null. */
export function getGradeLabel(difficultyId: number | null | undefined): string {
  if (difficultyId === null || difficultyId === undefined) return '';
  return GRADE_MAP[difficultyId] ?? '';
}

const MAX_CLIMB_STARS = 5;

/** Quality average (canonical 1-5) → integer 0-5 star count. Unrated → 0. */
export function getClimbStars(qualityAverage: number | string | null | undefined): number {
  const quality = Number(qualityAverage);
  if (!Number.isFinite(quality) || quality <= 0) return 0;
  return Math.min(MAX_CLIMB_STARS, Math.round(quality));
}
