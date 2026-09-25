import { BOARD_TYPE_LABELS, getLayoutName, getProductSize, type BoardName } from '@boardsesh/board-constants';

/**
 * The "which board is this" line under a climb name on an OG share card, e.g.
 * `Kilter · Original · 12 x 12 Square`.
 *
 * Derived from the config params the URL already carries rather than taken as a
 * param of its own. Those params fully determine the board that gets drawn, so a
 * caller-supplied label would be a second source for the same fact — and the
 * only one of the two that a stranger could put words into.
 */
export function describeBoardConfig(boardName: string, layoutId: number, sizeId: number): string {
  const parts = [BOARD_TYPE_LABELS[boardName] ?? boardName];

  const layoutName = safely(() => getLayoutName(boardName as BoardName, layoutId));
  // A layout named after its own board ("Kilter Board", "MoonBoard 2024") would
  // read as a stutter next to the brand, so keep only what the brand does not
  // already say.
  if (layoutName && !layoutName.toLowerCase().includes(boardName.toLowerCase())) parts.push(layoutName);

  const sizeName = safely(() => getProductSize(boardName as BoardName, sizeId)?.name);
  if (sizeName) parts.push(sizeName);

  return parts.join(' · ');
}

/**
 * Catalogue lookups throw for a board type they do not carry (MoonBoard and
 * Woods keep their layouts elsewhere). A missing line is a shorter card; a
 * throw here would be a 500 on a card that would otherwise have rendered.
 */
function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
