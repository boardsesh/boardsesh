// Woods Board constants — the device-name patterns, board sizes, and hold role
// codes shared across the web and mobile BLE adapters and the data importer.
// Pure values — no React, no platform APIs. See
// docs/WOODS_BLUETOOTH_PROTOCOL_SPEC.md.
import { WOODS_LED_MAPS, type WoodsBoardSize } from './generated/woods-led-maps-data';
import { WOODS_HOLD_POSITIONS, WOODS_OCCUPIED_HOLD_IDS } from './generated/woods-hold-positions-data';

export { WOODS_LED_MAPS, WOODS_HOLD_POSITIONS, WOODS_OCCUPIED_HOLD_IDS };
export type { WoodsBoardSize };

// The Woods board advertises its name over the Nordic UART Service. Both the v1
// ("Woods Board") and v2 ("Woods Board v2") controllers share this prefix and
// speak the same LED command format, so one case-insensitive prefix matches both
// (spec §3).
export const WOODS_DEVICE_NAME_PREFIXES = ['Woods Board'] as const;

// The two real Woods board sizes. A climb's `boardDimension` selects the size,
// which in turn selects the LED lookup table (spec §7).
export const WOODS_BOARD_SIZES = ['8x10', '12x12'] as const;

// Wire role codes the Woods firmware understands (spec §6). Boardsesh stores
// Woods climb frames with these same numeric codes (`p{baseHoldLocation}r{code}`),
// so the BLE encoder maps a frame's role code straight onto the wire.
export const WOODS_WIRE_ROLE = {
  FOOT: 1,
  HAND: 2,
  FINISH: 3,
  START: 4,
} as const;

export type WoodsWireRole = (typeof WOODS_WIRE_ROLE)[keyof typeof WOODS_WIRE_ROLE];

/** True when a BLE peripheral's advertised name looks like a Woods board. */
export function isWoodsDeviceName(name?: string): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase();
  return WOODS_DEVICE_NAME_PREFIXES.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}

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
