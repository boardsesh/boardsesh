/** The roster fields needed to match a human-entered screenshot selector. */
export interface ScreenshotBoardMatchingFields {
  name: string;
  layoutName?: string | null;
}

/** Keep the native slot order after trimming and removing empty selectors. */
export function parseScreenshotBoardSelectors(selectors: string): string[] {
  return selectors
    .split('|')
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0);
}

/** Apostrophes, punctuation, spacing and case do not change a wall's name. */
function looseKey(label: string | null | undefined): string {
  return (label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Return every match in the strongest tier, preserving roster order. Exact names
 * precede exact layouts, then name substrings precede layout substrings. Keeping
 * the entire winning tier lets strict callers reject ambiguous board identities.
 */
export function matchScreenshotBoardCandidates<Board extends ScreenshotBoardMatchingFields>(
  boards: readonly Board[],
  selector: string,
): Board[] {
  const wanted = looseKey(selector);
  if (!wanted) return [];
  const matchTiers = [
    (board: Board) => looseKey(board.name) === wanted,
    (board: Board) => looseKey(board.layoutName) === wanted,
    (board: Board) => looseKey(board.name).includes(wanted),
    (board: Board) => looseKey(board.layoutName).includes(wanted),
  ];
  for (const matchTier of matchTiers) {
    const candidates = boards.filter(matchTier);
    if (candidates.length > 0) return candidates;
  }
  return [];
}
