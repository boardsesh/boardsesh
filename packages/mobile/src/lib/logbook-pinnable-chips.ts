// The Logbook's pinnable quick-filter capsules: which filter controls a climber
// can pin to the capsule row above their logbook, the fixed order the capsules
// render in, and the pins a fresh install starts with. The filter SHEET is the
// full set; the row is the climber's pinned subset (same idea as the climbs
// catalog in pinnable-chips.ts, with its own kinds and storage key).
//
// Pure, so the store (logbook-pinned-chips-store.ts), the capsule builder
// (components/you/logbook-capsules.ts), the sheet's pin toggles and the token
// row all read one list without pulling in React or native code.

/**
 * Every pinnable Logbook capsule, in the order the row and the sheet show them:
 * Difficulty (grade), Your ascents (status, stars, when), The climb (board,
 * angle, setter, benchmarks), then Sort.
 */
export const LOGBOOK_PINNABLE_CHIP_KINDS = [
  'grade',
  'status',
  'stars',
  'date',
  'board',
  'angle',
  'setter',
  'benchmarks',
  'sort',
] as const;

export type LogbookPinnableChipKind = (typeof LOGBOOK_PINNABLE_CHIP_KINDS)[number];

/** The fixed render order. A capsule never moves because it was pinned later. */
export const LOGBOOK_PINNABLE_CHIP_CATALOG: readonly LogbookPinnableChipKind[] = LOGBOOK_PINNABLE_CHIP_KINDS;

/**
 * Pinned on a fresh install: the controls a climber reaches for while reading
 * back a session. Board, stars, setter and benchmarks are opt-in.
 */
export const LOGBOOK_DEFAULT_PINNED_CHIPS: readonly LogbookPinnableChipKind[] = [
  'grade',
  'status',
  'date',
  'angle',
  'sort',
];
