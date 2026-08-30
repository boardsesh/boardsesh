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
  quantum: 'Quantum Board',
};

/** Display label for a board type, falling back to the raw type string. */
export function boardTypeLabel(boardType: string): string {
  return BOARD_TYPE_LABELS[boardType] ?? boardType;
}
