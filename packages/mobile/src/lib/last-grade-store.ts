import { readSecureValue, writeSecureValue } from './secure-store-io';

// Remembers the last grade the climber actually filtered by, so the grade rail
// can open centred on it even after the filter is cleared. Deliberately a
// SINGLE global value (not per-board): the rail validates membership against
// the current board's grade band before centring, so a value from another board
// family with a different difficulty scale just falls through to the band
// default. Mirrors web's `lastUsedGrade` (user-preferences-db.ts) in spirit.
export const LAST_GRADE_KEY = 'boardsesh_last_used_grade';

/** The last-used difficulty id, or `undefined` if none was ever stored. */
export async function getLastUsedGradeId(): Promise<number | undefined> {
  try {
    const value = await readSecureValue(LAST_GRADE_KEY);
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function setLastUsedGradeId(difficultyId: number): Promise<void> {
  try {
    await writeSecureValue(LAST_GRADE_KEY, String(difficultyId));
  } catch {
    // Storage failure is non-critical.
  }
}
