// Protocol constants are owned by the portable Woods package. Geometry and
// catalog grading remain here.
export {
  WOODS_LED_MAPS,
  WOODS_DEVICE_NAME_PREFIXES,
  WOODS_BOARD_SIZES,
  WOODS_WIRE_ROLE,
  isWoodsDeviceName,
  type WoodsBoardSize,
  type WoodsWireRole,
} from '@boardsesh/woods-ble-protocol';
export { WOODS_HOLD_POSITIONS, WOODS_OCCUPIED_HOLD_IDS } from './generated/woods-hold-positions-data';
export { WOODS_ROW_LENGTHS } from './woods-dimensions';

// The Woods app grades a problem as a 0-based V number (0 = V0 … 17 = V17). That
// number is not comparable to anything else in Boardsesh, so the importer folds it
// onto the shared `BOULDER_GRADES` difficulty-id scale that every grade surface
// speaks — filters, colours, the offline grade rail, and tick grade matching.
//
// Each V band spans one or more Font grades; we take the LOWEST difficulty id in
// the band, matching `MOONBOARD_GRADE_TO_DIFFICULTY`. V17 clamps onto V16's id 33
// because the shared table stops at 8c+/V16.
export const WOODS_GRADE_TO_DIFFICULTY: Readonly<Record<number, number>> = {
  0: 10,
  1: 13,
  2: 15,
  3: 16,
  4: 18,
  5: 20,
  6: 22,
  7: 23,
  8: 24,
  9: 26,
  10: 27,
  11: 28,
  12: 29,
  13: 30,
  14: 31,
  15: 32,
  16: 33,
  17: 33,
};

/** The 17 distinct difficulty ids a Woods climb can carry (V17 folds into V16). */
export const WOODS_DIFFICULTY_IDS: ReadonlySet<number> = new Set(Object.values(WOODS_GRADE_TO_DIFFICULTY));

/**
 * Map a Woods problem grade (0-based V number) onto a shared difficulty id.
 * Returns null for a grade the Woods app never emits, so a caller can count and
 * skip the row rather than silently storing a wrong grade.
 */
export function woodsGradeToDifficulty(problemGrade: number): number | null {
  return WOODS_GRADE_TO_DIFFICULTY[problemGrade] ?? null;
}
