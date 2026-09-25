/**
 * Brand display names for board types — proper nouns, never translated.
 * Shared home for the map that was previously copy-pasted per component;
 * older call sites (board-detail, board cards, discovery scroll) still carry
 * local copies — migrate them here as they're touched.
 */
export const BOARD_TYPE_LABELS: Record<string, string> = {
  kilter: 'Kilter',
  tension: 'Tension',
  moonboard: 'MoonBoard',
  decoy: 'Decoy',
  touchstone: 'Touchstone',
  grasshopper: 'Grasshopper',
  soill: 'So iLL',
  woods: 'Woods',
  // Not a brand — a kind of wall. "Spray" alone reads as a truncated product
  // name, and the board type is what a row, a chip and a board title all print.
  spray: 'Spray wall',
};

/**
 * Board types that are a CATALOGUE board anyone can own and browse.
 *
 * Everything in `BOARD_TYPE_LABELS` except `spray`. A spray wall is one
 * climber's own wall: it has a label (it still has to be named on the wall's own
 * screens) but it is not a board model, so it must not appear anywhere the label
 * map is used as a *list* — a gym-directory facet, a board-type filter, a
 * picker. Derivations that enumerate board types read this; lookups that map one
 * type to its name read `boardTypeLabel`.
 */
const NON_CATALOGUE_BOARD_TYPES: ReadonlySet<string> = new Set(['spray']);

export const CATALOGUE_BOARD_TYPES: readonly string[] = Object.keys(BOARD_TYPE_LABELS).filter((boardType) =>
  isCatalogueBoardType(boardType),
);

/**
 * Whether a board type is a catalogue board — the predicate form of
 * {@link CATALOGUE_BOARD_TYPES}, for filtering values that did not come from
 * this module.
 *
 * Fails OPEN: a board type this file has never heard of answers `true`. The two
 * questions are genuinely different. `CATALOGUE_BOARD_TYPES` is an ALLOW LIST
 * for a value arriving from a URL (`?boardType=`), where an unknown value is
 * noise and must be dropped. This is a DENY check on a value that came from our
 * own database, where an unknown value is a board someone added without touching
 * this file — and silently hiding its gym chips would be a bug, not a guard.
 */
export function isCatalogueBoardType(boardType: string): boolean {
  return !NON_CATALOGUE_BOARD_TYPES.has(boardType);
}

/** Display label for a board type, falling back to the raw type string. */
export function boardTypeLabel(boardType: string): string {
  return BOARD_TYPE_LABELS[boardType] ?? boardType;
}
